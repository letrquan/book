import type { ToolDefinition, ToolContext, ToolResult } from '../types/tools.js';
import { toolFailure, toolSuccess } from './result.js';

const WEB_FETCH_MAX_BYTES = 256 * 1024;
const WEB_FETCH_MAX_CHARS = 20_000;
const WEB_SEARCH_MAX_BYTES = 512 * 1024;
const WEB_SEARCH_MAX_RESULTS = 10;
const WEB_SEARCH_FIELD_MAX_CHARS = 4_000;

interface LimitedResponseBody {
  text: string;
  truncated: boolean;
}

async function readResponseBody(
  response: Response,
  maxBytes: number,
): Promise<LimitedResponseBody> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new Error(`Response exceeds the ${maxBytes}-byte limit.`);
  }
  if (!response.body) return { text: '', truncated: false };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytesRead = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - bytesRead;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(decoder.decode(value.subarray(0, remaining), { stream: true }));
        }
        truncated = true;
        await reader.cancel();
        break;
      }
      bytesRead += value.byteLength;
      chunks.push(decoder.decode(value, { stream: true }));
      if (bytesRead === maxBytes) {
        const next = await reader.read();
        truncated = !next.done;
        if (truncated) await reader.cancel();
        break;
      }
    }
    chunks.push(decoder.decode());
    return { text: chunks.join(''), truncated };
  } finally {
    reader.releaseLock();
  }
}

function clipSearchField(value: string | undefined): string | undefined {
  if (value === undefined || value.length <= WEB_SEARCH_FIELD_MAX_CHARS) return value;
  return `${value.slice(0, WEB_SEARCH_FIELD_MAX_CHARS)}...(truncated)`;
}

/** Very small HTML-to-text converter: strips scripts/styles/tags, keeps text. */
function htmlToText(html: string): string {
  return (
    html
      // Remove script and style blocks entirely.
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      // Drop comments.
      .replace(/<!--[\s\S]*?-->/g, '')
      // Turn block-level closers into newlines so headings/paragraphs separate.
      .replace(
        /<\/(p|div|h[1-6]|li|ul|ol|tr|table|section|article|header|footer|nav|main|br)>/gi,
        '\n',
      )
      .replace(/<br\s*\/?>/gi, '\n')
      // Remove all remaining tags.
      .replace(/<[^>]+>/g, '')
      // Decode a few common entities.
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // Collapse runs of blank lines.
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

async function webFetch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const url = args.url as string;
  const prompt = (args.prompt as string) ?? 'Return the full content';

  if (!/^https?:\/\//i.test(url)) {
    return toolFailure(`URL must use http or https scheme: ${url}`, {
      code: 'invalid_url_scheme',
    });
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { 'User-Agent': 'book-agent/0.1 (+https://example.com/book)' },
      redirect: 'follow',
      signal: ctx.signal
        ? AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return toolFailure(`Fetch failed: ${e instanceof Error ? e.message : String(e)}`, {
      code: 'fetch_failed',
      retryable: true,
    });
  }

  if (!resp.ok) {
    return toolFailure(`HTTP ${resp.status} ${resp.statusText} for ${url}`, {
      code: 'http_error',
      retryable: resp.status >= 500,
      details: { status: resp.status, url },
    });
  }

  const contentType = resp.headers.get('content-type') ?? '';
  let body: LimitedResponseBody;
  try {
    body = await readResponseBody(resp, WEB_FETCH_MAX_BYTES);
  } catch (error) {
    return toolFailure(error instanceof Error ? error.message : String(error), {
      code: 'response_too_large',
      details: { url, maxBytes: WEB_FETCH_MAX_BYTES },
    });
  }
  const raw = body.text;
  const text = /html/i.test(contentType) ? htmlToText(raw) : raw;

  const wasTruncated = body.truncated || text.length > WEB_FETCH_MAX_CHARS;
  const truncated = wasTruncated ? `${text.slice(0, WEB_FETCH_MAX_CHARS)}\n...(truncated)` : text;

  return toolSuccess(`Fetched ${url} (prompt: ${prompt}).\n\n${truncated}`, {
    data: { url, prompt, truncated: wasTruncated },
  });
}

async function webSearch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const query = args.query as string;
  const backend =
    (args.backend as string | undefined) ||
    ctx.env.BOOK_SEARCH_BACKEND ||
    process.env.BOOK_SEARCH_BACKEND;

  if (!backend) {
    return toolFailure(
      'No search backend configured. Set BOOK_SEARCH_BACKEND in the host environment.',
      { code: 'search_backend_unconfigured' },
    );
  }

  let resp: Response;
  try {
    resp = await fetch(`${backend}?q=${encodeURIComponent(query)}`, {
      headers: { Accept: 'application/json' },
      signal: ctx.signal
        ? AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)])
        : AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return toolFailure(`Search request failed: ${e instanceof Error ? e.message : String(e)}`, {
      code: 'search_request_failed',
      retryable: true,
    });
  }

  if (!resp.ok) {
    return toolFailure(`Search backend returned ${resp.status}`, {
      code: 'search_backend_error',
      retryable: resp.status >= 500,
      details: { status: resp.status },
    });
  }

  try {
    const body = await readResponseBody(resp, WEB_SEARCH_MAX_BYTES);
    if (body.truncated) throw new Error('Search response exceeded the configured byte limit.');
    const data = JSON.parse(body.text) as {
      results?: Array<{ title?: string; url?: string; snippet?: string }>;
    };
    const results = (data.results ?? []).slice(0, WEB_SEARCH_MAX_RESULTS).map((result) => ({
      title: clipSearchField(result.title),
      url: clipSearchField(result.url),
      snippet: clipSearchField(result.snippet),
    }));
    if (results.length === 0) {
      return toolSuccess(`No results for: ${query}`, { data: { query, results } });
    }
    const out = results
      .map(
        (r, i) => `${i + 1}. ${r.title ?? '(untitled)'}\n   ${r.url ?? ''}\n   ${r.snippet ?? ''}`,
      )
      .join('\n\n');
    const omittedItems = Math.max(0, (data.results?.length ?? 0) - results.length);
    return toolSuccess(`Search: ${query}\n\n${out}`, {
      data: { query, results, truncated: omittedItems > 0 },
      pagination: { truncated: omittedItems > 0, omittedItems },
    });
  } catch {
    return toolFailure('Search backend returned non-JSON or malformed response', {
      code: 'invalid_search_response',
    });
  }
}

export const webTools: ToolDefinition[] = [
  {
    name: 'WebFetch',
    idempotent: true,
    description:
      'Fetch a URL over http(s) and return its text content (HTML is stripped to text). Use `prompt` to describe what to extract. 30s timeout; content truncated at 20k chars.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'http(s) URL to fetch' },
        prompt: {
          type: 'string',
          description: 'What to extract from the page (passed through as a hint)',
        },
      },
      required: ['url'],
    },
    execute: webFetch,
  },
  {
    name: 'WebSearch',
    idempotent: true,
    description:
      'Search the web via the host-configured BOOK_SEARCH_BACKEND. Returns titles, URLs, and snippets without allowing the model to select the backend.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
    execute: webSearch,
  },
];
