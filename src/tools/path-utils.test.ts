import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import {
  canonicalizePath,
  isBookLocalSettingsPath,
  realWorkspaceRoot,
  resolveMutationPath,
  resolveReadablePath,
  resolveReadablePathDetail,
  resolveWorkspacePath,
  type PathRoots,
} from './path-utils.js';

let workspace: string;
let extra: string;
let outside: string;
const dirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  workspace = tempDir('book-pathutils-ws-');
  extra = tempDir('book-pathutils-extra-');
  outside = tempDir('book-pathutils-out-');
  writeFileSync(join(workspace, 'notes.txt'), 'notes\n');
  writeFileSync(join(extra, 'extra.txt'), 'extra\n');
  writeFileSync(join(outside, 'secret.txt'), 'secret\n');
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const roots = (overrides: Partial<PathRoots> = {}): PathRoots => ({
  workspaceRoot: workspace,
  ...overrides,
});

describe('resolveReadablePathDetail', () => {
  it('serves a workspace file, preferring the workspace over the extra roots', () => {
    expect(resolveReadablePathDetail(roots({ additionalRoots: [extra] }), 'notes.txt')).toEqual({
      path: {
        filePath: join(workspace, 'notes.txt'),
        canonicalPath: join(realWorkspaceRoot(workspace), 'notes.txt'),
        relativePath: 'notes.txt',
        root: workspace,
        inWorkspace: true,
      },
    });
  });

  it('names the root a file in an honored additional directory was served by', () => {
    const detail = resolveReadablePathDetail(
      roots({ additionalRoots: [extra] }),
      join(extra, 'extra.txt'),
    );

    expect('path' in detail && detail.path.filePath).toBe(join(extra, 'extra.txt'));
    // The label a Glob or Grep result shows is this root's own spelling of the path, not the
    // root-relative one the resolution produced, and not the canonical one.
    expect('path' in detail && detail.path).toMatchObject({ root: extra, inWorkspace: false });
  });

  it('serves a file in an honored additional directory', () => {
    const detail = resolveReadablePathDetail(
      roots({ additionalRoots: [extra] }),
      join(extra, 'extra.txt'),
    );

    expect('path' in detail && detail.path.filePath).toBe(join(extra, 'extra.txt'));
  });

  it('serves a read-only root the workspace has no claim on', () => {
    const detail = resolveReadablePathDetail(
      roots({ readOnlyRoots: [outside] }),
      join(outside, 'secret.txt'),
    );

    expect('path' in detail).toBe(true);
  });

  /**
   * The distinction the single `null` used to hide. A path under a hidden subpath is a *prompt* —
   * the user can approve it — while a path no root contains is a refusal whose remedy is to widen
   * the roots. Reporting both as "outside" would tell the model to ask for something no approval
   * can reach.
   */
  it('distinguishes an excluded path from an unreachable one', () => {
    const inbox = tempDir('book-pathutils-inbox-');
    const rootsWithInbox = roots({
      readOnlyRoots: [{ root: inbox, exclude: ['inbox'] }],
      additionalRoots: [extra],
    });
    mkdirSync(join(inbox, 'inbox'), { recursive: true });
    writeFileSync(join(inbox, 'inbox', 'note.md'), 'private\n');

    expect(resolveReadablePathDetail(rootsWithInbox, join(inbox, 'inbox', 'note.md'))).toEqual({
      reason: 'excluded',
    });
    expect(resolveReadablePathDetail(rootsWithInbox, join(outside, 'secret.txt'))).toEqual({
      reason: 'unreachable',
    });
  });

  it('anchors a relative path to the workspace, never to an additional root', () => {
    // `extra.txt` names a file in the workspace, not the extra directory's identically named
    // file: re-anchoring a bare filename to a root would let it name something the caller never
    // mentioned.
    const detail = resolveReadablePathDetail(roots({ additionalRoots: [extra] }), 'extra.txt');

    expect('path' in detail && detail.path.canonicalPath).toBe(
      join(realWorkspaceRoot(workspace), 'extra.txt'),
    );
  });

  it('refuses a path that climbs out of the workspace', () => {
    expect(resolveReadablePathDetail(roots({ additionalRoots: [extra] }), '../notes.txt')).toEqual({
      reason: 'unreachable',
    });
  });

  it('refuses a symlink out of the workspace, following it to the real target', () => {
    symlinkSync(outside, join(workspace, 'escape'), 'junction');

    expect(resolveReadablePathDetail(roots(), join(workspace, 'escape', 'secret.txt'))).toEqual({
      reason: 'unreachable',
    });
  });

  it('excludes a path by its real name, not by the spelling used to reach it', () => {
    const inbox = tempDir('book-pathutils-inbox2-');
    mkdirSync(join(inbox, 'inbox'), { recursive: true });
    writeFileSync(join(inbox, 'inbox', 'note.md'), 'private\n');
    symlinkSync(join(inbox, 'inbox'), join(inbox, 'link'), 'junction');

    expect(
      resolveReadablePathDetail(
        roots({ readOnlyRoots: [{ root: inbox, exclude: ['inbox'] }] }),
        join(inbox, 'link', 'note.md'),
      ),
    ).toEqual({ reason: 'excluded' });
  });

  it('keeps resolveReadablePath as the null-returning form of the same decision', () => {
    expect(resolveReadablePath(roots(), 'notes.txt')).not.toBeNull();
    expect(resolveReadablePath(roots(), join(outside, 'secret.txt'))).toBeNull();
  });
});

describe('canonicalizePath', () => {
  it('follows a link, and keeps a tail that does not exist yet', () => {
    symlinkSync(extra, join(workspace, 'link'), 'junction');

    // A read target that has been deleted, or named before it is written, must still be seen
    // through the link above it — a plain `realpath` would fail and hand back the lexical path.
    expect(canonicalizePath(join(workspace, 'link', 'extra.txt'))).toBe(
      join(realpathSync.native(extra), 'extra.txt'),
    );
    expect(canonicalizePath(join(workspace, 'link', 'not-yet.txt'))).toBe(
      join(realpathSync.native(extra), 'not-yet.txt'),
    );
  });

  it('resolves an ordinary path to the form the file system calls it', () => {
    // On Windows a path is not already canonical: a temp directory under `C:\Users\RUNNER~1` is
    // reported by `realpath` as `C:\Users\runneradmin`, and a drive letter folds case freely. So
    // the property is the one that matters — an already-canonical path is left alone, which is
    // what lets a guarded path be compared against a root more than once for the price of one.
    const canonical = canonicalizePath(join(workspace, 'notes.txt'));

    expect(canonical).toBe(join(realWorkspaceRoot(workspace), 'notes.txt'));
    expect(canonicalizePath(canonical)).toBe(canonical);
  });

  it('is idempotent, which is what lets a guarded path be compared twice', () => {
    symlinkSync(extra, join(workspace, 'link'), 'junction');
    const once = canonicalizePath(join(workspace, 'link', 'extra.txt'));

    expect(canonicalizePath(once)).toBe(once);
  });
});

describe('isBookLocalSettingsPath', () => {
  it('matches the local settings file and its directory under any root', () => {
    expect(
      isBookLocalSettingsPath(join(workspace, '.book', 'settings.local.json'), workspace),
    ).toBe(true);
    expect(isBookLocalSettingsPath(join(workspace, '.book'), workspace, { directory: true })).toBe(
      true,
    );
    expect(isBookLocalSettingsPath(join(extra, '.book', 'settings.local.json'), extra)).toBe(true);
  });

  it('does not match a differently cased name on a case-folding filesystem', () => {
    // Matched case-insensitively everywhere: on a case-sensitive filesystem that only makes
    // the check stricter, while a case-insensitive Linux mount (WSL on /mnt/c) serves any
    // spelling from the same file.
    expect(
      isBookLocalSettingsPath(join(workspace, '.BOOK', 'SETTINGS.LOCAL.JSON'), workspace),
    ).toBe(true);
  });

  it('does not match the checked-in settings file', () => {
    // `settings.json` is the repository's, and reading it is the whole point of a read tool.
    expect(isBookLocalSettingsPath(join(workspace, '.book', 'settings.json'), workspace)).toBe(
      false,
    );
  });
});

describe('resolveWorkspacePath', () => {
  it('reports the file, its canonical form, and the path relative to the root', () => {
    expect(resolveWorkspacePath(workspace, 'notes.txt')).toEqual({
      filePath: resolve(workspace, 'notes.txt'),
      canonicalPath: join(realWorkspaceRoot(workspace), 'notes.txt'),
      relativePath: 'notes.txt',
    });
  });

  it('says no for a path outside the root, and for a path that climbs out of it', () => {
    expect(resolveWorkspacePath(workspace, join(outside, 'secret.txt'))).toBeNull();
    expect(resolveWorkspacePath(workspace, '../notes.txt')).toBeNull();
  });

  it('resolves through a link that stays inside the root', () => {
    mkdirSync(join(workspace, 'real'), { recursive: true });
    writeFileSync(join(workspace, 'real', 'inside.txt'), 'inside\n');
    symlinkSync(join(workspace, 'real'), join(workspace, 'link'), 'junction');

    const match = resolveWorkspacePath(workspace, join(workspace, 'link', 'inside.txt'));

    expect(match?.canonicalPath).toBe(join(realWorkspaceRoot(workspace), 'real', 'inside.txt'));
  });
});

describe('resolveMutationPath with a memory write root', () => {
  let memory: string;

  beforeEach(() => {
    memory = tempDir('book-pathutils-mem-');
    writeFileSync(join(memory, 'MEMORY.md'), '# index\n');
  });

  const withMemory = (): PathRoots => roots({ memoryWrite: { root: memory } });

  it('serves an absolute *.md path as a memory target, in the workspace-relative spelling', () => {
    const resolved = resolveMutationPath(withMemory(), join(memory, 'topic.md'));
    expect(resolved).toMatchObject({
      filePath: join(memory, 'topic.md'),
      root: memory,
      inWorkspace: false,
      memory: true,
    });
    expect(resolved?.relativePath.startsWith('..')).toBe(true);
    // A nested file and a case-insensitive extension are served too.
    expect(resolveMutationPath(withMemory(), join(memory, 'sub', 'a.MD'))?.memory).toBe(true);
    expect(resolveMutationPath(withMemory(), join(memory, 'MEMORY.md'))?.memory).toBe(true);
  });

  it('refuses everything the rules exclude', () => {
    mkdirSync(join(memory, '.inbox'));
    mkdirSync(join(memory, 'real'));
    writeFileSync(join(memory, 'real', 'x.md'), 'x\n');
    writeFileSync(join(outside, 'target.md'), 'target\n');
    symlinkSync(join(outside, 'target.md'), join(memory, 'linked.md'));
    symlinkSync(join(memory, 'real'), join(memory, 'dirlink'));
    symlinkSync(join(outside, 'nowhere.md'), join(memory, 'dangling.md'));
    const refused = [
      'topic.md', // relative: never anchors to the memory root
      join(memory, 'notes.txt'),
      join(memory, 'topic.md.bak'),
      join(memory, '.inbox', 'pending.md'),
      join(memory, '.hidden', 'a.md'),
      join(memory, '.dot.md'),
      join(memory, 'linked.md'),
      join(memory, 'dirlink', 'x.md'),
      join(memory, 'dangling.md'),
      join(memory, '..', 'escape.md'),
      join(outside, 'target.md'),
    ];
    for (const path of refused) {
      expect(resolveMutationPath(withMemory(), path)?.memory, path).toBeUndefined();
    }
    // Outside the workspace and every honored root, so nothing serves it at all.
    expect(resolveMutationPath(withMemory(), join(memory, 'linked.md'))).toBeNull();
    expect(resolveMutationPath(withMemory(), join(memory, '.inbox', 'pending.md'))).toBeNull();
  });

  it('serves nothing in the memory directory without the root (a subagent)', () => {
    expect(resolveMutationPath(roots(), join(memory, 'topic.md'))).toBeNull();
  });

  it('keeps the guard when the workspace holds the memory directory', () => {
    const inside = join(workspace, 'mem');
    mkdirSync(inside);
    const resolved = resolveMutationPath(
      roots({ memoryWrite: { root: inside } }),
      join(inside, 'topic.md'),
    );
    expect(resolved?.memory).toBe(true);
    expect(resolved?.relativePath).toBe('mem/topic.md');
    // A dot-directory there falls back to the ordinary workspace branch.
    mkdirSync(join(inside, '.inbox'));
    const plain = resolveMutationPath(
      roots({ memoryWrite: { root: inside } }),
      join(inside, '.inbox', 'a.md'),
    );
    expect(plain?.inWorkspace).toBe(true);
    expect(plain?.memory).toBeUndefined();
  });
});
