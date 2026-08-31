import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runConfigCommand } from './config-cmd.js';
import { setExitFn } from './exit.js';
import type { SettingsScope } from '../settings-scope.js';

let workspace: string;
let bookHome: string;
let previousBookHome: string | undefined;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-config-cmd-'));
  // The user layer resolves through BOOK_HOME, so a test that writes it has to
  // own one; without this the suite would write the developer's real settings.
  bookHome = mkdtempSync(join(tmpdir(), 'book-config-home-'));
  previousBookHome = process.env.BOOK_HOME;
  process.env.BOOK_HOME = bookHome;
});

afterEach(() => {
  if (previousBookHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = previousBookHome;
  rmSync(workspace, { recursive: true, force: true });
  rmSync(bookHome, { recursive: true, force: true });
});

interface RunResult {
  out: string;
  err: string;
  exitCode?: number;
}

async function run(
  action: string,
  key?: string,
  value?: string,
  scope?: SettingsScope,
): Promise<RunResult> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.map(String).join(' '));
  });
  const error = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    err.push(args.map(String).join(' '));
  });
  // Node's console.warn is its own function, not an alias of error, so a
  // shadowing notice would go uncaptured and the assertion would pass vacuously.
  const warn = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    err.push(args.map(String).join(' '));
  });
  const result: RunResult = { out: '', err: '' };
  class Exited extends Error {}
  setExitFn((code: number): never => {
    result.exitCode = code;
    throw new Exited();
  });
  try {
    await runConfigCommand(workspace, action, key, value, { scope });
  } catch (thrown) {
    if (!(thrown instanceof Exited)) throw thrown;
  } finally {
    setExitFn((code: number): never => process.exit(code));
    log.mockRestore();
    error.mockRestore();
    warn.mockRestore();
  }
  result.out = out.join('\n');
  result.err = err.join('\n');
  return result;
}

async function set(key: string, value: string, scope?: SettingsScope): Promise<RunResult> {
  return run('set', key, value, scope);
}

const localSettings = () => join(workspace, '.book', 'settings.local.json');
const projectSettings = () => join(workspace, '.book', 'settings.json');
const userSettings = () => join(bookHome, 'settings.json');
const readJson = (path: string) =>
  JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;

function writeSettings(path: string, contents: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf-8');
}

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
    expect(existsSync(userSettings())).toBe(false);
    expect(existsSync(localSettings())).toBe(false);
  });

  it('refuses mcp.projectServers, which has no subcommand yet', async () => {
    const result = await set('mcp.projectServers', '{}');

    expect(result.exitCode).toBe(1);
    expect(result.err).toContain('Approve the server when Book prompts for it.');
    expect(existsSync(userSettings())).toBe(false);
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
    expect(existsSync(userSettings())).toBe(false);
  });

  // And a path *below* the key reaches it just as well.
  it('refuses a path deeper than the trust key', async () => {
    const result = await set(
      'commands.projectCommands.deploy',
      JSON.stringify({ fingerprint: 'a', choice: 'approved' }),
    );

    expect(result.exitCode).toBe(1);
    expect(existsSync(userSettings())).toBe(false);
  });

  // The guard keys on the trust paths, not on their top-level sections: a
  // sibling under the same section stays writable.
  it('still writes a neighbouring key under the same top-level section', async () => {
    const result = await set('permissions.deny', '["Bash(rm *)"]');

    expect(result.exitCode).toBeUndefined();
    expect(result.out).toContain('Set permissions.deny');
    expect(existsSync(userSettings())).toBe(true);
  });

  it.each(['user', 'project', 'local'] as const)(
    'refuses a trust-owned key in the %s scope too, since no scope is read for it',
    async (scope) => {
      const result = await set('hooks.projectEntries', '{"abc":"approved"}', scope);

      expect(result.exitCode).toBe(1);
      expect(result.err).toContain('book trust hook');
      expect(existsSync(userSettings())).toBe(false);
      expect(existsSync(projectSettings())).toBe(false);
      expect(existsSync(localSettings())).toBe(false);
    },
  );

  /**
   * The capability gate is that no ordinary configuration command enables an
   * experimental flag. Defaulting writes to the user layer made `config set`
   * *able* to write the one file the flag is read from, so the refusal has to
   * cover the user scope explicitly or the gate is gone.
   */
  it.each(['user', 'project', 'local'] as const)(
    'refuses to write experimental capability flags in the %s scope',
    async (scope) => {
      const result = await set('experimental.zeroMem', 'true', scope);

      expect(result.exitCode).toBe(1);
      expect(result.err).toContain('cannot be written');
      expect(existsSync(userSettings())).toBe(false);
      expect(existsSync(projectSettings())).toBe(false);
      expect(existsSync(localSettings())).toBe(false);
    },
  );

  /**
   * Writing here would be worse than a no-op: the value lands in a file the
   * loader strips, so the user believes they configured a credential source
   * that is in fact ignored.
   */
  it('refuses to write auth settings to workspace-local settings', async () => {
    const result = await set('auth.profiles.anthropic.clientId', '"client-123"');

    expect(result.exitCode).toBe(1);
    expect(result.err).toContain('cannot be written');
    expect(result.err).toContain('BOOK_AUTH_CLIENT_ID_<PROFILE>');
    expect(existsSync(localSettings())).toBe(false);
  });

  it('refuses the whole auth section, not just a nested key', async () => {
    const result = await set('auth', '{"profile":"anthropic"}');

    expect(result.exitCode).toBe(1);
    expect(existsSync(localSettings())).toBe(false);
  });

  it('rejects the legacy Zero-Mem strategy with migration guidance', async () => {
    const result = await set('compactStrategy', '"zero-mem"');

    expect(result.exitCode).toBe(1);
    expect(result.err).toContain('BOOK_EXPERIMENTAL_ZERO_MEM=true');
    expect(existsSync(userSettings())).toBe(false);
  });
});

/**
 * A setting the user chose should follow the user. `config set` used to write
 * `.book/settings.local.json` unconditionally, so the same preference had to be
 * re-set in every checkout — and because local is the last layer resolved, an
 * old stray value silently outranked a newer deliberate one.
 */
describe('book config set scopes', () => {
  it('writes the user-global layer by default', async () => {
    const result = await set('model', '"claude-x"');

    expect(result.exitCode).toBeUndefined();
    expect(result.out).toContain('user-global');
    expect(readJson(userSettings())).toEqual({ model: 'claude-x' });
    expect(existsSync(localSettings())).toBe(false);
  });

  it.each([
    ['project', () => projectSettings()],
    ['local', () => localSettings()],
  ] as const)('writes the %s layer when asked for it', async (scope, path) => {
    const result = await set('model', '"claude-x"', scope);

    expect(result.exitCode).toBeUndefined();
    expect(readJson(path())).toEqual({ model: 'claude-x' });
    expect(existsSync(userSettings())).toBe(false);
  });

  // The write is real but inert: local resolves last. Saying nothing here is
  // what made the old per-project writes so confusing in the first place.
  it('warns when a workspace layer still shadows the global write', async () => {
    writeSettings(localSettings(), { model: 'stale-local' });

    const result = await set('model', '"claude-x"', 'user');

    expect(result.exitCode).toBeUndefined();
    expect(result.err).toContain('still wins here');
    expect(result.err).toContain('book config unset --local model');
  });

  it('does not warn when no workspace layer defines the key', async () => {
    writeSettings(localSettings(), { effort: 'high' });

    const result = await set('model', '"claude-x"', 'user');

    expect(result.err).toBe('');
  });

  // An unreadable layer cannot be shown to hold the key, and cannot be shown
  // not to. Reporting it as "no shadow" would be a guess presented as fact.
  it('reports a shadowing layer it could not read rather than staying silent', async () => {
    writeSettings(localSettings(), '{ not json');

    const result = await set('model', '"claude-x"', 'user');

    expect(result.exitCode).toBeUndefined();
    expect(result.err).toContain('could not be read');
  });
});

describe('book config get/list scopes', () => {
  it('reports the resolved merge when no scope is given', async () => {
    await set('model', '"from-user"', 'user');
    await set('model', '"from-local"', 'local');

    const result = await run('get', 'model');

    expect(result.out).toContain('from-local');
  });

  it('reads one layer verbatim when a scope is given', async () => {
    await set('model', '"from-user"', 'user');
    await set('model', '"from-local"', 'local');

    const result = await run('get', 'model', undefined, 'user');

    expect(result.out).toContain('from-user');
    expect(result.out).not.toContain('from-local');
  });

  it('says a scoped key is unset without claiming the merge is empty', async () => {
    await set('model', '"from-local"', 'local');

    const result = await run('get', 'model', undefined, 'project');

    expect(result.out).toContain('is not set in project');
  });

  it('fails a scoped read of an unreadable layer instead of reporting it empty', async () => {
    writeSettings(localSettings(), '{ not json');

    const result = await run('list', undefined, undefined, 'local');

    expect(result.exitCode).toBe(1);
    expect(result.err).toContain('Could not read');
  });
});

describe('book config unset', () => {
  it('removes a key from the scope it was asked for', async () => {
    await set('model', '"from-local"', 'local');

    const result = await run('unset', 'model', undefined, 'local');

    expect(result.exitCode).toBeUndefined();
    expect(result.out).toContain('Removed model');
    expect(readJson(localSettings())).toEqual({});
  });

  it('leaves other scopes alone', async () => {
    await set('model', '"from-user"', 'user');
    await set('model', '"from-local"', 'local');

    await run('unset', 'model', undefined, 'local');

    expect(readJson(userSettings())).toEqual({ model: 'from-user' });
  });

  it('reports a key that was already absent instead of failing', async () => {
    const result = await run('unset', 'model', undefined, 'local');

    expect(result.exitCode).toBeUndefined();
    expect(result.out).toContain('nothing to remove');
  });
});

/**
 * A settings layer does not determine the effective configuration, so
 * validating one cannot tell whether a write leaves a loadable one.
 *
 * `harness.workflow` is valid on its own and rejected against an effective
 * `harness.mode` of `off`. The write therefore succeeded and every subsequent
 * command — including the `book config` that would undo it — failed before it
 * started, leaving hand-editing JSON as the only recovery.
 */
describe('book config set validates against the merged configuration', () => {
  it('refuses a workflow the effective harness mode cannot enable', async () => {
    const result = await set('harness.workflow', '"safe-edit"', 'local');

    expect(result.exitCode).toBe(1);
    expect(result.err).toContain('Refusing to write harness.workflow');
    expect(result.err).toContain('requires an enabled harness mode');
    expect(result.err).toContain('Nothing was written.');
    expect(existsSync(localSettings())).toBe(false);
  });

  it('accepts the workflow once a mode in any layer enables it', async () => {
    // The point of merging rather than checking one file: the mode that makes
    // this legal lives in a different layer than the workflow.
    await set('harness.mode', '"observe"', 'user');

    const result = await set('harness.workflow', '"safe-edit"', 'local');

    expect(result.exitCode).toBeUndefined();
    expect(readJson(localSettings())).toEqual({ harness: { workflow: 'safe-edit' } });
  });

  it('refuses a mode that would disable a workflow another layer selects', async () => {
    // The same invariant from the other side. A single-layer check cannot see
    // this at all: `harness.mode: off` is the default and valid everywhere.
    await set('harness.mode', '"observe"', 'user');
    await set('harness.workflow', '"safe-edit"', 'local');

    const result = await set('harness.mode', '"off"', 'local');

    expect(result.exitCode).toBe(1);
    expect(result.err).toContain('Refusing to write harness.mode');
    expect(readJson(localSettings())).toEqual({ harness: { workflow: 'safe-edit' } });
  });

  it('leaves unrelated writes untouched', async () => {
    const result = await set('model', '"router/some-model"', 'local');

    expect(result.exitCode).toBeUndefined();
    expect(readJson(localSettings())).toEqual({ model: 'router/some-model' });
  });

  it('still writes when the configuration was already broken', async () => {
    // The check must never turn `config set` into the second thing that stops
    // working: repairing an existing break is the reason to run it. Only a write
    // that *introduces* a failure is refused.
    writeSettings(localSettings(), { harness: { workflow: 'safe-edit' } });

    const result = await set('harness.mode', '"observe"', 'local');

    expect(result.exitCode).toBeUndefined();
    expect(readJson(localSettings())).toEqual({
      harness: { workflow: 'safe-edit', mode: 'observe' },
    });
  });
});
