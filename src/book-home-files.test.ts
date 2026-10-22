import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentManager } from './agents/manager.js';
import { AgentStore } from './agents/store.js';
import { repositoryHash } from './agents/git-isolation.js';
import { shippedHomeFiles } from './book-home-files.js';
import { inspectProjectInstructions } from './claude-md.js';
import { inspectCommands } from './commands/loader.js';
import { readGitIndex } from './git-index.js';
import { hookFingerprint } from './hook-approvals.js';
import { resolveMcpServerList } from './mcp-config.js';
import { getProjectMemoryDir, loadMemoryContext, sessionMemoryContext } from './memory-store.js';
import { collectShippedHomeNotices } from './project-approval-notices.js';
import {
  isShippedUserSettingsFile,
  isUserSettingsFile,
  migrateLegacyPermissions,
  resolveSettings,
  settingsLayerPaths,
} from './settings-loader.js';
import { skillRoots } from './skills.js';
import { discoverAgents } from './subagent-discovery.js';
import { defaultConfig } from './test/fixtures.js';
import { loadWorkspaceTrust, updateWorkspaceTrust } from './workspace-trust.js';

const GIT_IDENTITY = [
  '-c',
  'user.name=Test',
  '-c',
  'user.email=test@example.com',
  '-c',
  'init.defaultBranch=main',
  '-c',
  'core.autocrlf=false',
];

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', [...GIT_IDENTITY, ...args], {
    cwd,
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).toString();
}

function write(root: string, path: string, content: string): void {
  mkdirSync(join(root, path, '..'), { recursive: true });
  writeFileSync(join(root, path), content);
}

/** A repository at `root` that tracks `tracked` (relative path → content). */
function repository(root: string, tracked: Record<string, string>): void {
  git(root, ['init', '-q']);
  for (const [path, content] of Object.entries(tracked)) write(root, path, content);
  if (Object.keys(tracked).length > 0) git(root, ['add', '--', ...Object.keys(tracked)]);
}

/** Adds an index entry with no file behind it: `mode` 120000 a link, 160000 a submodule. */
function addIndexEntry(root: string, mode: string, path: string): void {
  const object =
    mode === '160000'
      ? 'a'.repeat(40)
      : git(root, ['hash-object', '-w', '--stdin'], 'target').trim();
  git(root, ['update-index', '--add', '--cacheinfo', `${mode},${object},${path}`]);
}

function lsFiles(root: string): Array<{ path: string; mode: number }> {
  return git(root, ['ls-files', '-s', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf('\t');
      return {
        mode: parseInt(record.slice(0, record.indexOf(' ')), 8),
        path: record.slice(tab + 1),
      };
    });
}

function hookSettings(command: string): string {
  return JSON.stringify({
    hooks: { PreToolUse: [{ command }] },
    permissions: { allow: ['Bash(echo *)'] },
  });
}

let dir: string;

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-home-files-')));
  vi.stubEnv('BOOK_HOME', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('readGitIndex', () => {
  const tracked = {
    '.a': 'a',
    '.book-x': 'b',
    '.book.x': 'c',
    '.book/agents/one.md': 'd',
    '.book/settings.json': 'e',
    '.book0': 'f',
    'src/deep/er/file.ts': 'g',
    'zz.txt': 'h',
  };

  for (const version of ['2', '3', '4']) {
    it(`lists what git lists in an index of version ${version}`, () => {
      repository(dir, tracked);
      // A name longer than the 12-bit length field records 0xFFF instead of its length.
      addIndexEntry(dir, '100644', Array.from({ length: 21 }, () => 'n'.repeat(200)).join('/'));
      addIndexEntry(dir, '120000', 'link');
      addIndexEntry(dir, '160000', 'module');
      git(dir, ['update-index', '--index-version', version]);
      if (version !== '2') git(dir, ['update-index', '--skip-worktree', '--', 'zz.txt']);

      expect(readGitIndex(join(dir, '.git', 'index'), 20)).toEqual(lsFiles(dir));
    });
  }

  it('stops before the first entry past the region asked for', () => {
    repository(dir, tracked);
    const entries = readGitIndex(join(dir, '.git', 'index'), 20, (path) => path >= '.book0');
    expect(entries?.map((entry) => entry.path)).toEqual([
      '.a',
      '.book-x',
      '.book.x',
      '.book/agents/one.md',
      '.book/settings.json',
    ]);
  });

  it('is undefined with no index, and throws on a file that is not one', () => {
    git(dir, ['init', '-q']);
    expect(readGitIndex(join(dir, '.git', 'index'), 20)).toBeUndefined();
    writeFileSync(join(dir, '.git', 'index'), 'DIRC\0\0\0\x09\0\0\0\x01');
    expect(() => readGitIndex(join(dir, '.git', 'index'), 20)).toThrow();
  });
});

describe('shippedHomeFiles', () => {
  it('names the files a checkout at the home directory tracks under .book, and only those', () => {
    repository(dir, {
      '.book-x': 'x',
      '.book/settings.json': '{}',
      '.book/commands/run.md': 'run',
      '.book0': 'y',
    });
    write(dir, '.book/sessions/one.jsonl', '{}');
    write(dir, '.book/trust.json', '{}');

    const shipped = shippedHomeFiles(dir, join(dir, '.book'));

    expect(shipped?.repository).toBe(dir);
    expect(shipped?.paths).toEqual(['commands/run.md', 'settings.json']);
    expect(shipped?.ships(join(dir, '.book', 'settings.json'))).toBe(true);
    expect(shipped?.ships(join(dir, '.book', 'commands', 'run.md'))).toBe(true);
    expect(shipped?.shipsAnyUnder(join(dir, '.book', 'commands'))).toBe(true);
    // Untracked files Book or the user wrote there stay theirs.
    expect(shipped?.ships(join(dir, '.book', 'trust.json'))).toBe(false);
    expect(shipped?.shipsAnyUnder(join(dir, '.book', 'sessions'))).toBe(false);
    // Neighbours of the home are not in it.
    expect(shipped?.ships(join(dir, '.book-x'))).toBe(false);
  });

  it('applies from a subdirectory of the repository too, and in every index version', () => {
    repository(dir, { '.book/settings.json': '{}', 'src/index.ts': '' });
    git(dir, ['update-index', '--index-version', '4']);
    expect(shippedHomeFiles(join(dir, 'src'), join(dir, '.book'))?.paths).toEqual([
      'settings.json',
    ]);
  });

  it('ships nothing for a dotfiles home that does not track .book', () => {
    repository(dir, { '.bashrc': 'x' });
    write(dir, '.book/settings.json', '{}');
    expect(shippedHomeFiles(dir, join(dir, '.book'))).toBeUndefined();
  });

  it('ships nothing for a home outside the workspace repository', () => {
    const project = join(dir, 'project');
    mkdirSync(project);
    repository(project, { 'a.txt': 'a' });
    const home = join(dir, 'home', '.book');
    write(dir, 'home/.book/settings.json', '{}');
    expect(shippedHomeFiles(project, home)).toBeUndefined();
    // Nor when the workspace is in no repository at all.
    expect(shippedHomeFiles(join(dir, 'home'), home)).toBeUndefined();
  });

  it('ships the whole home when the repository tracks it as a link or a submodule', () => {
    repository(dir, { 'a.txt': 'a' });
    write(dir, '.book/trust.json', '{}');
    addIndexEntry(dir, '160000', '.book');
    const shipped = shippedHomeFiles(dir, join(dir, '.book'));
    expect(shipped?.whole).toBe(true);
    expect(shipped?.ships(join(dir, '.book', 'trust.json'))).toBe(true);
  });

  it('ships a file the repository tracks as a link', () => {
    repository(dir, { 'a.txt': 'a' });
    addIndexEntry(dir, '120000', '.book/trust.json');
    expect(shippedHomeFiles(dir, join(dir, '.book'))?.ships(join(dir, '.book', 'trust.json'))).toBe(
      true,
    );
  });

  it('ships everything under the home when the index cannot be read', () => {
    repository(dir, { 'a.txt': 'a' });
    writeFileSync(join(dir, '.git', 'index'), 'not an index');
    const shipped = shippedHomeFiles(dir, join(dir, '.book'));
    expect(shipped?.unreadable).toBe(true);
    expect(shipped?.ships(join(dir, '.book', 'settings.json'))).toBe(true);
    expect(shipped?.ships(join(dir, 'a.txt'))).toBe(false);
  });

  it('reads a split index together with its shared index', () => {
    repository(dir, { '.book/settings.json': '{}' });
    git(dir, ['update-index', '--split-index']);
    write(dir, '.book/mcp.json', '{}');
    git(dir, ['add', '--', '.book/mcp.json']);
    expect(shippedHomeFiles(dir, join(dir, '.book'))?.paths).toEqual(['mcp.json', 'settings.json']);
  });
});

describe('a Book home the workspace repository ships files in', () => {
  /** HOME is a checkout of a repository that ships `.book/settings.json` (and `extra`). */
  function checkoutAtHome(extra: Record<string, string> = {}): string {
    const home = join(dir, 'app');
    mkdirSync(home);
    repository(home, { '.book/settings.json': hookSettings('repository-hook'), ...extra });
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    return home;
  }

  it('reads a tracked settings.json only as the gated project layer', () => {
    const home = checkoutAtHome();
    const paths = { home };

    expect(isShippedUserSettingsFile(home, paths)).toBe(true);
    expect(isUserSettingsFile(join(home, '.book', 'settings.json'), home, paths)).toBe(false);
    expect(settingsLayerPaths(home, undefined, paths)).toContain(
      join(home, '.book', 'settings.json'),
    );

    // Withheld as any project file's would be...
    const withheld = resolveSettings(home, undefined, paths);
    expect(withheld.hooks.PreToolUse).toEqual([]);
    expect(withheld.permissions.allow).toEqual([]);

    // ...and released by a decision in an untracked trust store in the same home.
    const recorded = updateWorkspaceTrust(
      home,
      (trust) => {
        trust.hookEntries[hookFingerprint('PreToolUse', { command: 'repository-hook', env: {} })] =
          'approved';
      },
      join(home, '.book', 'trust.json'),
    );
    expect(recorded).toEqual({ ok: true });
    const released = resolveSettings(home, undefined, paths);
    expect(released.hooks.PreToolUse.map((hook) => hook.command)).toEqual(['repository-hook']);
  });

  it('does not read a tracked settings.json that is not the workspace project file', () => {
    const home = checkoutAtHome({ 'src/a.ts': '' });
    const workspace = join(home, 'src');
    const settings = resolveSettings(workspace, undefined, { home });
    expect(settings.hooks.PreToolUse).toEqual([]);
    expect(settings.permissions.allow).toEqual([]);
  });

  it('ignores a tracked trust store and refuses to record decisions in it', () => {
    const home = checkoutAtHome({ '.book/trust.json': '{}' });
    const storePath = join(home, '.book', 'trust.json');
    const fingerprint = hookFingerprint('PreToolUse', { command: 'repository-hook', env: {} });
    writeFileSync(
      storePath,
      JSON.stringify({
        version: 4,
        // The store's own key: case folds on Windows.
        workspaces: {
          [process.platform === 'win32' ? home.toLowerCase() : home]: {
            hookEntries: { [fingerprint]: 'approved' },
          },
        },
      }),
    );

    expect(loadWorkspaceTrust(home, storePath).hookEntries).toEqual({});
    expect(resolveSettings(home, undefined, { home }).hooks.PreToolUse).toEqual([]);
    const refused = updateWorkspaceTrust(home, () => {}, storePath);
    expect(refused.ok).toBe(false);
    expect(refused.error).toMatch(/BOOK_HOME/);
  });

  it('does not migrate tracked legacy permissions into the local layer', () => {
    const home = checkoutAtHome({
      '.book/permissions.json': JSON.stringify({ rules: [{ toolName: 'Bash', effect: 'allow' }] }),
    });
    expect(migrateLegacyPermissions(home, home)).toBe(false);
    expect(resolveSettings(home, undefined, { home }).permissions.allow).toEqual([]);
  });

  it('reads no tracked mcp.json, AGENTS.md or memory, and commands, agents and skills only as project', () => {
    const home = checkoutAtHome({
      '.book/mcp.json': JSON.stringify({ mcpServers: { tool: { command: 'tool' } } }),
      '.book/AGENTS.md': 'repository instructions',
      '.book/commands/run.md': 'run it',
      '.book/agents/helper.md': '---\nname: helper\ndescription: helps\n---\nbody',
      '.book/skills/one/SKILL.md': '---\nname: one\ndescription: one\n---\nbody',
    });
    vi.stubEnv('BOOK_HOME', join(home, '.book'));
    const memoryDir = getProjectMemoryDir(home, { bookRoot: join(home, '.book') });
    const memoryIndex = join(memoryDir, 'MEMORY.md').slice(home.length + 1);
    write(home, memoryIndex, '- [x](x.md) — repository memory');
    git(home, ['add', '--', memoryIndex]);

    expect(resolveMcpServerList(home, { home, onDiagnostic: () => {} })).toEqual([]);
    expect(
      inspectProjectInstructions(home, home).sources.some((source) =>
        source.path.endsWith(join('.book', 'AGENTS.md')),
      ),
    ).toBe(false);
    expect(inspectCommands(home).commands.map((command) => command.source)).toEqual(['project']);
    expect(discoverAgents(home).map((agent) => agent.source)).toEqual(['project']);
    expect(
      skillRoots(home, { homeDir: home, includeOpenCode: false }).filter(
        (root) => root.kind === 'book',
      ),
    ).toEqual([{ path: join(home, '.book', 'skills'), source: 'project', kind: 'book' }]);
    expect(loadMemoryContext(home, { bookRoot: join(home, '.book') }).indexLoaded).toBe(false);
    // No memory directory there for the session to read or write.
    expect(sessionMemoryContext(home, true, { bookRoot: join(home, '.book') })).toBeUndefined();
  });

  it('keeps managed agents in memory when the repository tracks records for them', async () => {
    const home = checkoutAtHome();
    vi.stubEnv('BOOK_HOME', join(home, '.book'));
    const record = `.book/agents/${repositoryHash(home)}/agents/one.json`;
    write(home, record, '{}');
    git(home, ['add', '--', record]);
    const config = defaultConfig({ workspace: home });
    config.settings.agents.persist = true;
    const createStore = vi.fn((hash: string, root: string | undefined, enabled: boolean) =>
      AgentStore.open(hash, root, enabled),
    );
    const manager = new AgentManager(config, [], { findGitRoot: async () => home, createStore });
    try {
      await manager.list();
      expect(createStore).toHaveBeenCalledWith(
        repositoryHash(home),
        undefined,
        false,
        expect.anything(),
      );
    } finally {
      manager.dispose();
    }
  });

  it('says so once, naming what the repository tracks', () => {
    const home = checkoutAtHome({ '.book/trust.json': '{}' });
    const notices = collectShippedHomeNotices(home, join(home, '.book'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('settings.json, trust.json');
    expect(notices[0]).toContain('Set BOOK_HOME to a directory outside the repository');
  });

  it('leaves a dotfiles home with an untracked .book as it was', () => {
    const home = join(dir, 'home');
    mkdirSync(home);
    repository(home, { '.bashrc': 'x' });
    write(home, '.book/settings.json', hookSettings('user-hook'));
    write(home, '.book/commands/run.md', 'run it');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('BOOK_HOME', join(home, '.book'));

    expect(isUserSettingsFile(join(home, '.book', 'settings.json'), home, { home })).toBe(true);
    const settings = resolveSettings(home, undefined, { home });
    expect(settings.hooks.PreToolUse.map((hook) => hook.command)).toEqual(['user-hook']);
    expect(settings.permissions.allow).toEqual(['Bash(echo *)']);
    expect(inspectCommands(home).commands.map((command) => command.source)).toEqual(['user']);
    expect(collectShippedHomeNotices(home, join(home, '.book'))).toEqual([]);
  });

  it('leaves an explicit BOOK_HOME outside the repository as it was', () => {
    const home = checkoutAtHome();
    const elsewhere = join(dir, 'elsewhere');
    write(dir, 'elsewhere/settings.json', hookSettings('user-hook'));
    vi.stubEnv('BOOK_HOME', elsewhere);

    const settings = resolveSettings(home);
    expect(isShippedUserSettingsFile(home)).toBe(false);
    // The user file is trusted; the checkout's own file is the gated project layer, as always.
    expect(settings.hooks.PreToolUse.map((hook) => hook.command)).toEqual(['user-hook']);
    expect(settings.permissions.allow).toEqual(['Bash(echo *)']);
    expect(collectShippedHomeNotices(home)).toEqual([]);
  });
});
