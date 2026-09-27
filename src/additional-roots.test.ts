import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative } from 'path';
import {
  collectDeclaredDirectories,
  homeGuards,
  partitionProjectDirectories,
  pathHoldsHome,
  persistProjectDirectoryChoice,
  realPathOfDirectory,
  resolveAdditionalRoots,
  rootHoldsHome,
} from './additional-roots.js';
import { loadWorkspaceTrust } from './workspace-trust.js';

let workspace: string;
let home: string;
let shared: string;
let storePath: string;
const created: string[] = [];

/** A temp directory the `afterEach` removes, for the cases that create one mid-test. */
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-dirs-ws-'));
  home = mkdtempSync(join(tmpdir(), 'book-dirs-home-'));
  shared = mkdtempSync(join(tmpdir(), 'book-dirs-shared-'));
  storePath = join(home, 'trust.json');
});

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  rmSync(shared, { recursive: true, force: true });
});

describe('realPathOfDirectory', () => {
  it('resolves a relative entry against the workspace, and follows links', () => {
    symlinkSync(shared, join(workspace, 'link'), 'junction');

    expect(realPathOfDirectory(workspace, 'link')).toBe(realpathSync.native(shared));
    expect(realPathOfDirectory(workspace, './link/')).toBe(realpathSync.native(shared));
    expect(realPathOfDirectory(workspace, shared)).toBe(realpathSync.native(shared));
  });

  // The one decision this whole module exists for: a repository controls the text and could
  // declare a link, so a user approving the string must be shown where it really goes.
  it('ignores an entry that does not exist, rather than trusting it as written', () => {
    expect(realPathOfDirectory(workspace, 'not-there')).toBeUndefined();
  });
});

describe('collectDeclaredDirectories', () => {
  it('keys every entry by its real path and drops the duplicates that creates', () => {
    symlinkSync(shared, join(workspace, 'link'), 'junction');

    const declared = collectDeclaredDirectories(workspace, [
      'link',
      './link/',
      shared,
      'not-there',
    ]);

    // `./shared` and an absolute path are the same decision, so the list must be one entry.
    expect(declared).toEqual([{ declared: 'link', realPath: realpathSync.native(shared) }]);
  });

  it('keeps declaration order across genuinely different directories', () => {
    const other = tempDir('book-dirs-other-');
    const declared = collectDeclaredDirectories(workspace, [other, shared]);
    expect(declared.map((entry) => entry.declared)).toEqual([other, shared]);
  });
});

describe('partitionProjectDirectories', () => {
  it('splits what the user has approved, refused, and not decided', () => {
    const other = tempDir('book-dirs-other-');
    const realShared = realpathSync.native(shared);
    const realOther = realpathSync.native(other);
    const declared = collectDeclaredDirectories(workspace, [shared, other]);

    const partition = partitionProjectDirectories(declared, {
      [realShared]: 'approved',
      [realOther]: 'rejected',
    });

    expect(partition.approved.map((entry) => entry.realPath)).toEqual([realShared]);
    expect(partition.rejected.map((entry) => entry.realPath)).toEqual([realOther]);
    expect(partition.pending.map((entry) => entry.realPath)).toEqual([]);
    expect(partitionProjectDirectories(declared, {}).approved).toEqual([]);
  });
});

describe('persistProjectDirectoryChoice', () => {
  it('records the choice under the real path, leaving other decisions alone', () => {
    persistProjectDirectoryChoice(workspace, '/real/shared', 'approved', {
      trustStorePath: storePath,
    });
    persistProjectDirectoryChoice(workspace, '/real/other', 'rejected', {
      trustStorePath: storePath,
    });

    const stored = loadWorkspaceTrust(workspace, storePath);
    expect(stored.projectDirectories).toEqual({
      '/real/shared': 'approved',
      '/real/other': 'rejected',
    });
  });
});

describe('resolveAdditionalRoots', () => {
  it('drops a directory the workspace already serves, and one that vanished', () => {
    mkdirSync(join(workspace, 'inside'));
    const inside = realpathSync.native(join(workspace, 'inside'));

    expect(resolveAdditionalRoots(workspace, ['inside', shared, 'gone'])).toEqual([
      realpathSync.native(shared),
    ]);
    expect(inside).not.toBe('');
  });

  it('follows a link, so the root is where the path really is', () => {
    symlinkSync(shared, join(workspace, 'link'), 'junction');

    expect(resolveAdditionalRoots(workspace, ['link'])).toEqual([realpathSync.native(shared)]);
  });

  it('keeps a sibling whose name starts with two dots, which is outside', () => {
    // `..cache` and `..foo` are ordinary directory names, and a bare `startsWith('..')` read them
    // as the `..` parent marker and dropped them — so a project that declared one of them
    // silently served nothing, with no error to show for it.
    const parent = dirname(realpathSync.native(workspace));
    const dotted = join(parent, '..cache');
    mkdirSync(dotted, { recursive: true });
    try {
      expect(resolveAdditionalRoots(workspace, [dotted])).toEqual([realpathSync.native(dotted)]);
      // And the workspace itself is still dropped: it is not outside itself.
      expect(resolveAdditionalRoots(workspace, [workspace])).toEqual([]);
    } finally {
      rmSync(dotted, { recursive: true, force: true });
    }
  });
});

describe('rootHoldsHome', () => {
  // #300: honoring a root is exactly what widens which paths a read reaches without a prompt, and
  // `BOOK_HOME` holds the trust store that gates this very decision. The loop turns every root
  // this returns true for into a guarded root, so the prompt stays.
  it('recognizes a root that is, or contains, BOOK_HOME', () => {
    const bookHome = tempDir('book-dirs-bookhome-');
    const previous = process.env.BOOK_HOME;
    process.env.BOOK_HOME = bookHome;
    try {
      // A parent of the home counts: a session rooted at `~`'s parent serves `~/.ssh`.
      const outer = tempDir('book-dirs-outer-');
      const nested = join(bookHome, 'nested');
      mkdirSync(nested, { recursive: true });
      expect(rootHoldsHome(bookHome)).toBe(true);
      expect(rootHoldsHome(outer)).toBe(false);
      // A child of the home does not, and does not need to: the read guard keys on the path.
      expect(rootHoldsHome(nested)).toBe(false);
      expect(rootHoldsHome(shared)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.BOOK_HOME;
      else process.env.BOOK_HOME = previous;
    }
  });

  it('says no for an ordinary sibling directory', () => {
    expect(relative(workspace, shared).startsWith('..')).toBe(true);
    expect(rootHoldsHome(shared)).toBe(false);
  });
});

describe('pathHoldsHome', () => {
  // The guard the loop actually uses, and the reason it is keyed on the path rather than the
  // root: a home reached through a link inside an approved root is covered by neither the root
  // test nor a walk of the root, but it is exactly the read that must keep its prompt.
  //
  // The home list is a temp directory rather than the real OS home, because on Windows the OS home
  // holds the temp directory — every `mkdtempSync` path in this file would be inside a home, and
  // the "an ordinary directory holds no home" half of the rule could not be tested at all. Only
  // the containment the rule reads matters, so a temp directory stands in for one.
  /** Point `BOOK_HOME` at a directory for the duration, and hand back the way to undo it. */
  function withBookHome(home: string): () => void {
    const previous = process.env.BOOK_HOME;
    process.env.BOOK_HOME = home;
    return () => {
      if (previous === undefined) delete process.env.BOOK_HOME;
      else process.env.BOOK_HOME = previous;
    };
  }

  it('covers a home reached through a link inside an otherwise ordinary root', () => {
    const bookHome = tempDir('book-dirs-bookhome-');
    const holder = tempDir('book-dirs-holder-');
    const restore = withBookHome(bookHome);
    try {
      writeFileSync(join(bookHome, 'id_rsa'), 'PRIVATE KEY\n');
      symlinkSync(bookHome, join(holder, 'link'), 'junction');
      // The OS home is deliberately left out: on Windows it holds this very temp directory, which
      // is what the "an ordinary directory holds no home" assertions below are about.
      const homes = homeGuards().filter((entry) => entry === realpathSync.native(bookHome));
      expect(homes).toEqual([realpathSync.native(bookHome)]);
      // The root itself holds no home: only a symlink to one.
      expect(rootHoldsHome(holder, homes)).toBe(false);
      expect(pathHoldsHome(join(bookHome, 'id_rsa'), homes)).toBe(true);
      expect(pathHoldsHome(join(holder, 'link', 'id_rsa'), homes)).toBe(true);
      expect(pathHoldsHome(join(shared, 'notes.txt'), homes)).toBe(false);
    } finally {
      restore();
    }
  });

  it('accepts a home list resolved once, so the per-call check touches no filesystem', () => {
    const bookHome = tempDir('book-dirs-bookhome-');
    const restore = withBookHome(bookHome);
    try {
      const homes = homeGuards().filter((entry) => entry === realpathSync.native(bookHome));
      expect(homes).toContain(realpathSync.native(bookHome));
      expect(pathHoldsHome(join(bookHome, '.ssh', 'id_rsa'), homes)).toBe(true);
      expect(pathHoldsHome(join(shared, 'notes.txt'), homes)).toBe(false);
    } finally {
      restore();
    }
  });
});

describe('a home directory is never silently read', () => {
  it('writes an API key where only a prompt stands in the way', () => {
    // The shape the guard exists for: a repository declares the user's home as an additional
    // directory, and a read of their SSH key would otherwise be auto-allowed.
    const previous = process.env.BOOK_HOME;
    process.env.BOOK_HOME = home;
    try {
      writeFileSync(join(home, 'id_rsa'), 'PRIVATE KEY\n');
      expect(rootHoldsHome(home)).toBe(true);
      expect(pathHoldsHome(join(home, 'id_rsa'))).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.BOOK_HOME;
      else process.env.BOOK_HOME = previous;
    }
  });
});
