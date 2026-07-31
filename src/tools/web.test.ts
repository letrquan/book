import { describe, expect, it, vi } from 'vitest';
import type { ToolContext, ToolDefinition } from '../types/tools.js';
import { createRegistry } from './registry.js';
import { TOOL_RESULT_MAX_BYTES, toolResultModelContent } from './result.js';
import { createWebTools } from './web.js';

const publicResolver = vi.fn(async () => ['93.184.216.34']);

function context(env: Record<string, string> = {}): ToolContext {
  return { workspaceRoot: '.', env };
}

function findTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find((definition) => definition.name === name);
  if (!tool) throw new Error(`Missing ${name}`);
  return tool;
}

function toolsFor(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  resolver = publicResolver,
): { fetchTool: ToolDefinition; searchTool: ToolDefinition } {
  const tools = createWebTools({
    fetch: fetchImpl,
    resolveHostname: resolver,
    now: () => new Date('2026-07-31T00:00:00.000Z'),
  });
  return {
    fetchTool: findTool(tools, 'WebFetch'),
    searchTool: findTool(tools, 'WebSearch'),
  };
}

describe('WebFetch', () => {
  it('converts HTML to markdown, strips active content, and returns provenance', async () => {
    const fetchImpl = vi.fn(async () => {
      const html =
        '<html><head><title>Example</title></head>' +
        '<body><h1>Hello World</h1><p>This is a <a href="/test">test page</a>.</p>' +
        '<script>ignore me</script></body></html>';
      return new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });
    const { fetchTool } = toolsFor(fetchImpl);

    const result = await fetchTool.execute(
      { url: 'https://example.com/', prompt: 'summarize' },
      context(),
    );

    expect(result.status).toBe('success');
    expect(result.content).toContain('# Hello World');
    expect(result.content).toContain('[test page](/test)');
    expect(result.content).toContain('Title: Example');
    expect(result.content).toContain('Retrieved: 2026-07-31T00:00:00.000Z');
    expect(result.content).not.toContain('ignore me');
    expect(result.content).not.toContain('prompt: summarize');
    expect(result.data).toMatchObject({
      requestedUrl: 'https://example.com/',
      finalUrl: 'https://example.com/',
      title: 'Example',
      format: 'markdown',
      prompt: 'summarize',
      truncated: false,
    });
  });

  it('returns plain text when requested', async () => {
    const { fetchTool } = toolsFor(
      vi.fn(async () =>
        Response.json('<h1>not html json</h1>', {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );

    const result = await fetchTool.execute(
      { url: 'https://example.com/data', format: 'text' },
      context(),
    );

    expect(result.status).toBe('success');
    expect(result.content).toContain('"<h1>not html json</h1>"');
  });

  it('fails on a non-2xx response', async () => {
    const { fetchTool } = toolsFor(vi.fn(async () => new Response('Not Found', { status: 404 })));
    const result = await fetchTool.execute({ url: 'https://example.com/x' }, context());

    expect(result.status).toBe('error');
    expect(result.structuredError?.message).toMatch(/404/);
  });

  it('rejects non-http schemes and plain HTTP by default', async () => {
    const fetchImpl = vi.fn(async () => new Response('unused'));
    const { fetchTool } = toolsFor(fetchImpl);

    const fileResult = await fetchTool.execute({ url: 'file:///etc/passwd' }, context());
    const httpResult = await fetchTool.execute({ url: 'http://example.com/' }, context());

    expect(fileResult.structuredError?.code).toBe('invalid_url_scheme');
    expect(httpResult.structuredError?.code).toBe('insecure_http_url');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows HTTP only when the host opts in', async () => {
    const fetchImpl = vi.fn(async () => new Response('allowed'));
    const { fetchTool } = toolsFor(fetchImpl);

    const result = await fetchTool.execute(
      { url: 'http://example.com/' },
      context({ BOOK_WEB_ALLOW_HTTP: 'true' }),
    );

    expect(result.status).toBe('success');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('blocks hostnames that resolve to private addresses', async () => {
    const fetchImpl = vi.fn(async () => new Response('unused'));
    const resolver = vi.fn(async () => ['127.0.0.1']);
    const { fetchTool } = toolsFor(fetchImpl, resolver);

    const result = await fetchTool.execute({ url: 'https://example.com/' }, context());

    expect(result.status).toBe('error');
    expect(result.structuredError?.code).toBe('private_network_forbidden');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('blocks cross-origin redirects before contacting the new origin', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://other.example/path' },
        }),
    );
    const { fetchTool } = toolsFor(fetchImpl);

    const result = await fetchTool.execute({ url: 'https://example.com/start' }, context());

    expect(result.status).toBe('blocked');
    expect(result.structuredError?.code).toBe('cross_origin_redirect');
    expect(result.structuredError?.remediation).toContain('https://other.example/path');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('follows bounded same-origin redirects and reports the final URL', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: '/docs' } }))
      .mockResolvedValueOnce(
        new Response('<main><h1>Docs</h1></main>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      );
    const { fetchTool } = toolsFor(fetchImpl);

    const result = await fetchTool.execute({ url: 'https://example.com/start' }, context());

    expect(result.status).toBe('success');
    expect(result.data).toMatchObject({
      finalUrl: 'https://example.com/docs',
      redirects: ['https://example.com/docs'],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('stops after the host-configured same-origin redirect limit', async () => {
    const fetchImpl = vi.fn(async (_input: string, _init?: RequestInit) =>
      Promise.resolve(new Response(null, { status: 302, headers: { location: '/next' } })),
    );
    const { fetchTool } = toolsFor(fetchImpl);

    const result = await fetchTool.execute(
      { url: 'https://example.com/start' },
      context({ BOOK_WEB_MAX_REDIRECTS: '1' }),
    );

    expect(result.structuredError?.code).toBe('redirect_limit_exceeded');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('removes active elements, event handlers, and unsafe URLs from sanitized HTML', async () => {
    const html =
      '<html><head><title>Safe</title><meta http-equiv="refresh" content="0"></head>' +
      '<body onload="steal()" style="display:none">' +
      '<a href="javascript:steal()" onclick="steal()">bad</a>' +
      '<a href="https://safe.example/path" target="_blank">safe</a>' +
      '<form action="https://evil.example"><input name="secret"></form>' +
      '<img src="https://tracker.example/pixel" onerror="steal()" alt="diagram">' +
      '</body></html>';
    const { fetchTool } = toolsFor(
      vi.fn(async () => new Response(html, { headers: { 'content-type': 'text/html' } })),
    );

    const result = await fetchTool.execute(
      { url: 'https://example.com/', format: 'html' },
      context(),
    );

    expect(result.status).toBe('success');
    expect(result.content).toContain('<a>bad</a>');
    expect(result.content).toContain('<a href="https://safe.example/path">safe</a>');
    expect(result.content).toContain('alt="diagram"');
    expect(result.content).not.toMatch(
      /javascript:|onload|onclick|onerror|style=|<meta|<form|<input|tracker\.example/i,
    );
  });

  it('streams only the configured byte limit and marks the response truncated', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('x'.repeat(300 * 1024), {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            'content-length': String(300 * 1024),
          },
        }),
    );
    const { fetchTool } = toolsFor(fetchImpl);

    const result = await fetchTool.execute({ url: 'https://example.com/large' }, context());

    expect(result.status).toBe('success');
    expect(result.data).toMatchObject({ bytes: 256 * 1024, truncated: true });
    expect(result.pagination).toMatchObject({ truncated: true, omittedBytes: 44 * 1024 });
    expect(result.content).toContain('Response truncated after 262144 bytes');
  });

  it('does not discard content at the legacy 20k-character boundary', async () => {
    const body = 'x'.repeat(30_000);
    const { fetchTool } = toolsFor(
      vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/plain' } })),
    );

    const result = await fetchTool.execute({ url: 'https://example.com/long' }, context());

    expect(result.status).toBe('success');
    expect(result.content.length).toBeGreaterThan(30_000);
    expect(result.data).toMatchObject({ bytes: 30_000, truncated: false });
  });

  it('lets the shared provider-facing output bound clip large fetched text', async () => {
    const body = 'x'.repeat(80_000);
    const { fetchTool } = toolsFor(
      vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/plain' } })),
    );

    const result = await fetchTool.execute({ url: 'https://example.com/long' }, context());
    const modelContent = toolResultModelContent(result);

    expect(result.content.length).toBeGreaterThan(80_000);
    expect(Buffer.byteLength(modelContent)).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    expect(modelContent).toContain(`Output truncated at ${TOOL_RESULT_MAX_BYTES} bytes`);
  });

  it('rejects binary response types', async () => {
    const { fetchTool } = toolsFor(
      vi.fn(
        async () =>
          new Response(new Uint8Array([0, 1, 2]), {
            headers: { 'content-type': 'application/octet-stream' },
          }),
      ),
    );

    const result = await fetchTool.execute({ url: 'https://example.com/file' }, context());

    expect(result.structuredError?.code).toBe('unsupported_content_type');
  });
});

describe('WebSearch', () => {
  it('uses the built-in Exa MCP search first without configuration', async () => {
    const fetchImpl = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        Response.json(
          { result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {} } },
          { headers: { 'mcp-session-id': 'session-1' } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({
          result: {
            content: [
              {
                type: 'text',
                text: '1. [Built-in result](https://example.com/result)\n   Search context',
              },
            ],
          },
        }),
      );
    const { searchTool } = toolsFor(fetchImpl);

    const result = await searchTool.execute(
      {
        query: 'test query',
        limit: 3,
        domains: ['example.com'],
        recencyDays: 30,
        country: 'vn',
      },
      context(),
    );

    expect(result.status).toBe('success');
    expect(result.content).toContain('Built-in result');
    expect(result.content).toContain('Provider: Exa Web Search');
    expect(result.data).toMatchObject({ provider: 'exa', source: 'builtin' });
    const [requestedUrl, init] = fetchImpl.mock.calls[0];
    const url = new URL(requestedUrl);
    expect(url.origin + url.pathname).toBe('https://mcp.exa.ai/mcp');
    expect([...url.searchParams]).toEqual([]);
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    });
    expect(init?.headers).not.toHaveProperty('Authorization');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const initializeRequest = JSON.parse(fetchImpl.mock.calls[0][1]?.body as string) as {
      method: string;
      params: { protocolVersion: string };
    };
    expect(initializeRequest.method).toBe('initialize');
    expect(initializeRequest.params.protocolVersion).toBe('2024-11-05');
    expect((fetchImpl.mock.calls[1][1]?.headers as Record<string, string>)['Mcp-Session-Id']).toBe(
      'session-1',
    );
    expect(fetchImpl.mock.calls[2][1]?.headers as Record<string, string>).toMatchObject({
      'MCP-Protocol-Version': '2024-11-05',
      'Mcp-Session-Id': 'session-1',
    });
    const searchRequest = JSON.parse(fetchImpl.mock.calls[2][1]?.body as string) as {
      method: string;
      params: { name: string; arguments: Record<string, unknown> };
    };
    expect(searchRequest.method).toBe('tools/call');
    expect(searchRequest.params.name).toBe('web_search_exa');
    expect(searchRequest.params.arguments).toMatchObject({
      type: 'auto',
      numResults: 3,
      livecrawl: 'fallback',
      contextMaxCharacters: 12_000,
    });
    expect(searchRequest.params.arguments.query).toBe(
      'test query site:example.com after:2026-07-01 country:vn',
    );
  });

  it('accepts MCP server-sent event responses from the built-in provider', async () => {
    const initialize = Response.json(
      { result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {} } },
      { headers: { 'mcp-session-id': 'session-sse' } },
    );
    const payload = JSON.stringify({
      result: { content: [{ type: 'text', text: 'SSE search result' }] },
    });
    const { searchTool } = toolsFor(
      vi.fn(async (_input, init) => {
        const request = JSON.parse(init?.body as string) as { method: string };
        if (request.method === 'initialize') return initialize;
        if (request.method === 'notifications/initialized')
          return new Response(null, { status: 202 });
        return new Response(`event: message\ndata: ${payload}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        });
      }),
    );

    const result = await searchTool.execute({ query: 'streamed search' }, context());

    expect(result.status).toBe('success');
    expect(result.content).toContain('SSE search result');
  });

  it('treats MCP tool-level errors as provider failures and falls back', async () => {
    const fetchImpl = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        Response.json(
          { result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {} } },
          { headers: { 'mcp-session-id': 'exa-tool-error' } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({
          result: {
            isError: true,
            content: [{ type: 'text', text: 'Exa search quota is exhausted.' }],
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {} } },
          { headers: { 'mcp-session-id': 'parallel-tool-error' } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({
          result: { content: [{ type: 'text', text: 'Parallel recovered result' }] },
        }),
      );
    const { searchTool } = toolsFor(fetchImpl);

    const result = await searchTool.execute({ query: 'tool error fallback' }, context());

    expect(result.status).toBe('success');
    expect(result.data).toMatchObject({ provider: 'parallel' });
    expect(result.content).toContain('Parallel recovered result');
    expect(result.content).not.toContain('Exa search quota is exhausted.');
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('falls back when a provider returns a malformed MCP initialization response', async () => {
    const fetchImpl = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json({ result: {} }))
      .mockResolvedValueOnce(
        Response.json(
          { result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {} } },
          { headers: { 'mcp-session-id': 'parallel-malformed' } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({
          result: { content: [{ type: 'text', text: 'Recovered from malformed Exa response' }] },
        }),
      );
    const { searchTool } = toolsFor(fetchImpl);

    const result = await searchTool.execute({ query: 'fallback search' }, context());

    expect(result.status).toBe('success');
    expect(result.data).toMatchObject({ provider: 'parallel' });
    expect(result.content).toContain('Recovered from malformed Exa response');
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('falls back when a provider response exceeds the search byte limit', async () => {
    const fetchImpl = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        Response.json(
          { result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {} } },
          { headers: { 'mcp-session-id': 'exa-oversized' } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({
          result: { content: [{ type: 'text', text: 'x'.repeat(600 * 1024) }] },
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {} } },
          { headers: { 'mcp-session-id': 'parallel-oversized' } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({
          result: { content: [{ type: 'text', text: 'Bounded fallback result' }] },
        }),
      );
    const { searchTool } = toolsFor(fetchImpl);

    const result = await searchTool.execute({ query: 'large response search' }, context());

    expect(result.status).toBe('success');
    expect(result.data).toMatchObject({ provider: 'parallel' });
    expect(result.content).toContain('Bounded fallback result');
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('does not try another provider after cancellation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const fetchImpl = vi.fn(async () => {
      throw controller.signal.reason;
    });
    const { searchTool } = toolsFor(fetchImpl);

    const result = await searchTool.execute(
      { query: 'cancelled search' },
      { ...context(), signal: controller.signal },
    );

    expect(result.status).toBe('cancelled');
    expect(result.structuredError?.code).toBe('cancelled');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('falls back to Parallel and keeps rate-limited Exa in cooldown', async () => {
    const fetchImpl = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        Response.json(
          { result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {} } },
          { headers: { 'mcp-session-id': 'session-limited' } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json(
          {
            jsonrpc: '2.0',
            error: { code: -32000, message: "You've hit Exa's free MCP rate limit." },
            id: null,
          },
          { status: 429, headers: { 'retry-after': '120' } },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {} } },
          { headers: { 'mcp-session-id': 'parallel-1' } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({
          result: {
            content: [{ type: 'text', text: 'Parallel fallback result' }],
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: {} } },
          { headers: { 'mcp-session-id': 'parallel-2' } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        Response.json({
          result: {
            content: [{ type: 'text', text: 'Parallel result while Exa cools down' }],
          },
        }),
      );
    const { searchTool } = toolsFor(fetchImpl);

    const fallback = await searchTool.execute(
      { query: 'limited search', limit: 4, domains: ['example.com'] },
      context(),
    );
    const duringCooldown = await searchTool.execute({ query: 'next search' }, context());

    expect(fallback.status).toBe('success');
    expect(fallback.content).toContain('Parallel fallback result');
    expect(fallback.content).toContain('Provider: Parallel Web Search');
    expect(fallback.data).toMatchObject({ provider: 'parallel', source: 'builtin' });
    expect(duringCooldown.status).toBe('success');
    expect(duringCooldown.content).toContain('Parallel result while Exa cools down');
    expect(fetchImpl).toHaveBeenCalledTimes(9);

    const providerUrls = fetchImpl.mock.calls.map(([input]) => new URL(input).hostname);
    expect(providerUrls.slice(0, 3)).toEqual(['mcp.exa.ai', 'mcp.exa.ai', 'mcp.exa.ai']);
    expect(providerUrls.slice(3)).toEqual(Array(6).fill('search.parallel.ai'));

    const parallelRequest = JSON.parse(fetchImpl.mock.calls[5][1]?.body as string) as {
      params: { name: string; arguments: Record<string, unknown> };
    };
    expect(fetchImpl.mock.calls[4][1]?.headers as Record<string, string>).toMatchObject({
      'MCP-Protocol-Version': '2024-11-05',
      'Mcp-Session-Id': 'parallel-1',
    });
    expect(fetchImpl.mock.calls[5][1]?.headers as Record<string, string>).toMatchObject({
      'MCP-Protocol-Version': '2024-11-05',
      'Mcp-Session-Id': 'parallel-1',
    });
    expect(parallelRequest.params.name).toBe('web_search');
    expect(parallelRequest.params.arguments).toEqual({
      objective: 'Find and summarize no more than 4 web results that answer: limited search',
      search_queries: ['limited search site:example.com'],
    });
  });

  it('reports every provider when all built-in searches are unavailable', async () => {
    const fetchImpl = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(
        Response.json(
          {
            jsonrpc: '2.0',
            error: { code: -32000, message: "You've hit Exa's free MCP rate limit." },
            id: null,
          },
          { status: 429, headers: { 'retry-after': '60' } },
        ),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: 'Parallel is temporarily unavailable.' } },
          { status: 503 },
        ),
      );
    const { searchTool } = toolsFor(fetchImpl);

    const result = await searchTool.execute({ query: 'unavailable search' }, context());

    expect(result.structuredError).toMatchObject({
      code: 'search_all_providers_failed',
      retryable: true,
      details: {
        attempts: [
          {
            provider: 'exa',
            status: 'failed',
            code: 'search_provider_error',
            retryAfterMs: 60_000,
          },
          {
            provider: 'parallel',
            status: 'failed',
            code: 'search_provider_error',
          },
        ],
      },
    });
    expect(result.structuredError?.message).toContain("You've hit Exa's free MCP rate limit.");
    expect(result.structuredError?.message).toContain('Parallel is temporarily unavailable.');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects blank queries and malformed domain filters before calling the backend', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ result: { content: [] } }));
    const { searchTool } = toolsFor(fetchImpl);
    const ctx = context();

    const blank = await searchTool.execute({ query: '   ' }, ctx);
    const invalidDomain = await searchTool.execute(
      { query: 'test', domains: ['example..com'] },
      ctx,
    );

    expect(blank.structuredError?.code).toBe('invalid_search_query');
    expect(invalidDomain.structuredError?.code).toBe('invalid_search_domain');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects model attempts to override the backend through registry validation', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ result: { content: [] } }));
    const registry = createRegistry();
    registry.registerAll(createWebTools({ fetch: fetchImpl, resolveHostname: publicResolver }));

    const result = await registry.execute(
      {
        id: 'search-override',
        name: 'WebSearch',
        arguments: {
          query: 'test',
          backend: 'https://model-selected.example/api',
        },
      },
      context(),
    );

    expect(result.structuredError?.code).toBe('invalid_arguments');
    expect(result.structuredError?.message).toContain('arguments.backend is not allowed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
