import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpConnection } from './mcp.js';
import { McpSessionHost } from './mcp-host.js';
import { mcpServerFingerprint } from './mcp-approvals.js';
import { toolSuccess } from './tools/result.js';

const directories: string[] = [];

function fixture(): { workspace: string; home: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'book-mcp-host-workspace-'));
  const home = mkdtempSync(join(tmpdir(), 'book-mcp-host-home-'));
  directories.push(workspace, home);
  mkdirSync(join(home, '.book'), { recursive: true });
  return { workspace, home };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('McpSessionHost', () => {
  it('connects user servers and reports unexpected disconnects', async () => {
    const { workspace, home } = fixture();
    writeFileSync(
      join(home, '.book', 'mcp.json'),
      JSON.stringify({ mcpServers: { local: { command: 'node' } } }),
    );
    let closeFromTransport: (() => void) | undefined;
    const connection: McpConnection = {
      name: 'local',
      tools: [
        {
          name: 'echo',
          description: 'Echo',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      pending: new Map(),
      closed: false,
      stderr: '',
      client: {} as McpConnection['client'],
      close: vi.fn(async () => {}),
    };
    const connectServers = vi.fn(async (_workspace, options) => {
      closeFromTransport = () => {
        connection.closed = true;
        options.onConnectionClosed?.('local');
      };
      return {
        connections: [connection],
        tools: [
          {
            name: 'mcp__local__echo',
            description: 'Echo',
            parameters: { type: 'object', properties: {} },
            execute: async () => toolSuccess('ok'),
          },
        ],
      };
    });
    const host = new McpSessionHost(workspace, {}, { home, connectServers });

    host.start();
    await flush();
    expect(host.getSnapshot().servers[0]).toMatchObject({
      name: 'local',
      status: 'connected',
      toolCount: 1,
    });
    expect(host.getToolDefinitions().map((tool) => tool.name)).toEqual(['mcp__local__echo']);

    closeFromTransport?.();
    expect(host.getSnapshot().servers[0]).toMatchObject({
      status: 'disconnected',
      toolCount: 0,
    });
    expect(host.getSnapshot().events.at(-1)).toMatchObject({ type: 'disconnected', id: 2 });
    expect(host.getToolDefinitions()).toEqual([]);
    await host.dispose();
  });

  it('persists approve/reject decisions and connects only approved project servers', async () => {
    const { workspace, home } = fixture();
    const config = { type: 'http' as const, url: 'https://example.test/mcp', headers: {} };
    writeFileSync(join(workspace, '.mcp.json'), JSON.stringify({ mcpServers: { remote: config } }));
    const persistChoice = vi.fn(() => ({ ok: true as const }));
    const connection: McpConnection = {
      name: 'remote',
      tools: [],
      pending: new Map(),
      closed: false,
      stderr: '',
      client: {} as McpConnection['client'],
      close: vi.fn(async () => {}),
    };
    const connectServers = vi.fn(async () => ({ connections: [connection], tools: [] }));
    const host = new McpSessionHost(workspace, {}, { home, persistChoice, connectServers });

    host.start();
    expect(host.getSnapshot().pendingApprovals.map((server) => server.name)).toEqual(['remote']);
    expect(connectServers).not.toHaveBeenCalled();
    expect(host.approve('remote')).toEqual({ ok: true });
    expect(persistChoice).toHaveBeenCalledWith(
      workspace,
      'remote',
      mcpServerFingerprint(config),
      'approved',
    );
    await flush();
    expect(connectServers).toHaveBeenCalledOnce();
    expect(host.getSnapshot().servers[0].status).toBe('connected');
    await host.dispose();

    const rejectHost = new McpSessionHost(workspace, {}, { home, persistChoice, connectServers });
    rejectHost.start();
    expect(rejectHost.reject('remote')).toEqual({ ok: true });
    expect(rejectHost.getSnapshot().servers[0].status).toBe('rejected');
    expect(persistChoice).toHaveBeenLastCalledWith(
      workspace,
      'remote',
      mcpServerFingerprint(config),
      'rejected',
    );
    await rejectHost.dispose();
  });

  it('defers a project decision only for the current session', async () => {
    const { workspace, home } = fixture();
    writeFileSync(
      join(workspace, '.mcp.json'),
      JSON.stringify({ mcpServers: { remote: { command: 'node' } } }),
    );
    const persistChoice = vi.fn(() => ({ ok: true as const }));
    const host = new McpSessionHost(workspace, {}, { home, persistChoice });

    host.start();
    host.defer('remote');
    expect(host.getSnapshot().servers[0].status).toBe('deferred');
    expect(host.getSnapshot().pendingApprovals).toEqual([]);
    expect(persistChoice).not.toHaveBeenCalled();
    await host.dispose();
  });
});
