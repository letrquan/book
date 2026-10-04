import { mkdirSync, mkdtempSync, readdir, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, resolve } from 'node:path';
import { glob } from 'tinyglobby';
import { afterEach, describe, expect, it } from 'vitest';
import {
  globPatternRefusal,
  globPatternWithinLimit,
  globToRegex,
  globWalkIgnore,
  globWalkPattern,
  globWalkScope,
  MAX_GLOB_GROUPS,
  MAX_GLOB_GROUP_DEPTH,
  MAX_GLOB_PATTERN_LENGTH,
} from './glob-regex.js';

const WS = '/tmp/ws';

/** A directory as the walk spells it: resolved, and in one separator. */
const walkDir = (path: string): string => resolve(path).replaceAll('\\', '/');

const scopeOf = (pattern: string, cwd = WS): string | null => globWalkScope(pattern, cwd);

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A workspace one directory below a parent that holds files of its own, so a walk that climbs out
 * has something to find. That is the whole test: whether a pattern escapes is a property of what
 * the walk returns, not of how the pattern reads.
 */
function workspace(): { ws: string; outside: string } {
  const base = mkdtempSync(join(tmpdir(), 'glob-scope-'));
  dirs.push(base);
  const ws = join(base, 'ws');
  const outside = join(base, 'outside');
  mkdirSync(join(ws, 'src'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(ws, 'src', 'a.ts'), 'a');
  writeFileSync(join(outside, 'secret.ts'), 'secret');
  writeFileSync(join(base, 'parent.ts'), 'parent');
  return { ws, outside };
}

/** A real walk, and the directories it read to get there. */
async function walk(pattern: string, cwd: string) {
  const visited: string[] = [];
  const found = await glob(pattern, {
    cwd,
    dot: true,
    expandDirectories: false,
    // fdir calls `fs.readdir` in its node style, so an instrumented one observes the crawl from
    // its first directory: that is the directory the walk really searches from.
    fs: {
      readdir: (
        path: Parameters<typeof readdir>[0],
        options: Parameters<typeof readdir>[1],
        callback: Parameters<typeof readdir>[2],
      ) => {
        visited.push(String(path));
        return readdir(path, options, callback);
      },
    } as never,
  });
  return { found, visited };
}

/** The entries a walk returns that land outside the workspace it was asked about. */
const escapes = (found: string[], cwd: string): string[] =>
  found.filter((entry) => relative(resolve(cwd), resolve(cwd, entry)).startsWith('..'));

/** Whether `path` is `root` itself or something under it. */
const holds = (root: string, path: string): boolean => {
  const rel = relative(root, resolve(path));
  return rel === '' || !rel.startsWith('..');
};

describe('globToRegex', () => {
  it('anchors a pattern at both ends', () => {
    expect(globToRegex('*.ts').test('a.ts')).toBe(true);
    expect(globToRegex('*.ts').test('a.ts.bak')).toBe(false);
  });
});

describe('globWalkScope', () => {
  it('reports the directory a walk answers from, not what the pattern spells', () => {
    const root = walkDir(WS);
    // Nothing is named, so the walk answers where it stands.
    expect(scopeOf('*')).toBe(root);
    expect(scopeOf('**/*.ts')).toBe(root);
    expect(scopeOf('src/**/*.ts')).toBe(posix.join(root, 'src'));
    expect(scopeOf('/tmp/ws/src/*.ts')).toBe(posix.join(root, 'src'));
    expect(scopeOf('a/b/c/*.ts')).toBe(posix.join(root, 'a/b/c'));
    // A trailing globstar searches from one level above what it can match, because the segment in
    // front of it can hold anything: `src/**` reads the workspace to reach a file under `src`.
    expect(scopeOf('src/**')).toBe(root);
    // A pattern holding no glob names a file or a directory, and both are walked from the `cwd`:
    // neither is expanded into a subtree.
    expect(scopeOf('notes.txt')).toBe(root);
    expect(scopeOf('src')).toBe(root);
    expect(scopeOf('src/')).toBe(root);
    expect(scopeOf('src/notes.txt')).toBe(posix.join(root, 'src'));
  });

  it('reports the directory a pattern climbs into', () => {
    const root = walkDir(WS);
    const parent = posix.dirname(root);
    expect(scopeOf('../**/*')).toBe(parent);
    expect(scopeOf('../*.ts')).toBe(parent);
    expect(scopeOf('../../**')).toBe(posix.dirname(parent));
    expect(scopeOf('foo/../bar/*.ts')).toBe(posix.join(root, 'bar'));
    expect(scopeOf('/tmp/other/*.ts')).toBe(posix.join(parent, 'other'));
    expect(scopeOf('/tmp/ws/parent.ts')).toBe(root);
    // A climb that lands on a named directory answers from that directory, which is what lets an
    // honored additional directory be reached: the walk reads the directories between on its way.
    expect(scopeOf('../other/*.ts')).toBe(posix.join(parent, 'other'));
    expect(scopeOf('/tmp/other/nested/*.ts')).toBe(posix.join(parent, 'other/nested'));
  });

  it('cancels a climb that lands back on the walk directory', () => {
    // `..` and the segment it steps onto are the same directory, so the pattern lands back inside.
    expect(scopeOf('../ws/src/*.ts')).toBe(posix.join(walkDir(WS), 'src'));
    expect(scopeOf('../ws/*.ts')).toBe(walkDir(WS));
  });

  it('reads a pattern whose leading segment is a group as a match, not as a spelling', () => {
    const root = walkDir(WS);
    // A brace group is one segment the matcher has to resolve, so the walk never starts inside it:
    // it starts at the workspace, and the group cannot reach a directory above it. Measured in the
    // real walks below — these three were refused before, on the enumeration of alternatives the
    // walk does not do.
    expect(scopeOf('{..,src}/*')).toBe(root);
    expect(scopeOf('.{.,x}/*')).toBe(root);
    expect(scopeOf('src/{a,{b,../..}}/*')).toBe(posix.join(root, 'src'));
    expect(scopeOf('src/{a,{b,..}}/*')).toBe(posix.join(root, 'src'));
    // A group in the first segment stops the named run there; a range is no different.
    expect(scopeOf('src/{a,b}/*.ts')).toBe(posix.join(root, 'src'));
    expect(scopeOf('logs/{1..3}.txt')).toBe(posix.join(root, 'logs'));
    expect(scopeOf('@(a|b)/*.ts')).toBe(root);
  });

  it('reports a parent for a climb that only normalization can see', async () => {
    // The permission bypass these three were allowed by: the pattern reads as a segment then a
    // hop, but `posix.normalize` is lexical, so the hop eats the glob segment and the walk runs as
    // `../**` from the parent of the workspace, answering `../parent.ts`. fast-glob returned
    // nothing for all three (and for `{..,src}/*`, which this walk answers with nothing too, from
    // the workspace).
    const { ws } = workspace();
    for (const pattern of ['*/../../**', '**/../../**', 'src/*/../../../*.ts']) {
      const { found, visited } = await walk(pattern, ws);
      expect(escapes(found, ws), pattern).not.toEqual([]);
      expect(walkDir(scopeOf(pattern, ws)!), pattern).toBe(resolve(visited[0]));
    }
  });

  it('covers every entry a walk returns, and answers from where it searches', async () => {
    const { ws, outside } = workspace();
    const patterns = [
      '*',
      '**/*.ts',
      'src/*.ts',
      'src',
      'src/',
      'src/**',
      '**',
      'foo/../bar/*.ts',
      '../**',
      '../ws/src/*.ts',
      '../outside/*.ts',
      '{..,src}/*',
      '.{.,x}/*',
      'src/{a,{b,../..}}/*',
      'src/{a,b}/*.ts',
      '**/*.{ts,tsx}',
      'logs/{1..3}.txt',
      '!(*.d).ts',
      '@(a|b)/*.ts',
      join(ws, 'src', '*.ts').replace(/\\/g, '/'),
      join(ws, '..', 'outside', '*.ts').replace(/\\/g, '/'),
    ];
    for (const pattern of patterns) {
      const { found, visited } = await walk(pattern, ws);
      const scope = scopeOf(pattern, ws);
      expect(scope, pattern).not.toBeNull();
      const answer = walkDir(scope!);
      // Every entry the walk returns is inside the directory it answers from.
      for (const entry of found) {
        expect(holds(answer, resolve(ws, entry)), `${pattern} -> ${entry}`).toBe(true);
      }
      // And it searches from that directory or from one above it: the entries a climb passes on
      // the way are listed, but nothing beside what the pattern names comes back.
      expect(visited.length, pattern).toBeGreaterThan(0);
      expect(holds(visited[0], answer), `${pattern} searched from ${visited[0]}`).toBe(true);
      // The absolute spelling of a sibling answers from that sibling, having read the parent to
      // get there; nothing comes back but the sibling's own file.
      if (pattern.includes('/outside/')) {
        expect(answer, pattern).toBe(walkDir(outside));
        expect(found, pattern).toEqual(['../outside/secret.ts']);
      }
    }
  });

  it('answers from the directory a leading group names, reading nothing above it', async () => {
    // The three the permission judgment had to follow out of refusal, with a walk to say so. A
    // group is resolved by the matcher at match time, so the walk is left at the directory the
    // pattern names and answers nothing — no climb, nothing outside the workspace.
    const { ws } = workspace();
    for (const pattern of ['{..,src}/*', '.{.,x}/*', 'src/{a,{b,../..}}/*']) {
      const { found, visited } = await walk(pattern, ws);
      const scope = walkDir(scopeOf(pattern, ws)!);
      expect(escapes(found, ws), pattern).toEqual([]);
      expect(escapes([scope], ws), pattern).toEqual([]);
      expect(scope, pattern).toBe(resolve(visited[0]));
      expect(visited).not.toContain(resolve(ws, '..'));
    }
  });

  it('answers null for a pattern picomatch cannot be handed at all', () => {
    expect(
      scopeOf('{a,'.repeat(MAX_GLOB_GROUP_DEPTH + 1) + '}'.repeat(MAX_GLOB_GROUP_DEPTH + 1)),
    ).toBe(null);
    expect(scopeOf('a'.repeat(MAX_GLOB_PATTERN_LENGTH + 1))).toBe(null);
  });
});

describe('globPatternRefusal', () => {
  it('holds the line at the length the matcher can survive', () => {
    expect(globPatternWithinLimit('src/**/*.ts')).toBe(true);
    expect(globPatternWithinLimit('a'.repeat(MAX_GLOB_PATTERN_LENGTH))).toBe(true);
    expect(globPatternWithinLimit('a'.repeat(MAX_GLOB_PATTERN_LENGTH + 1))).toBe(false);
    expect(globPatternRefusal('a'.repeat(MAX_GLOB_PATTERN_LENGTH + 1))).toContain(
      `${MAX_GLOB_PATTERN_LENGTH}`,
    );
  });

  it('refuses a nesting the matcher cannot compile, well inside the length limit', () => {
    // Measured against this walk: 2500 `!(` groups are 7500 characters and 50 000 short of the
    // length limit, and picomatch compiles them — then aborts Node with `RegExpCompiler Allocation
    // failed` on the first path matched against the result, which no `catch` intercepts. 3300 `+(`
    // groups are 9900 characters and never come back from picomatch's own parse at all.
    const deep = '!('.repeat(2500) + ')'.repeat(2500);
    expect(deep.length).toBeLessThan(MAX_GLOB_PATTERN_LENGTH);
    expect(globPatternRefusal(deep)).toContain(`${MAX_GLOB_GROUP_DEPTH}`);
    expect(globPatternWithinLimit(deep)).toBe(false);

    // Wide rather than deep, so the count is what refuses it: 771 characters of ordinary groups.
    const wide = '{a}'.repeat(MAX_GLOB_GROUPS + 1);
    expect(wide.length).toBeLessThan(MAX_GLOB_PATTERN_LENGTH);
    expect(globPatternRefusal(wide)).toContain(`${MAX_GLOB_GROUPS}`);
  });

  it('reads an ordinary nested pattern as ordinary', () => {
    // Nothing real comes near the bounds: a nested group set, an extglob alternation, a class, an
    // escaped bracket and a negative lookaround are all well inside both.
    for (const pattern of [
      'src/{a,{b,c},d}/*.ts',
      '**/*.{ts,tsx,js,jsx}',
      '@(src|lib)/**/*.ts',
      '+(a|b)/*.ts',
      '**/[a-z]*.ts',
      'src/\\(literal\\)/[0-9]?.ts',
      '?(src)/**',
      '!(*.min).js',
      'logs/{1..12}/{a,b}.log',
      `src/{${'{a,'.repeat(20)}${'}'.repeat(20)}}.ts`,
    ]) {
      expect(globPatternRefusal(pattern), pattern).toBeNull();
    }
  });

  it('counts an escaped bracket as nothing', () => {
    expect(globPatternRefusal('\\'.repeat(500) + '[abc]')).toBeNull();
    expect(globPatternRefusal('src/\\[0-9\\]/*.ts')).toBeNull();
  });
});

describe('globWalkIgnore', () => {
  it('drops the entries the matcher cannot compile and keeps the rest in order', () => {
    // A walk compiles its ignore entries like its pattern, so a `.gitignore` line the matcher
    // cannot read has to go before the list is handed over — the ordinary lines beside it still
    // apply. Nested groups are dropped on their shape now, not only on their length.
    const unreadable = '!('.repeat(2500) + ')'.repeat(2500);
    const tooLong = 'a'.repeat(MAX_GLOB_PATTERN_LENGTH + 1);
    expect(globWalkIgnore(['dist', unreadable, '**/build/**', tooLong])).toEqual([
      'dist',
      '**/build/**',
    ]);
    expect(globWalkIgnore([])).toEqual([]);
  });

  it('respells a root-anchored entry the way the walk reads it', () => {
    // Git means these relative to the repository root, which is the directory the walk starts in.
    // Handed over as written they are absolute paths, which move the crawl root to `/`: the walk
    // then lists every directory from the filesystem root down to the workspace, and still ignores
    // nothing (measured — see the crawl-root test in file.test.ts).
    expect(globWalkIgnore(['/build'])).toEqual(['build', 'build/**']);
    expect(globWalkIgnore(['/build/'])).toEqual(['build', 'build/**']);
    expect(globWalkIgnore(['/build/**'])).toEqual(['build/**']);
    expect(globWalkIgnore(['/build/**/'])).toEqual(['build/**']);
    expect(globWalkIgnore(['//build'])).toEqual(['build', 'build/**']);
    expect(globWalkIgnore(['/'])).toEqual([]);
    // A negation is kept, and the extglob `!(` is not one.
    expect(globWalkIgnore(['!/build'])).toEqual(['!build', '!build/**']);
    expect(globWalkIgnore(['!(build)'])).toEqual(['!(build)']);
    // Everything else is already one entry, as written.
    expect(globWalkIgnore(['dist', '**/node_modules/**', '/src/generated'])).toEqual([
      'dist',
      '**/node_modules/**',
      'src/generated',
      'src/generated/**',
    ]);
  });
});

describe('globWalkPattern', () => {
  it('leaves a POSIX pattern as written', () => {
    // A brace expansion, an extglob and an escape are the caller's syntax and must survive.
    for (const pattern of ['src/*.ts', 'src/{a,b}/*.ts', 'src/(a|b)/*.ts', 'src/\\*.ts']) {
      expect(globWalkPattern(pattern)).toBe(pattern);
    }
  });

  it('splices the converted base back onto the dynamic tail', () => {
    expect(globWalkPattern('src/{a,b}/*.ts')).toBe('src/{a,b}/*.ts');
    expect(globWalkPattern('/tmp/ws/src/*.ts')).toBe('/tmp/ws/src/*.ts');
  });
});
