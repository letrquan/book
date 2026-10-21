import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, relative } from 'path';
import {
  MAX_INDEX_BYTES,
  deleteMemoryEntry,
  findGitRoot,
  getMemoryHealth,
  getNewestMemoryWriteTime,
  getProjectMemoryDir,
  listMemoryFiles,
  loadMemoryContext,
  memoryFileForSlug,
  memoryWriteScope,
  migrateLegacyMemoryDir,
  sanitizeMemorySlug,
  shortenAtWord,
  slugifyWorkspace,
} from './memory-store.js';

describe('shortenAtWord', () => {
  it('returns text that fits unchanged', () => {
    expect(shortenAtWord('short text', 10)).toBe('short text');
  });

  it('cuts at a word boundary and ends with an ellipsis within max', () => {
    const out = shortenAtWord('alpha beta gamma delta', 14);
    expect(out).toBe('alpha beta…');
    expect(out.length).toBeLessThanOrEqual(14);
    // The cut falling exactly on a space keeps the whole words before it.
    expect(shortenAtWord('alpha beta gamma', 11)).toBe('alpha beta…');
  });

  it('never cuts inside a backtick span: it backs up to before the opening backtick', () => {
    expect(shortenAtWord('see `some long code span` here', 16)).toBe('see…');
    expect(shortenAtWord('`migrateLegacyMemoryFormat` src/x', 40)).toBe(
      '`migrateLegacyMemoryFormat` src/x',
    );
    // A closed span before the cut is kept.
    expect(shortenAtWord('use `a` then `bcdefgh ijkl` now', 24)).toBe('use `a` then…');
  });

  it('leaves only an ellipsis when a single word is too long', () => {
    expect(shortenAtWord('supercalifragilistic', 8)).toBe('…');
    expect(shortenAtWord('`supercalifragilistic`', 8)).toBe('…');
  });

  it('handles non-ASCII text without splitting a character', () => {
    const out = shortenAtWord('Résumé de la réunion — café 日本語 😀😀 notes', 22);
    expect(out).toBe('Résumé de la réunion…');
    expect(out.length).toBeLessThanOrEqual(22);
    expect(shortenAtWord('😀😀😀 😀😀😀', 8)).toBe('😀😀😀…');
  });
});

let bookRoot: string;

beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'book-memory-'));
});

afterEach(() => {
  rmSync(bookRoot, { recursive: true, force: true });
});

describe('memory store paths', () => {
  it('slugifies workspace paths using the existing convention', () => {
    expect(slugifyWorkspace('C:\\fake\\book test')).toBe('C-fake-book-test');
    expect(slugifyWorkspace('/home/me/project')).toBe('home-me-project');
    expect(slugifyWorkspace('weird ! name')).toBe('weird---name');
  });

  it('resolves the memory directory under the injected book root', () => {
    const ws = makeGitRepo('book-test-ws');
    expect(getProjectMemoryDir(ws, { bookRoot })).toBe(
      join(bookRoot, 'projects', slugifyWorkspace(ws), 'memory'),
    );
  });
});

/** A scratch tree for fake repositories; removed after each test. */
let scratch: string;
beforeEach(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'book-memory-root-')));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** `<scratch>/<name>` with a `.git` directory. */
function makeGitRepo(name: string): string {
  const root = join(scratch, name);
  mkdirSync(join(root, '.git'), { recursive: true });
  return root;
}

/**
 * A linked worktree of `main`, laid out as `git worktree add` writes it: `.git` is a file pointing
 * into `main/.git/worktrees/<name>`, whose `commondir` leads back to `main/.git` and whose
 * `gitdir` names the worktree's `.git`.
 */
function makeLinkedWorktree(main: string, name: string): string {
  const gitDir = join(main, '.git', 'worktrees', name);
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'commondir'), '../..\n');
  const worktree = join(scratch, name);
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`);
  writeFileSync(join(gitDir, 'gitdir'), `${join(worktree, '.git')}\n`);
  return worktree;
}

/**
 * `git` in `cwd` with a throwaway identity and no user config, and none of the `GIT_*` variables a
 * git hook running the suite exports (`GIT_DIR`, `GIT_INDEX_FILE`, …), which would aim it at the
 * developer's own repository.
 */
function git(cwd: string, ...args: string[]): void {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')),
  );
  const globalConfig = join(scratch, '.gitconfig-empty');
  writeFileSync(globalConfig, '');
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Book Test',
      '-c',
      'user.email=book@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    {
      cwd,
      stdio: 'ignore',
      env: { ...env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: '1' },
    },
  );
}

describe('findGitRoot', () => {
  it('is the repository root for a checkout', () => {
    const repo = makeGitRepo('repo');
    expect(findGitRoot(repo)).toBe(repo);
  });

  it('is the repository root for a subdirectory, existing or not', () => {
    const repo = makeGitRepo('repo');
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    expect(findGitRoot(join(repo, 'src', 'deep'))).toBe(repo);
    expect(findGitRoot(join(repo, 'not', 'created'))).toBe(repo);
  });

  it('maps a linked worktree to its main checkout', () => {
    const main = makeGitRepo('main');
    const worktree = makeLinkedWorktree(main, 'wt');
    mkdirSync(join(worktree, 'pkg'));
    expect(findGitRoot(worktree)).toBe(main);
    expect(findGitRoot(join(worktree, 'pkg'))).toBe(main);
    expect(getProjectMemoryDir(worktree, { bookRoot })).toBe(
      getProjectMemoryDir(main, { bookRoot }),
    );
  });

  // The layout git >= 2.48 writes with `worktree.useRelativePaths`: every pointer is relative,
  // and the entry's `gitdir` resolves against the entry itself.
  it('resolves a relative gitdir against the directory holding the .git file', () => {
    const main = makeGitRepo('main');
    mkdirSync(join(main, '.git', 'worktrees', 'rel'), { recursive: true });
    writeFileSync(join(main, '.git', 'worktrees', 'rel', 'commondir'), '../..');
    // Only the first line counts, as in the `.git` file.
    writeFileSync(join(main, '.git', 'worktrees', 'rel', 'gitdir'), '../../../../rel/.git\r\nx\n');
    const worktree = join(scratch, 'rel');
    mkdirSync(worktree);
    writeFileSync(join(worktree, '.git'), 'gitdir: ../main/.git/worktrees/rel');
    expect(findGitRoot(worktree)).toBe(main);
  });

  it('is its own root for a .git file without commondir (submodule, separate git dir)', () => {
    const sub = join(scratch, 'sub');
    mkdirSync(join(sub, 'inner'), { recursive: true });
    mkdirSync(join(scratch, 'elsewhere', 'modules', 'sub'), { recursive: true });
    writeFileSync(join(sub, '.git'), `gitdir: ${join(scratch, 'elsewhere', 'modules', 'sub')}\n`);
    expect(findGitRoot(sub)).toBe(sub);
    expect(findGitRoot(join(sub, 'inner'))).toBe(sub);
  });

  it('is its own root when a commondir does not end in .git', () => {
    const odd = join(scratch, 'odd');
    mkdirSync(odd);
    const gitDir = join(scratch, 'store', 'odd');
    mkdirSync(gitDir, { recursive: true });
    writeFileSync(join(gitDir, 'commondir'), '.');
    writeFileSync(join(odd, '.git'), `gitdir: ${gitDir}`);
    expect(findGitRoot(odd)).toBe(odd);
  });

  it('maps a worktree made by git worktree add to its main checkout', () => {
    const main = join(scratch, 'main');
    mkdirSync(main);
    git(main, 'init', '--quiet');
    git(main, 'commit', '--quiet', '--allow-empty', '-m', 'init');
    const worktree = join(scratch, 'wt');
    git(main, 'worktree', 'add', '--quiet', worktree);
    mkdirSync(join(worktree, 'pkg'));

    // Git writes long paths on Windows, where the temp dir may have an 8.3 short name.
    const real = (path: string) => realpathSync.native(path);
    expect(real(findGitRoot(worktree))).toBe(real(main));
    expect(real(findGitRoot(join(worktree, 'pkg')))).toBe(real(main));
  });

  // #575: a `.git` file in an archive or a shared directory named another project's `.git` as its
  // common dir, and the session took that project's memory key.
  describe('a .git file its main checkout does not list back (#575)', () => {
    it('keys a checkout naming another repository as its common dir by itself', () => {
      const victim = makeGitRepo('victim');
      const archive = join(scratch, 'archive');
      mkdirSync(join(archive, 'g'), { recursive: true });
      mkdirSync(join(archive, 'src'));
      writeFileSync(join(archive, '.git'), 'gitdir: ./g\n');
      writeFileSync(join(archive, 'g', 'commondir'), `${join(victim, '.git')}\n`);
      // A back-pointer of its own does not help: its git dir is none of the victim's worktrees.
      writeFileSync(join(archive, 'g', 'gitdir'), `${join(archive, '.git')}\n`);

      expect(findGitRoot(archive)).toBe(archive);
      expect(findGitRoot(join(archive, 'src'))).toBe(archive);
      expect(getProjectMemoryDir(archive, { bookRoot })).not.toBe(
        getProjectMemoryDir(victim, { bookRoot }),
      );
    });

    it('keys a relative commondir aimed at a .git above by the workspace', () => {
      const outer = makeGitRepo('outer');
      const archive = join(outer, 'vendor', 'archive');
      mkdirSync(join(archive, 'g'), { recursive: true });
      writeFileSync(join(archive, '.git'), 'gitdir: ./g\n');
      writeFileSync(join(archive, 'g', 'commondir'), '../../../.git\n');
      writeFileSync(join(archive, 'g', 'gitdir'), `${join(archive, '.git')}\n`);

      expect(findGitRoot(archive)).toBe(archive);
    });

    it("keys a copy of a real worktree's .git file by itself", () => {
      const main = makeGitRepo('main');
      makeLinkedWorktree(main, 'wt');
      const copy = join(scratch, 'copy');
      mkdirSync(copy);
      writeFileSync(join(copy, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'wt')}\n`);

      expect(findGitRoot(copy)).toBe(copy);
    });

    it('keys a worktree whose entry has no gitdir back-pointer by itself', () => {
      const main = makeGitRepo('main');
      const worktree = makeLinkedWorktree(main, 'wt');
      rmSync(join(main, '.git', 'worktrees', 'wt', 'gitdir'));

      expect(findGitRoot(worktree)).toBe(worktree);
    });

    it('keys a worktree whose entry it cannot read by itself, from any subdirectory', () => {
      const main = makeGitRepo('main');
      const worktree = makeLinkedWorktree(main, 'wt');
      mkdirSync(join(worktree, 'pkg'));
      rmSync(join(main, '.git', 'worktrees', 'wt', 'gitdir'));
      mkdirSync(join(main, '.git', 'worktrees', 'wt', 'gitdir'));

      expect(findGitRoot(worktree)).toBe(worktree);
      expect(findGitRoot(join(worktree, 'pkg'))).toBe(worktree);
    });

    it.skipIf(process.platform === 'win32')(
      "keys a .git link to a real worktree's .git file by itself",
      () => {
        const main = makeGitRepo('main');
        const worktree = makeLinkedWorktree(main, 'wt');
        const archive = join(scratch, 'archive');
        mkdirSync(archive);
        symlinkSync(join(worktree, '.git'), join(archive, '.git'));

        expect(findGitRoot(archive)).toBe(archive);
        expect(findGitRoot(worktree)).toBe(main);
      },
    );
  });

  it('is the workspace itself outside any repository', () => {
    const plain = join(scratch, 'plain', 'dir');
    mkdirSync(plain, { recursive: true });
    expect(findGitRoot(plain)).toBe(plain);
  });

  it('gives a relative workspace the key of the absolute one', ({ skip }) => {
    const repo = makeGitRepo('repo');
    mkdirSync(join(repo, 'src'));
    const relativeWorkspace = relative(process.cwd(), join(repo, 'src'));
    if (isAbsolute(relativeWorkspace)) {
      skip('no relative path from the cwd to the temp dir (different drive)');
    }
    expect(findGitRoot(relativeWorkspace)).toBe(repo);
    expect(getProjectMemoryDir(relativeWorkspace, { bookRoot })).toBe(
      getProjectMemoryDir(join(repo, 'src'), { bookRoot }),
    );
  });

  it('follows a symlinked workspace', () => {
    const repo = makeGitRepo('repo');
    mkdirSync(join(repo, 'src'));
    const link = join(scratch, 'link');
    symlinkSync(join(repo, 'src'), link);
    expect(findGitRoot(link)).toBe(repo);
  });

  it('falls back to the workspace on a garbage .git file', () => {
    const repo = makeGitRepo('repo');
    const inner = join(repo, 'inner');
    mkdirSync(inner);
    writeFileSync(join(inner, '.git'), 'this is not a gitdir pointer\n');
    expect(findGitRoot(inner)).toBe(inner);
    writeFileSync(join(inner, '.git'), '');
    expect(findGitRoot(inner)).toBe(inner);
  });

  it('falls back to the workspace on a .git file too big to be a pointer', () => {
    const repo = makeGitRepo('repo');
    const inner = join(repo, 'inner');
    mkdirSync(inner);
    writeFileSync(join(inner, '.git'), `gitdir: ${join(repo, '.git')}\n${'x'.repeat(64 * 1024)}`);
    expect(findGitRoot(inner)).toBe(inner);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'falls back to the workspace on an unreadable .git file',
    () => {
      const repo = makeGitRepo('repo');
      const inner = join(repo, 'inner');
      mkdirSync(inner);
      writeFileSync(join(inner, '.git'), `gitdir: ${join(repo, '.git')}\n`);
      chmodSync(join(inner, '.git'), 0o000);
      try {
        expect(findGitRoot(inner)).toBe(inner);
      } finally {
        chmodSync(join(inner, '.git'), 0o600);
      }
    },
  );
});

// A dotfiles repository at the home directory is no project (#567): taking it as the root, every
// project under the home directory without its own `.git` shared the home directory's memory.
describe('findGitRoot and a dotfiles ~/.git', () => {
  let home: string;

  beforeEach(() => {
    home = makeGitRepo('home');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keys a project under the home directory without its own .git by the project', () => {
    const proj = join(home, 'code', 'proj');
    mkdirSync(join(proj, 'src'), { recursive: true });

    expect(findGitRoot(proj)).toBe(proj);
    expect(findGitRoot(join(proj, 'src'))).toBe(join(proj, 'src'));
    expect(getProjectMemoryDir(proj, { bookRoot })).toBe(
      join(bookRoot, 'projects', slugifyWorkspace(proj), 'memory'),
    );
    expect(findGitRoot(home)).toBe(home);
  });

  it('keeps a project with its own .git under the home directory keyed by its root', () => {
    const repo = join(home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(repo, 'pkg'));

    expect(findGitRoot(join(repo, 'pkg'))).toBe(repo);
  });

  it('still maps a linked worktree to its main checkout under the home directory', () => {
    const main = join(home, 'main');
    mkdirSync(join(main, '.git'), { recursive: true });
    const worktree = makeLinkedWorktree(main, 'wt');

    expect(findGitRoot(worktree)).toBe(main);
  });

  // Only a `.git` at the home directory is no repository, as in `findRepositoryRoot`; a linked
  // worktree of the dotfiles repository elsewhere still maps to its main checkout.
  it('maps a linked worktree of the home repository to the home directory, as before', () => {
    const worktree = makeLinkedWorktree(home, 'dotfiles-wt');

    expect(findGitRoot(worktree)).toBe(home);
  });

  // #575: the home repository does not list this git dir as one of its worktrees, so the pointer
  // is no worktree's, and the home directory's key stays out of reach.
  it('keys a crafted relative commondir aimed at the home .git by the workspace', () => {
    const archive = join(home, 'proj', 'archive');
    mkdirSync(join(archive, 'g'), { recursive: true });
    writeFileSync(join(archive, '.git'), 'gitdir: ./g\n');
    writeFileSync(join(archive, 'g', 'commondir'), '../../../.git\n');
    writeFileSync(join(archive, 'g', 'gitdir'), `${join(archive, '.git')}\n`);

    expect(findGitRoot(archive)).toBe(archive);
    expect(getProjectMemoryDir(archive, { bookRoot })).not.toBe(
      getProjectMemoryDir(home, { bookRoot }),
    );
  });

  it.skipIf(process.platform === 'win32')('compares real paths: a home reached by a link', () => {
    const proj = join(home, 'proj');
    mkdirSync(proj);
    symlinkSync(home, join(scratch, 'home-link'));
    vi.stubEnv('HOME', join(scratch, 'home-link'));

    expect(findGitRoot(proj)).toBe(proj);
  });

  it('leaves memory stored under the home directory key where it is', () => {
    const proj = join(home, 'proj');
    mkdirSync(proj);
    const homeMemory = getProjectMemoryDir(home, { bookRoot });
    mkdirSync(homeMemory, { recursive: true });
    writeFileSync(join(homeMemory, 'shared.md'), 'from the home key');
    const projMemory = join(bookRoot, 'projects', slugifyWorkspace(proj), 'memory');
    mkdirSync(projMemory, { recursive: true });
    writeFileSync(join(projMemory, 'own.md'), 'from the project key');

    migrateLegacyMemoryDir(proj, { bookRoot });

    expect(readdirSync(homeMemory)).toEqual(['shared.md']);
    expect(getProjectMemoryDir(proj, { bookRoot })).toBe(projMemory);
    expect(readdirSync(projMemory)).toEqual(['own.md']);
  });
});

describe('moving the old workspace-keyed directory', () => {
  /** The directory the old key named: the workspace string as given. */
  const oldDirOf = (ws: string) => join(bookRoot, 'projects', slugifyWorkspace(ws), 'memory');
  const topic = (title: string) => `---\ntype: project\nstatus: approved\n---\n# ${title}\nBody`;

  function setup() {
    const repo = makeGitRepo('repo');
    const ws = join(repo, 'src');
    mkdirSync(ws);
    return { repo, ws, oldDir: oldDirOf(ws), newDir: getProjectMemoryDir(ws, { bookRoot }) };
  }

  it('renames the old directory when the new one is missing', () => {
    const { ws, oldDir, newDir } = setup();
    mkdirSync(join(oldDir, '.inbox'), { recursive: true });
    writeFileSync(join(oldDir, 'MEMORY.md'), '# Book memory index\n- [A](a.md) — project\n');
    writeFileSync(join(oldDir, 'a.md'), topic('A'));
    writeFileSync(join(oldDir, '.extraction-state.json'), '{}');
    writeFileSync(join(oldDir, '.inbox', 'c.md'), topic('C'));

    migrateLegacyMemoryDir(ws, { bookRoot });

    expect(existsSync(oldDir)).toBe(false);
    expect(readdirSync(newDir).sort()).toEqual([
      '.extraction-state.json',
      '.inbox',
      'MEMORY.md',
      'a.md',
    ]);
    expect(readFileSync(join(newDir, 'MEMORY.md'), 'utf-8')).toContain('[A](a.md)');
    // An existing inbox comes along untouched; it is no longer read, and is left for the migration.
    expect(existsSync(join(newDir, '.inbox', 'c.md'))).toBe(true);
    expect(existsSync(join(newDir, '.extraction-state.json'))).toBe(true);
  });

  it('does nothing when the old and new keys are the same', () => {
    const repo = makeGitRepo('same');
    const dir = getProjectMemoryDir(repo, { bookRoot });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.md'), topic('A'));
    migrateLegacyMemoryDir(repo, { bookRoot });
    expect(readdirSync(dir)).toEqual(['a.md']);
  });

  it('merges when both exist, keeping both files of a colliding name', () => {
    const { ws, oldDir, newDir } = setup();
    mkdirSync(join(oldDir, '.inbox', 'discarded'), { recursive: true });
    mkdirSync(join(newDir, '.inbox'), { recursive: true });
    writeFileSync(join(oldDir, 'a.md'), topic('Old A'));
    writeFileSync(join(oldDir, 'b.md'), topic('Old B'));
    writeFileSync(join(oldDir, 'note.txt'), 'not markdown');
    writeFileSync(join(oldDir, '.inbox', 'x.md'), topic('Old X'));
    writeFileSync(join(oldDir, '.inbox', 'discarded', 'd.md'), topic('Old D'));
    writeFileSync(join(oldDir, '.extraction-state.json'), '{"old":true}');
    writeFileSync(join(oldDir, '.extraction.lock'), '');
    writeFileSync(
      join(oldDir, 'MEMORY.md'),
      '# Old header\n- [Old A](a.md) — project — 2026-01-01\n- [Old B](b.md) — project — 2026-01-02\n',
    );
    writeFileSync(join(newDir, 'a.md'), topic('New A'));
    writeFileSync(join(newDir, 'a-2.md'), topic('Already -2'));
    writeFileSync(join(newDir, '.inbox', 'x.md'), topic('New X'));
    writeFileSync(
      join(newDir, 'MEMORY.md'),
      '# Book memory index\n- [New A](a.md) — project — 2026-02-01\nhand-written note\n',
    );

    migrateLegacyMemoryDir(ws, { bookRoot });

    // Both copies of the collision survive; the first free suffix is -3 because -2 is taken.
    expect(readFileSync(join(newDir, 'a.md'), 'utf-8')).toContain('New A');
    expect(readFileSync(join(newDir, 'a-2.md'), 'utf-8')).toContain('Already -2');
    expect(readFileSync(join(newDir, 'a-3.md'), 'utf-8')).toContain('Old A');
    expect(readFileSync(join(newDir, 'b.md'), 'utf-8')).toContain('Old B');
    expect(readFileSync(join(newDir, '.inbox', 'x.md'), 'utf-8')).toContain('New X');
    expect(readFileSync(join(newDir, '.inbox', 'x-2.md'), 'utf-8')).toContain('Old X');
    expect(existsSync(join(newDir, '.inbox', 'discarded', 'd.md'))).toBe(true);

    // The old entries follow the new header, point at the suffixed name, and nothing repeats.
    expect(readFileSync(join(newDir, 'MEMORY.md'), 'utf-8').split('\n')).toEqual([
      '# Book memory index',
      '- [Old A](a-3.md) — project — 2026-01-01',
      '- [Old B](b.md) — project — 2026-01-02',
      '- [New A](a.md) — project — 2026-02-01',
      'hand-written note',
      '',
    ]);

    // What stays behind: the extraction files and what is not markdown.
    expect(readdirSync(oldDir).sort()).toEqual([
      '.extraction-state.json',
      '.extraction.lock',
      'note.txt',
    ]);
    expect(existsSync(join(newDir, '.extraction-state.json'))).toBe(false);
  });

  it('adds no duplicate entry, and removes the old directory once it is empty', () => {
    const { ws, oldDir, newDir } = setup();
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(oldDir, 'MEMORY.md'), '- [Shared](shared.md) — project\n');
    writeFileSync(join(newDir, 'MEMORY.md'), '# Book memory index\n- [Shared](shared.md) — new\n');
    writeFileSync(join(newDir, 'shared.md'), topic('Shared'));

    migrateLegacyMemoryDir(ws, { bookRoot });
    migrateLegacyMemoryDir(ws, { bookRoot }); // a second session changes nothing

    expect(readFileSync(join(newDir, 'MEMORY.md'), 'utf-8')).toBe(
      '# Book memory index\n- [Shared](shared.md) — new\n',
    );
    expect(existsSync(oldDir)).toBe(false);
  });

  it('removes the empty old project directory after a rename', () => {
    const { ws, oldDir } = setup();
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, 'a.md'), topic('A'));

    loadMemoryContext(ws, { bookRoot });

    expect(existsSync(dirname(oldDir))).toBe(false);
  });

  it('removes the old project directory after a merge that empties the old memory directory', () => {
    const { ws, oldDir, newDir } = setup();
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(oldDir, 'a.md'), topic('A'));

    loadMemoryContext(ws, { bookRoot });

    expect(existsSync(join(newDir, 'a.md'))).toBe(true);
    expect(existsSync(dirname(oldDir))).toBe(false);
  });

  it('keeps the old project directory while the old memory directory holds extraction state', () => {
    const { ws, oldDir, newDir } = setup();
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(oldDir, 'a.md'), topic('A'));
    writeFileSync(join(oldDir, '.extraction-state.json'), '{}');

    loadMemoryContext(ws, { bookRoot });

    expect(readdirSync(oldDir)).toEqual(['.extraction-state.json']);
  });

  it('creates the index header when only the old directory had an index', () => {
    const { ws, oldDir, newDir } = setup();
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(oldDir, 'MEMORY.md'), '- [Solo](solo.md) — project\n');
    writeFileSync(join(oldDir, 'solo.md'), topic('Solo'));
    migrateLegacyMemoryDir(ws, { bookRoot });
    expect(readFileSync(join(newDir, 'MEMORY.md'), 'utf-8')).toBe(
      '# Book memory index\n- [Solo](solo.md) — project\n',
    );
  });

  it('skips an old directory that is a symlink', () => {
    const { ws, oldDir, newDir } = setup();
    const target = join(scratch, 'elsewhere');
    mkdirSync(target);
    writeFileSync(join(target, 'a.md'), topic('A'));
    mkdirSync(dirname(oldDir), { recursive: true });
    symlinkSync(target, oldDir);

    const ctx = loadMemoryContext(ws, { bookRoot });

    expect(ctx.files).toEqual([]);
    expect(readdirSync(target)).toEqual(['a.md']);
    expect(lstatSync(oldDir).isSymbolicLink()).toBe(true);
    expect(existsSync(newDir)).toBe(false);
  });

  it('skips a symlinked entry inside the old directory', () => {
    const { ws, oldDir, newDir } = setup();
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    const outside = join(scratch, 'outside.md');
    writeFileSync(outside, topic('Outside'));
    symlinkSync(outside, join(oldDir, 'link.md'));
    writeFileSync(join(oldDir, 'real.md'), topic('Real'));

    loadMemoryContext(ws, { bookRoot });

    expect(existsSync(join(newDir, 'real.md'))).toBe(true);
    expect(existsSync(join(newDir, 'link.md'))).toBe(false);
    expect(lstatSync(join(oldDir, 'link.md')).isSymbolicLink()).toBe(true);
  });

  it('does not throw when the move fails, and still loads the new directory', () => {
    const { ws, oldDir, newDir } = setup();
    mkdirSync(oldDir, { recursive: true });
    writeFileSync(join(oldDir, 'a.md'), topic('A'));
    // The new key's parent is a file, so neither the rename nor the mkdir can succeed.
    mkdirSync(dirname(dirname(newDir)), { recursive: true });
    writeFileSync(dirname(newDir), 'in the way');

    expect(() => migrateLegacyMemoryDir(ws, { bookRoot })).not.toThrow();
    const ctx = loadMemoryContext(ws, { bookRoot });
    expect(ctx.dir).toBe(newDir);
    expect(ctx.files).toEqual([]);
    expect(existsSync(join(oldDir, 'a.md'))).toBe(true);
  });
});

describe('index cut', () => {
  const writeIndex = (ws: string, text: string) => {
    const dir = getProjectMemoryDir(ws, { bookRoot });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), text, 'utf-8');
  };

  it('loads an index under both limits whole, with no marker', () => {
    const ws = makeGitRepo('under');
    const text = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
    writeIndex(ws, `${text}\n`);
    const ctx = loadMemoryContext(ws, { bookRoot });
    expect(ctx.indexText).toBe(text);
    expect(ctx.wasLineTruncated).toBe(false);
    expect(ctx.wasByteTruncated).toBe(false);
    expect(ctx.indexByteCount).toBe(Buffer.byteLength(text));
  });

  it('cuts at 200 lines and says where, with the exact marker', () => {
    const ws = makeGitRepo('lines');
    const lines = Array.from({ length: 205 }, (_, i) => `line ${i + 1}`);
    writeIndex(ws, lines.join('\n'));
    const ctx = loadMemoryContext(ws, { bookRoot });
    expect(ctx.wasLineTruncated).toBe(true);
    expect(ctx.wasByteTruncated).toBe(false);
    expect(ctx.indexLineCount).toBe(205);
    expect(ctx.loadedLineCount).toBe(200);
    expect(ctx.indexText).toBe(
      `${lines.slice(0, 200).join('\n')}\n\n> WARNING: MEMORY.md is 205 lines and 1,736 bytes (limits: 200 lines, 25,000 bytes). ` +
        'Only part of it was loaded: 5 of 205 lines were cut off, starting at line 201 ("line 201"). ' +
        'Keep each entry to one line and move detail into the memory file.',
    );
  });

  it('cuts at the last newline within 25,000 bytes when lines are long', () => {
    const ws = makeGitRepo('bytes');
    // 100 lines of 300 bytes + newline: line 83 ends at byte 24,982, line 84 would cross 25,000.
    const lines = Array.from(
      { length: 100 },
      (_, i) => `${String(i + 1).padStart(3, '0')}${'x'.repeat(297)}`,
    );
    writeIndex(ws, lines.join('\n'));
    const ctx = loadMemoryContext(ws, { bookRoot });
    expect(ctx.wasByteTruncated).toBe(true);
    expect(ctx.wasLineTruncated).toBe(false);
    expect(ctx.loadedLineCount).toBe(83);
    expect(ctx.indexText.startsWith(`${lines.slice(0, 83).join('\n')}\n\n> WARNING:`)).toBe(true);
    expect(ctx.indexText).toContain('MEMORY.md is 100 lines and 30,099 bytes');
    expect(ctx.indexText).toContain(
      `17 of 100 lines were cut off, starting at line 84 ("084${'x'.repeat(77)}")`,
    );
    const kept = ctx.indexText.slice(0, ctx.indexText.indexOf('\n\n> WARNING'));
    expect(Buffer.byteLength(kept)).toBeLessThanOrEqual(MAX_INDEX_BYTES);
  });

  it('cuts inside line 1 on a character boundary when it alone is over the limit', () => {
    const ws = makeGitRepo('line1');
    // '€' is 3 bytes; byte 25,000 falls inside a character, so the cut backs up to 24,999.
    writeIndex(ws, '€'.repeat(10_000));
    const ctx = loadMemoryContext(ws, { bookRoot });
    expect(ctx.wasByteTruncated).toBe(true);
    const kept = ctx.indexText.slice(0, ctx.indexText.indexOf('\n\n> WARNING'));
    expect(Buffer.byteLength(kept)).toBe(24_999);
    expect(kept).toBe('€'.repeat(8333));
    expect(ctx.indexText).toContain(
      'Only part of it was loaded: everything after the first 24,999 bytes of line 1 was cut off. ',
    );
    expect(ctx.indexText).toContain('MEMORY.md is 1 lines and 30,000 bytes');
  });

  it('reports a line cut and a byte cut together', () => {
    const ws = makeGitRepo('both');
    writeIndex(ws, Array.from({ length: 300 }, () => 'y'.repeat(200)).join('\n'));
    const ctx = loadMemoryContext(ws, { bookRoot });
    expect(ctx.wasLineTruncated).toBe(true);
    expect(ctx.wasByteTruncated).toBe(true);
    expect(ctx.indexText).toContain('MEMORY.md is 300 lines');
  });

  it('feeds health the same byte count and cut flags', () => {
    const ws = makeGitRepo('health');
    writeIndex(ws, Array.from({ length: 205 }, (_, i) => `line ${i + 1}`).join('\n'));
    const health = getMemoryHealth(ws, { bookRoot });
    expect(health.indexByteCount).toBe(1736);
    expect(health.wasLineTruncated).toBe(true);
    expect(health.wasByteTruncated).toBe(false);
  });
});

/** A memory file as the model writes it: its own `name`, `description` and `metadata` block. */
const newStyle = (name: string, type: string, extra = '') =>
  `---\nname: ${name}\ndescription: About ${name}\nmetadata:\n  type: ${type}\n${extra}---\nBody of ${name}.\n`;

describe('loadMemoryContext', () => {
  it('returns an empty context when the directory is absent', () => {
    const ctx = loadMemoryContext('C:\\fake\\missing', { bookRoot });
    expect(ctx.indexLoaded).toBe(false);
    expect(ctx.files).toEqual([]);
    expect(ctx).not.toHaveProperty('candidates');
  });

  it('loads only the first 200 lines of MEMORY.md', () => {
    const ws = 'C:\\fake\\with-index';
    const dir = getProjectMemoryDir(ws, { bookRoot });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'MEMORY.md'),
      Array.from({ length: 205 }, (_, i) => `line ${i + 1}`).join('\n'),
      'utf-8',
    );

    const ctx = loadMemoryContext(ws, { bookRoot });
    expect(ctx.indexLoaded).toBe(true);
    expect(ctx.indexLineCount).toBe(205);
    expect(ctx.loadedLineCount).toBe(200);
    expect(ctx.indexText).toContain('line 200\n');
    // Line 201 survives only inside the warning marker that names it.
    expect(ctx.indexText.split('\n').filter((l) => l === 'line 201')).toEqual([]);
  });

  it('lists every memory file, leaving out the index, dot-entries and what is not markdown', () => {
    const ws = 'C:\\fake\\files';
    const dir = getProjectMemoryDir(ws, { bookRoot });
    mkdirSync(join(dir, '.inbox'), { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), '# Book memory index\n', 'utf-8');
    writeFileSync(join(dir, 'a.md'), newStyle('a', 'project'));
    writeFileSync(
      join(dir, 'legacy.md'),
      '---\ntype: user\nstatus: approved\n---\n# Legacy\nBody',
      'utf-8',
    );
    writeFileSync(join(dir, '.hidden.md'), newStyle('hidden', 'project'));
    writeFileSync(join(dir, 'notes.txt'), 'not markdown');
    writeFileSync(join(dir, '.inbox', 'candidate.md'), newStyle('candidate', 'user'));

    const files = listMemoryFiles(ws, { bookRoot });
    expect(files.map((f) => f.name)).toEqual(['a.md', 'legacy.md']);
    expect(loadMemoryContext(ws, { bookRoot }).files.map((f) => f.name)).toEqual([
      'a.md',
      'legacy.md',
    ]);
  });

  it('reads a file from metadata.type, or from the legacy top-level type', () => {
    const ws = 'C:\\fake\\summary';
    const dir = getProjectMemoryDir(ws, { bookRoot });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'new.md'), newStyle('new-name', 'feedback'));
    writeFileSync(join(dir, 'old.md'), '---\ntype: project\nstatus: approved\n---\n# Old title\nB');
    writeFileSync(join(dir, 'bare.md'), '# Just a note\n');

    const byName = new Map(listMemoryFiles(ws, { bookRoot }).map((f) => [f.name, f]));
    expect(byName.get('new.md')).toMatchObject({ type: 'feedback', title: 'new-name' });
    expect(byName.get('old.md')).toMatchObject({ type: 'project', title: 'Old title' });
    expect(byName.get('bare.md')).toMatchObject({ type: undefined, title: 'Just a note' });
  });

  it('marks a delegated run’s file, in either layout', () => {
    const ws = 'C:\\fake\\driver';
    const dir = getProjectMemoryDir(ws, { bookRoot });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'agent-new.md'), newStyle('agent-new', 'project', '  driver: agent\n'));
    writeFileSync(join(dir, 'agent-old.md'), '---\ntype: project\ndriver: agent\n---\n# Old\nB');
    writeFileSync(join(dir, 'person.md'), newStyle('person', 'user'));

    const byName = new Map(listMemoryFiles(ws, { bookRoot }).map((f) => [f.name, f]));
    expect(byName.get('agent-new.md')?.driver).toBe('agent');
    expect(byName.get('agent-old.md')?.driver).toBe('agent');
    expect(byName.get('person.md')?.driver).toBeUndefined();
  });

  it('keeps a legacy superseded file in the listing, flagged', () => {
    const ws = 'C:\\fake\\legacy-superseded';
    const dir = getProjectMemoryDir(ws, { bookRoot });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'old.md'),
      '---\ntype: project\nstatus: superseded\nsupersededBy: new.md\n---\n# Old\nB',
    );
    writeFileSync(join(dir, 'new.md'), newStyle('new', 'project'));

    const files = listMemoryFiles(ws, { bookRoot });
    expect(files.map((f) => [f.name, f.legacySuperseded === true])).toEqual([
      ['new.md', false],
      ['old.md', true],
    ]);
  });

  it('lists memory files whatever the case of the .md extension', () => {
    const ws = 'C:\\fake\\case-insensitive-list';
    const dir = getProjectMemoryDir(ws, { bookRoot });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'Build.MD'), '# Build\n');
    writeFileSync(join(dir, 'Notes.md'), '# Notes\n');

    expect(listMemoryFiles(ws, { bookRoot }).map((file) => file.name)).toEqual([
      'Build.MD',
      'Notes.md',
    ]);
  });
});

describe('memory health', () => {
  it('does not hang on a symlink loop, and ignores dot-entries when finding the last write', () => {
    const ws = 'C:\\fake\\symlink-loop';
    const memoryDir = getProjectMemoryDir(ws, { bookRoot });
    mkdirSync(memoryDir, { recursive: true });

    const approvedFile = join(memoryDir, 'approved.md');
    writeFileSync(approvedFile, '# Approved fact', 'utf-8');
    const past = new Date('2026-01-01T00:00:00Z');
    utimesSync(approvedFile, past, past);

    // A symlink loop inside the memory directory.
    try {
      symlinkSync(memoryDir, join(memoryDir, 'loop-link'));
    } catch {
      // May be restricted on Windows without admin, continue if so
    }

    // Dot-entries written just now: the old extraction state, and an old inbox file.
    writeFileSync(join(memoryDir, '.extraction-state.json'), '{"watermark": "recent"}', 'utf-8');
    mkdirSync(join(memoryDir, '.inbox'), { recursive: true });
    writeFileSync(join(memoryDir, '.inbox', 'candidate.md'), '# Candidate', 'utf-8');

    expect(getNewestMemoryWriteTime(memoryDir)?.getTime()).toBe(past.getTime());
  });

  it('counts every memory file and the legacy superseded ones, but not the index or dot-entries', () => {
    const ws = 'C:\\fake\\health-count';
    const memoryDir = getProjectMemoryDir(ws, { bookRoot });
    mkdirSync(join(memoryDir, '.inbox'), { recursive: true });

    writeFileSync(join(memoryDir, 'MEMORY.md'), '# Index\n- [A](a.md)\n- [B](b.md)\n', 'utf-8');
    writeFileSync(join(memoryDir, 'new.md'), newStyle('new', 'project'), 'utf-8');
    writeFileSync(join(memoryDir, 'old.md'), '---\ntype: project\n---\n# Old', 'utf-8');
    writeFileSync(
      join(memoryDir, 'retired.md'),
      '---\nstatus: superseded\ntype: project\n---\n# Retired',
      'utf-8',
    );
    writeFileSync(join(memoryDir, '.inbox', 'cand.md'), newStyle('cand', 'user'), 'utf-8');

    const health = getMemoryHealth(ws, { bookRoot });
    expect(health.fileCount).toBe(3);
    expect(health.legacySupersededCount).toBe(1);
    expect(health).not.toHaveProperty('inboxCount');
    expect(health.indexLineCount).toBe(3); // non-empty lines in MEMORY.md
    expect(health.lastWrite).not.toBeNull();
  });
});

describe('deleteMemoryEntry', () => {
  const setup = (ws: string, index: string) => {
    const dir = getProjectMemoryDir(ws, { bookRoot });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), index, 'utf-8');
    return dir;
  };

  it('deletes the file and every MEMORY.md line linking to it, leaving the rest as written', () => {
    const ws = 'C:\\fake\\delete-entry';
    const dir = setup(
      ws,
      [
        '# My own heading',
        '- [Doc link](doc-link.md) — where the doc is',
        '- [Other](other.md) — keep me   ',
        'A hand-written note, not an entry.',
        '- [Doc again](./Doc-Link.md) — a second line for the same file',
        '- [Docs](doc-link.md.bak) — a different file',
        '',
      ].join('\n'),
    );
    writeFileSync(join(dir, 'doc-link.md'), newStyle('doc-link', 'reference'));
    writeFileSync(join(dir, 'other.md'), newStyle('other', 'project'));

    const del = deleteMemoryEntry(ws, 'doc-link.md', { bookRoot });
    expect(del).toEqual({ ok: true, path: join(dir, 'doc-link.md') });
    expect(existsSync(join(dir, 'doc-link.md'))).toBe(false);
    expect(existsSync(join(dir, 'other.md'))).toBe(true);
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf-8')).toBe(
      [
        '# My own heading',
        '- [Other](other.md) — keep me   ',
        'A hand-written note, not an entry.',
        '- [Docs](doc-link.md.bak) — a different file',
        '',
      ].join('\n'),
    );
  });

  it('does not rewrite an index with no line for the file, nor create one', () => {
    const ws = 'C:\\fake\\delete-no-line';
    const dir = setup(ws, '- [Other](other.md) — keep me\n');
    writeFileSync(join(dir, 'lonely.md'), newStyle('lonely', 'project'));
    const index = join(dir, 'MEMORY.md');
    const past = new Date('2026-01-01T00:00:00Z');
    utimesSync(index, past, past);

    expect(deleteMemoryEntry(ws, 'lonely.md', { bookRoot }).ok).toBe(true);
    expect(statSync(index).mtimeMs).toBe(past.getTime());

    // A repository of its own: every `C:\fake\…` string on a POSIX host resolves under this checkout.
    const bare = makeGitRepo('delete-no-index');
    const bareDir = getProjectMemoryDir(bare, { bookRoot });
    mkdirSync(bareDir, { recursive: true });
    writeFileSync(join(bareDir, 'x.md'), newStyle('x', 'project'));
    expect(deleteMemoryEntry(bare, 'x.md', { bookRoot }).ok).toBe(true);
    expect(existsSync(join(bareDir, 'MEMORY.md'))).toBe(false);
  });

  it('deletes by a path-like slug, and takes the last segment of a Windows-style one', () => {
    const ws = 'C:\\fake\\path-like-delete';
    const dir = setup(ws, '');
    writeFileSync(join(dir, 'deploy.md'), newStyle('deploy', 'reference'));
    writeFileSync(join(dir, 'release.md'), newStyle('release', 'reference'));

    const deleted = deleteMemoryEntry(ws, 'memory/deploy.md', { bookRoot });
    expect(deleted).toEqual({ ok: true, path: join(dir, 'deploy.md') });
    expect(existsSync(join(dir, 'deploy.md'))).toBe(false);

    expect(deleteMemoryEntry(ws, 'C:\\notes\\memory\\release.md', { bookRoot }).ok).toBe(true);
    expect(existsSync(join(dir, 'release.md'))).toBe(false);
  });

  it('rejects deletion of missing files, traversal paths, and MEMORY.md', () => {
    const ws = 'C:\\fake\\delete-guards';
    const dir = setup(ws, '- [A](a.md)\n');
    expect(deleteMemoryEntry(ws, 'nonexistent.md', { bookRoot }).ok).toBe(false);
    expect(deleteMemoryEntry(ws, 'MEMORY.md', { bookRoot }).ok).toBe(false);
    expect(deleteMemoryEntry(ws, 'memory.md', { bookRoot }).ok).toBe(false);
    // The last segment is what names the file, so a traversal prefix cannot reach out.
    expect(deleteMemoryEntry(ws, '../../escape.md', { bookRoot }).ok).toBe(false);
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf-8')).toBe('- [A](a.md)\n');
  });

  it('refuses to delete a symlinked file', () => {
    const ws = 'C:\\fake\\delete-symlink';
    const dir = setup(ws, '');
    const target = join(bookRoot, 'target.md');
    writeFileSync(target, '# Outside target', 'utf-8');
    try {
      symlinkSync(target, join(dir, 'link.md'));
    } catch {
      return; // Symlink creation might not be permitted on some Windows configs
    }
    const result = deleteMemoryEntry(ws, 'link.md', { bookRoot });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Refusing to delete symlinked file');
    expect(existsSync(target)).toBe(true);
  });
});

describe('slugs', () => {
  it('strips control characters, path separators, leading dots, preserves case, and rejects empty results', () => {
    expect(sanitizeMemorySlug('Foo/Bar\\Baz')).toBe('FooBarBaz');
    expect(sanitizeMemorySlug('...hidden')).toBe('hidden');
    expect(sanitizeMemorySlug('..\evil/Slug\n.md')).toBe('evilSlug.md');
    expect(sanitizeMemorySlug('x\nstatus: discarded')).toBe('xstatus: discarded');
    expect(sanitizeMemorySlug('\r\n\t')).toBeNull();
    expect(sanitizeMemorySlug('...')).toBeNull();
    expect(sanitizeMemorySlug('   ')).toBeNull();
  });

  it('resolves a slug to the one file it names inside the directory', () => {
    const dir = join(bookRoot, 'memory');
    expect(memoryFileForSlug(dir, 'build-cmd')).toEqual({
      filename: 'build-cmd.md',
      target: join(dir, 'build-cmd.md'),
    });
    expect(memoryFileForSlug(dir, 'memory/Build-Cmd.MD')).toEqual({
      filename: 'Build-Cmd.MD',
      target: join(dir, 'Build-Cmd.MD'),
    });
    // A newline or a path in the slug cannot reach the index or climb out.
    const injected = memoryFileForSlug(dir, 'notes\n/../../MEMORY.md\nstatus: discarded');
    expect('filename' in injected && injected.filename).toBe('MEMORY.mdstatus: discarded.md');
    expect('target' in injected && injected.target.startsWith(dir)).toBe(true);
  });

  it('refuses the index file case-insensitively, and a slug that is empty once cleaned', () => {
    const dir = join(bookRoot, 'memory');
    expect(memoryFileForSlug(dir, 'memory.md')).toEqual({
      error: 'Target filename cannot be the index file.',
    });
    expect(memoryFileForSlug(dir, 'MEMORY.MD')).toHaveProperty('error');
    expect(memoryFileForSlug(dir, '..')).toEqual({ error: 'Invalid memory slug.' });
    expect(memoryFileForSlug(dir, '   \t\n  ')).toEqual({ error: 'Invalid memory slug.' });
  });
});

describe('memoryWriteScope', () => {
  const memory = (enabled: boolean, autoSave: boolean) => ({
    settings: { memory: { enabled, autoSave } },
  });

  it('is none when memory or autoSave is off, whoever drives the session', () => {
    expect(memoryWriteScope(memory(false, true))).toBe('none');
    expect(memoryWriteScope(memory(true, false))).toBe('none');
    expect(memoryWriteScope({ ...memory(true, false), sessionDriver: 'agent' })).toBe('none');
  });

  it('is learnings for a session another agent drives, and full for a person', () => {
    expect(memoryWriteScope({ ...memory(true, true), sessionDriver: 'agent' })).toBe('learnings');
    expect(memoryWriteScope({ ...memory(true, true), sessionDriver: 'human' })).toBe('full');
    expect(memoryWriteScope(memory(true, true))).toBe('full');
    expect(memoryWriteScope({})).toBe('full');
  });
});
