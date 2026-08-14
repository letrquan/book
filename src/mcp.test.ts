import { describe, expect, it, vi } from 'vitest';
import {
  buildMcpToolDefinitions,
  connectMcpServers,
  disconnectMcpServers,
  renderMcpContent,
  type McpConnection,
} from './mcp.js';
import type { McpDiagnostic, McpServerConfig } from './mcp-config.js';
import type { ToolContext } from './types/tools.js';

// File-scoped by design: `vi.mock` is hoisted, so this replaces the streamable
// HTTP transport for every test here. Only the teardown-failure test constructs
// one; a future test that needs the real transport belongs in a separate file.
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    protocolVersion: string | undefined = undefined;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: unknown) => void;
    start = vi.fn(async () => {
      throw 'boom-not-an-error';
    });
    send = async () => {};
    terminateSession = vi.fn(async () => {
      throw new Error('DELETE failed');
    });
    close = vi.fn(async () => {
      throw new Error('close failed');
    });
  },
}));

const context: ToolContext = { workspaceRoot: process.cwd(), env: {} };

function stubConnection(overrides: Partial<Record<string, unknown>> = {}): McpConnection {
  return {
    name: 'fake',
    client: {} as McpConnection['client'],
    tools: [],
    pending: new Map(),
    closed: false,
    stderr: '',
    redact: (message: string) => message,
    requestCounter: 0,
    close: async () => {},
    ...overrides,
  } as unknown as McpConnection;
}

describe('renderMcpContent', () => {
  it('renders image and audio blocks as placeholders', () => {
    expect(
      renderMcpContent({
        content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }, { type: 'audio' }],
      }),
    ).toEqual({ text: '[image: image/png]\n[audio]', isError: false });
  });

  it('renders resource links and falls back to unknown without a uri', () => {
    expect(
      renderMcpContent({
        content: [
          { type: 'resource_link', uri: 'file:///tmp/report.md', name: 'report' },
          { type: 'resource_link' },
        ],
      }).text,
    ).toBe('[resource_link: file:///tmp/report.md]\n[resource_link: unknown]');
  });

  it('prefers embedded resource text and skips resources with neither text nor uri', () => {
    expect(
      renderMcpContent({
        content: [
          { type: 'resource', resource: { uri: 'file:///a.txt', text: 'inline body' } },
          {
            type: 'resource',
            resource: { uri: 'file:///b.bin', mimeType: 'application/octet-stream' },
          },
          { type: 'resource', resource: { uri: 'file:///c.bin' } },
          { type: 'resource' },
        ],
      }).text,
    ).toBe(
      'inline body\n[resource: file:///b.bin (application/octet-stream)]\n[resource: file:///c.bin]',
    );
  });

  it('skips malformed blocks, non-string text, and unknown block types', () => {
    expect(
      renderMcpContent({
        content: [
          null,
          'a-string',
          42,
          { type: 'text', text: 42 },
          { type: 'wormhole', text: 'ignored' },
          { type: 'text', text: 'kept' },
        ],
      }),
    ).toEqual({ text: 'kept', isError: false });
  });

  it('treats a missing content array as empty and reports isError strictly', () => {
    expect(renderMcpContent({ isError: true })).toEqual({ text: '', isError: true });
    expect(renderMcpContent({ content: [], isError: 'yes' }).isError).toBe(false);
  });

  it('falls back to structuredContent only when no block produced text', () => {
    expect(renderMcpContent({ content: [], structuredContent: { rows: 2, ok: true } }).text).toBe(
      JSON.stringify({ rows: 2, ok: true }, null, 2),
    );
    expect(
      renderMcpContent({
        content: [{ type: 'text', text: 'primary' }],
        structuredContent: { r: 2 },
      }).text,
    ).toBe('primary');
    expect(renderMcpContent({ content: [] }).text).toBe('');
  });
});

describe('connectMcpServers configuration failures', () => {
  it('reports a remote server declared without a URL and applies default timeouts', async () => {
    const diagnostics: McpDiagnostic[] = [];
    const result = await connectMcpServers('/does-not-matter', {
      servers: { broken: { type: 'http' } as McpServerConfig },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(result).toEqual({ connections: [], tools: [] });
    expect(diagnostics).toEqual([
      {
        level: 'warn',
        message: 'Failed to connect to MCP server "broken": MCP server broken has no URL',
        server: 'broken',
      },
    ]);
  });

  it('rejects a stdio server with no command without spawning a process', async () => {
    const diagnostics: McpDiagnostic[] = [];
    const spawned: unknown[] = [];
    const result = await connectMcpServers(process.cwd(), {
      initializationTimeoutMs: 100,
      requestTimeoutMs: 100,
      servers: { broken: { type: 'stdio' } as McpServerConfig },
      onProcessSpawn: (_name, child) => spawned.push(child),
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(result.connections).toEqual([]);
    expect(spawned).toHaveLength(0);
    expect(diagnostics.map((d) => d.message)).toEqual([
      'Failed to connect to MCP server "broken": MCP server broken is not a stdio server',
    ]);
  });

  it('swallows teardown failures when the transport fails to start', async () => {
    const diagnostics: McpDiagnostic[] = [];
    const result = await connectMcpServers(process.cwd(), {
      initializationTimeoutMs: 100,
      requestTimeoutMs: 100,
      servers: { remote: { type: 'http', url: 'http://127.0.0.1:9/' } as McpServerConfig },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(result.connections).toEqual([]);
    expect(diagnostics[0]).toEqual({
      level: 'warn',
      message: 'Failed to connect to MCP server "remote": boom-not-an-error',
      server: 'remote',
    });
  });

  it('builds a legacy SSE transport and reports handshake failure', async () => {
    const diagnostics: McpDiagnostic[] = [];
    const result = await connectMcpServers(process.cwd(), {
      initializationTimeoutMs: 100,
      requestTimeoutMs: 100,
      servers: { legacy: { type: 'sse', url: 'http://127.0.0.1:1/sse' } as McpServerConfig },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(result.connections).toEqual([]);
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.map((d) => d.message).join('\n')).toContain(
      'Failed to connect to MCP server "legacy"',
    );
  });

  it.each([
    ['an Error', new Error('env exploded')],
    ['a non-Error', 'env exploded'],
  ])('reports %s thrown while reading a server config', async (_label, thrown) => {
    const diagnostics: McpDiagnostic[] = [];
    const hostile = {
      command: 'node',
      get env(): Record<string, string> {
        throw thrown;
      },
    } as unknown as McpServerConfig;

    const result = await connectMcpServers(process.cwd(), {
      servers: { hostile },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(result).toEqual({ connections: [], tools: [] });
    expect(diagnostics).toEqual([
      {
        level: 'warn',
        message: 'Failed to connect to MCP server "hostile": env exploded',
        server: 'hostile',
      },
    ]);
  });
});

describe('buildMcpToolDefinitions', () => {
  it('falls back to the tool name and an empty object schema', () => {
    const conn = stubConnection({
      tools: [{ name: 'solo', description: '', inputSchema: undefined }],
    });
    const [def] = buildMcpToolDefinitions([conn], 500);

    expect(def.name).toBe('mcp__fake__solo');
    expect(def.description).toBe('[MCP:fake] solo');
    expect(def.parameters).toEqual({ type: 'object', properties: {} });
  });

  it('reports a generic message when a server errors with no renderable content', async () => {
    const conn = stubConnection({
      client: { callTool: async () => ({ isError: true, content: [] }) },
      tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
    });
    const result = await buildMcpToolDefinitions([conn], 500)[0].execute({}, context);

    expect(result.status).toBe('error');
    expect(result.structuredError?.message).toBe(
      'MCP tool mcp__fake__echo failed: the server reported an error',
    );
    expect(result.structuredError?.code).toBe('mcp_tool_error');
  });

  it('redacts secrets and appends stderr when a call throws a non-Error', async () => {
    const conn = stubConnection({
      client: {
        callTool: async () => {
          throw 'token-abc123 exploded';
        },
      },
      tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object' } }],
      stderr: '  tail-line  ',
      redact: (message: string) => message.replaceAll('token-abc123', '<redacted>'),
    });
    const result = await buildMcpToolDefinitions([conn], 500)[0].execute({}, context);

    expect(result.status).toBe('error');
    expect(result.structuredError?.code).toBe('mcp_tool_failed');
    expect(result.structuredError?.message).toBe(
      'MCP tool mcp__fake__echo failed: <redacted> exploded (stderr: tail-line)',
    );
    expect(conn.pending.size).toBe(0);
  });
});

describe('disconnectMcpServers', () => {
  it('closes every connection even when one close() rejects', async () => {
    const close = vi.fn(async () => {
      throw new Error('close blew up');
    });
    const good = vi.fn(async () => {});
    const bad = stubConnection({ name: 'bad', close });
    const ok = stubConnection({ name: 'ok', close: good });

    await expect(disconnectMcpServers([bad, ok])).resolves.toBeUndefined();

    expect(close).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
    expect(bad.closed).toBe(true);
    expect(ok.closed).toBe(true);

    await disconnectMcpServers([bad, ok]);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
