import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runConfigCommand } from './config-cmd.js';
import { setExitFn } from './exit.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-config-cmd-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

interface RunResult {
  out: string;
  err: string;
  exitCode?: number;
}

async function set(key: string, value: string): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.map(String).join(' '));
  });
  const result: RunResult = { out: '', err: '' };
  class Exited extends Error {}
  setExitFn((code: number): never => {
    result.exitCode = code;
    throw new Exited();
  });
  try {
    await runConfigCommand(workspace, 'set', key, value);
  } catch (thrown) {
    if (!(thrown instanceof Exited)) throw thrown;
  } finally {
    setExitFn((code: number): never => process.exit(code));
    log.mockRestore();
    error.mockRestore();
  }
  result.out = out.join('\n');
  result.err = err.join('\n');
  return result;
}

const localSettings = () => join(workspace, '.book', 'settings.local.json');

/**
 * `config set` writes the workspace-local layer, and every key recording a
 * decision *about* the repository is stripped from that layer. Accepting the
 * write would print success and change nothing on the next load — the failure
 * mode a trust gate can least afford, since the user would believe they had
 * decided.
 */
describe('book config set refuses trust-owned keys', () => {
  it.each([
    ['commands.projectCommands', 'book trust command <name>'],
    ['hooks.projectEntries', 'book trust hook <fingerprint>'],
    ['permissions.projectAllowRules', 'book trust rule <rule>'],
  ])('refuses %s and names what records it instead', async (key, hint) => {
    const result = await set(
      key,
      JSON.stringify({ deploy: { fingerprint: 'a', choice: 'approved' } }),
    );

    expect(result.exitCode).toBe(1);
    expect(result.err).toContain(hint);
    expect(existsSync(localSettings())).toBe(false);
  });

  it('refuses mcp.projectServers, which has no subcommand yet', async () => {
    const result = await set('mcp.projectServers', '{}');

    expect(result.exitCode).toBe(1);
    expect(result.err).toContain('Approve the server when Book prompts for it.');
    expect(existsSync(localSettings())).toBe(false);
  });

  // Replacing the whole parent section is the same write by another route: the
  // nested key lands in the local layer, is stripped on load, and `config set`
  // reports success. Matching only the leaf path would have missed it.
  it.each([
    ['commands', { projectCommands: { deploy: { fingerprint: 'a', choice: 'approved' } } }],
    ['hooks', { projectEntries: { abc: 'approved' } }],
    ['permissions', { projectAllowRules: { 'Bash(ls *)': 'approved' } }],
    ['mcp', { projectServers: {} }],
  ])('refuses %s, which would carry the trust key inside it', async (key, value) => {
    const result = await set(key, JSON.stringify(value));

    expect(result.exitCode).toBe(1);
    expect(existsSync(localSettings())).toBe(false);
  });

  // And a path *below* the key reaches it just as well.
  it('refuses a path deeper than the trust key', async () => {
    const result = await set(
      'commands.projectCommands.deploy',
      JSON.stringify({ fingerprint: 'a', choice: 'approved' }),
    );

    expect(result.exitCode).toBe(1);
    expect(existsSync(localSettings())).toBe(false);
  });

  // The guard keys on the trust paths, not on their top-level sections: a
  // sibling under the same section stays writable.
  it('still writes a neighbouring key under the same top-level section', async () => {
    const result = await set('permissions.deny', '["Bash(rm *)"]');

    expect(result.exitCode).toBeUndefined();
    expect(result.out).toContain('Set permissions.deny');
    expect(existsSync(localSettings())).toBe(true);
  });
});
