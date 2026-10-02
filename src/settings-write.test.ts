import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applySettingWrite, describeSettingShadow, guardSettingWrite } from './settings-write.js';
import type { SettingsScope } from './settings-scope.js';

/**
 * The one write both `book config set` and `/config <key>=<value>` go through.
 * Its callers only ever assert on a substring of one message, so the ordering of
 * the guards and the projection of shadowing layers are pinned here instead —
 * both are the kind of thing a later edit reorders without failing anything.
 */

let workspace: string;
let bookHome: string;
let previousBookHome: string | undefined;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-settings-write-'));
  // The user layer resolves through BOOK_HOME. Without one of its own this
  // suite would write the developer's real ~/.book/settings.json.
  bookHome = mkdtempSync(join(tmpdir(), 'book-settings-write-home-'));
  previousBookHome = process.env.BOOK_HOME;
  process.env.BOOK_HOME = bookHome;
});

afterEach(() => {
  if (previousBookHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = previousBookHome;
  rmSync(workspace, { recursive: true, force: true });
  rmSync(bookHome, { recursive: true, force: true });
});

function writeLayer(scope: SettingsScope, document: Record<string, unknown>): string {
  const path =
    scope === 'user'
      ? join(bookHome, 'settings.json')
      : join(workspace, '.book', scope === 'project' ? 'settings.json' : 'settings.local.json');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(document, null, 2));
  return path;
}

function write(key: string, value: unknown, scope: SettingsScope = 'user', override?: string) {
  return applySettingWrite({ workspace, key, value, scope, settingsOverridePath: override });
}

describe('guard order', () => {
  /**
   * `shell` is a real settings key, so the refusal has to explain the trust
   * boundary rather than the schema: it is honoured from the user-global file
   * and refused in a workspace one, and a reader told only "unknown key" would
   * conclude they had misspelled it.
   */
  it('refuses the shell setting as a trust boundary, not an unknown key', () => {
    const refusal = guardSettingWrite('shell');
    expect(refusal).toContain('BOOK_SHELL');
    expect(refusal).not.toContain('Unknown top-level key');
  });

  it('reaches a trust-owned key from above and below its own path', () => {
    expect(guardSettingWrite('permissions.projectAllowRules')).toContain('book trust rule');
    expect(guardSettingWrite('hooks.projectEntries.abc')).toContain('book trust hook');
    // Replacing the whole section is the same write with the same silent outcome.
    expect(guardSettingWrite('commands')).toContain('book trust command');
  });

  /**
   * The sandbox keys are judged by value, so the guard takes one: `enabled: true`
   * is the single value a workspace layer may set, and refusing the path would
   * take away the one sandbox decision a repository is allowed to make (#373).
   */
  it('judges a sandbox key by its value, not its path', () => {
    expect(guardSettingWrite('sandbox.enabled', false)).toContain('ignored');
    expect(guardSettingWrite('sandbox.enabled', true)).toBeUndefined();
    expect(guardSettingWrite('sandbox.filesystem.denyRead', ['~/.ssh'])).toBeUndefined();
    expect(guardSettingWrite('sandbox.filesystem.allowWrite', ['/'])).toContain('ignored');
    // A whole-object write is judged the same way, key by key.
    expect(guardSettingWrite('sandbox', { enabled: true, excludedCommands: ['*'] })).toContain(
      'sandbox.excludedCommands',
    );
    expect(guardSettingWrite('sandbox', { enabled: true })).toBeUndefined();
  });

  it('refuses the never-allowed sandbox keys even with no value in hand', () => {
    // `book config unset` and the live-branch check call the guard on a path
    // alone. Refusing by path there would be wrong for `sandbox.enabled`, and
    // wrong in the other direction for the keys no value can make acceptable.
    expect(guardSettingWrite('sandbox.excludedCommands')).toContain('ignored');
    expect(guardSettingWrite('sandbox.filesystem.allowWrite')).toContain('ignored');
    expect(guardSettingWrite('sandbox.network.allowedDomains')).toContain('ignored');
    expect(guardSettingWrite('sandbox.enabled')).toBeUndefined();
    expect(guardSettingWrite('sandbox.filesystem.denyWrite')).toBeUndefined();
  });

  it('refuses an ignored sandbox value in the project scope too, writing nothing', () => {
    const result = write('sandbox.allowUnsandboxedCommands', true, 'project');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the write to be refused');
    expect(result.error).toContain('ignored');
    // Refused before the file was created, so there is nothing to leave behind.
    expect(existsSync(join(workspace, '.book', 'settings.json'))).toBe(false);
  });

  /**
   * #300. `projectDirectories` is the fifth trust-owned key, and the guard list predated it, so
   * `book config set projectDirectories …` was accepted. The user scope is the default and the
   * user layer is trusted, so the written value released a project's declared directory with no
   * `book trust dir` at all — the exact decision the gate exists to withhold.
   */
  it('refuses projectDirectories in every scope, exactly like its four siblings', () => {
    const refusal = guardSettingWrite('projectDirectories');

    expect(refusal).toContain('book trust dir');
    expect(refusal).toContain('decision about repository-declared configuration');
    // The same write, spelled as a leaf of the map: a deeper path reaches the key.
    expect(guardSettingWrite('projectDirectories./shared')).toContain('book trust dir');

    for (const scope of ['user', 'project', 'local'] as const) {
      const result = write('projectDirectories', { '/opt/shared': 'approved' }, scope);
      expect(result.ok, scope).toBe(false);
    }
    // Nothing reached any layer, so nothing a later load could read was changed.
    expect(existsSync(join(bookHome, 'settings.json'))).toBe(false);
    expect(existsSync(join(workspace, '.book', 'settings.json'))).toBe(false);
    expect(existsSync(join(workspace, '.book', 'settings.local.json'))).toBe(false);
  });

  it('rejects an unknown top-level key before anything is written', () => {
    expect(guardSettingWrite('maxTruns')).toContain('Unknown top-level key');
    expect(write('maxTruns', 12).ok).toBe(false);
    expect(existsSync(join(bookHome, 'settings.json'))).toBe(false);
  });

  it('accepts a key the schema declares', () => {
    expect(guardSettingWrite('maxTurns')).toBeUndefined();
  });
});

describe('shadow projection', () => {
  it('reports both layers merged after a user-global write', () => {
    writeLayer('project', { maxTurns: 2 });
    writeLayer('local', { maxTurns: 3 });

    const result = write('maxTurns', 20, 'user');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shadowedBy.map((shadow) => shadow.scope)).toEqual(['project', 'local']);
    expect(describeSettingShadow(result.shadowedBy[1]!, 'maxTurns')).toContain(
      'book config unset --local maxTurns',
    );
  });

  /**
   * The scope most likely to be shadowed, because the previous `/config
   * <key>=<value>` put every typed setting in the local layer. Checking only the
   * user scope reported this write as effective while resolution still returned
   * the local value.
   */
  it('reports the local layer that outranks a project write', () => {
    writeLayer('local', { maxTurns: 3 });

    const result = write('maxTurns', 20, 'project');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shadowedBy.map((shadow) => shadow.scope)).toEqual(['local']);
  });

  it('reports nothing for a local write with no override', () => {
    writeLayer('user', { maxTurns: 1 });
    writeLayer('project', { maxTurns: 2 });

    const result = write('maxTurns', 20, 'local');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shadowedBy).toEqual([]);
    expect(
      JSON.parse(readFileSync(join(workspace, '.book', 'settings.local.json'), 'utf-8')),
    ).toEqual({ maxTurns: 20 });
  });

  /** `--settings` is merged after every scope, so it wins over all three. */
  it('reports a --settings override that still decides the key', () => {
    const override = join(workspace, 'ci.json');
    writeFileSync(override, JSON.stringify({ maxTurns: 99 }));

    const result = write('maxTurns', 20, 'local', override);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shadowedBy.map((shadow) => shadow.scope)).toEqual(['override']);
    const described = describeSettingShadow(result.shadowedBy[0]!, 'maxTurns');
    expect(described).toContain('--settings override');
    expect(described).toContain('start without --settings');
  });

  it('ignores an override that does not define the key', () => {
    const override = join(workspace, 'ci.json');
    writeFileSync(override, JSON.stringify({ maxTokens: 4096 }));

    const result = write('maxTurns', 20, 'local', override);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shadowedBy).toEqual([]);
  });
});

describe('write target', () => {
  it('writes the scope it is given and reports that path', () => {
    const result = write('maxTurns', 7, 'user');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(join(bookHome, 'settings.json'));
    expect(JSON.parse(readFileSync(result.path, 'utf-8'))).toEqual({ maxTurns: 7 });
  });
});
