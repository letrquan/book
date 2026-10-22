import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isolateBookHome } from './test/isolated-book-home.js';
import { projectFileWriteRefusal, SettingsRepository } from './settings-repository.js';
import { applySettingWrite, readScopeDocument } from './settings-write.js';
import { migrateLegacyPermissions } from './settings-loader.js';
import { runMcpAddCommand } from './cli/mcp.js';
import {
  persistPermissionRuleLocal,
  persistProviderSave,
  persistSettingsGlobal,
  persistSettingsLocal,
  persistUserSettingClearingLocal,
  removePermissionRuleLocal,
  removeProviderLocal,
} from './tui/persist.js';

const bookHome = isolateBookHome('book-regular-file-home-');
let workspace: string;
let outside: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-regular-file-ws-'));
  outside = mkdtempSync(join(tmpdir(), 'book-regular-file-other-'));
  mkdirSync(join(workspace, '.book'), { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const ORIGINAL = `${JSON.stringify({ model: 'kept', provider: { gw: { apiKey: 'x' } } }, null, 2)}\n`;

function localPath(): string {
  return join(workspace, '.book', 'settings.local.json');
}

/** Put a link at `path` to a regular file outside the workspace, and return that file. */
function linkTo(path: string): string {
  const target = join(outside, 'elsewhere.json');
  writeFileSync(target, ORIGINAL);
  symlinkSync(target, path);
  return target;
}

/** The link is still a link, and the file it names is byte for byte what it was. */
function expectUntouched(path: string, target: string): void {
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, 'utf-8')).toBe(ORIGINAL);
}

// Creating a symbolic link needs a privilege Windows runners do not grant by default.
const links = describe.skipIf(process.platform === 'win32');

describe('projectFileWriteRefusal', () => {
  it('lets a regular file and a missing one be written', () => {
    expect(projectFileWriteRefusal(localPath())).toBeUndefined();
    writeFileSync(localPath(), '{}');
    expect(projectFileWriteRefusal(localPath())).toBeUndefined();
  });

  it('refuses a directory in the file’s place, and leaves it', () => {
    mkdirSync(localPath());
    expect(projectFileWriteRefusal(localPath())).toContain('not a regular file');
    const result = persistSettingsLocal(workspace, { effort: 'high' });
    expect(result).toEqual({ ok: false, error: expect.stringContaining('not a regular file') });
    expect(lstatSync(localPath()).isDirectory()).toBe(true);
  });

  it('keeps the behaviour of the user-global files only', () => {
    mkdirSync(join(bookHome(), 'settings.json'), { recursive: true });
    mkdirSync(join(bookHome(), 'mcp.json'), { recursive: true });
    expect(projectFileWriteRefusal(join(bookHome(), 'settings.json'))).toBeUndefined();
    expect(projectFileWriteRefusal(join(bookHome(), 'mcp.json'))).toBeUndefined();
    // The rest of BOOK_HOME holds checkouts of other repositories, and is checked like any
    // workspace.
    const checkout = join(bookHome(), 'worktrees', 'one', '.book', 'settings.local.json');
    mkdirSync(checkout, { recursive: true });
    expect(projectFileWriteRefusal(checkout)).toContain('not a regular file');
  });
});

links('a project settings file that is a link', () => {
  it('is left unchanged by a local settings write', () => {
    const target = linkTo(localPath());
    const result = persistSettingsLocal(workspace, { effort: 'high' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(`${localPath()}: not a regular file, so Book left it unchanged`);
    expectUntouched(localPath(), target);
  });

  it('is left unchanged by the repository itself', () => {
    const target = linkTo(localPath());
    const result = new SettingsRepository(localPath()).update((candidate) => {
      candidate.effort = 'high';
    });
    expect(result.ok).toBe(false);
    expectUntouched(localPath(), target);
  });

  it('stops a user-global save whose local clear it would refuse, with the notice', () => {
    const target = linkTo(localPath());
    expect(persistProviderSave(workspace, 'gw', { type: 'openai', models: {} }, 'gw/m')).toEqual({
      ok: false,
      error: `${localPath()}: not a regular file, so Book left it unchanged`,
    });
    expect(persistUserSettingClearingLocal(workspace, 'effort', 'high').ok).toBe(false);
    // Neither save half-happened: the user file was not written either.
    expect(() => lstatSync(join(bookHome(), 'settings.json'))).toThrow();
    expectUntouched(localPath(), target);
  });

  it('is refused when the .book folder itself is a link', () => {
    const folder = join(outside, 'folder');
    mkdirSync(folder);
    writeFileSync(join(folder, 'settings.local.json'), ORIGINAL);
    rmSync(join(workspace, '.book'), { recursive: true });
    symlinkSync(folder, join(workspace, '.book'));
    const result = persistSettingsLocal(workspace, { effort: 'high' });
    expect(result.error).toContain('its .book folder is not a regular directory');
    expect(readFileSync(join(folder, 'settings.local.json'), 'utf-8')).toBe(ORIGINAL);
    expect(applySettingWrite({ workspace, key: 'effort', value: 'x', scope: 'project' }).ok).toBe(
      false,
    );
    expect(() => lstatSync(join(folder, 'settings.json'))).toThrow();
  });

  it('is refused before it is read by permission rule edits and provider removal', () => {
    const target = linkTo(localPath());
    expect(persistPermissionRuleLocal(workspace, 'allow', 'Read(*)').ok).toBe(false);
    expect(removePermissionRuleLocal(workspace, 'allow', 'Read(*)')).toEqual({
      ok: false,
      error: expect.stringContaining('not a regular file'),
    });
    expect(removeProviderLocal(workspace, 'gw')).toMatchObject({
      ok: false,
      error: expect.stringContaining('not a regular file'),
    });
    expectUntouched(localPath(), target);
  });

  it('is read for display as the loader reads it, and refused by book config set', () => {
    const target = linkTo(localPath());
    expect(readScopeDocument('local', workspace)).toMatchObject({
      status: 'present',
      document: { model: 'kept' },
    });
    expect(readScopeDocument('local', workspace, { forWrite: true })).toMatchObject({
      status: 'unreadable',
      error: 'not a regular file, so Book left it unchanged',
    });
    const set = applySettingWrite({ workspace, key: 'effort', value: 'high', scope: 'local' });
    expect(set.ok).toBe(false);

    const projectPath = join(workspace, '.book', 'settings.json');
    symlinkSync(target, projectPath);
    const project = applySettingWrite({
      workspace,
      key: 'effort',
      value: 'high',
      scope: 'project',
    });
    expect(project.ok).toBe(false);
    expect(lstatSync(projectPath).isSymbolicLink()).toBe(true);
    expectUntouched(localPath(), target);
  });

  it('is left unchanged by book mcp add --project', () => {
    const mcpPath = join(workspace, '.mcp.json');
    const target = linkTo(mcpPath);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() =>
      runMcpAddCommand('srv', 'node', ['server.js'], { workspace, scope: 'project' }),
    ).toThrow(`Cannot update ${mcpPath}: not a regular file`);
    expectUntouched(mcpPath, target);
  });

  it('stops the legacy permission migration, with a notice, before reading its marker', () => {
    const target = linkTo(join(workspace, '.book', 'migrations.json'));
    const home = mkdtempSync(join(tmpdir(), 'book-regular-file-legacy-'));
    try {
      mkdirSync(join(home, '.book'), { recursive: true });
      writeFileSync(
        join(home, '.book', 'permissions.json'),
        JSON.stringify({ rules: [{ toolName: 'Read', effect: 'allow' }] }),
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect(migrateLegacyPermissions(workspace, home)).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a regular file'));
      expectUntouched(join(workspace, '.book', 'migrations.json'), target);
      expect(() => lstatSync(localPath())).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('does not change how the user-global file is written', () => {
    mkdirSync(bookHome(), { recursive: true });
    const target = join(outside, 'user.json');
    writeFileSync(target, '{}\n');
    symlinkSync(target, join(bookHome(), 'settings.json'));
    expect(persistSettingsGlobal({ effort: 'high' })).toEqual({ ok: true });
  });
});
