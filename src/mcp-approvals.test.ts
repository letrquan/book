import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateMcpServerApproval,
  mcpServerFingerprint,
  mcpServersToRecord,
  partitionMcpServersByApproval,
  persistMcpProjectServerChoice,
} from './mcp-approvals.js';
import { resolveMcpServerList, type ResolvedMcpServer } from './mcp-config.js';
import type { McpProjectServerChoice } from './settings.js';

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function server(overrides: Partial<ResolvedMcpServer> = {}): ResolvedMcpServer {
  return {
    name: 'github',
    source: 'project',
    path: '/repo/.mcp.json',
    config: { command: 'npx', args: ['-y', 'server-github'], env: { A: '1' } },
    ...overrides,
  };
}

describe('mcpServerFingerprint', () => {
  it('is stable across env key ordering and changes when the command changes', () => {
    const a = mcpServerFingerprint({ command: 'npx', args: ['x'], env: { A: '1', B: '2' } });
    const b = mcpServerFingerprint({ command: 'npx', args: ['x'], env: { B: '2', A: '1' } });
    const c = mcpServerFingerprint({
      command: 'npx',
      args: ['x', '--evil'],
      env: { A: '1', B: '2' },
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('covers remote transport, URL, cwd, and secret header values without exposing them', () => {
    const secret = 'private-bearer-token';
    const base = {
      type: 'http' as const,
      url: 'https://example.test/mcp',
      headers: { Authorization: secret, 'X-Tenant': 'one' },
    };
    const reordered = {
      ...base,
      headers: { 'X-Tenant': 'one', Authorization: secret },
    };
    const changedSecret = {
      ...base,
      headers: { ...base.headers, Authorization: 'different-token' },
    };

    const fingerprint = mcpServerFingerprint(base);
    expect(fingerprint).toBe(mcpServerFingerprint(reordered));
    expect(fingerprint).not.toBe(mcpServerFingerprint(changedSecret));
    expect(fingerprint).not.toBe(mcpServerFingerprint({ ...base, type: 'sse' }));
    expect(fingerprint).not.toBe(
      mcpServerFingerprint({ command: 'node', cwd: 'one', type: 'stdio' }),
    );
    expect(fingerprint).not.toContain(secret);
  });
});

describe('evaluateMcpServerApproval', () => {
  it('always approves user-global servers', () => {
    expect(evaluateMcpServerApproval({}, server({ source: 'user' }))).toBe('approved');
  });

  it('treats project servers without a recorded choice as unknown', () => {
    expect(evaluateMcpServerApproval({}, server())).toBe('unknown');
  });

  it('honors a recorded choice only while the fingerprint matches', () => {
    const target = server();
    const fingerprint = mcpServerFingerprint(target.config);
    const settings = {
      mcp: { projectServers: { github: { fingerprint, choice: 'approved' as const } } },
    };
    expect(evaluateMcpServerApproval(settings, target)).toBe('approved');

    const changed = server({ config: { ...target.config, args: ['-y', 'other'] } });
    expect(evaluateMcpServerApproval(settings, changed)).toBe('unknown');
  });

  it('honors a recorded rejection', () => {
    const target = server();
    const fingerprint = mcpServerFingerprint(target.config);
    const settings = {
      mcp: { projectServers: { github: { fingerprint, choice: 'rejected' as const } } },
    };
    expect(evaluateMcpServerApproval(settings, target)).toBe('rejected');
  });
});

describe('partitionMcpServersByApproval', () => {
  it('splits servers into allowed, pending, and rejected', () => {
    const user = server({ name: 'user-server', source: 'user' });
    const unknown = server({ name: 'fresh' });
    const rejected = server({ name: 'blocked' });
    const settings = {
      mcp: {
        projectServers: {
          blocked: {
            fingerprint: mcpServerFingerprint(rejected.config),
            choice: 'rejected' as const,
          },
        },
      },
    };
    const partition = partitionMcpServersByApproval([user, unknown, rejected], settings);
    expect(partition.allowed.map((s) => s.name)).toEqual(['user-server']);
    expect(partition.pending.map((s) => s.name)).toEqual(['fresh']);
    expect(partition.rejected.map((s) => s.name)).toEqual(['blocked']);
    expect(mcpServersToRecord(partition.allowed)).toEqual({ 'user-server': user.config });
  });

  it('keeps a project server pending when it shadows a trusted user-global name', () => {
    const home = tempDir('book-mcp-home-');
    const workspace = tempDir('book-mcp-ws-');
    mkdirSync(join(home, '.book'), { recursive: true });
    writeFileSync(
      join(home, '.book', 'mcp.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'trusted-command' } } }),
    );
    writeFileSync(
      join(workspace, '.mcp.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'repo-command' } } }),
    );

    const servers = resolveMcpServerList(workspace, { home });
    expect(servers).toHaveLength(1);
    expect(servers[0].source).toBe('project');
    expect(servers[0].config.command).toBe('repo-command');

    const partition = partitionMcpServersByApproval(servers, {});
    expect(partition.allowed).toHaveLength(0);
    expect(partition.pending.map((s) => s.name)).toEqual(['shared']);
  });
});
describe('persistMcpProjectServerChoice', () => {
  function readServers(storePath: string): Record<string, McpProjectServerChoice> {
    const parsed = JSON.parse(readFileSync(storePath, 'utf-8')) as {
      workspaces: Record<string, { mcpServers: Record<string, McpProjectServerChoice> }>;
    };
    const entries = Object.values(parsed.workspaces);
    expect(entries).toHaveLength(1);
    return entries[0].mcpServers;
  }

  it('writes the decision to the trust store and evaluate honors it', () => {
    const workspace = tempDir('book-mcp-persist-');
    const storePath = join(tempDir('book-mcp-home-'), 'trust.json');
    const target = server();
    const fingerprint = mcpServerFingerprint(target.config);

    const result = persistMcpProjectServerChoice(workspace, target.name, fingerprint, 'approved', {
      trustStorePath: storePath,
    });
    expect(result.ok).toBe(true);

    const written = readServers(storePath);
    expect(written[target.name]).toEqual({ fingerprint, choice: 'approved' });
    expect(evaluateMcpServerApproval({ mcp: { projectServers: written } }, target)).toBe(
      'approved',
    );

    expect(
      persistMcpProjectServerChoice(workspace, target.name, fingerprint, 'rejected', {
        trustStorePath: storePath,
      }).ok,
    ).toBe(true);
    expect(readServers(storePath)[target.name].choice).toBe('rejected');
  });

  // Decisions accumulate: recording one must not revoke the ones before it.
  it('preserves decisions made earlier', () => {
    const workspace = tempDir('book-mcp-preserve-');
    const storePath = join(tempDir('book-mcp-home-'), 'trust.json');

    persistMcpProjectServerChoice(workspace, 'github', 'abc123', 'approved', {
      trustStorePath: storePath,
    });
    persistMcpProjectServerChoice(workspace, 'linear', 'def456', 'rejected', {
      trustStorePath: storePath,
    });

    expect(readServers(storePath)).toEqual({
      github: { fingerprint: 'abc123', choice: 'approved' },
      linear: { fingerprint: 'def456', choice: 'rejected' },
    });
  });

  // Nothing lands inside the workspace, so a repository can neither read the
  // decision back nor ship one of its own in a clone.
  it('writes nothing inside the workspace', () => {
    const workspace = tempDir('book-mcp-outside-');
    const storePath = join(tempDir('book-mcp-home-'), 'trust.json');

    persistMcpProjectServerChoice(workspace, 'github', 'abc123', 'approved', {
      trustStorePath: storePath,
    });

    expect(existsSync(join(workspace, '.book', 'settings.local.json'))).toBe(false);
  });
});
