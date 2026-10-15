import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, dirname, isAbsolute, join, relative } from 'path';
import {
  MAX_BODY_CHARS,
  MAX_INDEX_BYTES,
  approveMemoryCandidate,
  countMemoryCandidates,
  deleteMemoryEntry,
  discardMemoryCandidate,
  findGitRoot,
  getMemoryHealth,
  getMemoryInboxDir,
  getNewestMemoryWriteTime,
  getProjectMemoryDir,
  listMemoryCandidates,
  listMemoryFiles,
  loadMemoryContext,
  migrateLegacyMemoryDir,
  readMemoryFile,
  sanitizeMemorySlug,
  sanitizeMemoryTitle,
  saveMemory,
  shouldRejectMemoryText,
  slugifyWorkspace,
  writeMemoryCandidate,
} from './memory-store.js';

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

  it('resolves memory and inbox directories under injected book root', () => {
    const ws = makeGitRepo('book-test-ws');
    expect(getProjectMemoryDir(ws, { bookRoot })).toBe(
      join(bookRoot, 'projects', slugifyWorkspace(ws), 'memory'),
    );
    expect(getMemoryInboxDir(ws, { bookRoot })).toBe(
      join(bookRoot, 'projects', slugifyWorkspace(ws), 'memory', '.inbox'),
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

/** A linked worktree of `main`: `.git` is a file pointing into `main/.git/worktrees/<name>`. */
function makeLinkedWorktree(main: string, name: string): string {
  const gitDir = join(main, '.git', 'worktrees', name);
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(gitDir, 'commondir'), '../..\n');
  const worktree = join(scratch, name);
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`);
  return worktree;
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

  it('resolves a relative gitdir against the directory holding the .git file', () => {
    const main = makeGitRepo('main');
    mkdirSync(join(main, '.git', 'worktrees', 'rel'), { recursive: true });
    writeFileSync(join(main, '.git', 'worktrees', 'rel', 'commondir'), '../..');
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

    const ctx = loadMemoryContext(ws, { bookRoot });

    expect(existsSync(oldDir)).toBe(false);
    expect(ctx.dir).toBe(newDir);
    expect(ctx.files.map((f) => f.name)).toEqual(['a.md']);
    expect(ctx.indexText).toContain('[A](a.md)');
    expect(ctx.candidates.map((c) => c.name)).toEqual(['c.md']);
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

    loadMemoryContext(ws, { bookRoot });

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

    loadMemoryContext(ws, { bookRoot });
    loadMemoryContext(ws, { bookRoot }); // a second session changes nothing

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
    loadMemoryContext(ws, { bookRoot });
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

describe('loadMemoryContext', () => {
  it('returns an empty context when the directory is absent', () => {
    const ctx = loadMemoryContext('C:\\fake\\missing', { bookRoot });
    expect(ctx.indexLoaded).toBe(false);
    expect(ctx.files).toEqual([]);
    expect(ctx.candidates).toEqual([]);
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

  it('lists approved files and excludes inbox files from active memory', () => {
    const ws = 'C:\\fake\\files';
    const dir = getProjectMemoryDir(ws, { bookRoot });
    const inbox = getMemoryInboxDir(ws, { bookRoot });
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), '# Book memory index\n', 'utf-8');
    writeFileSync(
      join(dir, 'a.md'),
      '---\ntype: project\nstatus: approved\n---\n# A\nBody',
      'utf-8',
    );
    writeFileSync(
      join(inbox, 'candidate.md'),
      '---\ntype: user\nstatus: pending\n---\n# Candidate\nBody',
      'utf-8',
    );

    const files = listMemoryFiles(ws, { bookRoot });
    const ctx = loadMemoryContext(ws, { bookRoot });
    expect(files.map((f) => f.name)).toContain('a.md');
    expect(files.map((f) => f.name)).not.toContain('candidate.md');
    // The index file itself must not be counted as an approved memory file.
    expect(files.map((f) => f.name)).not.toContain('MEMORY.md');
    expect(ctx.candidates).toHaveLength(1);
    expect(ctx.candidates[0].status).toBe('pending');
  });
});

describe('candidate lifecycle', () => {
  it('writes candidates to the inbox', () => {
    const ws = 'C:\\fake\\candidate';
    const result = writeMemoryCandidate(
      ws,
      {
        type: 'user',
        title: 'User prefers concise summaries',
        body: 'The user prefers concise summaries.',
        source: 'auto',
        confidence: 'high',
        tags: ['explicit'],
      },
      { bookRoot, now: new Date('2026-07-04T12:34:56Z') },
    );

    expect(result.ok).toBe(true);
    expect(result.path).toContain('.inbox');
    expect(existsSync(result.path!)).toBe(true);
    expect(listMemoryCandidates(ws, { bookRoot })).toHaveLength(1);
  });

  it('approves candidates into active memory and updates MEMORY.md newest-first', () => {
    const ws = 'C:\\fake\\approve';
    const written = writeMemoryCandidate(
      ws,
      {
        type: 'project',
        title: 'Project uses pnpm',
        body: 'This repo uses pnpm.',
        source: 'auto',
      },
      { bookRoot, now: new Date('2026-07-04T12:34:56Z') },
    );

    const approved = approveMemoryCandidate(ws, written.path!, {
      bookRoot,
      now: new Date('2026-07-04T13:00:00Z'),
    });
    expect(approved.ok).toBe(true);
    expect(approved.path).toContain('project-uses-pnpm');
    expect(
      readFileSync(join(getProjectMemoryDir(ws, { bookRoot }), 'MEMORY.md'), 'utf-8'),
    ).toContain('[Project uses pnpm]');
    expect(loadMemoryContext(ws, { bookRoot }).candidates).toHaveLength(0);
  });

  it('rejects traversal and symlink candidates', () => {
    const ws = 'C:\\fake\\safe';
    const dir = getMemoryInboxDir(ws, { bookRoot });
    mkdirSync(dir, { recursive: true });
    expect(approveMemoryCandidate(ws, '../evil.md', { bookRoot }).ok).toBe(false);

    const target = join(bookRoot, 'target.md');
    writeFileSync(target, '---\ntype: user\n---\n# Secret', 'utf-8');
    const link = join(dir, 'link.md');
    try {
      symlinkSync(target, link);
      expect(approveMemoryCandidate(ws, 'link.md', { bookRoot }).ok).toBe(false);
    } catch {
      // Symlink creation can be unavailable on Windows without privileges.
    }
  });

  it('discards candidates into the discarded inbox folder', () => {
    const ws = 'C:\\fake\\discard';
    const written = writeMemoryCandidate(
      ws,
      {
        type: 'feedback',
        title: 'That worked',
        body: 'User confirmed the approach worked.',
        source: 'auto',
      },
      { bookRoot },
    );

    const discarded = discardMemoryCandidate(ws, written.path!, { bookRoot });
    expect(discarded.ok).toBe(true);
    expect(discarded.path).toContain('discarded');
    expect(listMemoryCandidates(ws, { bookRoot })).toHaveLength(0);
  });

  it('writes memory markdown with blank-line spacers between frontmatter, heading, and body', () => {
    const ws = 'C:\\fake\\render';
    const written = writeMemoryCandidate(
      ws,
      {
        type: 'user',
        title: 'Prefers concise summaries',
        body: 'The user prefers concise summaries.',
        source: 'auto',
        confidence: 'high',
        tags: ['explicit'],
      },
      { bookRoot, now: new Date('2026-07-04T12:34:56Z') },
    );

    const raw = readFileSync(written.path!, 'utf-8');
    // Blank line between the closing --- fence and the # heading.
    expect(raw).toContain('---\n\n# ');
    // Blank line between the heading and the body text.
    expect(raw).toMatch(/# [^\n]+\n\nThe user prefers/);
    // Frontmatter fields are populated, not collapsed into the fence.
    expect(raw).toContain('type: user');
    expect(raw).toContain('confidence: high');
  });

  describe('getNewestMemoryWriteTime and memory health', () => {
    it('does not hang on a symlink loop and ignores discarded candidates and dotfiles', () => {
      const ws = 'C:\\fake\\symlink-loop';
      const memoryDir = getProjectMemoryDir(ws, { bookRoot });
      mkdirSync(memoryDir, { recursive: true });

      // Write an approved file
      const approvedFile = join(memoryDir, 'approved.md');
      writeFileSync(approvedFile, '# Approved fact', 'utf-8');

      // Create a symlink loop inside memoryDir
      const loopLink = join(memoryDir, 'loop-link');
      try {
        symlinkSync(memoryDir, loopLink);
      } catch {
        // May be restricted on Windows without admin, continue if so
      }

      // Write a dotfile (like .extraction-state.json) with recent timestamp
      const dotFile = join(memoryDir, '.extraction-state.json');
      writeFileSync(dotFile, '{"watermark": "recent"}', 'utf-8');

      // Write a discarded candidate inside .inbox/discarded/
      const inboxDir = getMemoryInboxDir(ws, { bookRoot });
      const discardedDir = join(inboxDir, 'discarded');
      mkdirSync(discardedDir, { recursive: true });
      const discardedFile = join(discardedDir, 'discarded.md');
      writeFileSync(discardedFile, '# Discarded fact', 'utf-8');

      const newest = getNewestMemoryWriteTime(memoryDir);
      expect(newest).not.toBeNull();
      // Should see approvedFile, and neither hang on loop-link nor count .extraction-state.json or discarded.md
    });

    it('counts approved files with status approved or absent, excluding pending/discarded and MEMORY.md', () => {
      const ws = 'C:\\fake\\health-status';
      const memoryDir = getProjectMemoryDir(ws, { bookRoot });
      mkdirSync(memoryDir, { recursive: true });

      writeFileSync(join(memoryDir, 'MEMORY.md'), '# Index\n- [A](a.md)\n- [B](b.md)\n', 'utf-8');
      writeFileSync(
        join(memoryDir, 'approved-explicit.md'),
        '---\nstatus: approved\ntype: project\n---\n# Expl',
        'utf-8',
      );
      writeFileSync(
        join(memoryDir, 'approved-absent.md'),
        '---\ntype: project\n---\n# Absent status is approved',
        'utf-8',
      );
      writeFileSync(
        join(memoryDir, 'pending.md'),
        '---\nstatus: pending\ntype: project\n---\n# Pending',
        'utf-8',
      );
      writeFileSync(
        join(memoryDir, 'discarded.md'),
        '---\nstatus: discarded\ntype: project\n---\n# Discarded',
        'utf-8',
      );

      // Also write one candidate to inbox
      writeMemoryCandidate(
        ws,
        {
          type: 'user',
          title: 'Candidate in inbox',
          body: 'Candidate body.',
          source: 'auto',
        },
        { bookRoot },
      );

      const health = getMemoryHealth(ws, { bookRoot });
      expect(health.approvedCount).toBe(2); // approved-explicit.md and approved-absent.md
      expect(health.inboxCount).toBe(1);
      expect(health.indexLineCount).toBe(3); // non-empty lines in MEMORY.md
      expect(health.lastWrite).not.toBeNull();
    });

    it('cheaply counts candidates in inbox without parsing frontmatter', () => {
      const ws = 'C:\\fake\\cheap-count';
      const inboxDir = getMemoryInboxDir(ws, { bookRoot });
      mkdirSync(inboxDir, { recursive: true });

      writeFileSync(join(inboxDir, 'cand1.md'), 'not valid frontmatter', 'utf-8');
      writeFileSync(join(inboxDir, 'cand2.md'), 'also raw text', 'utf-8');
      writeFileSync(join(inboxDir, 'other.txt'), 'txt file', 'utf-8');
      writeFileSync(join(inboxDir, '.dotfile.md'), 'dotfile', 'utf-8');

      expect(countMemoryCandidates(ws, { bookRoot })).toBe(2);
      expect(countMemoryCandidates(ws, { dir: memoryDirOrInbox(ws, bookRoot) })).toBe(2);
    });
  });

  describe('provenance schema and round-trip', () => {
    it('round-trips full provenance fields through frontmatter', () => {
      const ws = 'C:\\fake\\provenance-rt';
      const result = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Monorepo conventions',
          body: 'Use pnpm across all packages.\nWhy: Single lockfile.\nHow to apply: Never run npm install.',
          origin: 'model-tool',
          source: 'auto',
          sessionId: 'session-xyz-456',
          externalContext: true,
          evidence: ['rec-turn-1', 'rec-turn-2'],
          confidence: 'high',
          tags: ['monorepo', 'tooling'],
        },
        { bookRoot, quarantineExternal: false, now: new Date('2026-09-20T10:00:00Z') },
      );

      expect(result.ok).toBe(true);
      expect(result.status).toBe('approved');
      expect(result.path).toBeDefined();

      const parsed = readMemoryFile(result.path!);
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe('project');
      expect(parsed?.title).toBe('Monorepo conventions');
      expect(parsed?.origin).toBe('model-tool');
      expect(parsed?.source).toBe('auto');
      expect(parsed?.sessionId).toBe('session-xyz-456');
      expect(parsed?.externalContext).toBe(true);
      expect(parsed?.evidence).toEqual(['rec-turn-1', 'rec-turn-2']);
      expect(parsed?.confidence).toBe('high');
      expect(parsed?.tags).toEqual(['monorepo', 'tooling']);
      expect(parsed?.status).toBe('approved');
    });

    it('reads legacy source: auto files and derives origin user-text and externalContext false', () => {
      const dir = getProjectMemoryDir('C:\\fake\\legacy-auto', { bookRoot });
      mkdirSync(dir, { recursive: true });
      const legacyPath = join(dir, 'legacy-auto.md');
      writeFileSync(
        legacyPath,
        [
          '---',
          'type: feedback',
          'source: auto',
          'status: approved',
          'created: 2026-05-01T12:00:00Z',
          '---',
          '',
          '# That worked',
          '',
          'User confirmed the approach worked.',
          '',
        ].join('\n'),
        'utf-8',
      );

      const parsed = readMemoryFile(legacyPath);
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe('feedback');
      expect(parsed?.title).toBe('That worked');
      expect(parsed?.origin).toBe('user-text');
      expect(parsed?.source).toBe('auto');
      expect(parsed?.externalContext).toBe(false);
      expect(parsed?.sessionId).toBeUndefined();
      expect(parsed?.evidence).toBeUndefined();
    });

    it('reads legacy source: manual files and derives origin user-text', () => {
      const dir = getProjectMemoryDir('C:\\fake\\legacy-manual', { bookRoot });
      mkdirSync(dir, { recursive: true });
      const legacyPath = join(dir, 'legacy-manual.md');
      writeFileSync(
        legacyPath,
        [
          '---',
          'type: user',
          'source: manual',
          'status: approved',
          'created: 2026-05-01T12:00:00Z',
          '---',
          '',
          '# User prefers concise answers',
          '',
          'Give short answers.',
          '',
        ].join('\n'),
        'utf-8',
      );

      const parsed = readMemoryFile(legacyPath);
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe('user');
      expect(parsed?.title).toBe('User prefers concise answers');
      expect(parsed?.origin).toBe('user-text');
      expect(parsed?.source).toBe('manual');
      expect(parsed?.externalContext).toBe(false);
    });

    it('resolves a legacy targetSlug with a path prefix to its file name', () => {
      const ws = 'C:\\fake\\legacy-target-slug';
      const inbox = getMemoryInboxDir(ws, { bookRoot });
      mkdirSync(inbox, { recursive: true });
      const candidatePath = join(inbox, 'legacy-candidate.md');
      writeFileSync(
        candidatePath,
        [
          '---',
          'type: project',
          'source: auto',
          'status: pending',
          'targetSlug: notes/build',
          'created: 2026-05-01T12:00:00Z',
          '---',
          '',
          '# Build conventions',
          '',
          'Run npm run build.',
          '',
        ].join('\n'),
        'utf-8',
      );

      // The slug names a file in the memory directory, so the last segment is
      // the file name — sanitizing alone would have glued the segments together
      // into `notesbuild.md`.
      expect(readMemoryFile(candidatePath)?.targetSlug).toBe('build');

      const approved = approveMemoryCandidate(ws, candidatePath, { bookRoot });
      expect(approved.ok).toBe(true);
      expect(approved.path).toBe(join(getProjectMemoryDir(ws, { bookRoot }), 'build.md'));
    });
  });

  describe('saveMemory and deleteMemoryEntry', () => {
    it('writes directly to approved store and index when requireApproval is false', () => {
      const ws = 'C:\\fake\\direct-save';
      const result = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Direct save entry',
          body: 'Content for direct save.',
          origin: 'model-tool',
          externalContext: false,
        },
        { bookRoot, requireApproval: false, now: new Date('2026-09-20T10:00:00Z') },
      );

      expect(result.ok).toBe(true);
      expect(result.status).toBe('approved');
      expect(result.path).not.toContain('.inbox');
      expect(existsSync(result.path!)).toBe(true);
      expect(result.indexLine).toContain('[Direct save entry]');

      const indexText = readFileSync(
        join(getProjectMemoryDir(ws, { bookRoot }), 'MEMORY.md'),
        'utf-8',
      );
      expect(indexText).toContain('[Direct save entry]');
      expect(loadMemoryContext(ws, { bookRoot }).candidates).toHaveLength(0);
    });

    it('routes to .inbox/ when requireApproval is true', () => {
      const ws = 'C:\\fake\\inbox-save';
      const result = saveMemory(
        ws,
        {
          type: 'user',
          title: 'Inbox review entry',
          body: 'Needs user approval.',
          origin: 'model-tool',
          externalContext: false,
        },
        { bookRoot, requireApproval: true, now: new Date('2026-09-20T10:00:00Z') },
      );

      expect(result.ok).toBe(true);
      expect(result.status).toBe('pending');
      expect(result.path).toContain('.inbox');
      expect(result.indexLine).toBeUndefined();

      expect(existsSync(join(getProjectMemoryDir(ws, { bookRoot }), 'MEMORY.md'))).toBe(false);
      expect(loadMemoryContext(ws, { bookRoot }).candidates).toHaveLength(1);
    });

    it('quarantines candidate to .inbox/ when externalContext is true, even if requireApproval is false', () => {
      const ws = 'C:\\fake\\quarantine-ext';
      const result = saveMemory(
        ws,
        {
          type: 'project',
          title: 'External context fact',
          body: 'Learned from web.',
          origin: 'model-tool',
          externalContext: true,
        },
        { bookRoot, requireApproval: false, now: new Date('2026-09-20T10:00:00Z') },
      );

      expect(result.ok).toBe(true);
      expect(result.status).toBe('pending');
      expect(result.quarantined).toBe(true);
      expect(result.path).toContain('.inbox');
      expect(existsSync(join(getProjectMemoryDir(ws, { bookRoot }), 'MEMORY.md'))).toBe(false);
      expect(loadMemoryContext(ws, { bookRoot }).candidates).toHaveLength(1);
    });

    it('approves directly when externalContext is false and requireApproval is false', () => {
      const ws = 'C:\\fake\\internal-direct';
      const result = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Internal context fact',
          body: 'Learned from repo.',
          origin: 'model-tool',
          externalContext: false,
        },
        { bookRoot, requireApproval: false, now: new Date('2026-09-20T10:00:00Z') },
      );

      expect(result.ok).toBe(true);
      expect(result.status).toBe('approved');
      expect(result.path).not.toContain('.inbox');
      expect(existsSync(join(getProjectMemoryDir(ws, { bookRoot }), 'MEMORY.md'))).toBe(true);
      expect(loadMemoryContext(ws, { bookRoot }).candidates).toHaveLength(0);
    });

    it('approves directly even with externalContext true when quarantineExternal is false', () => {
      const ws = 'C:\\fake\\quarantine-disabled';
      const result = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Unquarantined external fact',
          body: 'Learned from web but quarantine disabled.',
          origin: 'model-tool',
          externalContext: true,
        },
        {
          bookRoot,
          requireApproval: false,
          quarantineExternal: false,
          now: new Date('2026-09-20T10:00:00Z'),
        },
      );

      expect(result.ok).toBe(true);
      expect(result.status).toBe('approved');
      expect(result.path).not.toContain('.inbox');
      expect(existsSync(join(getProjectMemoryDir(ws, { bookRoot }), 'MEMORY.md'))).toBe(true);
      expect(loadMemoryContext(ws, { bookRoot }).candidates).toHaveLength(0);
    });

    it('updates an existing entry by slug, preserving created and rewriting index line', () => {
      const ws = 'C:\\fake\\slug-update';
      const initial = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Initial title',
          body: 'Initial body.',
          origin: 'model-tool',
          externalContext: false,
        },
        { bookRoot, slug: 'conventions.md', now: new Date('2026-09-01T10:00:00Z') },
      );
      expect(initial.ok).toBe(true);

      const updated = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Updated title',
          body: 'Updated body content.',
          origin: 'model-tool',
          externalContext: true,
        },
        {
          bookRoot,
          slug: 'conventions.md',
          quarantineExternal: false,
          now: new Date('2026-09-20T10:00:00Z'),
        },
      );
      expect(updated.ok).toBe(true);

      const parsed = readMemoryFile(updated.path!);
      expect(parsed?.created).toBe('2026-09-01T10:00:00.000Z');
      expect(parsed?.updated).toBe('2026-09-20T10:00:00.000Z');
      expect(parsed?.title).toBe('Updated title');
      expect(parsed?.externalContext).toBe(true);

      const indexText = readFileSync(
        join(getProjectMemoryDir(ws, { bookRoot }), 'MEMORY.md'),
        'utf-8',
      );
      expect(indexText).toContain('[Updated title](conventions.md)');
      expect(indexText).not.toContain('[Initial title]');
    });

    it('deletes an entry and removes its index line', () => {
      const ws = 'C:\\fake\\delete-entry';
      const saved = saveMemory(
        ws,
        {
          type: 'reference',
          title: 'Doc link',
          body: 'Reference url: https://example.com',
          origin: 'model-tool',
          externalContext: false,
        },
        { bookRoot, slug: 'doc-link.md' },
      );
      expect(saved.ok).toBe(true);

      const del = deleteMemoryEntry(ws, 'doc-link.md', { bookRoot });
      expect(del.ok).toBe(true);
      expect(existsSync(saved.path!)).toBe(false);

      const indexText = readFileSync(
        join(getProjectMemoryDir(ws, { bookRoot }), 'MEMORY.md'),
        'utf-8',
      );
      expect(indexText).not.toContain('doc-link.md');
    });

    it('rejects deletion of missing files, traversal paths, and MEMORY.md', () => {
      const ws = 'C:\\fake\\delete-guards';
      expect(deleteMemoryEntry(ws, 'nonexistent.md', { bookRoot }).ok).toBe(false);
      expect(deleteMemoryEntry(ws, 'MEMORY.md', { bookRoot }).ok).toBe(false);
      expect(deleteMemoryEntry(ws, 'memory.md', { bookRoot }).ok).toBe(false);
      expect(deleteMemoryEntry(ws, '../../escape.md', { bookRoot }).ok).toBe(false);
    });

    it('rejects saving to index file case-insensitively', () => {
      const ws = 'C:\\fake\\index-case';
      expect(
        saveMemory(
          ws,
          { type: 'project', title: 'Test', body: 'Body' },
          { bookRoot, slug: 'memory.md' },
        ).ok,
      ).toBe(false);
      expect(
        saveMemory(
          ws,
          { type: 'project', title: 'Test', body: 'Body' },
          { bookRoot, slug: 'MEMORY.MD' },
        ).ok,
      ).toBe(false);
    });

    it('refuses to overwrite symlinked memory file', () => {
      const ws = 'C:\\fake\\symlink-save';
      const dir = getProjectMemoryDir(ws, { bookRoot });
      mkdirSync(dir, { recursive: true });
      const target = join(bookRoot, 'target.md');
      writeFileSync(target, '# Outside target', 'utf-8');
      const symlinkFile = join(dir, 'link.md');
      try {
        symlinkSync(target, symlinkFile);
        const result = saveMemory(
          ws,
          { type: 'project', title: 'Symlink attack', body: 'Evil' },
          { bookRoot, slug: 'link.md' },
        );
        expect(result.ok).toBe(false);
        expect(result.error).toContain('Refusing to overwrite symlinked memory file');
      } catch {
        // Symlink creation might not be permitted on some Windows configs
      }
    });

    it('preserves targetSlug when requireApproval is true and approve overwrites original with one index entry', () => {
      const ws = 'C:\\fake\\approval-slug';
      // First, write and approve initial memory
      const initial = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Original Conventions',
          body: 'Original content.',
          origin: 'model-tool',
          externalContext: false,
        },
        { bookRoot, slug: 'custom-slug.md', now: new Date('2026-09-01T10:00:00Z') },
      );
      expect(initial.ok).toBe(true);

      // Now save an update with requireApproval: true and the same slug
      const candidateResult = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Updated Conventions',
          body: 'Updated approved content.',
          origin: 'model-tool',
          externalContext: false,
        },
        {
          bookRoot,
          slug: 'custom-slug.md',
          requireApproval: true,
          now: new Date('2026-09-20T10:00:00Z'),
        },
      );
      expect(candidateResult.ok).toBe(true);
      expect(candidateResult.status).toBe('pending');
      expect(candidateResult.path).toContain('.inbox');

      // Verify the candidate file has targetSlug in frontmatter
      const candParsed = readMemoryFile(candidateResult.path!);
      expect(candParsed?.targetSlug).toBe('custom-slug.md');

      // Approve the candidate
      const approved = approveMemoryCandidate(ws, candidateResult.path!, {
        bookRoot,
        now: new Date('2026-09-20T11:00:00Z'),
      });
      expect(approved.ok).toBe(true);
      expect(approved.path).toContain('custom-slug.md');

      // Verify original was overwritten, created timestamp preserved, and index has exactly one line
      const finalParsed = readMemoryFile(approved.path!);
      expect(finalParsed?.title).toBe('Updated Conventions');
      expect(finalParsed?.created).toBe('2026-09-01T10:00:00.000Z');

      const indexText = readFileSync(
        join(getProjectMemoryDir(ws, { bookRoot }), 'MEMORY.md'),
        'utf-8',
      );
      const lines = indexText.split('\n').filter((l) => l.includes('custom-slug.md'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('[Updated Conventions](custom-slug.md)');
      expect(indexText).not.toContain('[Original Conventions]');
    });
  });

  describe('title sanitization', () => {
    it('sanitizes titles with newlines, control characters, brackets, and leading hashes', () => {
      expect(sanitizeMemoryTitle('My title\nstatus: discarded')).toBe('My title status: discarded');
      expect(sanitizeMemoryTitle('Evil title](http://evil.com) [foo')).toBe(
        'Evil titlehttp://evil.com foo',
      );
      expect(sanitizeMemoryTitle('### Leading hashes')).toBe('Leading hashes');
      expect(sanitizeMemoryTitle('   \t\r\n   ')).toBe('');
    });

    it('produces clean frontmatter, heading, and index line for malicious title inputs', () => {
      const ws = 'C:\\fake\\sanitize-title';
      const result = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Malicious title\nstatus: discarded\nfoo: bar](evil.com)[',
          body: 'Safe body content.',
          origin: 'model-tool',
          externalContext: false,
        },
        { bookRoot, slug: 'sanitized.md' },
      );
      expect(result.ok).toBe(true);

      const raw = readFileSync(result.path!, 'utf-8');
      expect(raw).not.toMatch(/\nstatus: discarded\n/);
      expect(raw).toContain('# Malicious title status: discarded foo: barevil.com');

      const indexText = readFileSync(
        join(getProjectMemoryDir(ws, { bookRoot }), 'MEMORY.md'),
        'utf-8',
      );
      expect(indexText).toContain(
        '[Malicious title status: discarded foo: barevil.com](sanitized.md)',
      );
      // Markdown link is not broken; contains only the single valid markdown link
      expect(indexText.match(/\]\(/g)).toHaveLength(1);
    });

    it('rejects memory writes when title is empty after sanitizing', () => {
      const ws = 'C:\\fake\\empty-title';
      expect(
        saveMemory(
          ws,
          { type: 'project', title: '   [ ] ( ) # \n\t  ', body: 'Body' },
          { bookRoot },
        ).ok,
      ).toBe(false);
    });
  });

  describe('slug sanitization', () => {
    it('strips control characters, path separators, leading dots, preserves case, and rejects empty results', () => {
      expect(sanitizeMemorySlug('Foo/Bar\\Baz')).toBe('FooBarBaz');
      expect(sanitizeMemorySlug('...hidden')).toBe('hidden');
      expect(sanitizeMemorySlug('..\evil/Slug\n.md')).toBe('evilSlug.md');
      expect(sanitizeMemorySlug('x\nstatus: discarded')).toBe('xstatus: discarded');
      expect(sanitizeMemorySlug('\r\n\t')).toBeNull();
      expect(sanitizeMemorySlug('...')).toBeNull();
      expect(sanitizeMemorySlug('   ')).toBeNull();
    });

    it('neutralizes a slug that carries a newline or a path, and cannot reach the index', () => {
      const ws = 'C:\\fake\\slug-injection';
      const result = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Slug injection test',
          body: 'Some body content.',
          origin: 'model-tool',
          externalContext: false,
        },
        { bookRoot, slug: 'notes\n/../../MEMORY.md\nstatus: discarded' },
      );
      expect(result.ok).toBe(true);

      const raw = readFileSync(result.path!, 'utf-8');
      expect(raw).not.toMatch(/\nstatus: discarded\n/);
      expect(raw).toContain('status: approved');

      const parsed = readMemoryFile(result.path!);
      expect(parsed?.status).toBe('approved');
      expect(basename(result.path!)).toBe('MEMORY.mdstatus: discarded.md');
      expect(result.path!.startsWith(getProjectMemoryDir(ws, { bookRoot }))).toBe(true);
    });

    it('updates the existing file when the slug names it through a path', () => {
      const ws = 'C:\\fake\\path-like-slug';
      const dir = getProjectMemoryDir(ws, { bookRoot });
      const initial = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Build command',
          body: 'Use npm run build.',
          origin: 'model-tool',
          externalContext: false,
        },
        { bookRoot, slug: 'build-cmd.md' },
      );
      expect(initial.ok).toBe(true);

      const updated = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Build command',
          body: 'Use npm run build --production.',
          origin: 'model-tool',
          externalContext: false,
        },
        { bookRoot, slug: 'memory/build-cmd.md' },
      );
      expect(updated.ok).toBe(true);
      expect(updated.path).toBe(join(dir, 'build-cmd.md'));

      const indexLines = readFileSync(join(dir, 'MEMORY.md'), 'utf-8')
        .split('\n')
        .filter((line) => line.includes('](build-cmd.md)'));
      expect(indexLines).toHaveLength(1);
    });

    it('deletes by a path-like slug', () => {
      const ws = 'C:\\fake\\path-like-delete';
      const dir = getProjectMemoryDir(ws, { bookRoot });
      const saved = saveMemory(
        ws,
        {
          type: 'reference',
          title: 'Deploy doc',
          body: 'See the runbook.',
          origin: 'model-tool',
          externalContext: false,
        },
        { bookRoot, slug: 'deploy.md' },
      );
      expect(saved.ok).toBe(true);

      const deleted = deleteMemoryEntry(ws, 'memory/deploy.md', { bookRoot });
      expect(deleted.ok).toBe(true);
      expect(deleted.path).toBe(join(dir, 'deploy.md'));
      expect(existsSync(saved.path!)).toBe(false);
    });

    it('takes the last segment of a Windows-style path slug', () => {
      const ws = 'C:\\fake\\windows-slug';
      const dir = getProjectMemoryDir(ws, { bookRoot });
      const saved = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Windows slug',
          body: 'Body.',
          origin: 'model-tool',
          externalContext: false,
        },
        { bookRoot, slug: 'C:\\notes\\memory\\release.md' },
      );

      expect(saved.ok).toBe(true);
      expect(saved.path).toBe(join(dir, 'release.md'));
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

    it('rejects save when slug is non-empty but invalid after sanitization', () => {
      const ws = 'C:\\fake\\empty-slug';
      expect(
        saveMemory(
          ws,
          { type: 'project', title: 'Valid title', body: 'Body' },
          { bookRoot, slug: '..' },
        ).ok,
      ).toBe(false);
    });

    it('treats a whitespace-only slug as absent in saveMemory', () => {
      const ws = 'C:\\fake\\absent-slug';
      const result = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Valid title',
          body: 'Body.',
        },
        { bookRoot, slug: '   \t\n  ' },
      );
      expect(result.ok).toBe(true);
      expect(result.status).toBe('approved');
      expect(basename(result.path!)).not.toBe('.md');
    });
  });

  describe('shouldRejectMemoryText', () => {
    it('rejects empty text and overly long text', () => {
      expect(shouldRejectMemoryText('')).toBe('empty');
      expect(shouldRejectMemoryText('   ')).toBe('empty');
      expect(shouldRejectMemoryText('a'.repeat(MAX_BODY_CHARS * 2 + 10))).toBe('too long');
    });

    it('rejects secrets via looksLikeSecretOrUnfit', () => {
      expect(shouldRejectMemoryText('-----BEGIN OPENSSH PRIVATE KEY-----')).not.toBeNull();
      expect(shouldRejectMemoryText('api_key=sk-1234567890abcdef12345678')).not.toBeNull();
      expect(shouldRejectMemoryText('ghp_' + 'A'.repeat(36))).not.toBeNull();
    });

    it('accepts legitimate memory text', () => {
      expect(shouldRejectMemoryText('We use Vitest for unit testing.')).toBeNull();
    });
  });
});

function memoryDirOrInbox(ws: string, root: string): string {
  return getProjectMemoryDir(ws, { bookRoot: root });
}

describe('Phase 2: supersession and index hygiene', () => {
  const ws = '/tmp/book-phase2-ws';
  const opts = () => ({ bookRoot });
  const save = (title: string, body: string, extra: Record<string, unknown> = {}, slug?: string) =>
    saveMemory(
      ws,
      { type: 'project', title, body, origin: 'model-tool', externalContext: false, ...extra },
      { ...opts(), slug },
    );

  it('retires a superseded entry: kept on disk, out of the index and the listing', () => {
    const old = save('Deploy branch', 'We deploy from release.', {}, 'deploy-branch');
    expect(old.ok).toBe(true);
    const next = save('Deploy branch (prod)', 'We deploy from prod.', {
      supersedes: 'deploy-branch',
    });
    expect(next.ok).toBe(true);

    const dir = getProjectMemoryDir(ws, opts());
    const retired = readFileSync(join(dir, 'deploy-branch.md'), 'utf-8');
    expect(retired).toContain('status: superseded');
    expect(retired).toContain(`supersededBy: ${basename(next.path!)}`);
    expect(readFileSync(next.path!, 'utf-8')).toContain('supersedes: deploy-branch.md');

    const index = readFileSync(join(dir, 'MEMORY.md'), 'utf-8');
    expect(index).not.toContain('deploy-branch.md');
    expect(index).toContain(basename(next.path!));
    expect(listMemoryFiles(ws, opts()).map((f) => f.name)).toEqual([basename(next.path!)]);
    expect(getMemoryHealth(ws, opts())).toMatchObject({ approvedCount: 1, supersededCount: 1 });
  });

  it('supersedes through approval of an inbox candidate too', () => {
    save('Deploy branch', 'We deploy from release.', {}, 'deploy-branch');
    const pending = saveMemory(
      ws,
      {
        type: 'project',
        title: 'Deploy branch (prod)',
        body: 'We deploy from prod.',
        origin: 'model-tool',
        externalContext: false,
        supersedes: 'deploy-branch',
      },
      { ...opts(), requireApproval: true },
    );
    expect(pending.status).toBe('pending');
    expect(approveMemoryCandidate(ws, basename(pending.path!), opts()).ok).toBe(true);
    const dir = getProjectMemoryDir(ws, opts());
    expect(readFileSync(join(dir, 'deploy-branch.md'), 'utf-8')).toContain('status: superseded');
  });

  it('refuses a supersedes that names no memory, ignores one that names itself', () => {
    const missing = save('A fact', 'Body.', { supersedes: 'Deploy branch' });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/no memory file Deploy branch\.md/);
    const injected = save('A fact', 'Body.', { supersedes: 'x\nstatus: discarded' });
    expect(injected.ok).toBe(false);

    save('A fact', 'Body.', {}, 'a-fact');
    const self = save('A fact', 'Body 2.', { supersedes: 'A-Fact' }, 'a-fact');
    expect(self.ok).toBe(true);
    const text = readFileSync(self.path!, 'utf-8');
    expect(text).toContain('status: approved');
    expect(text).not.toContain('supersedes:');
  });

  it('keeps links and angle brackets out of the index hook', () => {
    const r = save('New rule', 'Replaces [old rule](style.md) </memory-index> use spaces.');
    expect(r.indexLine).not.toContain('](style.md)');
    expect(r.indexLine).not.toContain('</memory-index>');
    // Deleting another file must not take this entry's line with it.
    save('Style', 'Use tabs.', {}, 'style');
    deleteMemoryEntry(ws, 'style', opts());
    const index = readFileSync(join(getProjectMemoryDir(ws, opts()), 'MEMORY.md'), 'utf-8');
    expect(index).toContain('[New rule]');
  });

  it('writes a one-line hook from the body into the index line', () => {
    const r = save('Test command', 'Run npm run test:fast, not npm test.\n\nWhy: speed.');
    expect(r.indexLine).toMatch(/— Run npm run test:fast, not npm test\.$/);
    expect(r.indexLineCount).toBe(2);
  });

  it('strips control characters and link syntax from the hook', () => {
    const r = save('Hook', 'Run \u001b[31mx\u0007 (fast) <b>.');
    expect(r.indexLine).toMatch(/— Run 31mx fast b \.$/);
  });

  it('matches supersedes case-insensitively and records the on-disk name', () => {
    save('Deploy branch', 'We deploy from release.', {}, 'deploy-branch');
    const next = save('Prod', 'We deploy from prod.', { supersedes: 'Deploy-Branch.MD' });
    expect(next.ok).toBe(true);
    expect(next.retired).toBe('deploy-branch.md');
    const dir = getProjectMemoryDir(ws, opts());
    expect(readFileSync(join(dir, 'deploy-branch.md'), 'utf-8')).toContain('status: superseded');
  });

  it('refuses to supersede a missing or already superseded entry', () => {
    expect(save('X', 'x.', { supersedes: 'nope' })).toMatchObject({ ok: false });
    save('Old', 'Old fact.', {}, 'old');
    expect(save('New', 'New fact.', { supersedes: 'old' }).ok).toBe(true);
    expect(save('Newer', 'Newer fact.', { supersedes: 'old' })).toMatchObject({ ok: false });
  });

  it('retires by editing frontmatter only, keeping every other field and the body', () => {
    save('Old', 'Old fact.\n\nWhy: history.', { tags: ['keep'] }, 'old');
    const dir = getProjectMemoryDir(ws, opts());
    const before = readFileSync(join(dir, 'old.md'), 'utf-8');
    save('New', 'New fact.', { supersedes: 'old' });
    const after = readFileSync(join(dir, 'old.md'), 'utf-8');
    const unchanged = (raw: string) =>
      raw.split('\n').filter((l) => !/^(status|supersededBy|updated):/.test(l));
    expect(unchanged(after)).toEqual(unchanged(before));
  });

  it('prunes index lines whose file is gone, and keeps free-form lines', () => {
    const dir = getProjectMemoryDir(ws, opts());
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'MEMORY.md'),
      '# Book memory index\n- [Gone](gone.md) — project\n- a hand-written note\n',
    );
    save('Fresh', 'A fact.');
    const index = readFileSync(join(dir, 'MEMORY.md'), 'utf-8');
    expect(index).not.toContain('gone.md');
    expect(index).toContain('- a hand-written note');
  });

  it('does not create an index when deleting', () => {
    const dir = getProjectMemoryDir(ws, opts());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'loose.md'), '---\ntype: project\n---\n\n# Loose\n\nA fact.\n');
    expect(deleteMemoryEntry(ws, 'loose', opts()).ok).toBe(true);
    expect(existsSync(join(dir, 'MEMORY.md'))).toBe(false);
  });
});
