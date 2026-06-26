import type { ToolDefinition, ToolContext, ToolResult } from '../types.js';

/** Very small HTML-to-text converter: strips scripts/styles/tags, keeps text. */
function htmlToText(html: string): string {
  return html
    // Remove script and style blocks entirely.
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Drop comments.
    .replace(/<!--[\s\S]*?-->/g, '')
    // Turn block-level closers into newlines so headings/paragraphs separate.
    .replace(/<\/(p|div|h[1-6]|li|ul|ol|tr|table|section|article|header|footer|nav|main|br)>/gi, '\n')
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
    .trim();
}

async function webFetch(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const url = args.url as string;
  const prompt = (args.prompt as string) ?? 'Return the full content';

  if (!/^https?:\/\//i.test(url)) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: `URL must use http or https scheme: ${url}`,
    };
  }

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { 'User-Agent': 'book-agent/0.1 (+https://example.com/book)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: `Fetch failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!resp.ok) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: `HTTP ${resp.status} ${resp.statusText} for ${url}`,
    };
  }

  const contentType = resp.headers.get('content-type') ?? '';
  const raw = await resp.text();
  const text = /html/i.test(contentType) ? htmlToText(raw) : raw;

  // Truncate to keep tool output manageable; the model can ask for more via Read on a saved file.
  const MAX = 20000;
  const truncated = text.length > MAX ? text.slice(0, MAX) + '\n…(truncated)' : text;

  return {
    toolCallId: '',
    success: true,
    output: `Fetched ${url} (prompt: ${prompt}).\n\n${truncated}`,
  };
}

async function webSearch(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const query = args.query as string;
  // Backend is chosen per-call, else env, else a global default — pluggable.
  const backend =
    (args.backend as string | undefined) ||
    ctx.env.BOOK_SEARCH_BACKEND ||
    process.env.BOOK_SEARCH_BACKEND;

  if (!backend) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: 'No search backend configured. Set BOOK_SEARCH_BACKEND or pass `backend`.',
    };
  }

  let resp: Response;
  try {
    resp = await fetch(`${backend}?q=${encodeURIComponent(query)}`, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: `Search request failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!resp.ok) {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: `Search backend returned ${resp.status}`,
    };
  }

  try {
    const data = (await resp.json()) as { results?: Array<{ title?: string; url?: string; snippet?: string }> };
    const results = data.results ?? [];
    if (results.length === 0) {
      return { toolCallId: '', success: true, output: `No results for: ${query}` };
    }
    const out = results
      .map((r, i) => `${i + 1}. ${r.title ?? '(untitled)'}\n   ${r.url ?? ''}\n   ${r.snippet ?? ''}`)
      .join('\n\n');
    return { toolCallId: '', success: true, output: `Search: ${query}\n\n${out}` };
  } catch {
    return {
      toolCallId: '',
      success: false,
      output: '',
      error: 'Search backend returned non-JSON or malformed response',
    };
  }
}

export const webTools: ToolDefinition[] = [
  {
    name: 'WebFetch',
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
    description:
      'Search the web via a configured backend. Set BOOK_SEARCH_BACKEND env or pass `backend`. Backend should return JSON {results:[{title,url,snippet}]}.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        backend: { type: 'string', description: 'Override search backend URL for this call' },
      },
      required: ['query'],
    },
    execute: webSearch,
  },
];
