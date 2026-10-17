import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { applySettingWrite, describeSettingShadow, guardSettingWrite } from './settings-write.js';
import { resolveSettings } from './settings-loader.js';
import type { SettingsScope } from './settings-scope.js';
import { isolateBookHome } from './test/isolated-book-home.js';

// Delegates to the real loader. It is wrapped only so a test can see which layer paths the
// pre-flight in `applySettingWrite` hands it: there is no refusal that depends on them today.
vi.mock('./settings-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./settings-loader.js')>();
  return { ...actual, resolveSettings: vi.fn(actual.resolveSettings) };
});

/**
 * The one write both `book config set` and `/config <key>=<value>` go through.
 * Its callers only ever assert on a substring of one message, so the ordering of
 * the guards and the projection of shadowing layers are pinned here instead —
 * both are the kind of thing a later edit reorders without failing anything.
 */

let workspace: string;

// The user layer resolves through BOOK_HOME. Without one of its own this
// suite would write the developer's real ~/.book/settings.json.
const bookHome = isolateBookHome('book-settings-write-home-');

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-settings-write-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function writeLayer(scope: SettingsScope, document: Record<string, unknown>): string {
  const path =
    scope === 'user'
      ? join(bookHome(), 'settings.json')
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
    const refusal = guardSettingWrite('shell', 'bash', 'local');
    expect(refusal).toContain('BOOK_SHELL');
    expect(refusal).not.toContain('Unknown top-level key');
  });

  it('reaches a trust-owned key from above and below its own path', () => {
    expect(guardSettingWrite('permissions.projectAllowRules', undefined, 'local')).toContain(
      'book trust rule',
    );
    expect(guardSettingWrite('hooks.projectEntries.abc', undefined, 'local')).toContain(
      'book trust hook',
    );
    // Replacing the whole section is the same write with the same silent outcome.
    expect(guardSettingWrite('commands', undefined, 'local')).toContain('book trust command');
  });

  /**
   * The sandbox keys are judged by value, so the guard takes one: `enabled: true`
   * is the single value a workspace layer may set, and refusing the path would
   * take away the one sandbox decision a repository is allowed to make (#373).
   */
  it('judges a sandbox key by its value, not its path', () => {
    expect(guardSettingWrite('sandbox.enabled', false, 'local')).toContain('ignored');
    expect(guardSettingWrite('sandbox.enabled', true, 'local')).toBeUndefined();
    expect(guardSettingWrite('sandbox.filesystem.denyRead', ['~/.ssh'], 'local')).toBeUndefined();
    expect(guardSettingWrite('sandbox.filesystem.allowWrite', ['/'], 'local')).toContain('ignored');
    expect(guardSettingWrite('sandbox.filesystem.allowGitWrites', true, 'local')).toContain(
      'ignored',
    );
    expect(guardSettingWrite('sandbox.filesystem.allowGitWrites', true, 'project')).toContain(
      'ignored',
    );
    expect(guardSettingWrite('sandbox.filesystem.allowGitWrites', false, 'local')).toBeUndefined();
    expect(
      guardSettingWrite('sandbox.filesystem.allowGitWrites', false, 'project'),
    ).toBeUndefined();
    // A whole-object write is judged the same way, key by key.
    expect(
      guardSettingWrite('sandbox', { enabled: true, excludedCommands: ['*'] }, 'local'),
    ).toContain('sandbox.excludedCommands');
    expect(guardSettingWrite('sandbox', { enabled: true }, 'local')).toBeUndefined();
  });

  it('refuses the never-allowed sandbox keys even with no value in hand', () => {
    // `book config unset` and the live-branch check call the guard on a path
    // alone. Refusing by path there would be wrong for `sandbox.enabled`, and
    // wrong in the other direction for the keys no value can make acceptable.
    expect(guardSettingWrite('sandbox.excludedCommands', undefined, 'local')).toContain('ignored');
    expect(guardSettingWrite('sandbox.filesystem.allowWrite', undefined, 'local')).toContain(
      'ignored',
    );
    expect(guardSettingWrite('sandbox.network.allowedDomains', undefined, 'local')).toContain(
      'ignored',
    );
    expect(guardSettingWrite('sandbox.enabled', undefined, 'local')).toBeUndefined();
    expect(guardSettingWrite('sandbox.filesystem.denyWrite', undefined, 'local')).toBeUndefined();
  });

  /**
   * The filter is about what a *file inside the working tree* may carry, and the
   * user-global file is not one. `book config set sandbox.enabled false` writes
   * `<BOOK_HOME>/settings.json` and is the documented way to turn the sandbox
   * off, so the guard refused it with advice to edit the very file it was
   * writing to — the one action a user takes to fix a sandbox it cannot use.
   */
  it('accepts every sandbox value in the user scope, which is not a workspace file', () => {
    for (const [key, value] of [
      ['sandbox.enabled', false],
      ['sandbox.failIfUnavailable', true],
      ['sandbox.allowUnsandboxedCommands', true],
      ['sandbox.excludedCommands', ['*']],
      ['sandbox.filesystem.allowWrite', ['/']],
      ['sandbox.filesystem.allowGitWrites', true],
      ['sandbox', { enabled: true, excludedCommands: ['*'] }],
    ] as const) {
      expect(guardSettingWrite(key, value, 'user'), key).toBeUndefined();
      // ...and with no value in hand, since `unset` writes one scope too.
      expect(guardSettingWrite(key, undefined, 'user'), key).toBeUndefined();
    }
  });

  it('writes the trusted sandbox value the user scope refused to take', () => {
    const result = write('sandbox.enabled', false, 'user');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const written = JSON.parse(readFileSync(result.path, 'utf8')) as Record<string, unknown>;
    expect(written.sandbox).toEqual({ enabled: false });
  });

  it('refuses an ignored sandbox value in the project scope too, writing nothing', () => {
    const result = write('sandbox.allowUnsandboxedCommands', true, 'project');

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected the write to be refused');
    expect(result.error).toContain('ignored');
    // Refused before the file was created, so there is nothing to leave behind.
    expect(existsSync(join(workspace, '.book', 'settings.json'))).toBe(false);
  });

  it('refuses allowGitWrites: true at project and local scope, but accepts it at user scope and accepts false at project scope', () => {
    const projectTrue = write('sandbox.filesystem.allowGitWrites', true, 'project');
    expect(projectTrue.ok).toBe(false);
    if (projectTrue.ok) throw new Error('expected the write to be refused');
    expect(projectTrue.error).toContain('ignored');
    expect(existsSync(join(workspace, '.book', 'settings.json'))).toBe(false);

    const localTrue = write('sandbox.filesystem.allowGitWrites', true, 'local');
    expect(localTrue.ok).toBe(false);
    if (localTrue.ok) throw new Error('expected the write to be refused');
    expect(localTrue.error).toContain('ignored');
    expect(existsSync(join(workspace, '.book', 'settings.local.json'))).toBe(false);

    const userTrue = write('sandbox.filesystem.allowGitWrites', true, 'user');
    expect(userTrue.ok).toBe(true);
    if (!userTrue.ok) throw new Error(userTrue.error);
    const writtenUser = JSON.parse(readFileSync(userTrue.path, 'utf8')) as Record<string, unknown>;
    expect(writtenUser.sandbox).toEqual({ filesystem: { allowGitWrites: true } });

    const projectFalse = write('sandbox.filesystem.allowGitWrites', false, 'project');
    expect(projectFalse.ok).toBe(true);
    if (!projectFalse.ok) throw new Error(projectFalse.error);
    const writtenProject = JSON.parse(readFileSync(projectFalse.path, 'utf8')) as Record<
      string,
      unknown
    >;
    expect(writtenProject.sandbox).toEqual({ filesystem: { allowGitWrites: false } });
  });

  /**
   * #300. `projectDirectories` is the fifth trust-owned key, and the guard list predated it, so
   * `book config set projectDirectories …` was accepted. The user scope is the default and the
   * user layer is trusted, so the written value released a project's declared directory with no
   * `book trust dir` at all — the exact decision the gate exists to withhold.
   */
  it('refuses projectDirectories in every scope, exactly like its four siblings', () => {
    const refusal = guardSettingWrite('projectDirectories', undefined, 'user');

    expect(refusal).toContain('book trust dir');
    expect(refusal).toContain('decision about repository-declared configuration');
    // The same write, spelled as a leaf of the map: a deeper path reaches the key.
    expect(guardSettingWrite('projectDirectories./shared', undefined, 'user')).toContain(
      'book trust dir',
    );

    for (const scope of ['user', 'project', 'local'] as const) {
      const result = write('projectDirectories', { '/opt/shared': 'approved' }, scope);
      expect(result.ok, scope).toBe(false);
    }
    // Nothing reached any layer, so nothing a later load could read was changed.
    expect(existsSync(join(bookHome(), 'settings.json'))).toBe(false);
    expect(existsSync(join(workspace, '.book', 'settings.json'))).toBe(false);
    expect(existsSync(join(workspace, '.book', 'settings.local.json'))).toBe(false);
  });

  it('rejects an unknown top-level key before anything is written', () => {
    expect(guardSettingWrite('maxTruns', 12, 'user')).toContain('Unknown top-level key');
    expect(write('maxTruns', 12).ok).toBe(false);
    expect(existsSync(join(bookHome(), 'settings.json'))).toBe(false);
  });

  it('accepts a key the schema declares', () => {
    expect(guardSettingWrite('maxTurns', 12, 'user')).toBeUndefined();
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

/**
 * #449. A session at `$HOME` with `BOOK_HOME` unset has `~/.book/settings.json` as its user layer
 * *and* as its project file. The loader reads it once, as the user's; the shadow report has to
 * agree, or `book config set` warns that a write is overridden by the very file it just wrote.
 */
describe('a workspace at the home directory (#449)', () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'book-settings-write-userhome-'));
    mkdirSync(join(home, '.book'), { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  });

  const homeLayer = (name: 'settings.json' | 'settings.local.json') => join(home, '.book', name);
  const writeAtHome = (key: string, value: unknown) =>
    applySettingWrite({ workspace: home, key, value, scope: 'user' });

  it('does not report the user file as a project layer shadowing its own write', () => {
    vi.stubEnv('BOOK_HOME', undefined);
    writeFileSync(homeLayer('settings.json'), JSON.stringify({ model: 'old' }));

    const result = writeAtHome('model', 'x');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.path).toBe(homeLayer('settings.json'));
    expect(result.shadowedBy).toEqual([]);
  });

  it('reports the project file as a shadow when BOOK_HOME is elsewhere', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'book-settings-write-elsewhere-'));
    try {
      vi.stubEnv('BOOK_HOME', elsewhere);
      writeFileSync(homeLayer('settings.json'), JSON.stringify({ model: 'project-model' }));

      const result = writeAtHome('model', 'x');

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(result.path).toBe(join(elsewhere, 'settings.json'));
      expect(result.shadowedBy).toEqual([
        { scope: 'project', path: homeLayer('settings.json'), unreadable: false },
      ]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('still reports the local layer', () => {
    vi.stubEnv('BOOK_HOME', undefined);
    writeFileSync(homeLayer('settings.json'), JSON.stringify({ model: 'old' }));
    writeFileSync(homeLayer('settings.local.json'), JSON.stringify({ model: 'local-model' }));

    const result = writeAtHome('model', 'x');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.shadowedBy).toEqual([
      { scope: 'local', path: homeLayer('settings.local.json'), unreadable: false },
    ]);
  });

  /**
   * The pre-flight resolves the merge with a candidate file standing in for the layer being
   * written. At `$HOME` the user file is also the project file, so the candidate has to stand in
   * for both: otherwise the loader no longer sees one file, and merges the old one again as a
   * gated workspace layer (doubled rules, stale scalars, workspace-only sandbox filtering).
   *
   * No loader assertion refuses a write on that account today (the cross-layer harness rule that
   * motivated the pre-flight is gone), so the contract is pinned at the boundary: the paths the
   * pre-flight hands the loader.
   */
  describe('pre-flight merge', () => {
    const preflightPaths = () =>
      vi
        .mocked(resolveSettings)
        .mock.calls.map(([, , paths]) => paths)
        .filter((paths) => paths !== undefined);

    beforeEach(() => {
      vi.mocked(resolveSettings).mockClear();
    });

    it('stands the candidate in for the one file a user write is both user and project', () => {
      vi.stubEnv('BOOK_HOME', undefined);
      writeFileSync(
        homeLayer('settings.json'),
        JSON.stringify({ sandbox: { excludedCommands: ['make'] } }),
      );

      const result = writeAtHome('sandbox.excludedCommands', ['docker']);

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(JSON.parse(readFileSync(homeLayer('settings.json'), 'utf-8'))).toEqual({
        sandbox: { excludedCommands: ['docker'] },
      });
      const [candidate] = preflightPaths();
      expect(candidate?.userSettingsPath).toBeDefined();
      expect(candidate?.userSettingsPath).not.toBe(homeLayer('settings.json'));
      expect(candidate?.projectSettingsPath).toBe(candidate?.userSettingsPath);
    });

    it('does the same for a --project write at the home directory', () => {
      vi.stubEnv('BOOK_HOME', undefined);
      writeFileSync(homeLayer('settings.json'), JSON.stringify({ model: 'old' }));

      const result = applySettingWrite({
        workspace: home,
        key: 'model',
        value: 'y',
        scope: 'project',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error);
      expect(JSON.parse(readFileSync(homeLayer('settings.json'), 'utf-8'))).toEqual({
        model: 'y',
      });
      const [candidate] = preflightPaths();
      expect(candidate?.projectSettingsPath).toBeDefined();
      expect(candidate?.projectSettingsPath).not.toBe(homeLayer('settings.json'));
      expect(candidate?.userSettingsPath).toBe(candidate?.projectSettingsPath);
    });

    it('keeps <home>/.book/settings.json a workspace layer when BOOK_HOME is elsewhere', () => {
      const elsewhere = mkdtempSync(join(tmpdir(), 'book-settings-write-elsewhere-'));
      try {
        vi.stubEnv('BOOK_HOME', elsewhere);
        writeFileSync(homeLayer('settings.json'), JSON.stringify({ model: 'old' }));

        const result = applySettingWrite({
          workspace: home,
          key: 'model',
          value: 'y',
          scope: 'project',
        });

        expect(result.ok).toBe(true);
        const [candidate] = preflightPaths();
        // Only the project layer is replaced; the user layer is the real one in BOOK_HOME.
        expect(candidate?.projectSettingsPath).toBeDefined();
        expect(candidate?.userSettingsPath).toBeUndefined();

        // And a workspace-loosening value is still refused for that file, writing nothing.
        const loosening = applySettingWrite({
          workspace: home,
          key: 'sandbox.excludedCommands',
          value: ['*'],
          scope: 'project',
        });
        expect(loosening.ok).toBe(false);
        if (loosening.ok) throw new Error('expected the write to be refused');
        expect(loosening.error).toContain('ignored');
        expect(JSON.parse(readFileSync(homeLayer('settings.json'), 'utf-8'))).toEqual({
          model: 'y',
        });
      } finally {
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });
  });
});

describe('write target', () => {
  it('writes the scope it is given and reports that path', () => {
    const result = write('maxTurns', 7, 'user');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.path).toBe(join(bookHome(), 'settings.json'));
    expect(JSON.parse(readFileSync(result.path, 'utf-8'))).toEqual({ maxTurns: 7 });
  });
});
