import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatMcpServerCommand,
  resolveMcpServerList,
  type McpDiagnostic,
  type McpServerConfig,
} from './mcp-config.js';

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function writeConfig(path: string, mcpServers: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify({ mcpServers }));
}

function resolveFixture(
  userServers: Record<string, unknown>,
  projectServers: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = {},
): { servers: ReturnType<typeof resolveMcpServerList>; diagnostics: McpDiagnostic[] } {
  const home = tempDir('book-mcp-config-home-');
  const workspace = tempDir('book-mcp-config-workspace-');
  mkdirSync(join(home, '.book'), { recursive: true });
  writeConfig(join(home, '.book', 'mcp.json'), userServers);
  writeConfig(join(workspace, '.mcp.json'), projectServers);
  const diagnostics: McpDiagnostic[] = [];
  const servers = resolveMcpServerList(workspace, {
    home,
    env,
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
  });
  return { servers, diagnostics };
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveMcpServerList', () => {
  it('normalizes legacy and explicit stdio configurations', () => {
    const { servers, diagnostics } = resolveFixture({
      legacy: { command: 'node', args: ['server.js'], env: { MODE: 'safe' } },
      explicit: { type: 'stdio', command: 'npx', args: ['-y', 'pkg'], cwd: 'tools' },
    });

    expect(diagnostics).toEqual([]);
    expect(servers.map(({ name, config }) => [name, config])).toEqual([
      [
        'legacy',
        {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: { MODE: 'safe' },
        },
      ],
      ['explicit', { type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: {}, cwd: 'tools' }],
    ]);
  });

  it('normalizes Streamable HTTP and legacy SSE configurations', () => {
    const { servers, diagnostics } = resolveFixture({
      remote: {
        type: 'http',
        url: 'https://mcp.example.test/rpc',
        headers: { Authorization: 'Bearer test' },
      },
      legacySse: { transport: 'SSE', url: 'http://127.0.0.1:4312/events' },
    });

    expect(diagnostics).toEqual([]);
    expect(servers.map((server) => server.config)).toEqual([
      {
        type: 'http',
        url: 'https://mcp.example.test/rpc',
        headers: { Authorization: 'Bearer test' },
      },
      { type: 'sse', url: 'http://127.0.0.1:4312/events', headers: {} },
    ]);
  });

  it('lets a project declaration override a same-named user server with project provenance', () => {
    const { servers } = resolveFixture(
      { shared: { command: 'trusted-user-command' }, userOnly: { command: 'user-command' } },
      { shared: { type: 'http', url: 'https://project.example.test/mcp' } },
    );

    expect(servers).toHaveLength(2);
    expect(servers.find((server) => server.name === 'shared')).toMatchObject({
      source: 'project',
      config: { type: 'http', url: 'https://project.example.test/mcp' },
    });
    expect(servers.find((server) => server.name === 'userOnly')?.source).toBe('user');
  });

  it('expands variables and fallbacks without evaluating shell syntax', () => {
    const { servers, diagnostics } = resolveFixture(
      {
        local: {
          command: '${NODE_BIN}',
          args: ['${PACKAGE:-fallback-package}', '$(not-executed)'],
          cwd: '${WORK_DIR}',
          env: { TOKEN: '${TOKEN_VALUE}' },
        },
        remote: {
          url: '${MCP_URL}',
          headers: { Authorization: 'Bearer ${ACCESS_TOKEN}' },
        },
      },
      {},
      {
        NODE_BIN: 'node',
        WORK_DIR: 'mcp-workdir',
        TOKEN_VALUE: 'token-value',
        MCP_URL: 'https://example.test/mcp',
        ACCESS_TOKEN: 'remote-secret',
      },
    );

    expect(diagnostics).toEqual([]);
    expect(servers[0].config).toMatchObject({
      command: 'node',
      args: ['fallback-package', '$(not-executed)'],
      cwd: 'mcp-workdir',
      env: { TOKEN: 'token-value' },
    });
    expect(servers[1].config.headers).toEqual({ Authorization: 'Bearer remote-secret' });
  });

  it.each([
    ['missing variable', { command: '${MISSING}' }, /missing environment variable.*MISSING/i],
    [
      'unsupported type',
      { type: 'websocket', url: 'https://example.test' },
      /unsupported transport/i,
    ],
    ['relative URL', { type: 'http', url: '/mcp' }, /valid absolute URL/i],
    [
      'URL credentials',
      { type: 'http', url: 'https://user:pass@example.test/mcp' },
      /credentials/i,
    ],
    ['unsafe server name', { command: 'node' }, /invalid MCP server name/i],
  ])('rejects %s configurations', (label, config, expected) => {
    const name = label === 'unsafe server name' ? 'bad__name' : 'invalid';
    const { servers, diagnostics } = resolveFixture({ [name]: config });

    expect(servers).toEqual([]);
    expect(diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toMatch(expected);
  });

  it('never renders header values in connection descriptions or validation diagnostics', () => {
    const secret = 'super-secret-header-value';
    const config: McpServerConfig = {
      type: 'http',
      url: 'https://example.test/mcp?access_token=query-secret',
      headers: { Authorization: secret, 'X-Tenant': 'acme' },
    };
    const formatted = formatMcpServerCommand(config);
    const { diagnostics } = resolveFixture({
      bad: { type: 'http', url: 'not-a-url', headers: { Authorization: secret } },
    });
    const messages = diagnostics.map((diagnostic) => diagnostic.message).join('\n');

    expect(formatted).toContain('Authorization');
    expect(formatted).toContain('X-Tenant');
    expect(formatted).toContain('query configured');
    expect(formatted).not.toContain(secret);
    expect(formatted).not.toContain('query-secret');
    expect(messages).not.toContain(secret);
  });
});
