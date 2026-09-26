import type { RetryConfig } from '../types/runtime.js';

interface RetryLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

import { systemClock, type Clock, type MonotonicMs } from '../clock.js';

export type ProviderErrorCode =
  | 'network'
  | 'timeout'
  | 'context_overflow'
  | 'rate_limited'
  | 'overloaded'
  | 'server_error'
  | 'auth'
  | 'bad_request'
  | 'not_found'
  | 'unprocessable'
  | 'quota'
  | 'unknown';

export function classifyHttpStatus(status: number): {
  code: ProviderErrorCode;
  retryable: boolean;
} {
  if (status === 413) return { code: 'context_overflow', retryable: false };
  if (status === 429) return { code: 'rate_limited', retryable: true };
  if (status === 529) return { code: 'overloaded', retryable: true };
  if (status >= 500 && status < 600) return { code: 'server_error', retryable: true };
  if (status === 408) return { code: 'timeout', retryable: true };
  if (status === 401 || status === 403) return { code: 'auth', retryable: false };
  if (status === 402) return { code: 'quota', retryable: false };
  if (status === 400) return { code: 'bad_request', retryable: false };
  if (status === 404) return { code: 'not_found', retryable: false };
  if (status === 422) return { code: 'unprocessable', retryable: false };
  return { code: 'unknown', retryable: false };
}

/**
 * The upstream HTTP status a router quoted inside its own error body, if any.
 *
 * 9router wraps an upstream 4xx as a 503 plus a cooldown, so the wrapper's status
 * says "transient" while the body says the request itself is invalid. Only a 4xx
 * is ever taken from the body: a quoted 5xx says nothing the wrapper did not.
 *
 * Only two shapes count as a quote: 9router's own `[<route>] [400]:` prefix, and
 * a JSON `"error"` object whose `code` is a 4xx. A status mentioned in prose
 * (`upstream sent HTTP 403`, `chunk [404]`) or a longer number that merely starts
 * like one (`"code": 4001`) is not: misreading an outage body ends the run after
 * a single request, or parks it as a rejected credential.
 */
export function quotedUpstreamStatus(body: string): number | undefined {
  if (!body) return undefined;
  const text = body.length > 65536 ? body.slice(0, 65536) : body;
  const patterns = [
    /\[[^\]\s]+\]\s*\[(4\d\d)\]:/,
    /"error"\s*:\s*\{[^{}]*?"code"\s*:\s*"?(4\d\d)(?![\d.])/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}

/**
 * The upstream 4xx quoted inside a retryable response, when that quote is what
 * classifies it: 9router answers 503 and names the real status in the body. A
 * non-retryable status is its own answer, and its body is never re-read.
 */
export function wrappedUpstreamStatus(status: number, body: string): number | undefined {
  return classifyHttpStatus(status).retryable ? quotedUpstreamStatus(body) : undefined;
}

/** `error.code` or `error.type` values that name a context overflow outright. */
const CONTEXT_OVERFLOW_ERROR_NAMES: ReadonlySet<string> = new Set([
  'context_length_exceeded',
  'request_too_large',
  // llama.cpp's server.
  'exceed_context_size_error',
]);

/**
 * The message and the `code` / `type` names of a provider's error body. The
 * message is `error.message` (or `error` itself when it is a string), else a
 * top-level `message` or `detail`; a body that is not JSON is its own message.
 * A body that starts like JSON but does not parse (cut at the read cap, or
 * malformed) is read for its first `"message"`, `"code"` and `"type"` strings
 * alone, never for the rest, which may echo the request. `raw` is the upstream's
 * own error body that OpenRouter forwards in `error.metadata.raw`, as a string
 * or as an object. `parsed` says the body read as a JSON object, so a reader
 * can tell a body with no message of its own from a body that is not JSON at
 * all.
 */
function errorBodyParts(body: string): {
  message: string;
  names: string[];
  raw?: string;
  parsed: boolean;
} {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    // A router's plain text can open with a bracket of its own (9router's
    // `[antigravity/x] [400]: …`), so only a `{` or an array of objects counts as JSON.
    if (!/^\s*(?:\{|\[\s*\{)/.test(body)) return { message: body, names: [], parsed: false };
    // JSON cut at the read cap, or malformed: only its first `"message"`, `"code"` and
    // `"type"` strings are read, never the rest, which may echo the request.
    const match = body.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    let message = '';
    if (match) {
      try {
        message = JSON.parse(`"${match[1]}"`) as string;
      } catch {
        message = '';
      }
    }
    const names = [body.match(/"code"\s*:\s*"([^"]*)"/), body.match(/"type"\s*:\s*"([^"]*)"/)]
      .filter((name): name is RegExpMatchArray => name !== null)
      .map((name) => name[1]);
    return { message, names, parsed: true };
  }
  const root: unknown = Array.isArray(parsedJson) ? parsedJson[0] : parsedJson;
  if (typeof root !== 'object' || root === null) {
    return { message: body, names: [], parsed: false };
  }
  const error: unknown = (root as { error?: unknown }).error;
  if (typeof error === 'string') return { message: error, names: [], parsed: true };
  const source = (typeof error === 'object' && error !== null ? error : root) as Record<
    string,
    unknown
  >;
  const fallback = (root as { detail?: unknown }).detail;
  const message =
    typeof source.message === 'string'
      ? source.message
      : typeof fallback === 'string'
        ? fallback
        : '';
  const metadata = source.metadata as { raw?: unknown } | null | undefined;
  const raw = metadata?.raw;
  return {
    message,
    names: [source.code, source.type].filter((name): name is string => typeof name === 'string'),
    raw:
      typeof raw === 'string'
        ? raw
        : typeof raw === 'object' && raw !== null
          ? JSON.stringify(raw)
          : undefined,
    parsed: true,
  };
}

/**
 * True when an error body states that the input is too large: its `error.code`
 * or `error.type` names an overflow, or its message says so
 * (`isContextOverflowError`). Only the message is read for wording, never the
 * rest of the body: a field path such as `contents[413]` or an id such as
 * `req-413-x` elsewhere in a 400 says nothing about the context window, and a
 * stated overflow permanently lowers the model's learned window. OpenRouter's
 * own message is generic (`Provider returned error`), so the upstream body it
 * forwards is read the same way; each level is shorter than the last.
 */
function statesContextOverflow(body: string): boolean {
  const { message, names, raw } = errorBodyParts(body);
  return (
    names.some((name) => CONTEXT_OVERFLOW_ERROR_NAMES.has(name.toLowerCase())) ||
    isContextOverflowError(message) ||
    (raw !== undefined && statesContextOverflow(raw))
  );
}

export function classifyApiError(status: number, body: string): ProviderErrorCode {
  const code = classifyHttpStatus(wrappedUpstreamStatus(status, body) ?? status).code;
  return code === 'bad_request' && statesContextOverflow(body) ? 'context_overflow' : code;
}

export function classifyProviderError(error: unknown): ProviderErrorCode {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes('timed out') || message.includes('timeout')) return 'timeout';
  if (isContextOverflowError(message)) return 'context_overflow';
  return 'network';
}

export function formatApiError(status: number, body: string): string {
  const code = classifyApiError(status, body);
  const detail = safeErrorDetail(body);
  const base = `API Error: ${status}`;
  switch (code) {
    case 'context_overflow':
      return `${base} ${detail || 'Input exceeds the model context window.'} Reduce the conversation or tool output and try again.`;
    case 'rate_limited':
      return isOversizedForRateLimit(detail)
        ? `${base} ${detail}. The request is larger than the rate limit allows at once, so it has to shrink; waiting will not help.`
        : `${base} ${detail}. This may be a temporary capacity issue. Try again in a moment.`;
    case 'overloaded':
      return `${base} Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.`;
    case 'server_error':
      return `${base} ${detail}. This is a server-side issue, usually temporary — try again in a moment.`;
    case 'timeout':
      return 'Request timed out. Check your network connection and try again.';
    case 'auth':
      return `${base} ${detail}. Check BOOK_API_KEY, or provider.<id>.apiKey in settings.`;
    case 'quota':
      return `${base} ${detail}. Check your usage/credits.`;
    default:
      return `${base} ${detail}`;
  }
}

/**
 * Detect provider/router responses that mean the input, rather than transport, is
 * too large. A 413 counts only where it is named as a status (`API Error: 413`,
 * `HTTP 413`, `status 413`, `Error code: 413`), never as a bare number: a field
 * path such as `contents[413]` or an id such as `req-413-x` is not one.
 */
export function isContextOverflowError(error: unknown): boolean {
  const normalized = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    /\b(?:api\s+error|http|(?:error|status)(?:\s+code)?)\s*:?\s*413\b/.test(normalized) ||
    normalized.includes('request entity too large') ||
    normalized.includes('payload too large') ||
    normalized.includes('request too large') ||
    normalized.includes('context_length_exceeded') ||
    normalized.includes('maximum context length') ||
    normalized.includes('context window') ||
    normalized.includes('prompt too long') ||
    /prompt\s+is\s+too\s+long/.test(normalized) ||
    /input\s+(?:is\s+)?too\s+long/.test(normalized) ||
    normalized.includes('too many tokens') ||
    // Gemini names the count: `The input token count (1196266) exceeds the maximum …`.
    /input\s+(?:token\s+count\s+)?(?:\(\d+\)\s+)?exceeds?.*(?:context|limit|maximum)/.test(
      normalized,
    ) ||
    /input\s+exceeds?.*(?:context\s+window|context\s+length|token\s+limit)/.test(normalized) ||
    /maximum\s+context|context\s+(?:length|window|size).*(?:exceed|overflow|too\s+(?:long|large)|maximum)/.test(
      normalized,
    ) ||
    /too\s+many\s+(?:input\s+)?tokens|request\s+too\s+large.*token/.test(normalized)
  );
}

/**
 * True when a rate-limit error says the request itself is larger than the limit allows at
 * once, which no amount of waiting fixes: OpenAI's `Request too large for <model> … on tokens
 * per min (TPM): Limit 30000, Requested 45000.` A transient per-minute limit reads `Rate limit
 * reached …` and is not this, and neither is a bare "too many tokens". When the text gives
 * both numbers, the request must exceed the limit.
 */
export function isOversizedForRateLimit(text: string): boolean {
  if (!/\brequest too large\b/i.test(text)) return false;
  const limit = text.match(/\blimit:?\s*(\d+)/i);
  const requested = text.match(/\brequested:?\s*(\d+)/i);
  return !limit || !requested || Number(requested[1]) > Number(limit[1]);
}

/**
 * The longest text still read as an error envelope rather than an answer when a
 * model may have written it. OpenAI's server-error sentence is about 260
 * characters, and a JSON-rendered upstream error rarely passes 1,000.
 */
const ERROR_ENVELOPE_MAX_CHARS = 2_000;

type EnvelopeUsage = { promptTokens: number; completionTokens: number } | null;

/**
 * A usage block that reports zero tokens both ways: what a router reports for
 * text it wrote itself. A provider that sends no usage block at all gives
 * `undefined`, which is not this.
 */
function isZeroUsage(usage?: EnvelopeUsage): boolean {
  return usage != null && usage.promptTokens === 0 && usage.completionTokens === 0;
}

/**
 * True when `text` has the shape a router gives an upstream error it renders as
 * the answer. 9router's Responses translator writes an upstream `error` or
 * `response.failed` event as `[Error] <message>` (or the error object as JSON
 * when it has no message) and ends the stream there. When a model may have
 * written the text, the envelope must be the whole answer: one `[Error] …` line.
 * An answer that quotes such a line and goes on to explain it is an answer. With
 * a usage block that reports zero tokens both ways any answer that opens with
 * `[Error]` is read as the router's, however many lines it runs to.
 */
export function isErrorEnvelopeShape(text: string, usage?: EnvelopeUsage): boolean {
  if (isZeroUsage(usage)) return /^\s*\[Error\]/i.test(text);
  const trimmed = text.trim();
  return (
    trimmed.length <= ERROR_ENVELOPE_MAX_CHARS &&
    /^\[Error\]/i.test(trimmed) &&
    !/[\r\n]/.test(trimmed)
  );
}

/**
 * A router that answers 200 with the upstream's error as the assistant text has
 * not answered. The envelope shape (`isErrorEnvelopeShape`) is required; then
 * either a usage block reporting zero tokens both ways or the upstream's own
 * server-error wording confirms it. The supported shapes are the table in
 * `reliability.test.ts`:
 *   - OpenAI's `[Error] An error occurred while processing your request. …
 *     help.openai.com … Please include the request ID <id> in your message.`,
 *     whatever the usage says;
 *   - any other one-line server error that names its request ID;
 *   - with a usage block that reports zero tokens both ways, any answer that
 *     opens with `[Error]`, one line or many.
 */
export function isUpstreamErrorEnvelope(text: string, usage?: EnvelopeUsage): boolean {
  if (!isErrorEnvelopeShape(text, usage)) return false;
  return (
    isZeroUsage(usage) ||
    /\brequest id\b/i.test(text) ||
    /help\.openai\.com/i.test(text) ||
    /error occurred while processing/i.test(text)
  );
}

/**
 * How long a retryable response's error body may take to arrive. The body only
 * informs the retry decision (a quoted upstream 4xx stops the retries), so a
 * router that sends its headers and then stalls must not hold every attempt for
 * the full `requestTimeoutMs`: ten attempts at 600 s each by default. After this
 * long the decision is made on what arrived.
 */
export const ERROR_BODY_READ_TIMEOUT_MS = 5_000;

/** The most of an error body that is ever read; the rest is cancelled unread. */
const ERROR_BODY_MAX_BYTES = 65_536;

/**
 * Read at most ERROR_BODY_MAX_BYTES of an error body, for at most
 * ERROR_BODY_READ_TIMEOUT_MS. What arrived before the cap, the deadline, an
 * abort or a stream error is kept, and the rest of the body is cancelled.
 *
 * Every error body goes through here, retryable or not: a non-retryable one is
 * what the classification and the text the user is shown are both read from, so
 * an unbounded read there is a socket held for as long as the provider sends.
 */
export async function readErrorBody(response: Response, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted || !response.body) return '';
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    // A body something else already locked has nothing left to read here.
    return '';
  }
  const decoder = new TextDecoder();
  let text = '';
  let received = 0;
  let finished = false;
  // Cancelling resolves the pending read as done, which ends the loop below.
  const stop = (): void => {
    reader.cancel().catch(() => {});
  };
  const timer = setTimeout(stop, ERROR_BODY_READ_TIMEOUT_MS);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    while (received < ERROR_BODY_MAX_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) {
        finished = true;
        break;
      }
      const bytes = chunk.value.subarray(0, ERROR_BODY_MAX_BYTES - received);
      received += bytes.byteLength;
      text += decoder.decode(bytes, { stream: true });
    }
  } catch {
    // A body that fails part-way still leaves what arrived before it.
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    if (!finished) stop();
    try {
      reader.releaseLock();
    } catch {
      // Nothing is pending once the loop has ended.
    }
  }
  return text + decoder.decode();
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retry: RetryConfig,
  signal?: AbortSignal,
  onRetry?: (attempt: number, max: number, delayMs: number) => void,
  logger?: RetryLogger,
  // The retry budget is a duration, so it reads the monotonic clock. On the
  // wall clock an NTP step or a resumed VM could hand a week-long run either
  // failure mode: a backwards correction makes the budget never expire and the
  // call retries forever, a forwards one exhausts it on the first attempt.
  clock: Clock = systemClock,
): Promise<Response> {
  const startMs = clock.monotonicNowMs();
  const maxAttempts = retry.watchdog ? Number.MAX_SAFE_INTEGER : retry.maxAttempts;
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    if (attempt > 0 && signal?.aborted) throw abortError(signal);
    const fetchSignal = requestSignal(signal, retry.requestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: fetchSignal });
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt >= maxAttempts || budgetExhausted(clock, startMs, retry.totalBudgetMs)) break;
      const delay = boundedDelay(clock, backoffMs(attempt, retry), startMs, retry.totalBudgetMs);
      logger?.warn('retry network error', {
        attempt: attempt + 1,
        delayMs: delay,
        error: lastError,
      });
      onRetry?.(attempt + 1, maxAttempts > 100 ? -1 : maxAttempts, delay);
      await sleep(delay, signal);
      continue;
    }

    const classification = classifyHttpStatus(response.status);
    if (!classification.retryable) return response;
    lastError = `API error ${response.status}`;

    const bodyText = await readErrorBody(response, signal);
    const quoted = quotedUpstreamStatus(bodyText);
    if (quoted !== undefined && !classifyHttpStatus(quoted).retryable) {
      logger?.warn('upstream error quoted in retryable status; not retrying', {
        status: response.status,
        upstreamStatus: quoted,
      });
      return new Response(bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    // A 429 that states the request itself is too large (OpenAI's per-minute cap on one request
    // that can never fit under it) is refused the same way however long the retries wait: the
    // loop's overflow recovery is what lets it through, so it gets the response now. Tested on
    // the same formatted text the loop reads, so a statement buried in `metadata.raw` — which
    // that text does not carry — leaves the retries running.
    if (
      response.status === 429 &&
      isOversizedForRateLimit(formatApiError(response.status, bodyText))
    ) {
      logger?.warn('rate limit on a request too large to ever fit; not retrying', {
        status: response.status,
      });
      return new Response(bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    const watchdogRetry = retry.watchdog && (response.status === 429 || response.status === 529);
    const effectiveMax = watchdogRetry ? Number.MAX_SAFE_INTEGER : maxAttempts;
    if (attempt >= effectiveMax || budgetExhausted(clock, startMs, retry.totalBudgetMs)) {
      return new Response(bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    const delay = boundedDelay(
      clock,
      backoffMs(attempt, retry, response.headers.get('retry-after')),
      startMs,
      retry.totalBudgetMs,
    );
    logger?.warn('retry http status', {
      attempt: attempt + 1,
      status: response.status,
      delayMs: delay,
    });
    onRetry?.(attempt + 1, watchdogRetry ? -1 : maxAttempts, delay);
    try {
      await sleep(delay, signal);
    } catch {
      return new Response(bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    try {
      await response.body?.cancel();
    } catch {
      // A custom fetch implementation may expose an already-locked body.
    }
  }

  throw new Error(lastError ?? 'request failed after retries');
}

export async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  stallTimeoutMs: number,
): Promise<
  | { tag: 'read'; done: boolean; value: Uint8Array | undefined }
  | { tag: 'stall' }
  | { tag: 'abort' }
> {
  if (signal?.aborted) return { tag: 'abort' };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      reader.read().then((result) => ({
        tag: 'read' as const,
        done: result.done,
        value: result.value,
      })),
      ...(stallTimeoutMs > 0
        ? [
            new Promise<{ tag: 'stall' }>((resolve) => {
              timeout = setTimeout(() => resolve({ tag: 'stall' }), stallTimeoutMs);
            }),
          ]
        : []),
      ...(signal
        ? [
            new Promise<{ tag: 'abort' }>((resolve) => {
              onAbort = () => resolve({ tag: 'abort' });
              signal.addEventListener('abort', onAbort, { once: true });
            }),
          ]
        : []),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

function requestSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal | undefined {
  if (timeoutMs <= 0) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Aborted');
}

/**
 * The message `errorBodyParts` reads, so the text shown and the text classified are the
 * same. A body with no message of its own (a nested `error.error.message`) or that is not
 * JSON shows its first characters instead.
 */
function safeErrorDetail(body: string): string {
  const { message, parsed } = errorBodyParts(body);
  if (parsed && message) return message.slice(0, 2000);
  return body.slice(0, 200);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal ? abortError(signal) : new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function backoffMs(attempt: number, retry: RetryConfig, retryAfter?: string | null): number {
  const retryAfterMs = parseRetryAfter(retryAfter);
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, retry.maxDelayMs);
  const exponential = Math.min(retry.baseDelayMs * 2 ** attempt, retry.maxDelayMs);
  return Math.round(exponential * (0.5 + Math.random()));
}

function parseRetryAfter(value?: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  // Wall clock on purpose, and the one place in this file that should be: the
  // server sent an HTTP date, which is a point on the wall clock by definition.
  // Subtracting a monotonic reading from it would be meaningless.
  return Math.max(0, timestamp - Date.now());
}

function budgetExhausted(clock: Clock, startMs: MonotonicMs, budgetMs: number): boolean {
  return budgetMs > 0 && clock.monotonicNowMs() - startMs >= budgetMs;
}

function boundedDelay(
  clock: Clock,
  delayMs: number,
  startMs: MonotonicMs,
  budgetMs: number,
): number {
  if (budgetMs <= 0) return delayMs;
  return Math.min(delayMs, Math.max(0, budgetMs - (clock.monotonicNowMs() - startMs)));
}
