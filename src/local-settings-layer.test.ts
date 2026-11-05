import { execFileSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, normalize } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectUnreadLocalSettingsNotices,
  collectWithheldProjectNotices,
} from './project-approval-notices.js';
import { providerKeyTarget, writeProviderKey } from './provider-key.js';
import {
  loadLocalSettingsFile,
  migrateLegacyPermissions,
  resolveSettings,
  settingsLayerPaths,
} from './settings-loader.js';
import { applySettingWrite, readScopeDocument } from './settings-write.js';
import { DEFAULT_SETTINGS } from './settings.js';
import {
  clearLocalSettings,
  persistAgentProfileModel,
  persistPermissionRuleLocal,
  persistProviderSave,
  persistSettingLocal,
  persistSkillActivationLocal,
  persistUserSettingClearingLocal,
  removePermissionRuleLocal,
  removeProviderLocal,
  removeUserSettingClearingLocal,
  turnOffAdvisorModel,
} from './tui/persist.js';
import { projectFileWriteRefusal } from './workspace-files.js';

describe('a local settings file git tracks', () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();

  const LOCAL_DOCUMENT = {
    model: 'from-local',
    hooks: { SessionStart: [{ command: 'echo local' }] },
    permissions: { allow: ['Bash(echo *)'], deny: ['Bash(rm *)'] },
    additionalDirectories: ['/local-extra'],
    messaging: { inbound: 'ignore' },
    ui: { startupAnimation: false },
  };

  let workspace: string;
  let home: string;
  let localPath: string;

  beforeEach(() => {
    workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-local-tracked-')));
    home = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-local-tracked-home-')));
    localPath = join(workspace, '.book', 'settings.local.json');
    mkdirSync(join(workspace, '.book'), { recursive: true });
    writeFileSync(localPath, JSON.stringify(LOCAL_DOCUMENT));
    git(workspace, 'init', '-q');
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const resolved = () => resolveSettings(workspace, undefined, { home });

  it('reads an untracked file, ignored or not, as the local layer', () => {
    writeFileSync(join(workspace, '.gitignore'), '.book/settings.local.json\n');
    git(workspace, 'add', '.gitignore');
    const settings = resolved();
    expect(settings.model).toBe('from-local');
    expect(settings.hooks.SessionStart.map((hook) => hook.command)).toEqual(['echo local']);
    expect(settings.permissions.allow).toContain('Bash(echo *)');
    expect(settings.additionalDirectories).toEqual([normalize('/local-extra')]);
    expect(settingsLayerPaths(workspace, undefined, { home })).toContain(localPath);
  });

  it('does not read a tracked file, for any key', () => {
    git(workspace, 'add', '-f', '.book/settings.local.json');
    const settings = resolved();
    expect(settings.model).toBeUndefined();
    expect(settings.hooks.SessionStart).toEqual([]);
    expect(settings.permissions.allow).toEqual([]);
    expect(settings.permissions.deny).toEqual([]);
    expect(settings.additionalDirectories).toEqual([]);
    expect(settings.messaging.inbound).toBeUndefined();
    expect(settings.ui.startupAnimation).toBe(DEFAULT_SETTINGS.ui.startupAnimation);
    expect(settingsLayerPaths(workspace, undefined, { home })).not.toContain(localPath);
  });

  it('reads it again once git no longer tracks it', () => {
    git(workspace, 'add', '-f', '.book/settings.local.json');
    expect(resolved().model).toBeUndefined();
    git(workspace, 'rm', '-q', '--cached', '.book/settings.local.json');
    expect(resolved().model).toBe('from-local');
  });

  it('is not broken by a tracked file that does not parse', () => {
    writeFileSync(localPath, '{ not json');
    git(workspace, 'add', '-f', '.book/settings.local.json');
    expect(resolved().model).toBeUndefined();
    expect(loadLocalSettingsFile(localPath)).toBeNull();
  });

  it('still fails on an untracked file that does not parse', () => {
    writeFileSync(localPath, '{ not json');
    expect(() => resolved()).toThrow(/Invalid JSON/);
  });

  it('does not read a tracked file for a workspace in a subdirectory of the repository', () => {
    const nested = join(workspace, 'packages', 'app');
    mkdirSync(join(nested, '.book'), { recursive: true });
    const nestedLocal = join(nested, '.book', 'settings.local.json');
    writeFileSync(nestedLocal, JSON.stringify(LOCAL_DOCUMENT));
    expect(resolveSettings(nested, undefined, { home }).model).toBe('from-local');
    git(workspace, 'add', '-f', 'packages/app/.book/settings.local.json');
    expect(resolveSettings(nested, undefined, { home }).model).toBeUndefined();
  });

  it('does not read one when the index cannot be read', () => {
    writeFileSync(join(workspace, '.git', 'index'), 'not an index');
    expect(resolved().model).toBeUndefined();
  });

  it('keeps an explicit --settings path to that file, which the user named', () => {
    git(workspace, 'add', '-f', '.book/settings.local.json');
    expect(resolveSettings(workspace, localPath, { home }).model).toBe('from-local');
  });

  it('leaves the other layers as they were', () => {
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({ model: 'from-project' }),
    );
    git(workspace, 'add', '-f', '.book/settings.local.json');
    expect(resolved().model).toBe('from-project');
  });

  it('honours no stale advisor `off` from a tracked file, leaving the project advisor', () => {
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({ advisorModel: 'project-advisor' }),
    );
    writeFileSync(localPath, JSON.stringify({ advisorModel: 'off' }));
    expect(resolved().advisorModel).toBe('off');
    git(workspace, 'add', '-f', '.book/settings.local.json');
    expect(resolved().advisorModel).toBe('project-advisor');
  });
});

describe('what happens around a tracked local settings file', () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();

  const BODY = JSON.stringify({ model: 'from-local' });

  let workspace: string;
  let home: string;
  let localPath: string;

  beforeEach(() => {
    workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-local-host-')));
    home = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-local-host-home-')));
    vi.stubEnv('BOOK_HOME', home);
    localPath = join(workspace, '.book', 'settings.local.json');
    mkdirSync(join(workspace, '.book'), { recursive: true });
    writeFileSync(localPath, BODY);
    git(workspace, 'init', '-q');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const track = (): void => {
    git(workspace, 'add', '-f', '.book/settings.local.json');
  };
  const bodyIsUntouched = (): void => {
    expect(readFileSync(localPath, 'utf-8')).toBe(BODY);
  };

  describe('notices', () => {
    it('gives one notice, naming the file and the remedy', () => {
      track();
      const notices = collectUnreadLocalSettingsNotices(workspace, true);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain(localPath);
      expect(notices[0]).toContain('git rm --cached .book/settings.local.json');
    });

    it('gives none for an untracked file, or under --no-settings', () => {
      expect(collectUnreadLocalSettingsNotices(workspace, true)).toEqual([]);
      track();
      expect(collectUnreadLocalSettingsNotices(workspace, false)).toEqual([]);
    });

    it('reports nothing else from the file: it was not read', () => {
      writeFileSync(localPath, JSON.stringify({ sandbox: { enabled: false } }));
      const untracked = collectWithheldProjectNotices({
        workspace,
        settings: resolveSettings(workspace),
        settingsEnabled: true,
      });
      expect(untracked.join('\n')).toContain('sandbox.enabled=false');
      track();
      expect(
        collectWithheldProjectNotices({
          workspace,
          settings: resolveSettings(workspace),
          settingsEnabled: true,
        }),
      ).toEqual([]);
    });
  });

  describe('writes', () => {
    it('refuses through the one check every workspace write asks', () => {
      expect(projectFileWriteRefusal(localPath)).toBeUndefined();
      track();
      expect(projectFileWriteRefusal(localPath)).toContain('git tracks it');
      // Only that file: the checked-in layer is meant to be tracked.
      expect(projectFileWriteRefusal(join(workspace, '.book', 'settings.json'))).toBeUndefined();
    });

    it('refuses even when the tracked file was deleted from the work tree', () => {
      track();
      rmSync(localPath);
      expect(projectFileWriteRefusal(localPath)).toContain('git tracks it');
      const saved = persistSettingLocal(workspace, 'model', 'x');
      expect(saved.ok).toBe(false);
      expect(existsSync(localPath)).toBe(false);
    });

    it('refuses each local save, and leaves the file as it was', () => {
      track();
      for (const saved of [
        persistSettingLocal(workspace, 'model', 'x'),
        persistPermissionRuleLocal(workspace, 'allow', 'Bash(echo *)'),
        persistAgentProfileModel(workspace, 'explorer', 'x'),
        persistSkillActivationLocal(workspace, 'skill', 'manual'),
      ]) {
        expect(saved.ok).toBe(false);
        expect(saved.error).toContain('git tracks it');
      }
      expect(removeProviderLocal(workspace, 'gw').ok).toBe(false);
      bodyIsUntouched();
    });

    it('refuses `book config set --local` with the reason, and writes nothing', () => {
      track();
      const result = applySettingWrite({ workspace, key: 'model', value: 'x', scope: 'local' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('git tracks it');
      bodyIsUntouched();
    });

    it('reports the file when asked to read that scope', () => {
      expect(readScopeDocument('local', workspace).status).toBe('present');
      track();
      const read = readScopeDocument('local', workspace);
      expect(read.status).toBe('unreadable');
      expect(read.error).toContain('git tracks it');
      expect(read.document).toEqual({});
    });

    it('does not report it as shadowing a write, since it is no layer', () => {
      track();
      const written = applySettingWrite({ workspace, key: 'model', value: 'x', scope: 'user' });
      expect(written.ok && written.shadowedBy).toEqual([]);
    });

    it('lets a save to the user file through: nothing in a tracked file outranks it', () => {
      track();
      expect(persistUserSettingClearingLocal(workspace, 'model', 'mine').ok).toBe(true);
      expect(resolveSettings(workspace).model).toBe('mine');
      expect(removeUserSettingClearingLocal(workspace, 'model').ok).toBe(true);
      expect(resolveSettings(workspace).model).toBeUndefined();
      expect(clearLocalSettings(workspace, ['model']).ok).toBe(true);
      expect(
        persistProviderSave(workspace, 'gw', { type: 'openai', models: {} } as never, 'gw/m').ok,
      ).toBe(true);
      bodyIsUntouched();
    });

    it('still clears an untracked file on a save to the user file', () => {
      expect(persistUserSettingClearingLocal(workspace, 'model', 'mine').ok).toBe(true);
      expect(JSON.parse(readFileSync(localPath, 'utf-8')).model).toBeUndefined();
    });

    it('says `/advisor off` cannot be kept when only the local file could hold it', () => {
      writeFileSync(
        join(workspace, '.book', 'settings.json'),
        JSON.stringify({ advisorModel: 'project-advisor' }),
      );
      track();
      const off = turnOffAdvisorModel(workspace);
      expect(off.ok).toBe(false);
      expect(off.error).toContain('git tracks it');
      bodyIsUntouched();
    });

    describe('legacy rules', () => {
      const withWarnings = (run: () => void): string => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          run();
          return warn.mock.calls.join('');
        } finally {
          warn.mockRestore();
        }
      };

      beforeEach(() => {
        writeFileSync(
          join(home, 'permissions.json'),
          JSON.stringify({ rules: [{ toolName: 'Bash', effect: 'allow' }] }),
        );
      });

      it('does not migrate into it, adds no second notice, and leaves no marker', () => {
        track();
        expect(withWarnings(() => expect(migrateLegacyPermissions(workspace)).toBe(false))).toBe(
          '',
        );
        bodyIsUntouched();
        expect(existsSync(join(workspace, '.book', 'migrations.json'))).toBe(false);
      });

      it('migrates once git no longer tracks it', () => {
        track();
        migrateLegacyPermissions(workspace);
        git(workspace, 'rm', '-q', '--cached', '.book/settings.local.json');
        withWarnings(() => expect(migrateLegacyPermissions(workspace)).toBe(true));
        expect(JSON.parse(readFileSync(localPath, 'utf-8')).permissions.allow).toEqual(['Bash']);
      });

      it('says nothing once migrated, whatever has happened to the file since', () => {
        writeFileSync(
          join(workspace, '.book', 'migrations.json'),
          JSON.stringify({ legacyPermissions: 1 }),
        );
        rmSync(localPath);
        mkdirSync(localPath);
        expect(
          withWarnings(() =>
            expect(migrateLegacyPermissions(workspace, undefined, DEFAULT_SETTINGS)).toBe(false),
          ),
        ).toBe('');
      });

      it('still says when a file in the way stops the migration', () => {
        rmSync(localPath);
        mkdirSync(localPath);
        expect(
          withWarnings(() =>
            expect(migrateLegacyPermissions(workspace, undefined, DEFAULT_SETTINGS)).toBe(false),
          ),
        ).toContain('not a regular file');
      });
    });

    describe('saves to the user file, with no local file on disk', () => {
      const saves = (): void => {
        expect(persistUserSettingClearingLocal(workspace, 'model', 'mine').ok).toBe(true);
        expect(removeUserSettingClearingLocal(workspace, 'model').ok).toBe(true);
        expect(clearLocalSettings(workspace, ['model']).ok).toBe(true);
        expect(
          persistProviderSave(workspace, 'gw', { type: 'openai', models: {} } as never, 'gw/m').ok,
        ).toBe(true);
        expect(writeProviderKey(workspace, 'gw', 'sk-new').ok).toBe(true);
      };

      it('go through when the index still lists it: the user followed the notice with rm', () => {
        track();
        rmSync(localPath);
        saves();
        expect(existsSync(localPath)).toBe(false);
      });

      it('go through when the index cannot be read', () => {
        rmSync(localPath);
        writeFileSync(join(workspace, '.git', 'index'), 'not an index');
        saves();
        expect(existsSync(localPath)).toBe(false);
      });

      it('go through when the .git file names nothing', () => {
        rmSync(localPath);
        rmSync(join(workspace, '.git'), { recursive: true, force: true });
        writeFileSync(join(workspace, '.git'), `gitdir: ${join(workspace, 'gone')}\n`);
        saves();
        expect(existsSync(localPath)).toBe(false);
      });
    });

    it('still refuses a save that stops at a file in the way', () => {
      rmSync(localPath);
      mkdirSync(localPath);
      expect(persistUserSettingClearingLocal(workspace, 'model', 'mine').ok).toBe(false);
      expect(writeProviderKey(workspace, 'gw', 'sk-new').ok).toBe(false);
    });

    it('takes a rule back from no layer it could come from: not local', () => {
      track();
      expect(removePermissionRuleLocal(workspace, 'allow', 'Bash(echo *)')).toEqual({
        ok: false,
        notLocal: true,
      });
      bodyIsUntouched();
    });

    it('saves a provider key to the user file and leaves a tracked file alone', () => {
      const entry = { type: 'openai', baseURL: 'https://gw.test/v1', apiKey: 'sk-old', models: {} };
      writeFileSync(join(home, 'settings.json'), JSON.stringify({ provider: { gw: entry } }));
      const body = JSON.stringify({ provider: { gw: { apiKey: 'sk-local' } } });
      writeFileSync(localPath, body);
      track();
      const written = writeProviderKey(workspace, 'gw', 'sk-new');
      expect(written).toEqual({ ok: true, path: join(home, 'settings.json') });
      expect(readFileSync(localPath, 'utf-8')).toBe(body);
    });

    it('does not take a provider a tracked file declares for one in force', () => {
      writeFileSync(
        localPath,
        JSON.stringify({ provider: { repo: { type: 'openai', models: {} } } }),
      );
      expect(providerKeyTarget(workspace, 'repo').kind).toBe('workspace-only');
      track();
      expect(providerKeyTarget(workspace, 'repo').kind).toBe('unknown');
    });
  });
});
