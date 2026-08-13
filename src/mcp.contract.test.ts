import type { ChildProcess } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectMcpServers, disconnectMcpServers } from './mcp.js';
import { createMcpStdioFixture, type McpStdioFixture } from './test/mcp-stdio-fixture.js';
import type { ToolContext } from './types/tools.js';

const fixtures: McpStdioFixture[] = [];

function fixture(servers: Parameters<typeof createMcpStdioFixture>[0]): McpStdioFixture {
  const item = createMcpStdioFixture(servers);
  fixtures.push(item);
  return item;
}

async function waitForExit(child: ChildProcess, timeoutMs = 1000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('MCP fixture did not exit')), timeoutMs),
    ),
  ]);
}

async function waitForPending(
  connection: Awaited<ReturnType<typeof connectMcpServers>>['connections'][number],
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (connection.pending.size > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('MCP request never entered the pending map');
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const item of fixtures.splice(0).reverse()) item.cleanup();
});

describe('MCP connection safety', () => {
  it('connects, discovers tools, and disconnects without pending work', async () => {
    const item = fixture({ fixture: 'success' });
    const result = await connectMcpServers(item.workspace, {
      initializationTimeoutMs: 500,
      requestTimeoutMs: 500,
    });

    expect(result.connections).toHaveLength(1);
    expect(result.connections[0].pending.size).toBe(0);
    expect(result.tools.map((tool) => tool.name)).toEqual(['mcp__fixture__echo']);

    const child = result.connections[0].process!;
    await disconnectMcpServers(result.connections);
    expect(result.connections[0].closed).toBe(true);
    expect(result.connections[0].pending.size).toBe(0);
    await waitForExit(child);
  });

  it.each(['silence', 'malformed', 'exit', 'crash'] as const)(
    'rejects the %s initialization mode within a bound',
    async (mode) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const item = fixture({ fixture: mode });
      const startedAt = Date.now();
      const spawned: ChildProcess[] = [];

      const result = await connectMcpServers(item.workspace, {
        initializationTimeoutMs: 50,
        requestTimeoutMs: 50,
        onProcessSpawn: (_name, child) => spawned.push(child),
      });

      expect(result.connections).toHaveLength(0);
      expect(spawned).toHaveLength(1);
      await waitForExit(spawned[0]);
      expect(spawned[0].exitCode !== null || spawned[0].signalCode !== null).toBe(true);
      expect(spawned[0].listenerCount('error')).toBe(0);
      expect(spawned[0].listenerCount('exit')).toBe(0);
      expect(spawned[0].listenerCount('close')).toBe(0);
      expect(spawned[0].stdin?.listenerCount('error') ?? 0).toBe(0);
      expect(spawned[0].stdout?.listenerCount('data') ?? 0).toBe(0);
      expect(spawned[0].stderr?.listenerCount('data') ?? 0).toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(1000);
    },
  );

  it('accepts delayed responses that arrive within the timeout', async () => {
    const item = fixture({ fixture: { mode: 'delay', delayMs: 20 } });
    const result = await connectMcpServers(item.workspace, {
      initializationTimeoutMs: 250,
      requestTimeoutMs: 250,
    });

    expect(result.connections).toHaveLength(1);
    expect(result.tools).toHaveLength(1);
    await disconnectMcpServers(result.connections);
    await waitForExit(result.connections[0].process!);
  });

  it('keeps healthy servers when another server is silent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const item = fixture({ healthy: 'success', silent: 'silence' });
    const result = await connectMcpServers(item.workspace, {
      // Two child processes can take longer to start on a loaded Windows runner.
      initializationTimeoutMs: 250,
      requestTimeoutMs: 250,
    });

    expect(result.connections.map((connection) => connection.name)).toEqual(['healthy']);
    expect(result.tools.map((tool) => tool.name)).toEqual(['mcp__healthy__echo']);
    await disconnectMcpServers(result.connections);
    await waitForExit(result.connections[0].process!);
  });

  it('clears pending requests on timeout', async () => {
    const item = fixture({ fixture: 'call-silence' });
    const result = await connectMcpServers(item.workspace, {
      initializationTimeoutMs: 250,
      requestTimeoutMs: 30,
    });
    const connection = result.connections[0];

    const toolResult = await result.tools[0].execute(
      { value: 'timeout' },
      { workspaceRoot: item.workspace, env: {} },
    );

    expect(toolResult.status).toBe('error');
    expect(toolResult.structuredError?.message).toMatch(/timed out/i);
    expect(connection.pending.size).toBe(0);
    await disconnectMcpServers(result.connections);
    await waitForExit(connection.process!);
  });

  it('bounds stderr context attached to request failures', async () => {
    const item = fixture({ fixture: 'stderr-call-silence' });
    const result = await connectMcpServers(item.workspace, {
      initializationTimeoutMs: 250,
      requestTimeoutMs: 30,
      maxStderrBytes: 16,
    });
    const connection = result.connections[0];

    const toolResult = await result.tools[0].execute(
      { value: 'stderr' },
      { workspaceRoot: item.workspace, env: {} },
    );

    expect(toolResult.status).toBe('error');
    expect(toolResult.structuredError?.message).toContain('stderr-tail');
    expect(connection.stderr.length).toBeLessThanOrEqual(16);
    await disconnectMcpServers(result.connections);
    await waitForExit(connection.process!);
  });

  it('clears pending requests on abort', async () => {
    const item = fixture({ fixture: 'call-silence' });
    const result = await connectMcpServers(item.workspace, {
      initializationTimeoutMs: 250,
      requestTimeoutMs: 500,
    });
    const connection = result.connections[0];
    const abortController = new AbortController();
    const context: ToolContext = {
      workspaceRoot: item.workspace,
      env: {},
      signal: abortController.signal,
    };
    const execution = result.tools[0].execute({ value: 'abort' }, context);
    await waitForPending(connection);

    abortController.abort();
    const toolResult = await execution;

    expect(toolResult.status).toBe('error');
    expect(toolResult.structuredError?.message).toMatch(/aborted/i);
    expect(connection.pending.size).toBe(0);
    await disconnectMcpServers(result.connections);
    await waitForExit(connection.process!);
  });

  it('settles a pending tool request exactly once on disconnect', async () => {
    const item = fixture({ fixture: 'call-silence' });
    const result = await connectMcpServers(item.workspace, {
      initializationTimeoutMs: 250,
      requestTimeoutMs: 500,
    });
    const connection = result.connections[0];
    const execution = result.tools[0].execute(
      { value: 'disconnect' },
      { workspaceRoot: item.workspace, env: {} },
    );
    await waitForPending(connection);

    await disconnectMcpServers(result.connections);
    await disconnectMcpServers(result.connections);
    const toolResult = await execution;

    expect(toolResult.status).toBe('error');
    expect(toolResult.structuredError?.message).toMatch(/disconnected/i);
    expect(connection.pending.size).toBe(0);
    expect(connection.closed).toBe(true);
    await waitForExit(connection.process!);
  });
});
