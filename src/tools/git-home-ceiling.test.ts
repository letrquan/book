import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { homeGitCeiling, ignoresHomeRepository, isInGitRepository } from '../repo-containment.js';
import { resolveReviewTarget } from '../review/target.js';
import type { ReviewScope } from '../review/types.js';
import { isInsideWorkTree } from '../tui/hooks/useGitStatus.js';
import type { ResolvedShell } from '../types/runtime.js';
import type { ToolContext, ToolDefinition, ToolResult } from '../types/tools.js';
import { gitTools, hardenedGitEnv } from './git.js';
import { shellTools } from './shell.js';

// A dotfiles repository at the home directory is not the repository of a project below it that
// has no `.git` of its own (#567). Book's own git carries the home directory as a
// `GIT_CEILING_DIRECTORIES` entry when it holds a `.git`, so the Git tools and `/review` find no
// repository there, while a workspace that is the home directory still finds it (#579). The
// user's own `Bash` is left alone.

const READ_ONLY_TOOLS = ['GitStatus', 'GitDiff', 'GitLog', 'GitBranch'] as const;
const SCOPE: ReviewScope = { deep: false, fix: false, help: false };
const SHELL: ResolvedShell =
  process.platform === 'win32'
    ? { kind: 'cmd', label: 'cmd.exe', source: 'fallback' }
    : { kind: 'sh', label: '/bin/sh', source: 'detected' };

let root: string;
let home: string;

/** A real repository with one commit: `rev-parse HEAD` fails on an unborn branch. */
function repository(at: string): void {
  mkdirSync(at, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: at, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'base',
  );
}

/** How many commits `HEAD` has in the repository at `at`. */
function commits(at: string): number {
  return Number(
    execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: at }).toString().trim(),
  );
}

/** A commit identity for `GitCommit`, which runs with Book's environment and no config of its own. */
function stubIdentity(): void {
  vi.stubEnv('GIT_AUTHOR_NAME', 'Test');
  vi.stubEnv('GIT_AUTHOR_EMAIL', 'test@example.com');
  vi.stubEnv('GIT_COMMITTER_NAME', 'Test');
  vi.stubEnv('GIT_COMMITTER_EMAIL', 'test@example.com');
}

function tool(definitions: ToolDefinition[], name: string): ToolDefinition {
  const found = definitions.find((definition) => definition.name === name);
  if (!found) throw new Error(`Missing tool ${name}`);
  return found;
}

/** A context like the agent's, whose `env` is Book's own environment. */
function context(workspaceRoot: string): ToolContext {
  return { workspaceRoot, env: process.env as Record<string, string>, shell: SHELL };
}

function failure(result: ToolResult): string {
  return `${result.structuredError?.message ?? ''}${result.content}`;
}

/** A path as git prints it on any platform, for comparing with a native one. */
function shown(path: string): string {
  const forward = path.trim().replace(/\\/g, '/');
  return process.platform === 'win32' ? forward.toLowerCase() : forward;
}

beforeEach(() => {
  // The long form on Windows, as git reports it, not the runner's 8.3 temp path.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-git-ceiling-')));
  home = join(root, 'home');
  mkdirSync(home);
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('GIT_CEILING_DIRECTORIES', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
});

describe('a project below a home directory that holds a .git, with none of its own', () => {
  let proj: string;

  beforeEach(() => {
    repository(home);
    proj = join(home, 'proj');
    mkdirSync(proj);
    writeFileSync(join(proj, 'a.txt'), 'a\n');
  });

  it('gives Book’s own git the home directory as a ceiling', () => {
    expect(homeGitCeiling()).toBe(home);
    expect(hardenedGitEnv().GIT_CEILING_DIRECTORIES).toBe(home);
    expect(ignoresHomeRepository(home, proj)).toBe(true);
  });

  it('is in no repository for the read-only Git tools', async () => {
    for (const name of READ_ONLY_TOOLS) {
      const result = await tool(gitTools, name).execute({}, context(proj));
      expect(result.status, name).toBe('error');
      expect(failure(result), name).toMatch(/not a git repository/i);
    }
    // The ceiling is the calls' own: Book's environment is unchanged.
    expect(process.env.GIT_CEILING_DIRECTORIES).toBeUndefined();
  });

  it('is in no repository for GitCommit, which commits nothing to the home repository', async () => {
    stubIdentity();
    execFileSync('git', ['add', '--', join('proj', 'a.txt')], { cwd: home, stdio: 'ignore' });

    const result = await tool(gitTools, 'GitCommit').execute({ message: 'x' }, context(proj));

    expect(result.status).toBe('error');
    expect(failure(result)).toMatch(/not a git repository/i);
    expect(commits(home)).toBe(1);
  });

  it('is in no repository for the /review target', async () => {
    await expect(resolveReviewTarget(proj, SCOPE)).rejects.toThrow(/not a git repository/i);
  });

  it('is no working tree for the status poll', () => {
    expect(isInsideWorkTree(proj)).toBe(false);
  });

  it('leaves the user’s Bash seeing the home repository', async () => {
    const bash = tool(shellTools, 'Bash');
    const result = await bash.execute({ command: 'git rev-parse --show-toplevel' }, context(proj));

    expect(result.status).toBe('success');
    expect(result.content.split(/\r?\n/).map(shown)).toContain(shown(home));
  });

  it('keeps a project with its own .git in its repository', async () => {
    const own = join(home, 'own');
    repository(own);
    mkdirSync(join(own, 'pkg'));

    expect(ignoresHomeRepository(own, join(own, 'pkg'))).toBe(false);
    expect(isInsideWorkTree(join(own, 'pkg'))).toBe(true);
    const status = await tool(gitTools, 'GitBranch').execute({}, context(join(own, 'pkg')));
    expect(status.status).toBe('success');
    expect(status.content).toContain('main');
  });

  it('appends the home directory to a ceiling the operator exported', () => {
    const exported = join(root, 'elsewhere');
    vi.stubEnv('GIT_CEILING_DIRECTORIES', exported);

    expect(hardenedGitEnv().GIT_CEILING_DIRECTORIES).toBe(`${exported}${delimiter}${home}`);
  });

  // Git walks up from the real working directory, so the walk that decides without git does too:
  // a link under the home directory into a repository elsewhere is in that repository, not in the
  // dotfiles one the path as written passes through.
  it.skipIf(process.platform === 'win32')(
    'follows the real path of a workspace linked from under the home directory',
    async () => {
      const repo = join(root, 'elsewhere', 'repo');
      repository(repo);
      mkdirSync(join(repo, 'sub'));
      const linked = join(home, 'linked');
      symlinkSync(join(repo, 'sub'), linked);

      expect(isInGitRepository(linked)).toBe(true);
      expect(isInsideWorkTree(linked)).toBe(true);
      const branch = await tool(gitTools, 'GitBranch').execute({}, context(linked));
      expect(branch.status).toBe('success');
      expect(branch.content).toContain('main');
    },
  );

  it.skipIf(process.platform === 'win32')('compares real paths: a home reached by a link', () => {
    symlinkSync(home, join(root, 'home-link'));
    vi.stubEnv('HOME', join(root, 'home-link'));

    expect(homeGitCeiling()).toBe(home);
    expect(isInsideWorkTree(join(root, 'home-link', 'proj'))).toBe(false);
    expect(isInsideWorkTree(join(root, 'home-link'))).toBe(true);
  });
});

describe('a workspace that is the home directory, which holds a .git', () => {
  beforeEach(() => {
    repository(home);
    writeFileSync(join(home, 'notes.txt'), 'notes\n');
  });

  it('is in the home repository for the Git tools, /review and the status poll', async () => {
    expect(ignoresHomeRepository(home, home)).toBe(false);
    expect(isInsideWorkTree(home)).toBe(true);
    for (const name of READ_ONLY_TOOLS) {
      const result = await tool(gitTools, name).execute({}, context(home));
      expect(result.status, name).toBe('success');
    }
    const branch = await tool(gitTools, 'GitBranch').execute({}, context(home));
    expect(branch.content).toContain('main');

    const target = await resolveReviewTarget(home, SCOPE);
    expect(target.kind).toBe('working-tree');
    expect(target.changedFiles).toContain('notes.txt');
  });

  it('is in the home repository for GitCommit', async () => {
    stubIdentity();
    execFileSync('git', ['add', '--', 'notes.txt'], { cwd: home, stdio: 'ignore' });

    const result = await tool(gitTools, 'GitCommit').execute({ message: 'notes' }, context(home));

    expect(result.status).toBe('success');
    expect(commits(home)).toBe(2);
  });
});

describe('a home directory with no .git', () => {
  it('sets no ceiling, so a repository above the home directory is still found', async () => {
    repository(root);
    const proj = join(home, 'proj');
    mkdirSync(proj);
    writeFileSync(join(proj, 'a.txt'), 'a\n');

    expect(homeGitCeiling()).toBeUndefined();
    expect(hardenedGitEnv()).not.toHaveProperty('GIT_CEILING_DIRECTORIES');
    expect(isInsideWorkTree(proj)).toBe(true);
    for (const name of READ_ONLY_TOOLS) {
      const result = await tool(gitTools, name).execute({}, context(proj));
      expect(result.status, name).toBe('success');
    }
    // Untracked files are listed relative to the workspace, as `git ls-files` prints them.
    const target = await resolveReviewTarget(proj, SCOPE);
    expect(target.changedFiles).toContain('a.txt');
  });

  it('leaves an exported ceiling to the environment it came from', () => {
    vi.stubEnv('GIT_CEILING_DIRECTORIES', join(root, 'elsewhere'));

    expect(hardenedGitEnv()).not.toHaveProperty('GIT_CEILING_DIRECTORIES');
  });
});
