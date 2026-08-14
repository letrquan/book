import type { ChildProcess } from 'child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectMcpServers, disconnectMcpServers } from './mcp.js';
import type { McpDiagnostic } from './mcp-config.js';
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

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const item of fixtures.splice(0).reverse()) item.cleanup();
});

describe('MCP connection safety', () => {
  it('connects, discovers tools, and disconnects without pending work', async () => {
    const item = fixture({ fixture: 'success' });
    const result = await connectMcpServers(item.workspace, {
      home: item.workspace,
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
        home: item.workspace,
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
      home: item.workspace,
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
      home: item.workspace,
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
      home: item.workspace,
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
      home: item.workspace,
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
      home: item.workspace,
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
      home: item.workspace,
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

describe('MCP stdio transport lifecycle', () => {
  async function connectSuccess(overrides: Parameters<typeof connectMcpServers>[1] = {}) {
    const item = fixture({ fixture: 'success' });
    const diagnostics: McpDiagnostic[] = [];
    const closedServers: string[] = [];
    const changedServers: string[] = [];
    const result = await connectMcpServers(item.workspace, {
      home: item.workspace,
      initializationTimeoutMs: 500,
      requestTimeoutMs: 500,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      onConnectionClosed: (name) => closedServers.push(name),
      onToolListChanged: (name) => changedServers.push(name),
      ...overrides,
    });
    return { item, result, diagnostics, closedServers, changedServers };
  }

  const listChanged = { jsonrpc: '2.0', method: 'notifications/tools/list_changed' };

  function injectNotification(connection: { client: { transport?: unknown } }): void {
    const transport = connection.client.transport as {
      onmessage?: (message: unknown) => void;
    };
    transport.onmessage?.(listChanged);
  }

  it('reports a child-process error and tears the transport down', async () => {
    const { result, diagnostics, closedServers } = await connectSuccess();
    const connection = result.connections[0];
    const child = connection.process!;

    child.emit('error', new Error('spawn-boom'));

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].level).toBe('warn');
    expect(diagnostics[0].server).toBe('fixture');
    expect(diagnostics[0].message).toMatch(/spawn-boom/);
    expect(connection.closed).toBe(true);
    expect(closedServers).toEqual(['fixture']);
    await waitForExit(child);
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.stdout?.listenerCount('data') ?? 0).toBe(0);
  });

  it('ignores stdin stream errors and tears down once on child close', async () => {
    const { result, diagnostics, closedServers } = await connectSuccess();
    const connection = result.connections[0];
    const child = connection.process!;

    child.stdin!.emit('error', new Error('EPIPE'));
    expect(connection.closed).toBe(false);
    expect(diagnostics).toEqual([]);

    child.emit('close', 0, null);
    expect(connection.closed).toBe(true);
    expect(closedServers).toEqual(['fixture']);

    child.emit('close', 0, null);
    expect(closedServers).toEqual(['fixture']);
    await waitForExit(child);
  });

  it('rejects a request once the stdin pipe is destroyed', async () => {
    const { item, result } = await connectSuccess();
    const connection = result.connections[0];
    connection.process!.stdin!.destroy();

    const toolResult = await result.tools[0].execute(
      { value: 'x' },
      { workspaceRoot: item.workspace, env: {} },
    );

    expect(toolResult.status).toBe('error');
    expect(toolResult.structuredError?.message).toMatch(/stdin is closed/);
    await disconnectMcpServers(result.connections);
    await waitForExit(connection.process!);
  });

  it.each([
    ['an Error', new Error('sync-write-boom'), /sync-write-boom/],
    ['a non-Error', 'sync-write-string', /sync-write-string/],
  ])('rejects a request when stdin.write throws %s', async (_label, thrown, matcher) => {
    const { item, result } = await connectSuccess();
    const connection = result.connections[0];
    vi.spyOn(connection.process!.stdin!, 'write').mockImplementation((() => {
      throw thrown;
    }) as never);

    const toolResult = await result.tools[0].execute(
      { value: 'x' },
      { workspaceRoot: item.workspace, env: {} },
    );

    expect(toolResult.status).toBe('error');
    expect(toolResult.structuredError?.message).toMatch(matcher);
    vi.restoreAllMocks();
    await disconnectMcpServers(result.connections);
    await waitForExit(connection.process!);
  });

  it('marks an initialized connection closed when the server exits', async () => {
    const { result, closedServers } = await connectSuccess();
    const connection = result.connections[0];
    expect(connection.closed).toBe(false);

    connection.process!.kill();
    await waitFor(() => closedServers.length > 0, 'the disconnect callback');

    expect(closedServers).toEqual(['fixture']);
    expect(connection.closed).toBe(true);

    await disconnectMcpServers(result.connections);
    expect(closedServers).toEqual(['fixture']);
    await waitForExit(connection.process!);
  });

  it.each([
    ['an Error', new Error('boom'), /session: boom$/],
    ['a non-Error', 'boom-string', /session: boom-string$/],
  ])('warns when terminating the session rejects with %s', async (_label, thrown, matcher) => {
    const { result, diagnostics } = await connectSuccess();
    const connection = result.connections[0];
    const child = connection.process!;
    (
      connection.client.transport as unknown as { terminateSession?: () => Promise<void> }
    ).terminateSession = () => Promise.reject(thrown);

    await disconnectMcpServers(result.connections);

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].level).toBe('warn');
    expect(diagnostics[0].message).toMatch(matcher);
    expect(connection.closed).toBe(true);
    await waitForExit(child);
  });

  it('refreshes tools when the server reports a tool list change', async () => {
    const { result, changedServers } = await connectSuccess();
    const connection = result.connections[0];
    connection.tools = [];

    injectNotification(connection);
    injectNotification(connection);
    await waitFor(() => changedServers.length > 0, 'the tool-list-changed callback');

    expect(changedServers).toEqual(['fixture']);
    expect(connection.tools.map((tool) => tool.name)).toEqual(['echo']);

    const transport = connection.client.transport!;
    await disconnectMcpServers(result.connections);
    (transport as unknown as { onmessage?: (message: unknown) => void }).onmessage?.(listChanged);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changedServers).toEqual(['fixture']);
    await waitForExit(connection.process!);
  });

  it.each([
    ['an Error', new Error('boom'), /fixture": boom$/],
    ['a non-Error', 'boom-string', /fixture": boom-string$/],
  ])('warns when a tool-list refresh fails with %s', async (_label, thrown, matcher) => {
    const { result, diagnostics, changedServers } = await connectSuccess();
    const connection = result.connections[0];
    vi.spyOn(connection.client, 'listTools').mockRejectedValue(thrown);

    injectNotification(connection);
    await waitFor(() => diagnostics.length > 0, 'the refresh failure diagnostic');

    expect(diagnostics[0].level).toBe('warn');
    expect(diagnostics[0].server).toBe('fixture');
    expect(diagnostics[0].message).toMatch(matcher);
    expect(changedServers).toEqual([]);

    vi.restoreAllMocks();
    await disconnectMcpServers(result.connections);
    await waitForExit(connection.process!);
  });
});
