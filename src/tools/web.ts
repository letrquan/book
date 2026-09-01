import { DomUtils, parseDocument } from 'htmlparser2';
import TurndownService from 'turndown';
import { Agent, fetch as undiciFetch } from 'undici';
import { z } from 'zod';
import type { ToolDefinition, ToolContext, ToolResult } from '../types/tools.js';
import { toolFailure, toolSuccess } from './result.js';
import { resolveToolTimeoutMs } from './timeouts.js';
import {
  type HostResolver,
  WebPolicyError,
  connectionBlockedReason,
  resolveHostname,
  safeNetworkLookup,
  validateWebUrl,
  webUrlPolicyFromEnv,
} from './web-policy.js';

const WEB_FETCH_MAX_BYTES = 256 * 1024;
const WEB_SEARCH_MAX_BYTES = 512 * 1024;
const WEB_SEARCH_MAX_RESULTS = 10;
const WEB_FETCH_DEFAULT_TIMEOUT_MS = 30_000;
const WEB_FETCH_MAX_TIMEOUT_MS = 120_000;
const BUILTIN_SEARCH_CONTEXT_MAX_CHARS = 12_000;
const SEARCH_PROVIDER_FAILURE_COOLDOWN_MS = 30_000;
const SEARCH_PROVIDER_RATE_LIMIT_COOLDOWN_MS = 5 * 60_000;
const SEARCH_PROVIDER_MAX_COOLDOWN_MS = 24 * 60 * 60_000;
const MCP_PROTOCOL_VERSION = '2024-11-05';
const strictWebDispatcher = new Agent({ connect: { lookup: safeNetworkLookup } });

type WebFetchFormat = 'markdown' | 'text' | 'html';
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type BuiltinSearchProviderId = 'exa' | 'parallel';

/**
 * Fetch through the same undici the dispatcher comes from.
 *
 * `strictWebDispatcher` carries the DNS-rebinding guard, and a dispatcher is only consulted by
 * the undici that created it. Node's global `fetch` is its own bundled undici, which builds
 * request handlers this package's `Agent` rejects outright (`invalid onRequestStart method`) —
 * so handing the guard to `globalThis.fetch` fails the request before the lookup hook is ever
 * called. Routing through undici's own `fetch` keeps the guard on the connect path.
 */
const undiciWebFetch: FetchLike = (input, init) =>
  undiciFetch(input, init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>;

interface BuiltinSearchProvider {
  id: BuiltinSearchProviderId;
  label: string;
  endpoint: string;
  toolName: string;
  arguments: (query: string, searchQuery: string, resultLimit: number) => Record<string, unknown>;
}

interface SearchProviderAttempt {
  provider: BuiltinSearchProviderId;
  status: 'failed' | 'cooldown';
  code?: string;
  message?: string;
  retryable: boolean;
  retryAfterMs?: number;
}

const BUILTIN_SEARCH_PROVIDERS: readonly BuiltinSearchProvider[] = [
  {
    id: 'exa',
    label: 'Exa Web Search',
    endpoint: 'https://mcp.exa.ai/mcp',
    toolName: 'web_search_exa',
    arguments: (_query, searchQuery, resultLimit) => ({
      query: searchQuery,
      type: 'auto',
      numResults: resultLimit,
      livecrawl: 'fallback',
      contextMaxCharacters: BUILTIN_SEARCH_CONTEXT_MAX_CHARS,
    }),
  },
  {
    id: 'parallel',
    label: 'Parallel Web Search',
    endpoint: 'https://search.parallel.ai/mcp',
    toolName: 'web_search',
    arguments: (query, searchQuery, resultLimit) => ({
      objective: `Find and summarize no more than ${resultLimit} web results that answer: ${query}`,
      search_queries: [searchQuery],
    }),
  },
];

export interface WebToolDependencies {
  fetch?: FetchLike;
  resolveHostname?: HostResolver;
  now?: () => Date;
}

interface LimitedResponseBody {
  bytes: Uint8Array;
  bytesRead: number;
  omittedBytes: number;
  truncated: boolean;
}

interface FetchedResponse {
  response: Response;
  requestedUrl: string;
  finalUrl: string;
  redirects: string[];
}

class CrossOriginRedirectError extends Error {
  constructor(
    readonly sourceUrl: string,
    readonly targetUrl: string,
  ) {
    super(`Redirect from ${sourceUrl} to a different origin requires a new WebFetch approval.`);
    this.name = 'CrossOriginRedirectError';
  }
}

class RedirectLimitError extends Error {
  constructor(readonly maxRedirects: number) {
    super(`Web fetch exceeded the ${maxRedirects}-redirect limit.`);
    this.name = 'RedirectLimitError';
  }
}

class InvalidSearchDomainError extends Error {
  readonly code = 'invalid_search_domain';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidSearchDomainError';
  }
}

const mcpSearchResponseSchema = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(
      z.object({
        type: z.string(),
        text: z.string(),
      }),
    ),
  }),
});

interface McpSearchResponse {
  text: string;
  isError: boolean;
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
): Promise<LimitedResponseBody> {
  if (!response.body) {
    return { bytes: new Uint8Array(), bytesRead: 0, omittedBytes: 0, truncated: false };
  }

  const declaredLength = Number(response.headers.get('content-length'));
  const declaredTruncated = Number.isFinite(declaredLength) && declaredLength > maxBytes;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  let truncated = declaredTruncated;

  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytesRead;
      const kept = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(kept);
      bytesRead += kept.byteLength;
      if (kept.byteLength < value.byteLength) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }

    if (bytesRead === maxBytes && !declaredTruncated) {
      const next = await reader.read();
      truncated = !next.done;
      if (truncated) await reader.cancel();
    } else if (declaredTruncated) {
      await reader.cancel();
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const omittedBytes =
    truncated && Number.isFinite(declaredLength)
      ? Math.max(1, declaredLength - bytesRead)
      : truncated
        ? 1
        : 0;
  return { bytes, bytesRead, omittedBytes, truncated };
}

function charsetFromContentType(contentType: string): string {
  return /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1] ?? 'utf-8';
}

function decodeBody(body: LimitedResponseBody, contentType: string): string {
  try {
    return new TextDecoder(charsetFromContentType(contentType)).decode(body.bytes);
  } catch {
    return new TextDecoder().decode(body.bytes);
  }
}

function isHtmlElement(node: object, names: Set<string>): boolean {
  return 'name' in node && typeof node.name === 'string' && names.has(node.name.toLowerCase());
}

function isSafeHtmlUrl(value: string): boolean {
  const normalized = value.trim();
  if (!normalized) return false;
  if (/^(?:#|\?|\/(?!\/)|\.{1,2}\/)/.test(normalized)) return true;
  try {
    const url = new URL(normalized);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:';
  } catch {
    return false;
  }
}

function sanitizeElementAttributes(node: object): void {
  if (
    !('name' in node) ||
    typeof node.name !== 'string' ||
    !('attribs' in node) ||
    !node.attribs ||
    typeof node.attribs !== 'object'
  ) {
    return;
  }

  const name = node.name.toLowerCase();
  const attributes = node.attribs as Record<string, string>;
  const allowedByElement: Record<string, Set<string>> = {
    a: new Set(['href', 'title']),
    img: new Set(['alt', 'title']),
    td: new Set(['colspan', 'rowspan']),
    th: new Set(['colspan', 'rowspan', 'scope']),
  };
  const allowed = allowedByElement[name] ?? new Set<string>();
  for (const attribute of Object.keys(attributes)) {
    const normalized = attribute.toLowerCase();
    if (!allowed.has(normalized)) {
      delete attributes[attribute];
      continue;
    }
    if (normalized === 'href' && !isSafeHtmlUrl(attributes[attribute])) {
      delete attributes[attribute];
    }
  }
}

function sanitizeHtml(html: string): {
  html: string;
  markdown: string;
  text: string;
  title?: string;
} {
  const document = parseDocument(html, { decodeEntities: true });
  const unwantedNames = new Set([
    'script',
    'style',
    'noscript',
    'iframe',
    'object',
    'embed',
    'svg',
    'canvas',
    'template',
    'base',
    'link',
    'meta',
    'form',
    'input',
    'button',
    'select',
    'textarea',
    'audio',
    'video',
    'source',
    'track',
  ]);
  const unwanted = DomUtils.findAll(
    (node) => isHtmlElement(node, unwantedNames),
    document.children,
  );
  for (const node of unwanted) DomUtils.removeElement(node);
  const remainingElements = DomUtils.findAll(
    (node) => 'name' in node && typeof node.name === 'string',
    document.children,
  );
  for (const node of remainingElements) sanitizeElementAttributes(node);

  const titleNode = DomUtils.findOne(
    (node) => isHtmlElement(node, new Set(['title'])),
    document.children,
  );
  const title = titleNode ? DomUtils.textContent(titleNode).replace(/\s+/g, ' ').trim() : undefined;
  const sanitizedHtml = DomUtils.getOuterHTML(document);
  const turndown = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });
  turndown.remove(['script', 'style', 'noscript', 'iframe', 'object', 'embed', 'canvas']);
  const markdown = turndown
    .turndown(sanitizedHtml)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const text = markdown
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/```[^\n]*\n?/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { html: sanitizedHtml, markdown, text, title: title || undefined };
}

function mimeFromContentType(contentType: string): string {
  return contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function isTextualMime(mime: string): boolean {
  return (
    !mime ||
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime.endsWith('+json') ||
    mime === 'application/xml' ||
    mime.endsWith('+xml') ||
    mime === 'application/javascript' ||
    mime === 'application/x-javascript'
  );
}

function looksLikeHtml(text: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html|<head|<body|<main|<article)\b/i.test(text);
}

function formatFetchedContent(
  raw: string,
  contentType: string,
  format: WebFetchFormat,
): { output: string; title?: string } {
  const mime = mimeFromContentType(contentType);
  if (mime === 'application/json' || mime.endsWith('+json')) {
    try {
      return { output: JSON.stringify(JSON.parse(raw), null, 2) };
    } catch {
      return { output: raw };
    }
  }
  if (mime === 'text/html' || mime === 'application/xhtml+xml' || looksLikeHtml(raw)) {
    const converted = sanitizeHtml(raw);
    return {
      output:
        format === 'html'
          ? converted.html
          : format === 'text'
            ? converted.text
            : converted.markdown,
      title: converted.title,
    };
  }
  return { output: raw };
}

function combinedSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

async function cancelResponse(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The response may already be closed by the transport.
  }
}

async function fetchWithPolicy(
  rawUrl: string,
  ctx: ToolContext,
  deps: Required<Pick<WebToolDependencies, 'fetch' | 'resolveHostname'>>,
  timeoutMs: number,
  format: WebFetchFormat,
): Promise<FetchedResponse> {
  const env = { ...process.env, ...ctx.env } as Record<string, string | undefined>;
  const policy = webUrlPolicyFromEnv(env);
  const requested = await validateWebUrl(rawUrl, policy, deps.resolveHostname);
  let current = requested;
  const redirects: string[] = [];
  const signal = combinedSignal(ctx.signal, timeoutMs);

  while (true) {
    const requestInit: RequestInit & { dispatcher?: Agent } = {
      headers: {
        'User-Agent': 'book-agent/0.1 (+https://github.com/letrquan/book)',
        Accept:
          format === 'markdown'
            ? 'text/markdown;q=1.0, text/plain;q=0.9, text/html;q=0.8, application/json;q=0.8, */*;q=0.1'
            : format === 'text'
              ? 'text/plain;q=1.0, text/html;q=0.8, application/json;q=0.8, */*;q=0.1'
              : 'text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.7, */*;q=0.1',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'manual',
      signal,
      ...(policy.allowPrivateNetwork ? {} : { dispatcher: strictWebDispatcher }),
    };
    const response = await deps.fetch(current.toString(), requestInit);

    if (!isRedirectStatus(response.status)) {
      return {
        response,
        requestedUrl: requested.toString(),
        finalUrl: current.toString(),
        redirects,
      };
    }

    const location = response.headers.get('location');
    await cancelResponse(response);
    if (!location)
      throw new Error(`HTTP ${response.status} redirect did not include a Location header.`);
    if (redirects.length >= policy.maxRedirects) throw new RedirectLimitError(policy.maxRedirects);
    const next = await validateWebUrl(
      new URL(location, current).toString(),
      policy,
      deps.resolveHostname,
    );
    if (next.origin !== current.origin) {
      throw new CrossOriginRedirectError(current.toString(), next.toString());
    }
    redirects.push(next.toString());
    current = next;
  }
}

function webPolicyFailure(error: unknown): ToolResult | undefined {
  if (error instanceof WebPolicyError) {
    return toolFailure(error.message, { code: error.code });
  }
  // The connect-time guard refuses after pre-flight validation has already passed -- a rebinding
  // answer, or a redirect target that resolves privately. Report the policy's own reason instead
  // of the `fetch failed` undici wraps it in, and do not invite a retry that cannot succeed.
  const blockedReason = connectionBlockedReason(error);
  if (blockedReason) {
    return toolFailure(blockedReason, {
      code: 'private_network_forbidden',
      status: 'blocked',
      retryable: false,
    });
  }
  if (error instanceof CrossOriginRedirectError) {
    return toolFailure(error.message, {
      code: 'cross_origin_redirect',
      status: 'blocked',
      remediation: `Call WebFetch again with url: ${error.targetUrl}`,
      details: { sourceUrl: error.sourceUrl, targetUrl: error.targetUrl },
    });
  }
  if (error instanceof RedirectLimitError) {
    return toolFailure(error.message, {
      code: 'redirect_limit_exceeded',
      details: { maxRedirects: error.maxRedirects },
    });
  }
  return undefined;
}

async function webFetch(
  args: Record<string, unknown>,
  ctx: ToolContext,
  deps: Required<Pick<WebToolDependencies, 'fetch' | 'resolveHostname'>> &
    Pick<WebToolDependencies, 'now'>,
): Promise<ToolResult> {
  const url = args.url as string;
  const prompt = args.prompt as string | undefined;
  const format = (args.format as WebFetchFormat | undefined) ?? 'markdown';
  // Resolved through the shared helper so the operator's BOOK_TOOL_TIMEOUT_MS
  // reaches this deadline too. Reading only the argument left a lowered value
  // moving the registry's backstop under this timer, so a slow fetch died on
  // the contentless `tool_timeout` instead of reporting `fetch_timeout`.
  const timeoutMs = Math.min(
    WEB_FETCH_MAX_TIMEOUT_MS,
    resolveToolTimeoutMs({
      requested: args.timeout,
      env: ctx.env,
      fallback: WEB_FETCH_DEFAULT_TIMEOUT_MS,
    }),
  );

  let fetched: FetchedResponse;
  try {
    fetched = await fetchWithPolicy(url, ctx, deps, timeoutMs, format);
  } catch (error) {
    const policyFailure = webPolicyFailure(error);
    if (policyFailure) return policyFailure;
    const message = error instanceof Error ? error.message : String(error);
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return toolFailure(`Fetch failed: ${message}`, {
      code: timedOut ? 'fetch_timeout' : 'fetch_failed',
      retryable: !timedOut,
    });
  }

  const { response } = fetched;
  if (!response.ok) {
    await cancelResponse(response);
    return toolFailure(`HTTP ${response.status} ${response.statusText} for ${fetched.finalUrl}`, {
      code: 'http_error',
      retryable: response.status >= 500,
      details: { status: response.status, url: fetched.finalUrl },
    });
  }

  const contentType = response.headers.get('content-type') ?? '';
  const mime = mimeFromContentType(contentType);
  if (!isTextualMime(mime)) {
    await cancelResponse(response);
    return toolFailure(`Unsupported fetched content type: ${mime || '(unknown)'}`, {
      code: 'unsupported_content_type',
      details: { contentType, url: fetched.finalUrl },
    });
  }

  let body: LimitedResponseBody;
  try {
    body = await readResponseBody(response, WEB_FETCH_MAX_BYTES);
  } catch (error) {
    return toolFailure(error instanceof Error ? error.message : String(error), {
      code: 'response_read_failed',
      retryable: true,
      details: { url: fetched.finalUrl, maxBytes: WEB_FETCH_MAX_BYTES },
    });
  }

  const raw = decodeBody(body, contentType);
  const formatted = formatFetchedContent(raw, contentType, format);
  const fetchedAt = (deps.now?.() ?? new Date()).toISOString();
  const truncationNotice = body.truncated
    ? `\n\n[Response truncated after ${body.bytesRead} bytes.]`
    : '';
  const metadata = [
    `Fetched: ${fetched.finalUrl}`,
    formatted.title ? `Title: ${formatted.title}` : undefined,
    contentType ? `Content-Type: ${contentType}` : undefined,
    `Retrieved: ${fetchedAt}`,
    '',
    '--- Web content (untrusted) ---',
  ].filter((line): line is string => line !== undefined);

  return toolSuccess(`${metadata.join('\n')}\n${formatted.output}${truncationNotice}`, {
    data: {
      requestedUrl: fetched.requestedUrl,
      finalUrl: fetched.finalUrl,
      redirects: fetched.redirects,
      title: formatted.title,
      contentType,
      format,
      prompt,
      bytes: body.bytesRead,
      fetchedAt,
      truncated: body.truncated,
    },
    pagination: body.truncated ? { truncated: true, omittedBytes: body.omittedBytes } : undefined,
  });
}

function normalizeSearchDomain(domain: string): string {
  let normalized = domain.trim().toLowerCase();
  if (/^https?:\/\//.test(normalized)) {
    let url: URL;
    try {
      url = new URL(normalized);
    } catch {
      throw new InvalidSearchDomainError(`Invalid search domain: ${domain}`);
    }
    if (url.username || url.password || url.port) {
      throw new InvalidSearchDomainError(`Invalid search domain: ${domain}`);
    }
    normalized = url.hostname;
  } else {
    normalized = normalized.replace(/^\*\./, '').replace(/\.$/, '');
    if (/[\/:?#@\[\]]/.test(normalized)) {
      throw new InvalidSearchDomainError(`Invalid search domain: ${domain}`);
    }
  }

  const labels = normalized.split('.');
  const validLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (
    normalized.length > 253 ||
    labels.length < 2 ||
    labels.some((label) => !validLabel.test(label))
  ) {
    throw new InvalidSearchDomainError(`Invalid search domain: ${domain}`);
  }
  return normalized;
}

function builtinSearchQuery(
  query: string,
  args: Record<string, unknown>,
  now: () => Date = () => new Date(),
): string {
  const filters: string[] = [];
  const domains = (args.domains as string[] | undefined) ?? [];
  if (domains.length === 1) filters.push(`site:${normalizeSearchDomain(domains[0])}`);
  if (domains.length > 1) {
    filters.push(
      `(${domains.map((domain) => `site:${normalizeSearchDomain(domain)}`).join(' OR ')})`,
    );
  }
  if (args.recencyDays !== undefined) {
    const cutoff = new Date(now().getTime() - Number(args.recencyDays) * 86_400_000)
      .toISOString()
      .slice(0, 10);
    filters.push(`after:${cutoff}`);
  }
  if (args.country !== undefined) filters.push(`country:${String(args.country).toLowerCase()}`);
  return [query, ...filters].join(' ');
}

function parseMcpSearchResponse(raw: string): McpSearchResponse | undefined {
  for (const value of parseMcpMessages(raw)) {
    const parsed = mcpSearchResponseSchema.safeParse(value);
    if (!parsed.success) continue;
    const text = parsed.data.result.content.find((item) => item.text.trim())?.text.trim() ?? '';
    if (text || parsed.data.result.isError) {
      return { text, isError: parsed.data.result.isError === true };
    }
  }
  return undefined;
}

function parseMcpMessages(raw: string): unknown[] {
  const candidates = [
    raw,
    ...raw.split(/\r?\n/).map((line) => line.trim().replace(/^data:\s*/, '')),
  ];
  const messages: unknown[] = [];
  for (const candidate of candidates) {
    if (!candidate.startsWith('{')) continue;
    let value: unknown;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    messages.push(value);
  }
  return messages;
}

function parseMcpInitializeResponse(raw: string): string | undefined {
  for (const value of parseMcpMessages(raw)) {
    const result = z
      .object({ result: z.object({ protocolVersion: z.string().optional() }) })
      .safeParse(value);
    if (result.success) return result.data.result.protocolVersion;
  }
  return undefined;
}

async function mcpHttpErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const body = await readResponseBody(response, 32 * 1024);
    if (body.truncated) return undefined;
    for (const value of parseMcpMessages(decodeBody(body, 'application/json'))) {
      const parsed = z.object({ error: z.object({ message: z.string() }) }).safeParse(value);
      if (parsed.success) return parsed.data.error.message;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function retryAfterMs(response: Response, now: Date): number | undefined {
  const raw = response.headers.get('retry-after')?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  const duration = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(raw) - now.getTime();
  if (!Number.isFinite(duration) || duration <= 0) return undefined;
  return Math.min(Math.max(1_000, duration), SEARCH_PROVIDER_MAX_COOLDOWN_MS);
}

function providerRequestFailure(
  provider: BuiltinSearchProvider,
  phase: string,
  error: unknown,
  ctx: ToolContext,
): ToolResult {
  if (ctx.signal?.aborted) {
    return toolFailure('Web search was cancelled.', {
      status: 'cancelled',
      code: 'cancelled',
      details: { provider: provider.id, phase },
    });
  }
  // `postMcp` always dispatches through `strictWebDispatcher`, so a provider endpoint that
  // resolves to a private address is refused by the connect-time guard. Report that the same
  // way WebFetch does: it is a policy decision, not a transient network fault.
  const blockedReason = connectionBlockedReason(error);
  if (blockedReason) {
    return toolFailure(blockedReason, {
      code: 'private_network_forbidden',
      status: 'blocked',
      retryable: false,
      details: { provider: provider.id, phase },
    });
  }
  return toolFailure(
    `${provider.label} ${phase} failed: ${error instanceof Error ? error.message : String(error)}`,
    {
      code: 'search_request_failed',
      retryable: true,
      details: { provider: provider.id, phase },
    },
  );
}

async function providerHttpFailure(
  response: Response,
  provider: BuiltinSearchProvider,
  phase: string,
  now: Date,
): Promise<ToolResult> {
  const providerMessage = await mcpHttpErrorMessage(response);
  const retryDelay = retryAfterMs(response, now);
  return toolFailure(
    `${provider.label} returned HTTP ${response.status}.${providerMessage ? ` ${providerMessage}` : ''}`,
    {
      code: 'search_provider_error',
      retryable: response.status >= 500 || response.status === 429,
      details: {
        status: response.status,
        provider: provider.id,
        phase,
        ...(retryDelay === undefined ? {} : { retryAfterMs: retryDelay }),
      },
    },
  );
}

async function runBuiltinSearchProvider(
  provider: BuiltinSearchProvider,
  query: string,
  searchQuery: string,
  resultLimit: number,
  ctx: ToolContext,
  fetchImpl: FetchLike,
  resolver: HostResolver,
  now: () => Date,
): Promise<ToolResult> {
  let endpoint: URL;
  try {
    endpoint = await validateWebUrl(
      provider.endpoint,
      { allowHttp: false, allowPrivateNetwork: false, maxRedirects: 0 },
      resolver,
    );
  } catch (error) {
    return toolFailure(
      `${provider.label} endpoint is unavailable: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: 'search_provider_unavailable',
        retryable: true,
        details: { provider: provider.id, phase: 'endpoint_validation' },
      },
    );
  }

  const baseHeaders = {
    Accept: 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'User-Agent': 'book-agent/0.1 (+https://github.com/letrquan/book)',
  };
  const postMcp = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
    fetchImpl(endpoint.toString(), {
      method: 'POST',
      headers: { ...baseHeaders, ...headers },
      body: JSON.stringify(body),
      redirect: 'error',
      signal: combinedSignal(ctx.signal, 25_000),
      dispatcher: strictWebDispatcher,
    } as RequestInit & { dispatcher?: Agent });

  let initializeResponse: Response;
  try {
    initializeResponse = await postMcp({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'book-agent', version: '0.1.0' },
      },
    });
  } catch (error) {
    return providerRequestFailure(provider, 'initialization', error, ctx);
  }

  if (!initializeResponse.ok) {
    return providerHttpFailure(initializeResponse, provider, 'initialize', now());
  }

  let initializeBody: LimitedResponseBody;
  try {
    initializeBody = await readResponseBody(initializeResponse, 64 * 1024);
    if (initializeBody.truncated)
      throw new Error('MCP initialization response exceeded the byte limit.');
  } catch (error) {
    return toolFailure(
      `${provider.label} returned an invalid initialization response: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: 'invalid_search_response',
        details: { provider: provider.id, phase: 'initialize' },
      },
    );
  }

  const negotiatedProtocolVersion =
    initializeResponse.headers.get('mcp-protocol-version') ??
    parseMcpInitializeResponse(decodeBody(initializeBody, 'application/json'));
  if (!negotiatedProtocolVersion) {
    return toolFailure(`${provider.label} initialization did not return a protocol version.`, {
      code: 'invalid_search_response',
      details: { provider: provider.id, phase: 'initialize' },
    });
  }
  const sessionId = initializeResponse.headers.get('mcp-session-id');
  const sessionHeaders = {
    'MCP-Protocol-Version': negotiatedProtocolVersion,
    ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
  };

  let initializedResponse: Response;
  try {
    initializedResponse = await postMcp(
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      sessionHeaders,
    );
  } catch (error) {
    return providerRequestFailure(provider, 'session setup', error, ctx);
  }
  if (!initializedResponse.ok) {
    return providerHttpFailure(initializedResponse, provider, 'initialized', now());
  }
  await cancelResponse(initializedResponse);

  let response: Response;
  try {
    response = await postMcp(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: provider.toolName,
          arguments: provider.arguments(query, searchQuery, resultLimit),
        },
      },
      sessionHeaders,
    );
  } catch (error) {
    return providerRequestFailure(provider, 'request', error, ctx);
  }

  if (!response.ok) {
    return providerHttpFailure(response, provider, 'tools_call', now());
  }

  try {
    const body = await readResponseBody(response, WEB_SEARCH_MAX_BYTES);
    if (body.truncated) throw new Error('Search response exceeded the configured byte limit.');
    const parsed = parseMcpSearchResponse(decodeBody(body, 'application/json'));
    if (!parsed) throw new Error('MCP response did not contain search content.');
    if (parsed.isError) {
      return toolFailure(
        `${provider.label} search tool failed: ${parsed.text || 'The provider returned an unspecified MCP tool error.'}`,
        {
          code: 'search_provider_error',
          retryable: true,
          details: { provider: provider.id, phase: 'tools_call', toolError: true },
        },
      );
    }
    return toolSuccess(
      `Search: ${query}\nProvider: ${provider.label}\n\n--- Search results (untrusted) ---\n${parsed.text}`,
      {
        data: {
          provider: provider.id,
          query,
          searchQuery,
          results: [],
          source: 'builtin',
        },
      },
    );
  } catch (error) {
    return toolFailure(
      `${provider.label} returned an invalid response: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: 'invalid_search_response',
        details: { provider: provider.id, phase: 'tools_call' },
      },
    );
  }
}

function providerCooldownMs(result: ToolResult): number | undefined {
  // `blocked` counts: a provider refused on policy grounds will be refused again, so it
  // earns the same cooldown rather than being retried on every search. `cancelled` does not.
  if (result.status !== 'error' && result.status !== 'blocked') return undefined;
  const details = result.structuredError?.details;
  if (details?.status === 429) {
    return typeof details.retryAfterMs === 'number'
      ? details.retryAfterMs
      : SEARCH_PROVIDER_RATE_LIMIT_COOLDOWN_MS;
  }
  return SEARCH_PROVIDER_FAILURE_COOLDOWN_MS;
}

async function builtinWebSearch(
  args: Record<string, unknown>,
  ctx: ToolContext,
  fetchImpl: FetchLike,
  resolver: HostResolver,
  cooldowns: Map<BuiltinSearchProviderId, number>,
  now: () => Date,
): Promise<ToolResult> {
  const query = args.query as string;
  const requestedLimit = (args.limit as number | undefined) ?? WEB_SEARCH_MAX_RESULTS;
  const resultLimit = Math.min(requestedLimit, WEB_SEARCH_MAX_RESULTS);
  let searchQuery: string;
  try {
    searchQuery = builtinSearchQuery(query, args, now);
  } catch (error) {
    return toolFailure(error instanceof Error ? error.message : String(error), {
      code: error instanceof InvalidSearchDomainError ? error.code : 'invalid_search_query',
    });
  }

  const attempts: SearchProviderAttempt[] = [];
  for (const provider of BUILTIN_SEARCH_PROVIDERS) {
    const currentTime = now().getTime();
    const cooldownUntil = cooldowns.get(provider.id);
    if (cooldownUntil !== undefined && cooldownUntil > currentTime) {
      attempts.push({
        provider: provider.id,
        status: 'cooldown',
        retryable: true,
        retryAfterMs: cooldownUntil - currentTime,
      });
      continue;
    }
    cooldowns.delete(provider.id);

    const result = await runBuiltinSearchProvider(
      provider,
      query,
      searchQuery,
      resultLimit,
      ctx,
      fetchImpl,
      resolver,
      now,
    );
    if (result.status === 'success' || result.status === 'cancelled') return result;

    const cooldownMs = providerCooldownMs(result);
    if (cooldownMs !== undefined) cooldowns.set(provider.id, now().getTime() + cooldownMs);
    attempts.push({
      provider: provider.id,
      status: 'failed',
      code: result.structuredError?.code,
      message: result.structuredError?.message,
      retryable: result.structuredError?.retryable ?? false,
      ...(cooldownMs === undefined ? {} : { retryAfterMs: cooldownMs }),
    });
  }

  const failures = attempts
    .map((attempt) =>
      attempt.status === 'cooldown'
        ? `${attempt.provider} is cooling down`
        : `${attempt.provider}: ${attempt.message ?? attempt.code ?? 'unknown error'}`,
    )
    .join('; ');
  return toolFailure(`Built-in web search providers are unavailable. ${failures}`, {
    code: 'search_all_providers_failed',
    retryable: attempts.some((attempt) => attempt.retryable),
    details: { attempts },
  });
}

async function webSearch(
  args: Record<string, unknown>,
  ctx: ToolContext,
  fetchImpl: FetchLike,
  resolver: HostResolver,
  cooldowns: Map<BuiltinSearchProviderId, number>,
  now?: () => Date,
): Promise<ToolResult> {
  const query = (args.query as string).trim();
  if (!query) {
    return toolFailure('Search query must not be blank.', { code: 'invalid_search_query' });
  }
  const currentTime = now ?? (() => new Date());
  return builtinWebSearch({ ...args, query }, ctx, fetchImpl, resolver, cooldowns, currentTime);
}

export function createWebTools(dependencies: WebToolDependencies = {}): ToolDefinition[] {
  const fetchImpl: FetchLike = dependencies.fetch ?? undiciWebFetch;
  const resolver = dependencies.resolveHostname ?? resolveHostname;
  const searchProviderCooldowns = new Map<BuiltinSearchProviderId, number>();

  return [
    {
      name: 'WebFetch',
      idempotent: true,
      policy: { concurrency: 'parallel' },
      description:
        'Fetch a public HTTP(S) URL and return bounded text, Markdown, or sanitized HTML. HTTPS is required unless the host opts into HTTP. Private-network destinations and cross-origin redirects are blocked. The network timeout defaults to 30 seconds. The deprecated `prompt` value is retained only as metadata and does not perform extraction.',
      // WebFetch enforces its own deadline and self-clamps at this value, so the
      // registry must outlast it; at an equal budget the registry fires first and
      // replaces `fetch_timeout` with a contentless `tool_timeout`.
      timeoutMs: WEB_FETCH_MAX_TIMEOUT_MS,
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            minLength: 1,
            maxLength: 4_096,
            description: 'Public HTTP(S) URL to fetch',
          },
          format: {
            type: 'string',
            enum: ['markdown', 'text', 'html'],
            description: 'Output format. Defaults to markdown.',
          },
          prompt: {
            type: 'string',
            maxLength: 2_000,
            description: 'Deprecated compatibility metadata; it does not control extraction.',
          },
        },
        required: ['url'],
      },
      execute: (args, ctx) =>
        webFetch(args, ctx, {
          fetch: fetchImpl,
          resolveHostname: resolver,
          now: dependencies.now,
        }),
    },
    {
      name: 'WebSearch',
      idempotent: true,
      policy: { concurrency: 'parallel' },
      description:
        'Search the web with fixed built-in providers and automatic fallback. No configuration is required. Supports bounded result count, domain filters, recency, and country hints. Provider origins are fixed and never model-controlled.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            minLength: 1,
            maxLength: 1_000,
            description: 'Precise web search query',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: WEB_SEARCH_MAX_RESULTS,
            description: `Maximum results to return. Defaults to ${WEB_SEARCH_MAX_RESULTS}.`,
          },
          domains: {
            type: 'array',
            items: { type: 'string', minLength: 1, maxLength: 253 },
            maxItems: 10,
            description: 'Optional domains to restrict the search to.',
          },
          recencyDays: {
            type: 'integer',
            minimum: 1,
            maximum: 3650,
            description: 'Optional freshness window in days.',
          },
          country: {
            type: 'string',
            minLength: 2,
            maxLength: 2,
            description: 'Optional two-letter country code.',
          },
        },
        required: ['query'],
      },
      execute: (args, ctx) =>
        webSearch(args, ctx, fetchImpl, resolver, searchProviderCooldowns, dependencies.now),
    },
  ];
}

export const webTools = createWebTools();
