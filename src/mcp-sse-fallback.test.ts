import { describe, expect, it, vi } from 'vitest';
import { connectMcpServers } from './mcp.js';
import type { McpDiagnostic, McpServerConfig } from './mcp-config.js';

/**
 * Lives in its own file because `vi.mock` is hoisted and file-scoped: mcp.test.ts
 * already replaces this transport with one that fails in a different way.
 *
 * A legacy SSE endpoint answers the Streamable HTTP handshake with 405, and
 * `book mcp add <name> <url>` always infers `http` from the URL. Without the
 * retry the server simply looks broken, and `--transport sse` is not something a
 * user can be expected to guess.
 */
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    protocolVersion: string | undefined = undefined;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: unknown) => void;
    start = vi.fn(async () => {
      throw new Error('Error POSTing to endpoint (HTTP 405): Method Not Allowed');
    });
    send = async () => {};
    close = vi.fn(async () => {});
  },
}));

describe('legacy SSE fallback', () => {
  async function connect(config: McpServerConfig): Promise<McpDiagnostic[]> {
    const diagnostics: McpDiagnostic[] = [];
    await connectMcpServers(process.cwd(), {
      initializationTimeoutMs: 100,
      requestTimeoutMs: 100,
      servers: { legacy: config },
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    return diagnostics;
  }

  it('retries as SSE when the server rejects Streamable HTTP', async () => {
    const messages = (await connect({ type: 'http', url: 'http://127.0.0.1:1/sse' })).map(
      (diagnostic) => diagnostic.message,
    );
    expect(messages.join('\n')).toContain('rejected Streamable HTTP; retrying as legacy SSE');
    // Two attempts, not one: the second failure is the SSE transport reaching a
    // dead port, which is proof the retry actually ran.
    expect(messages.filter((message) => message.includes('Failed to connect'))).toHaveLength(2);
  });

  it('does not retry a server already declared as SSE', async () => {
    const messages = (await connect({ type: 'sse', url: 'http://127.0.0.1:1/sse' })).map(
      (diagnostic) => diagnostic.message,
    );
    expect(messages.join('\n')).not.toContain('retrying as legacy SSE');
  });

  it('does not retry a stdio server', async () => {
    const messages = (await connect({ command: 'definitely-not-a-real-binary' })).map(
      (diagnostic) => diagnostic.message,
    );
    expect(messages.join('\n')).not.toContain('retrying as legacy SSE');
  });
});
