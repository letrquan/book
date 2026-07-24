import { describe, it, expect, vi, beforeEach } from 'vitest';
import { webTools } from './web.js';
import type { ToolContext } from '../types/tools.js';

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

    const r = await fetchTool.execute({ url: 'https://example.com/', prompt: 'summarize' }, ctx);
    expect(r.status).toBe('success');
    expect(r.content).toMatch(/Hello World/);
    expect(r.content).toMatch(/test page/);
    // script content should be stripped
    expect(r.content).not.toMatch(/ignore me/);
  });

  it('fails on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Not Found', { status: 404 })),
    );
    const r = await fetchTool.execute({ url: 'https://example.com/x', prompt: 'x' }, ctx);
    expect(r.status).toBe('error');
    expect(r.structuredError?.message).toMatch(/404/);
  });

  it('rejects non-http(s) schemes', async () => {
    const r = await fetchTool.execute({ url: 'file:///etc/passwd', prompt: 'x' }, ctx);
    expect(r.status).toBe('error');
    expect(r.structuredError?.message).toMatch(/http/i);
  });

  it('rejects declared responses above the byte limit without reading the body', async () => {
    const cancel = vi.fn(async () => undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const response = new Response('ignored', {
          status: 200,
          headers: { 'content-length': String(300 * 1024) },
        });
        Object.defineProperty(response, 'body', {
          configurable: true,
          value: { cancel },
        });
        return response;
      }),
    );

    const result = await fetchTool.execute({ url: 'https://example.com/large' }, ctx);

    expect(result.status).toBe('error');
    expect(result.structuredError?.message).toContain('262144-byte limit');
    expect(cancel).toHaveBeenCalled();
  });
});

describe('WebSearch', () => {
  it('calls the configured search backend and returns results', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
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
    expect(r.status).toBe('success');
    expect(r.content).toMatch(/Result One/);
    expect(r.content).toMatch(/Result Two/);
    expect(r.content).toMatch(/https:\/\/a\.example\.com/);
  });

  it('returns an error if no backend is configured', async () => {
    const r = await searchTool.execute({ query: 'test query' }, ctx);
    expect(r.status).toBe('error');
    expect(r.structuredError?.message).toMatch(/no search backend/i);
  });

  it('limits result count and field sizes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          results: Array.from({ length: 15 }, (_, index) => ({
            title: `Result ${index}`,
            url: `https://example.com/${index}`,
            snippet: 'x'.repeat(5_000),
          })),
        }),
      ),
    );

    const result = await searchTool.execute(
      { query: 'bounded', backend: 'https://search.example.com/api' },
      ctx,
    );

    expect((result.data as { results: unknown[] }).results).toHaveLength(10);
    expect(result.pagination).toMatchObject({ truncated: true, omittedItems: 5 });
    expect(result.content.length).toBeLessThan(50_000);
  });
});
