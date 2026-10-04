import { mkdirSync, mkdtempSync, readdir, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, win32 } from 'node:path';
import { glob } from 'tinyglobby';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  globPatternRefusal,
  globPatternWithinLimit,
  globToRegex,
  globWalkIgnore,
  globWalkPattern,
  globWalkPlan,
  globWalkScopes,
  MAX_GLOB_GROUPS,
  MAX_GLOB_GROUP_DEPTH,
  MAX_GLOB_PATTERN_LENGTH,
} from './glob-regex.js';

const WS = '/tmp/ws';

/** A directory as the walk spells it: resolved, and in one separator. */
const walkDir = (path: string): string => resolve(path).replaceAll('\\', '/');

/** An absolute pattern as this platform's walk directory spells it, so a test builds its own. */
const patternOf = (...segments: readonly string[]): string => posix.join(walkDir(WS), ...segments);

const scopeOf = (pattern: string, cwd = WS): string | null =>
  globWalkScopes(pattern, cwd)?.[0] ?? null;

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * A workspace one directory below a parent that holds files of its own, so a walk that climbs out
 * has something to find, and a symlink inside the workspace pointing at that parent, so a walk that
 * stays inside by name can still leave by link. That is the whole test: whether a pattern escapes is
 * a property of what the walk returns, not of how the pattern reads.
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
  symlinkSync(outside, join(ws, 'link'));
  return { ws, outside };
}

/**
 * A real walk, and the directories it read to get there. The ignore list is the one a tool builds
 * (`globWalkIgnore`), so a walk here is the walk a tool does.
 */
async function walk(pattern: string, cwd: string, ignore: readonly string[] = []) {
  const visited: string[] = [];
  const found = await glob(pattern, {
    cwd,
    dot: true,
    expandDirectories: false,
    ignore: [...ignore],
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

describe('globWalkScopes', () => {
  it('reports the directory a walk answers from, not what the pattern spells', () => {
    const root = walkDir(WS);
    // Nothing is named, so the walk answers where it stands.
    expect(scopeOf('*')).toBe(root);
    expect(scopeOf('**/*.ts')).toBe(root);
    expect(scopeOf('src/**/*.ts')).toBe(posix.join(root, 'src'));
    // Spelled as the walk directory spells itself: `/tmp/ws` on POSIX is `D:/tmp/ws` under a Windows
    // runner, and a hard-coded POSIX root would be a different directory there.
    expect(scopeOf(patternOf('src', '*.ts'))).toBe(posix.join(root, 'src'));
    expect(scopeOf('a/b/c/*.ts')).toBe(posix.join(root, 'a/b/c'));
    // A trailing globstar reads from one level above what it can match, because the segment in front
    // of it can hold anything, but it *answers* from one level down: `src/**` reads the workspace to
    // reach a file under `src`, and no entry it returns can be outside `src`.
    expect(globWalkScopes('src/**', WS)).toEqual([posix.join(root, 'src')]);
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
    expect(scopeOf('../../**')).toBe(walkDir(resolve(WS, '..', '..')));
    expect(scopeOf('foo/../bar/*.ts')).toBe(posix.join(root, 'bar'));
    expect(scopeOf(patternOf('..', 'other', '*.ts'))).toBe(posix.join(parent, 'other'));
    expect(scopeOf(patternOf('parent.ts'))).toBe(root);
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
    expect(scopeOf('.{.,x}/*')).toBe(root);
    expect(scopeOf('src/{a,{b,../..}}/*')).toBe(posix.join(root, 'src'));
    expect(scopeOf('src/{a,{b,..}}/*')).toBe(posix.join(root, 'src'));
    // A group is a segment the walk has to resolve, so the walk reads from the directory in front of
    // it and answers from whichever alternative matched — one scope each, all of them judged. A `..`
    // inside the group is why this one is not enumerated: the count of alternatives it could name is
    // not bounded by what is written, so the run stops in front of it and the whole workspace is the
    // answer scope. That is the wider and so the safer answer, and it is what keeps `{..,src}/*`
    // allowed.
    expect(globWalkScopes('{..,src}/*', WS)).toEqual([root]);
    expect(globWalkScopes('src/{a,b}/*.ts', WS)).toEqual([
      posix.join(root, 'src', 'a'),
      posix.join(root, 'src', 'b'),
    ]);
    // A range is not enumerated — the count of alternatives is not bounded by what is written — and
    // neither is an extglob, so both stop the run in front of them and answer from what is left.
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
      expect(walkDir(scopeOf(pattern, ws)!), pattern).toBe(walkDir(visited[0]));
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
      expect(scope, pattern).toBe(walkDir(visited[0]));
      expect(visited.map(walkDir)).not.toContain(walkDir(resolve(ws, '..')));
    }
  });

  it('answers from every directory a group in the first segment names', () => {
    // A group is a segment the matcher has to resolve, so a walk answers from wherever the
    // alternative names — and `link` here is a symlink out of the workspace, so the scope the walk
    // reads is the link target and not the name. One scope of several is how the group in the first
    // segment of a pattern evaded the judgment: it answered `link/**` from the workspace and the
    // walk returned `link/secret.ts`.
    const { ws } = workspace();
    expect(globWalkScopes('link/**', ws)).toEqual([walkDir(join(ws, 'link'))]);
    expect(globWalkScopes('link/*', ws)).toEqual([walkDir(join(ws, 'link'))]);
    expect(globWalkScopes('{link,src}/**', ws)).toEqual([
      walkDir(join(ws, 'link')),
      walkDir(join(ws, 'src')),
    ]);
    // The directory is spelled the way the pattern spells it; following the link is the permission
    // layer's job (`paths.detail` canonicalizes), which is where `link` is found to be outside the
    // workspace and the walk is refused. One scope of several was how it evaded the judgment.
    expect(globWalkScopes('link/../*.ts', ws)).toEqual([walkDir(ws)]);
  });

  it('answers every group alternative a walk can answer from, not the one in front of it', async () => {
    const { ws, outside } = workspace();
    for (const pattern of ['{link,src}/**', 'link/**', 'src/{a,b}/*.ts', '{link,src}/*']) {
      const { found } = await walk(pattern, ws);
      const scopes = globWalkScopes(pattern, ws);
      expect(scopes, pattern).not.toBeNull();
      for (const entry of found) {
        expect(
          scopes!.some((scope) => holds(scope, resolve(ws, entry))),
          `${pattern} -> ${entry}`,
        ).toBe(true);
      }
    }
    // And the walk really does answer from both alternatives of the group, one of which is a link
    // out of the workspace: the judgment has to see it to refuse it.
    expect((await walk('{link,src}/**', ws)).found).toContain('link/secret.ts');
    expect((await walk('link/**', ws)).found).toEqual(['link/secret.ts']);
    expect(outside).not.toBe('');
  });

  it('reports the directory it reads from when a climb loses the rest of the pattern', () => {
    // The walk rewrites a partially cancelled climb (`../..c/b/c/**` from a `cwd` ending in `b/c`
    // becomes `**`), and a matcher that has lost its named run matches anything under the directory
    // the walk reads — so that directory is the only thing that holds every entry.
    const ws = join(walkDir(WS), 'b', 'c');
    expect(globWalkScopes('../..c/b/c/**', ws)).toEqual([posix.join(walkDir(WS), 'b', '..c', 'b')]);
    expect(globWalkScopes('../..c/b/c/**', ws)?.[0]).not.toContain('/../');
  });

  it('reports a climb only as far as the segments say, not as far as a regex counts', () => {
    // The three shapes a whole-prefix regex counted wrong: `....` reads as 1⅔ hops and lands the
    // judgment on a fractional array length (`new Array(1.667)` → RangeError, thrown from the
    // permission judgment before any walk), and `..c` / `..foo` are ordinary names to a segment-wise
    // count, not hops — so they stay inside the workspace instead of being refused as climbs.
    const { ws } = workspace();
    // `....` is not a name to count and not a hop to step: the walk reads the directory it spells and
    // answers nothing, and the judgment says where it read rather than refusing a climb that is not
    // one. `..foo` *is* read as a hop — the walk climbs one step toward it and then matches the name —
    // so it answers from the parent, outside the workspace.
    expect(globWalkScopes('..../*', ws)).toEqual([walkDir(join(ws, '....'))]);
    expect(globWalkScopes('..../x', ws)).toEqual([walkDir(join(ws, '....'))]);
    expect(globWalkScopes('..foo/*', ws)).toEqual([walkDir(join(dirname(ws), '..foo'))]);
    expect(globWalkScopes('..c/b/*.ts', ws)).toEqual([walkDir(join(dirname(ws), '..c', 'b'))]);
    // A hop that really is a hop is still a hop.
    expect(globWalkScopes('../*.ts', ws)).toEqual([walkDir(dirname(ws))]);
    // A hop plus a name is not one thing to count. The walk's own count of the run is two for
    // `../..c/b/c/**` — `..` is a hop and `..c` is a name, and the two are counted apart — so the
    // answer is `..c/b/c` measured from two levels up. Both of the old answers were wrong: the
    // fractional count made the judgment throw, and the `..c` read as a hop answered from the
    // directory the pattern spells rather than the one the walk reads.
    expect(globWalkScopes('../..c/b/c/**', ws)).toEqual([
      walkDir(join(dirname(dirname(ws)), '..c', 'b', 'c')),
    ]);
    // The walk of it reads from there and answers nothing (nothing under the workspace spells `..c`),
    // and the scope is normalized, so a caller is not handed a `..` to resolve.
    expect(globWalkScopes('../..c/b/c/**', ws)?.[0]).not.toContain('/../');
  });

  it('reads a pattern whose directory holds a glob character as itself', () => {
    // The walk makes an absolute pattern relative against an *escaped* `cwd`, so a workspace under
    // `project (2)` never matched an absolute pattern — and the judgment spelled the same directory
    // two ways, so it compared `project \(2\)` with `project (2)` and called a walk from inside the
    // workspace `outside`. Both are answered from the workspace now.
    const base = mkdtempSync(join(tmpdir(), 'glob-meta-'));
    dirs.push(base);
    const ws = join(base, 'project (2)', 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src', 'a.ts'), 'a');
    for (const pattern of ['src/*.ts', `**/*.ts`, `${walkDir(ws)}/**/*.ts`]) {
      expect(globWalkScopes(pattern, ws), pattern).toEqual(
        pattern.endsWith('*.ts') && pattern.startsWith('src')
          ? [walkDir(join(ws, 'src'))]
          : [walkDir(ws)],
      );
    }
    // And the walk is handed the part below the workspace, which is what makes it answer at all.
    expect(globWalkPattern(`${walkDir(ws)}/**/*.ts`, ws)).toBe('**/*.ts');
    expect(globWalkPattern(`${walkDir(ws)}/src/*.ts`, ws)).toBe('src/*.ts');
  });

  it('answers null for a pattern picomatch cannot be handed at all', () => {
    expect(
      scopeOf('{a,'.repeat(MAX_GLOB_GROUP_DEPTH + 1) + '}'.repeat(MAX_GLOB_GROUP_DEPTH + 1)),
    ).toBe(null);
    expect(scopeOf('a'.repeat(MAX_GLOB_PATTERN_LENGTH + 1))).toBe(null);
  });
});

/**
 * The Windows reading of a walk, judged on any platform: `platform` is the platform whose paths are
 * read, so the drive, the separator, and the root a climb lands on are measured here rather than only
 * on a Windows runner — where, besides, `C:\Users\me\ws` cannot be created to be walked.
 */
describe('globWalkScopes for Windows', () => {
  const WIN_WS = 'C:\\Users\\me\\ws';
  /** A scope as `path.win32` reads it back: one separator, and it is the one a walk spells with. */
  const winSpelled = (path: string): string => path.replaceAll('\\', '/');

  it('answers with scopes a Windows path module reads back as themselves', () => {
    for (const pattern of [
      'src\\*.ts',
      'src/*.ts',
      `${WIN_WS}\\src\\*.ts`,
      'C:/Users/me/ws/src/*.ts',
      `${WIN_WS}\\**\\*.ts`,
      'src\\**\\*.ts',
      '*',
      '**/*.ts',
      '..\\outside\\*.ts',
      'C:\\Users\\me\\outside\\*.ts',
      '..\\..\\**',
      'C:\\..\\..\\**',
      '/ws/src/*.ts',
    ]) {
      const scopes = globWalkScopes(pattern, WIN_WS, 'win32');
      expect(scopes, pattern).not.toBeNull();
      for (const scope of scopes!) {
        // Absolute in the platform's own reading — a relative scope resolved against the workspace
        // points somewhere the walk never was — and spelled so `path.win32.resolve` hands it back
        // unchanged, which is what the permission layer does with every scope it is given.
        expect(win32.isAbsolute(scope), `${pattern} -> ${scope}`).toBe(true);
        expect(winSpelled(win32.resolve(scope)), `${pattern} -> ${scope}`).toBe(scope);
      }
    }
  });

  it('names the same directory whichever way the pattern is spelled', () => {
    for (const pattern of [
      'src\\*.ts',
      'src/*.ts',
      `${WIN_WS}\\src\\*.ts`,
      'C:/Users/me/ws/src/*.ts',
    ]) {
      expect(globWalkScopes(pattern, WIN_WS, 'win32'), pattern).toEqual(['C:/Users/me/ws/src']);
    }
  });

  it('reads a climb against the drive it lands on', () => {
    // A sibling outside the workspace, a climb back into it, and a climb that reaches the root of
    // the drive: all three are absolute paths of one filesystem, whatever separator wrote them.
    expect(globWalkScopes('..\\outside\\*.ts', WIN_WS, 'win32')).toEqual(['C:/Users/me/outside']);
    expect(globWalkScopes('..\\ws\\src\\*.ts', WIN_WS, 'win32')).toEqual(['C:/Users/me/ws/src']);
    expect(globWalkScopes('..\\..\\**', WIN_WS, 'win32')).toEqual(['C:/Users']);
    expect(globWalkScopes('C:\\..\\..\\**', WIN_WS, 'win32')).toEqual(['C:/']);
    // A rooted pattern is the root of the drive, not a path inside the workspace.
    expect(globWalkScopes('/ws/src/*.ts', WIN_WS, 'win32')).toEqual(['C:/ws/src']);
  });

  it('hands the walk the part below the workspace, however the pattern is spelled', () => {
    expect(globWalkPattern('src\\*.ts', WIN_WS, 'win32')).toBe('src/*.ts');
    expect(globWalkPattern(`${WIN_WS}\\src\\*.ts`, WIN_WS, 'win32')).toBe('src/*.ts');
    expect(globWalkPattern('C:/Users/me/ws/src/*.ts', WIN_WS, 'win32')).toBe('src/*.ts');
    expect(globWalkPattern('..\\other\\*.ts', WIN_WS, 'win32')).toBe('../other/*.ts');
    // And a POSIX spelling keeps its escapes, because `\` is an escape to picomatch off Windows.
    expect(globWalkPattern('src/\\*.ts', WIN_WS, 'linux')).toBe('src/\\*.ts');
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
    expect(globWalkIgnore(['/build/'])).toEqual(['build/**/*']);
    expect(globWalkIgnore(['/build/**'])).toEqual(['build/**']);
    expect(globWalkIgnore(['/build/**/'])).toEqual(['build/**']);
    expect(globWalkIgnore(['//build'])).toEqual(['build', 'build/**']);
    expect(globWalkIgnore(['/'])).toEqual([]);
    // A negation is kept; an extglob `!(` is not a negation at all (git means a literal `!` here,
    // picomatch an extglob), and it is dropped rather than left to filter results as one.
    expect(globWalkIgnore(['!/build'])).toEqual(['!build', '!build/**']);
    const dropped: Array<[string, string]> = [];
    expect(
      globWalkIgnore(['!(build)', '/../x', '../x', '..'], (entry, reason) =>
        dropped.push([entry, reason]),
      ),
    ).toEqual([]);
    expect(dropped.map(([entry]) => entry)).toEqual(['!(build)', '/../x', '../x', '..']);
    expect(dropped[0][1]).toContain('extglob');
    expect(dropped[1][1]).toContain('climb out of its own root');
    // Everything else is already one entry, as written.
    expect(globWalkIgnore(['dist', '**/node_modules/**', '/src/generated'])).toEqual([
      'dist',
      '**/node_modules/**',
      'src/generated',
      'src/generated/**',
    ]);
  });
});

/**
 * The walks behind the ignore list: every one of these is what a `.gitignore` line does to a tool,
 * measured rather than reasoned about, and each has a judgment that used to be wrong.
 */
describe('globWalkIgnore in a walk', () => {
  /** A workspace with the shapes these findings are about. */
  function ignoreWorkspace(): { ws: string; base: string } {
    const base = mkdtempSync(join(tmpdir(), 'glob-ignore-'));
    dirs.push(base);
    const ws = join(base, 'ws');
    // A root *file* named `build`: `/build/` in git means the directory and not this file, and the
    // walk cannot tell the two apart by name.
    writeFileSync(join(base, 'build'), 'a file, not a directory');
    mkdirSync(join(ws, 'src'), { recursive: true });
    mkdirSync(join(ws, 'src', 'build'), { recursive: true });
    writeFileSync(join(ws, 'src', 'build', 'a.ts'), 'a');
    mkdirSync(join(ws, 'keep'), { recursive: true });
    writeFileSync(join(ws, 'keep', 'b.ts'), 'b');
    mkdirSync(join(base, 'outside'), { recursive: true });
    writeFileSync(join(base, 'outside', 'secret.ts'), 'secret');
    return { ws, base };
  }

  it('ignores what git ignores without matching a file that happens to have the name', async () => {
    const { ws } = ignoreWorkspace();
    const { found } = await walk('**/*', ws, globWalkIgnore(['/build/']));
    // `build/` is a directory-only line: git ignores the directory and everything under it, and
    // keeps a *file* named `build`. Spelling the entry `build` (as it was) matched the file: the walk
    // lists the root, the bare name matched the file it found there, and `/build` is answered from
    // the root so the file at the repository root is the one git keeps.
    // Sorted: a walk answers in the order the filesystem listed its directories in.
    expect([...found].sort()).toEqual(['keep/b.ts', 'src/build/a.ts']);
    // And the old spelling really did lose the file, which is what the finding was about.
    expect((await walk('**/*', ws, ['build', 'build/**'])).found).not.toContain('build');
    expect((await walk('/build', ws, ['build', 'build/**'])).found).toEqual([]);
    // And where `build` really is a directory, the directory and everything under it still go.
    const base = mkdtempSync(join(tmpdir(), 'glob-ignore-dir-'));
    dirs.push(base);
    const ws2 = join(base, 'ws');
    mkdirSync(join(ws2, 'build', 'nested'), { recursive: true });
    writeFileSync(join(ws2, 'build', 'a.js'), 'a');
    writeFileSync(join(ws2, 'build', 'nested', 'b.js'), 'b');
    writeFileSync(join(ws2, 'keep.ts'), 'k');
    expect((await walk('**/*', ws2, globWalkIgnore(['build/']))).found).toEqual(['keep.ts']);
  });

  it('keeps a walk whose ignore entry climbs out of its own root inside the root', async () => {
    // `/../x` and `../x` read as a climb out of the walk's own root, which moves the crawl root to
    // `/`: the walk then lists every directory from the filesystem root down to the workspace and
    // still ignores nothing (measured). Both are dropped instead, with the reason.
    const { ws, base } = ignoreWorkspace();
    const dropped: string[] = [];
    expect(globWalkIgnore(['/../x', 'a/../..', '..'], (entry) => dropped.push(entry))).toEqual([]);
    expect(dropped).toEqual(['/../x', 'a/../..', '..']);
    // Handed over as written, the walk reads one level above the workspace (`../x`) or the filesystem
    // root (`/../x`) to get to it, lists everything on the way, and still ignores nothing — measured,
    // and the reason the entries are dropped rather than respelled.
    const relative = await walk('**/*', ws, ['../outside']);
    // `posix.join(cwd, '..')` keeps the trailing slash, so the two are compared as paths.
    expect(walkDir(relative.visited[0])).toBe(walkDir(base));
    expect(relative.found).toContain('keep/b.ts');
    const anchored = await walk('**/*', ws, ['/../outside']);
    expect(anchored.found).toContain('keep/b.ts');
    // Dropped, the walk starts in the workspace and answers the same entries.
    const { found, visited } = await walk(
      '**/*',
      ws,
      globWalkIgnore(['../outside', '/../outside']),
    );
    expect(found).toContain('keep/b.ts');
    expect(found).toContain('src/build/a.ts');
    expect(walkDir(visited[0])).toBe(walkDir(ws));
    expect(visited).not.toContain(base);
  });

  it.skipIf(process.platform === 'win32')(
    'reads a root-anchored climb out of the walk from the filesystem root',
    async () => {
      // The crawl root of the entry above, measured where `/` names the filesystem root: on Windows
      // the same entry is normalized against the drive, and the walk that answers it is not the one
      // this finding is about. What it ignores nothing like is asserted above, on both platforms.
      const { ws } = ignoreWorkspace();
      const anchored = await walk('**/*', ws, ['/../outside']);
      expect(anchored.visited[0]).toBe('/');
    },
  );

  it('does not turn a root-relative `.` entry into a pattern that matches nothing', () => {
    // `/.`, `/./` and `//.` normalized to `[".", "./**"]`, and a walk ignoring `./**` returns nothing
    // at all: every entry is under `.`, so everything matched and was dropped. Git's `/` means the
    // repository root itself, which a walk rooted there cannot ignore.
    for (const entry of ['/', '/.', '/./', '//.']) {
      expect(globWalkIgnore([entry]), entry).toEqual([]);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'keeps the answer of a walk handed a root-relative `.` entry as written',
    async () => {
      // Measured on POSIX, where `/` is the filesystem root. There the entry still matches nothing,
      // so the walk answers the whole workspace — which is the reason it is respelled rather than
      // handed over (Windows answers a rooted `.` as a drive path, and no tool hands it one).
      const { ws } = ignoreWorkspace();
      const { found } = await walk('**/*', ws, ['/.']);
      expect(found).toContain('keep/b.ts');
      expect(found.length).toBeGreaterThan(1);
    },
  );

  it('drops an extglob `!(` rather than letting it filter results as one', async () => {
    // picomatch reads `!(build)` as "any entry that is not `build`", so an ignore entry that git
    // means as a literal `!(build)` name dropped everything *except* the directories that name. The
    // walk with the entry handed over kept a single file and dropped the rest.
    const { ws } = ignoreWorkspace();
    const dropped: Array<[string, string]> = [];
    expect(globWalkIgnore(['!(build)'], (entry, reason) => dropped.push([entry, reason]))).toEqual(
      [],
    );
    expect(dropped[0][0]).toBe('!(build)');
    expect(dropped[0][1]).toContain('extglob');
    // Handed over as written it filters results as an extglob — everything *except* what the pattern
    // names — so the walk prunes its first directory and answers nothing at all (measured).
    expect((await walk('**/*', ws, ['!(build)'])).found).toEqual([]);
    // Dropped, the walk answers everything the `.gitignore` does not exclude. Sorted: the order a
    // walk answers in is the order the filesystem listed its directories in, which is no order at
    // all.
    expect((await walk('**/*', ws, globWalkIgnore(['!(build)']))).found.sort()).toEqual([
      'keep/b.ts',
      'src/build/a.ts',
    ]);
  });
});

describe('the dropped-entry report', () => {
  /**
   * The default reporter through a fresh copy of the module, which is the only way to see the
   * logger's gate: `DEBUG_ENABLED` is read when the module loads, so setting the variable inside the
   * test is too late for the logger already built.
   */
  async function reportedBy(value: string | undefined): Promise<string[]> {
    const written: string[] = [];
    const original = { debug: process.env.BOOK_DEBUG, stderr: process.env.BOOK_DEBUG_STDERR };
    if (value === undefined) delete process.env.BOOK_DEBUG;
    else process.env.BOOK_DEBUG = value;
    process.env.BOOK_DEBUG_STDERR = '1';
    vi.resetModules();
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as never;
    try {
      const { globWalkIgnore } = await import('./glob-regex.js');
      globWalkIgnore(['!(build)', 'a'.repeat(MAX_GLOB_PATTERN_LENGTH + 1)]);
    } finally {
      process.stderr.write = originalWrite;
      if (original.debug === undefined) delete process.env.BOOK_DEBUG;
      else process.env.BOOK_DEBUG = original.debug;
      if (original.stderr === undefined) delete process.env.BOOK_DEBUG_STDERR;
      else process.env.BOOK_DEBUG_STDERR = original.stderr;
    }
    return written;
  }

  it('names the entry and the reason, per walk, and only under BOOK_DEBUG=1', async () => {
    // The changelog claimed `BOOK_DEBUG=tools:glob` and said the entry was named once. The logger is
    // a no-op unless the variable is `1` — `tools:glob` is not a namespace it filters on — the entry
    // was not in the message at all, and it fires per walk, not once per entry list.
    expect(await reportedBy(undefined)).toEqual([]);
    expect(await reportedBy('tools:glob')).toEqual([]);
    const report = (await reportedBy('1')).join('');
    // One line per dropped entry, each naming the entry and why it went, and one line per walk:
    // three walks over this repository (Glob, Grep, mentions) log it three times.
    expect(report.split('\n').filter(Boolean)).toHaveLength(2);
    expect(report).toContain('!(build)');
    expect(report).toContain('extglob');
    expect(report).toContain(`${MAX_GLOB_PATTERN_LENGTH}`);
  });
});

describe('globWalkPattern', () => {
  it('leaves a POSIX pattern as written', () => {
    // A brace expansion, an extglob and an escape are the caller's syntax and must survive. The
    // platform is named rather than taken from the host, so the POSIX reading is measured on Windows
    // too — where `src/\*.ts` is `src//*.ts` and the escape is a separator.
    for (const pattern of ['src/*.ts', 'src/{a,b}/*.ts', 'src/(a|b)/*.ts', 'src/\\*.ts']) {
      expect(globWalkPattern(pattern, WS, 'linux'), pattern).toBe(pattern);
    }
  });

  it('splices the converted base back onto the dynamic tail', () => {
    expect(globWalkPattern('src/{a,b}/*.ts', WS)).toBe('src/{a,b}/*.ts');
    // An absolute pattern inside the workspace is handed over relative to it, which is also how a
    // workspace under a directory holding a glob character is walked at all (`escapePath` on the
    // `cwd` is what made the absolute spelling match nothing). It is spelled as the walk directory
    // spells itself, which on a Windows runner is a drive root rather than `/tmp`.
    expect(globWalkPattern(patternOf('src', '*.ts'), WS)).toBe('src/*.ts');
    expect(globWalkPattern(patternOf('..', 'other', '*.ts'), WS)).toBe('../other/*.ts');
  });

  it('hands the walk a pattern it can read, or the reason it cannot be handed one', () => {
    // The refusal is asked of the pattern the walk would read, not of the spelling the caller wrote:
    // `posixPattern` rewrites `\` to `/` on Windows, so a pattern that skips the limits as escapes
    // is refused as the group it becomes.
    const plan = globWalkPlan('src/**/*.ts', WS);
    expect(plan.pattern).toBe('src/**/*.ts');
    expect(plan.refusal).toBeNull();
    expect(plan.scopes).toEqual([posix.join(walkDir(WS), 'src')]);
    // The refusal is asked of the walked spelling, and it is what the tools report.
    expect(globWalkPlan('a'.repeat(MAX_GLOB_PATTERN_LENGTH + 1), WS).refusal).toBe(
      globPatternRefusal('a'.repeat(MAX_GLOB_PATTERN_LENGTH + 1)),
    );
    expect(globWalkPlan('a'.repeat(MAX_GLOB_PATTERN_LENGTH + 1), WS).scopes).toBeNull();
    expect(
      globWalkPlan(
        '{a,'.repeat(MAX_GLOB_GROUP_DEPTH + 1) + '}'.repeat(MAX_GLOB_GROUP_DEPTH + 1),
        WS,
      ).refusal,
    ).toContain(`${MAX_GLOB_GROUP_DEPTH}`);
    expect(globWalkPlan('a'.repeat(MAX_GLOB_PATTERN_LENGTH + 1), WS).refusal).toContain(
      `${MAX_GLOB_PATTERN_LENGTH}`,
    );
    // The brace shapes the caps could be evaded with on Windows: `\` is a separator there, so a
    // run of them is a run of hops in the spelling the walk reads.
    const winBraces = globWalkPlan('x\\{a,b\\}/*.ts', WS, 'win32');
    expect(winBraces.refusal).toBe(globPatternRefusal('x/{a,b/}/*.ts'));
    expect(globWalkScopes('x\\{a,b\\}/*.ts', WS, 'win32')).toEqual(
      globWalkScopes('x/{a,b/}/*.ts', WS, 'win32'),
    );
  });
});
