import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  TRUST_STORE_VERSION,
  defaultTrustStorePath,
  loadWorkspaceTrust,
  updateWorkspaceTrust,
} from './workspace-trust.js';

let home: string;
let workspace: string;
let storePath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'book-trust-home-'));
  workspace = mkdtempSync(join(tmpdir(), 'book-trust-ws-'));
  storePath = join(home, 'trust.json');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
});

describe('defaultTrustStorePath', () => {
  it('lives beside the other user-global state, never in the workspace', () => {
    expect(defaultTrustStorePath('/somewhere')).toBe(join('/somewhere', '.book', 'trust.json'));
  });
});

describe('loadWorkspaceTrust', () => {
  it('reports no decisions when the store does not exist', () => {
    expect(loadWorkspaceTrust(workspace, storePath)).toEqual({
      permissionAllowRules: {},
      mcpServers: {},
      hookEntries: {},
      projectCommands: {},
      projectDirectories: {},
    });
  });

  // Fail closed. Anything the store cannot vouch for withholds the gated input
  // rather than releasing it, so a damaged file cannot approve a hook.
  it.each([
    ['unparseable JSON', '{not json'],
    ['a JSON array', '[]'],
    ['a non-object workspaces key', '{"version":1,"workspaces":[]}'],
    ['an off-schema decision', '{"version":1,"workspaces":{"*":{"hookEntries":{"a":"maybe"}}}}'],
  ])('records no decisions for %s', (_label, contents) => {
    mkdirSync(home, { recursive: true });
    writeFileSync(storePath, contents);

    expect(loadWorkspaceTrust(workspace, storePath).hookEntries).toEqual({});
  });

  it('reads back what was recorded for this workspace', () => {
    const realDir = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-trust-dir-')));
    try {
      updateWorkspaceTrust(
        workspace,
        (trust) => {
          trust.hookEntries.abc123 = 'approved';
          trust.permissionAllowRules['Bash(ls *)'] = 'rejected';
          trust.mcpServers.github = { fingerprint: 'def456', choice: 'approved' };
          trust.projectCommands.deploy = { fingerprint: 'ghi789', choice: 'approved' };
          // A directory decision is keyed by the real path, so two spellings of one directory
          // are one decision — see `additional-roots.ts`.
          trust.projectDirectories[realDir] = 'approved';
        },
        storePath,
      );

      expect(loadWorkspaceTrust(workspace, storePath)).toEqual({
        hookEntries: { abc123: 'approved' },
        permissionAllowRules: { 'Bash(ls *)': 'rejected' },
        mcpServers: { github: { fingerprint: 'def456', choice: 'approved' } },
        projectCommands: { deploy: { fingerprint: 'ghi789', choice: 'approved' } },
        projectDirectories: { [realDir]: 'approved' },
      });
    } finally {
      rmSync(realDir, { recursive: true, force: true });
    }
  });

  it('keeps one workspace out of another', () => {
    const other = mkdtempSync(join(tmpdir(), 'book-trust-other-'));
    try {
      updateWorkspaceTrust(other, (trust) => (trust.hookEntries.abc123 = 'approved'), storePath);

      expect(loadWorkspaceTrust(workspace, storePath).hookEntries).toEqual({});
      expect(loadWorkspaceTrust(other, storePath).hookEntries).toEqual({ abc123: 'approved' });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('updateWorkspaceTrust', () => {
  it('stamps the format version it wrote', () => {
    updateWorkspaceTrust(workspace, (trust) => (trust.hookEntries.a = 'approved'), storePath);

    const written = JSON.parse(readFileSync(storePath, 'utf-8')) as { version: number };
    expect(written.version).toBe(TRUST_STORE_VERSION);
  });

  // Recording one decision must not disturb any other, in this workspace or in
  // any other project the user has ever answered for.
  it('leaves every other decision untouched', () => {
    const other = mkdtempSync(join(tmpdir(), 'book-trust-other-'));
    try {
      updateWorkspaceTrust(other, (trust) => (trust.hookEntries.theirs = 'approved'), storePath);
      updateWorkspaceTrust(workspace, (trust) => (trust.hookEntries.mine = 'approved'), storePath);
      updateWorkspaceTrust(workspace, (trust) => (trust.hookEntries.later = 'rejected'), storePath);

      expect(loadWorkspaceTrust(workspace, storePath).hookEntries).toEqual({
        mine: 'approved',
        later: 'rejected',
      });
      expect(loadWorkspaceTrust(other, storePath).hookEntries).toEqual({ theirs: 'approved' });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  // A store this version cannot parse might hold decisions it would destroy.
  it('refuses to write over a store it could not read', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(storePath, '{not json');

    const result = updateWorkspaceTrust(
      workspace,
      (trust) => (trust.hookEntries.a = 'approved'),
      storePath,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not valid JSON');
    expect(readFileSync(storePath, 'utf-8')).toBe('{not json');
  });

  it('refuses to write over a store from a newer Book', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(storePath, JSON.stringify({ version: TRUST_STORE_VERSION + 1, workspaces: {} }));

    const result = updateWorkspaceTrust(
      workspace,
      (trust) => (trust.hookEntries.a = 'approved'),
      storePath,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain('newer version of Book');
  });

  it('rejects a value that is not a decision', () => {
    const result = updateWorkspaceTrust(
      workspace,
      (trust) => ((trust.hookEntries as Record<string, string>).a = 'maybe'),
      storePath,
    );

    expect(result.ok).toBe(false);
  });
});
