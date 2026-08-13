import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runMcpAddCommand,
  runMcpGetCommand,
  runMcpListCommand,
  runMcpRemoveCommand,
} from './mcp.js';

const directories: string[] = [];
let previousToken: string | undefined;

function fixture(): { workspace: string; home: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'book-mcp-cli-workspace-'));
  const home = mkdtempSync(join(tmpdir(), 'book-mcp-cli-home-'));
  directories.push(workspace, home);
  return { workspace, home };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  if (previousToken === undefined) delete process.env.MCP_TOKEN;
  else process.env.MCP_TOKEN = previousToken;
});

describe('book mcp commands', () => {
  it('adds, lists, gets, replaces, and removes a user stdio server', () => {
    const { workspace, home } = fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    previousToken = process.env.MCP_TOKEN;
    process.env.MCP_TOKEN = 'configured-for-test';

    runMcpAddCommand('local', 'node', ['server.js'], {
      workspace,
      home,
      env: ['TOKEN=${MCP_TOKEN}'],
      cwd: 'tools',
    });

    const path = join(home, '.book', 'mcp.json');
    const written = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(written.mcpServers.local).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['server.js'],
      env: { TOKEN: '${MCP_TOKEN}' },
      cwd: 'tools',
    });

    runMcpListCommand({ workspace, home });
    runMcpGetCommand('local', { workspace, home });
    expect(log.mock.calls.flat().join('\n')).toContain('local: node server.js');

    expect(() => runMcpAddCommand('local', 'other', [], { workspace, home })).toThrow(
      /already exists/i,
    );
    runMcpAddCommand('local', 'other', [], { workspace, home, force: true });
    runMcpRemoveCommand('local', { workspace, home });
    const removed = JSON.parse(readFileSync(path, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(removed.mcpServers).toEqual({});
  });

  it('adds a project HTTP server while keeping header values out of list/get output', () => {
    const { workspace, home } = fixture();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const secret = 'remote-cli-secret';

    runMcpAddCommand('remote', 'https://example.test/mcp', [], {
      workspace,
      home,
      scope: 'project',
      transport: 'http',
      header: [`Authorization=Bearer ${secret}`],
    });
    expect(readFileSync(join(workspace, '.mcp.json'), 'utf8')).toContain(secret);

    runMcpListCommand({ workspace, home });
    runMcpGetCommand('remote', { workspace, home, json: true });
    const output = log.mock.calls.flat().join('\n');
    expect(output).toContain('Authorization');
    expect(output).toContain('project: unknown');
    expect(output).not.toContain(secret);
  });

  it('rejects invalid names, scopes, transports, and incompatible options', () => {
    const { workspace, home } = fixture();
    expect(() => runMcpAddCommand('bad__name', 'node', [], { workspace, home })).toThrow(
      /names may contain/i,
    );
    expect(() =>
      runMcpAddCommand('server', 'node', [], {
        workspace,
        home,
        scope: 'shared' as 'user',
      }),
    ).toThrow(/scope/i);
    expect(() =>
      runMcpAddCommand('server', 'https://example.test', [], {
        workspace,
        home,
        transport: 'websocket' as 'http',
      }),
    ).toThrow(/transport/i);
    expect(() =>
      runMcpAddCommand('server', 'https://example.test', [], {
        workspace,
        home,
        env: ['TOKEN=x'],
      }),
    ).toThrow(/only for stdio/i);
  });

  it('refuses to overwrite malformed configuration', () => {
    const { workspace, home } = fixture();
    const configPath = join(home, '.book', 'mcp.json');
    mkdirSync(join(home, '.book'), { recursive: true });
    writeFileSync(configPath, '{invalid-json');

    expect(() => runMcpAddCommand('server', 'node', [], { workspace, home })).toThrow(
      /cannot update/i,
    );
    expect(readFileSync(configPath, 'utf8')).toBe('{invalid-json');
  });
});
