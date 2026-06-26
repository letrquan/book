import { describe, it, expect, vi, beforeEach } from 'vitest';
import { webTools } from './web.js';
import type { ToolContext } from '../types.js';

const ctx: ToolContext = { workspaceRoot: '.', env: {} };

const fetchTool = webTools.find((t) => t.name === 'WebFetch')!;
const searchTool = webTools.find((t) => t.name === 'WebSearch')!;

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('WebFetch', () => {
  it('returns markdown-extracted content and honors the prompt hint', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const html =
          '<html><head><title>Example</title></head>' +
          '<body><h1>Hello World</h1><p>This is a test page.</p>' +
          '<script>ignore me</script></body></html>';
        return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
      }),
    );

    const r = await fetchTool.execute(
      { url: 'https://example.com/', prompt: 'summarize' },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/Hello World/);
    expect(r.output).toMatch(/test page/);
    // script content should be stripped
    expect(r.output).not.toMatch(/ignore me/);
  });

  it('fails on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Not Found', { status: 404 })),
    );
    const r = await fetchTool.execute({ url: 'https://example.com/x', prompt: 'x' }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/404/);
  });

  it('rejects non-http(s) schemes', async () => {
    const r = await fetchTool.execute({ url: 'file:///etc/passwd', prompt: 'x' }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/http/i);
  });
});

describe('WebSearch', () => {
  it('calls the configured search backend and returns results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            results: [
              { title: 'Result One', url: 'https://a.example.com', snippet: 'snippet a' },
              { title: 'Result Two', url: 'https://b.example.com', snippet: 'snippet b' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    const r = await searchTool.execute(
      { query: 'test query', backend: 'https://search.example.com/api' },
      ctx,
    );
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/Result One/);
    expect(r.output).toMatch(/Result Two/);
    expect(r.output).toMatch(/https:\/\/a\.example\.com/);
  });

  it('returns an error if no backend is configured', async () => {
    const r = await searchTool.execute({ query: 'test query' }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/no search backend/i);
  });
});
