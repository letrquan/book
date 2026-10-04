import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { FileSystemAdapter } from 'tinyglobby';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Records how many files are being sized at once, and sizes them exactly as the module would. A
 * list of fifty read one at a time is fifty round trips before the user sees the first suggestion;
 * nothing about the result says so, so the concurrency is asked for here.
 */
const sizes = vi.hoisted(() => ({ inFlight: 0, peak: 0 }));
vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    stat: async (path: string) => {
      sizes.inFlight += 1;
      sizes.peak = Math.max(sizes.peak, sizes.inFlight);
      try {
        // Long enough that a sequential read of the list below cannot overlap itself.
        await new Promise((done) => setTimeout(done, 1));
        return await actual.stat(path);
      } finally {
        sizes.inFlight -= 1;
      }
    },
  };
});

/**
 * Records what each walk is asked for, and walks exactly as the library would — except for the
 * directories a test says the walk cannot read, which is handed over as an `fs` adapter rather than
 * made with `chmod 000`. A mode bit reaches neither Windows (where it removes no read access) nor a
 * root, and the failure a walk swallows is a `readdir` failure, so that is what is simulated here.
 */
const walks = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  locked: [] as string[],
}));
vi.mock('tinyglobby', async (importOriginal) => {
  const actual = await importOriginal<typeof import('tinyglobby')>();
  const { readdir } = await import('fs');
  const { resolve } = await import('path');
  return {
    ...actual,
    glob: (patterns: string | string[], options?: Record<string, unknown>) => {
      walks.calls.push({ patterns, ...options });
      if (walks.locked.length === 0) return actual.glob(patterns, options);
      const readdirPassthrough = readdir as unknown as (
        path: unknown,
        options: unknown,
        callback: (error: NodeJS.ErrnoException | null, entries?: unknown) => void,
      ) => void;
      const readdirWithFailure = ((
        path: unknown,
        readdirOptions: unknown,
        callback: (error: NodeJS.ErrnoException | null, entries?: unknown) => void,
      ): void => {
        // A walk spells a directory with a trailing separator, so the two are compared resolved.
        if (walks.locked.some((locked) => resolve(String(path)) === resolve(locked))) {
          callback(
            Object.assign(new Error(`EACCES: permission denied, scandir '${String(path)}'`), {
              code: 'EACCES',
            }),
          );
          return;
        }
        readdirPassthrough(path, readdirOptions, callback);
      }) as FileSystemAdapter['readdir'];
      return actual.glob(patterns, { ...options, fs: { readdir: readdirWithFailure } });
    },
  };
});

import {
  findActiveFileMention,
  getFileMentionCandidates,
  replaceActiveFileMention,
  resolveWorkspaceMentionPath,
} from './file-mentions.js';

let dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-mentions-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe('file mention helpers', () => {
  it('finds the active unquoted mention at the end of input', () => {
    expect(findActiveFileMention('explain @src/too')).toEqual({
      start: 8,
      end: 16,
      query: 'src/too',
      quoted: false,
    });
  });

  it('finds an active quoted mention', () => {
    expect(findActiveFileMention('read @"my file')).toEqual({
      start: 5,
      end: 14,
      query: 'my file',
      quoted: true,
    });
  });

  it('ignores completed or non-boundary mentions', () => {
    expect(findActiveFileMention('email dev@example.com')).toBeNull();
    expect(findActiveFileMention('read @src/file.ts now')).toBeNull();
  });

  it('replaces active mention with the selected path', () => {
    const mention = findActiveFileMention('explain @src/too');
    expect(mention).not.toBeNull();
    expect(replaceActiveFileMention('explain @src/too', mention!, 'src/tools/file.ts')).toBe(
      'explain @src/tools/file.ts ',
    );
  });

  it('keeps workspace paths inside the workspace', () => {
    const ws = workspace();
    expect(resolveWorkspaceMentionPath(ws, '../outside')).toBeNull();
    expect(resolveWorkspaceMentionPath(ws, './src/app.ts')?.relativePath).toBe('src/app.ts');
  });

  it('stays silent about a directory the walk could not read', async () => {
    // Glob and Grep name the directories they could not read, because a file missing from their
    // answer is a file the caller asked about and did not get. A mention list is neither: it is a
    // hint at what can be typed, and a path it cannot offer costs a keystroke that finds nothing.
    // Pinned here so the silence is a decision on the record rather than an omission.
    const ws = workspace();
    const locked = join(ws, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'secret.ts'), 'secret');
    writeFileSync(join(ws, 'open.ts'), 'open');
    walks.locked.push(locked);
    try {
      const candidates = await getFileMentionCandidates(ws, '');
      expect(candidates.map((candidate) => candidate.path)).toContain('open.ts');
      expect(candidates.map((candidate) => candidate.path)).not.toContain('locked/secret.ts');
    } finally {
      walks.locked.length = 0;
    }
  });

  it('returns gitignore-aware file candidates', async () => {
    const ws = workspace();
    mkdirSync(join(ws, 'src'));
    mkdirSync(join(ws, 'dist'));
    writeFileSync(join(ws, '.gitignore'), 'dist\n');
    writeFileSync(join(ws, 'src', 'app.ts'), 'app');
    writeFileSync(join(ws, 'dist', 'app.js'), 'ignored');

    const candidates = await getFileMentionCandidates(ws, 'app');

    expect(candidates.map((c) => c.path)).toContain('src/app.ts');
    expect(candidates.map((c) => c.path)).not.toContain('dist/app.js');
  });

  it('reports a directory with the slash the walk spells it with', async () => {
    // A directory walk entry arrives with a trailing `/`, which is the only thing telling a
    // directory from a file, and that spelling is the one that reaches the input: `@src/`.
    const ws = workspace();
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src', 'app.ts'), 'app');

    const candidates = await getFileMentionCandidates(ws, 'src');

    expect(candidates.find((c) => c.kind === 'directory')).toEqual({
      path: 'src/',
      kind: 'directory',
      desc: 'directory',
    });
  });

  it('offers a symlinked directory, which the walk enters without reporting', async () => {
    // A symlinked directory is walked through but is not itself an entry: the walk answers
    // `linkdir/out.ts` and never `linkdir/`, so `@linkdir` — the spelling a mention is most often
    // about — had nothing to offer. Its ancestors are spelled out here when the walk left them
    // out, and a real directory is entered, so nothing else is added twice.
    const ws = workspace();
    mkdirSync(join(ws, 'real'));
    writeFileSync(join(ws, 'real', 'app.ts'), 'app');
    symlinkSync(join(ws, 'real'), join(ws, 'linkdir'), 'dir');
    mkdirSync(join(ws, 'nested'));
    writeFileSync(join(ws, 'nested', 'note.md'), 'note');
    symlinkSync(join(ws, 'nested'), join(ws, 'link2'), 'dir');

    // An empty query matches everything, so the list is the walk's own.
    const candidates = await getFileMentionCandidates(ws, '');

    expect(candidates.find((c) => c.path === 'linkdir/')).toEqual({
      path: 'linkdir/',
      kind: 'directory',
      desc: 'directory',
    });
    // Every directory is listed once: the real ones the walk reports, and the links it walks
    // through without reporting.
    for (const path of ['linkdir/', 'link2/', 'real/', 'nested/']) {
      expect(
        candidates.filter((c) => c.path === path),
        path,
      ).toHaveLength(1);
    }
    // And a file under the link is listed once, under the name the walk reached it by.
    expect(candidates.filter((c) => c.path === 'linkdir/app.ts')).toHaveLength(1);
    expect(candidates.filter((c) => c.path === 'linkdir/note.md')).toHaveLength(0);
  });

  it('keeps a root-anchored .gitignore line pruning what it names', async () => {
    // Git reads `/build` as the repository root's `build`; the walk reads a leading `/` as the
    // filesystem root, so the line as written moves the search to `/` — every directory from there
    // down listed to reach one the pattern cannot match — and prunes nothing. It is respelled where
    // the walk reads it.
    const ws = workspace();
    mkdirSync(join(ws, 'src'));
    mkdirSync(join(ws, 'build'));
    writeFileSync(join(ws, '.gitignore'), '/build\n');
    writeFileSync(join(ws, 'src', 'app.ts'), 'app');
    writeFileSync(join(ws, 'build', 'app.js'), 'ignored');

    const candidates = await getFileMentionCandidates(ws, 'app');

    expect(candidates.map((c) => c.path)).toContain('src/app.ts');
    expect(candidates.map((c) => c.path)).not.toContain('build/app.js');
  });

  it('drops a .gitignore line too long for the matcher and keeps the rest', async () => {
    // Every entry of the walk's `ignore` list is compiled by the same matcher as the pattern, and
    // these entries come from the repository's own `.gitignore`. Ten thousand nested brace groups
    // compile into a regular expression V8 cannot build — a fatal error, below the reach of any
    // catch — so the line is dropped on its length and the ordinary line beside it still applies.
    const ws = workspace();
    mkdirSync(join(ws, 'src'));
    mkdirSync(join(ws, 'build'));
    writeFileSync(
      join(ws, '.gitignore'),
      ['{a,'.repeat(10_000) + '}'.repeat(10_000), 'build', ''].join('\n'),
    );
    writeFileSync(join(ws, 'src', 'app.ts'), 'app');
    writeFileSync(join(ws, 'build', 'app.js'), 'ignored');

    const candidates = await getFileMentionCandidates(ws, 'app');

    // `build` and not `dist`, which the default ignore list covers whatever the file says.
    expect(candidates.map((c) => c.path)).toContain('src/app.ts');
    expect(candidates.map((c) => c.path)).not.toContain('build/app.js');
  }, 60_000);

  it('sizes the suggestions it lists together, not one at a time', async () => {
    // The walk has already finished by this point, and each size is a separate filesystem call:
    // read one after another, a list of fifty costs fifty round trips between typing `@` and
    // seeing anything.
    const ws = workspace();
    mkdirSync(join(ws, 'src'));
    for (let index = 0; index < 12; index++) {
      writeFileSync(join(ws, 'src', `file-${index}.ts`), 'x'.repeat(index));
    }
    sizes.peak = 0;

    const candidates = await getFileMentionCandidates(ws, 'file', 12);

    expect(candidates).toHaveLength(12);
    expect(sizes.peak).toBe(12);
    expect(candidates.every((c) => /^\d+ bytes$/.test(c.desc))).toBe(true);
  });

  it('hands the walk the signal it is to stop on', async () => {
    // A keystroke that moves on before the walk finishes leaves a list nobody will read, and a
    // walk that is not told to stop runs to the end of the repository first.
    const ws = workspace();
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src', 'app.ts'), 'app');
    const controller = new AbortController();
    walks.calls.length = 0;

    const candidates = await getFileMentionCandidates(ws, 'app', 10, controller.signal);

    expect(candidates.map((c) => c.path)).toContain('src/app.ts');
    expect(walks.calls).toHaveLength(1);
    expect(walks.calls[0].signal).toBe(controller.signal);
  });

  it('returns metadata asynchronously and honors cancellation', async () => {
    const ws = workspace();
    mkdirSync(join(ws, 'src'));
    for (let index = 0; index < 300; index++) {
      writeFileSync(join(ws, 'src', `file-${index}.ts`), String(index));
    }

    let timerFired = false;
    const timer = setTimeout(() => {
      timerFired = true;
    }, 0);
    try {
      const candidates = await getFileMentionCandidates(ws, 'file', 10);
      expect(timerFired).toBe(true);
      expect(candidates).toHaveLength(10);
      expect(candidates[0]).toMatchObject({ kind: 'file', desc: expect.stringMatching(/bytes/) });
    } finally {
      clearTimeout(timer);
    }

    const controller = new AbortController();
    controller.abort(new Error('mention cancelled'));
    await expect(getFileMentionCandidates(ws, 'file', 50, controller.signal)).rejects.toThrow(
      'mention cancelled',
    );
  });
});
