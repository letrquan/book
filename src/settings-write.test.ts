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
   * `experimental` is not in the settings schema, so an ordering that ran the
   * top-level check first would answer a capability-gate question with a typo
   * message — and a reader would conclude the flag is simply misspelled.
   */
  it('refuses an experimental flag as a capability gate, not an unknown key', () => {
    const refusal = guardSettingWrite('experimental.zeroMem', true);
    expect(refusal).toContain('in any scope');
    expect(refusal).not.toContain('Unknown top-level key');
  });

  it('refuses auth in every scope without naming a file the write could reach', () => {
    const refusal = guardSettingWrite('auth.profile', 'anthropic');
    expect(refusal).toContain('in any scope');
    expect(refusal).toContain('BOOK_AUTH_CLIENT_ID_<PROFILE>');
    // The workspace wording pointed at <BOOK_HOME>/settings.json, which is the
    // file a user-global write was already aimed at: following it verbatim
    // re-ran the same command and was refused again.
    expect(refusal).not.toContain('cannot be written to .book/settings.local.json');
  });

  it('reaches a trust-owned key from above and below its own path', () => {
    expect(guardSettingWrite('permissions.projectAllowRules', [])).toContain('book trust rule');
    expect(guardSettingWrite('hooks.projectEntries.abc', {})).toContain('book trust hook');
    // Replacing the whole section is the same write with the same silent outcome.
    expect(guardSettingWrite('commands', { projectCommands: {} })).toContain('book trust command');
  });

  it('rejects an unknown top-level key before anything is written', () => {
    expect(guardSettingWrite('maxTruns', 12)).toContain('Unknown top-level key');
    expect(write('maxTruns', 12).ok).toBe(false);
    expect(existsSync(join(bookHome, 'settings.json'))).toBe(false);
  });

  it('rejects the retired Zero-Mem strategy value', () => {
    expect(guardSettingWrite('compactStrategy', 'zero-mem')).toContain(
      'BOOK_EXPERIMENTAL_ZERO_MEM=true',
    );
  });

  it('accepts a key the schema declares', () => {
    expect(guardSettingWrite('maxTurns', 12)).toBeUndefined();
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
