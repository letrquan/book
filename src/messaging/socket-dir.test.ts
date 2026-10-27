import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MAX_SOCKET_PATH_BYTES,
  longestSocketName,
  resolveSocketDir,
  socketDirCandidates,
  vetSocketDir,
} from './socket-dir.js';

const posix = process.platform !== 'win32';
const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
const roots: string[] = [];

/** A private scratch directory; `/tmp` on POSIX, so its parent is root's and sticky. */
function scratch(): string {
  const root = realpathSync(mkdtempSync(join(posix ? '/tmp' : tmpdir(), 'book-sockdir-')));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      chmodSync(root, 0o700);
    } catch {
      // Already gone.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe('socketDirCandidates', () => {
  it('uses the test override alone, with no fallback after it', () => {
    expect(
      socketDirCandidates({
        env: {
          BOOK_MESSAGING_SOCKET_DIR: '/x/socks',
          BOOK_HOME: '/h',
          XDG_RUNTIME_DIR: '/run/user/1',
        },
        tmpdir: '/t',
        uid: 7,
      }),
    ).toEqual([{ dir: resolve('/x/socks'), source: 'env' }]);
  });

  it('derives from an explicit BOOK_HOME before the runtime directory', () => {
    expect(
      socketDirCandidates({
        env: { BOOK_HOME: '/h', XDG_RUNTIME_DIR: '/run/user/1' },
        tmpdir: '/t',
        uid: 7,
      }),
    ).toEqual([
      { dir: join(resolve('/h'), 'socks'), source: 'book-home' },
      { dir: join('/t', 'book-socks-7'), source: 'tmp' },
    ]);
  });

  it('uses the runtime directory, then the per-uid fallback', () => {
    expect(
      socketDirCandidates({
        env: { XDG_RUNTIME_DIR: '/run/user/1' },
        tmpdir: '/t',
        uid: 7,
        platform: 'linux',
      }),
    ).toEqual([
      { dir: join('/run/user/1', 'book-socks'), source: 'xdg-runtime' },
      { dir: join('/t', 'book-socks-7'), source: 'tmp' },
    ]);
  });

  it('ignores a relative runtime directory', () => {
    expect(socketDirCandidates({ env: { XDG_RUNTIME_DIR: 'run' }, tmpdir: '/t', uid: 7 })).toEqual([
      { dir: join('/t', 'book-socks-7'), source: 'tmp' },
    ]);
  });
});

describe.skipIf(!posix)('vetSocketDir', () => {
  it('creates a missing directory 0700', async () => {
    const dir = join(scratch(), 'socks');
    const verdict = await vetSocketDir(dir, { create: true, uid });
    expect(verdict).toEqual({ ok: true, dir });
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
  });

  it('reports a missing directory without creating it when inspecting', async () => {
    const dir = join(scratch(), 'socks');
    expect(await vetSocketDir(dir, { create: false, uid })).toEqual({
      ok: true,
      dir,
      missing: true,
    });
    expect(() => lstatSync(dir)).toThrow();
  });

  it('tightens a directory of ours that is too open', async () => {
    const dir = join(scratch(), 'socks');
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    expect(await vetSocketDir(dir, { create: false, uid })).toEqual({ ok: true, dir, loose: true });
    expect((await vetSocketDir(dir, { create: true, uid })).ok).toBe(true);
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
  });

  it('refuses a symlink, even to a private directory of ours', async () => {
    const root = scratch();
    mkdirSync(join(root, 'real'), { mode: 0o700 });
    symlinkSync(join(root, 'real'), join(root, 'socks'));
    const verdict = await vetSocketDir(join(root, 'socks'), { create: true, uid });
    expect(verdict).toMatchObject({ ok: false, reason: 'symlink' });
    if (!verdict.ok) expect(verdict.message).toContain('remove it');
  });

  it('refuses a parent that is a symlink loop', async () => {
    const root = scratch();
    symlinkSync(join(root, 'b'), join(root, 'a'));
    symlinkSync(join(root, 'a'), join(root, 'b'));
    expect(await vetSocketDir(join(root, 'a', 'socks'), { create: true, uid })).toMatchObject({
      ok: false,
      reason: 'symlink-loop',
    });
  });

  it('resolves symlinks above the directory, as macOS needs for /tmp', async () => {
    const root = scratch();
    mkdirSync(join(root, 'real'), { mode: 0o700 });
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(await vetSocketDir(join(root, 'link', 'socks'), { create: true, uid })).toEqual({
      ok: true,
      dir: join(root, 'real', 'socks'),
    });
  });

  it('refuses something that is not a directory', async () => {
    const root = scratch();
    writeFileSync(join(root, 'socks'), '');
    expect(await vetSocketDir(join(root, 'socks'), { create: true, uid })).toMatchObject({
      ok: false,
      reason: 'not-directory',
    });
  });

  it("refuses another user's directory", async () => {
    // /tmp is root's and sticky, so only the directory itself can be the problem.
    const dir = scratch();
    const verdict = await vetSocketDir(dir, { create: true, uid: uid + 1 });
    expect(verdict).toMatchObject({ ok: false, reason: 'not-owner' });
    if (!verdict.ok) expect(verdict.message).toContain(`uid ${uid}`);
  });

  it("refuses a parent that is neither ours nor root's", async () => {
    const root = scratch();
    expect(await vetSocketDir(join(root, 'socks'), { create: true, uid: uid + 1 })).toMatchObject({
      ok: false,
      reason: uid === 0 ? 'not-owner' : 'parent-not-owner',
    });
  });

  it.each([
    [0o777, 'world'],
    [0o770, 'group'],
  ])('refuses a parent writable by others without the sticky bit (%o, %s)', async (mode) => {
    const root = scratch();
    const parent = join(root, 'shared');
    mkdirSync(parent);
    chmodSync(parent, mode);
    const verdict = await vetSocketDir(join(parent, 'socks'), { create: true, uid });
    expect(verdict).toMatchObject({ ok: false, reason: 'parent-writable' });
    if (!verdict.ok) expect(verdict.message).toContain('chmod go-w');
  });

  it('accepts a parent writable by others when it is sticky', async () => {
    const root = scratch();
    const parent = join(root, 'shared');
    mkdirSync(parent);
    chmodSync(parent, 0o1777);
    expect((await vetSocketDir(join(parent, 'socks'), { create: true, uid })).ok).toBe(true);
  });

  it('refuses a directory whose moved-aside socket path would pass 103 bytes', async () => {
    const root = scratch();
    const pid = 4_194_304;
    // `<root>/<name>/<pid>-<8 hex>.sock`, exactly 103 bytes long.
    const fit = MAX_SOCKET_PATH_BYTES - Buffer.byteLength(root) - 2 - longestSocketName(pid).length;
    expect(await vetSocketDir(join(root, 'd'.repeat(fit)), { create: false, uid, pid })).toEqual({
      ok: true,
      dir: join(root, 'd'.repeat(fit)),
      missing: true,
    });
    expect(
      await vetSocketDir(join(root, 'd'.repeat(fit + 1)), { create: false, uid, pid }),
    ).toMatchObject({ ok: false, reason: 'too-long' });
  });
});

describe.skipIf(!posix)('resolveSocketDir', () => {
  it('falls back to the per-uid directory when the path is too long', async () => {
    const root = scratch();
    const deepHome = join(root, 'h'.repeat(90));
    const tmp = scratch();
    const resolution = await resolveSocketDir({
      create: true,
      env: { BOOK_HOME: deepHome },
      tmpdir: tmp,
      uid,
    });
    expect(resolution).toMatchObject({
      ok: true,
      dir: join(tmp, `book-socks-${uid}`),
      source: 'tmp',
      skipped: [{ source: 'book-home', reason: 'too-long' }],
    });
  });

  it('falls back with the remediation when a directory is refused', async () => {
    const home = scratch();
    const tmp = scratch();
    mkdirSync(join(home, 'elsewhere'), { mode: 0o700 });
    symlinkSync(join(home, 'elsewhere'), join(home, 'socks'));
    const resolution = await resolveSocketDir({
      create: true,
      env: { BOOK_HOME: home },
      tmpdir: tmp,
      uid,
    });
    expect(resolution.ok && resolution.source).toBe('tmp');
    expect(resolution.skipped[0]).toMatchObject({ reason: 'symlink', dir: join(home, 'socks') });
    expect(resolution.skipped[0]!.message).toContain('is a symlink');
  });

  describe('on macOS, XDG_RUNTIME_DIR', () => {
    // macOS has no system runtime directory, so the variable is always set by hand, and a
    // sandboxed command could repoint whatever it names: it is never a candidate there.
    function layout() {
      const outside = scratch();
      const tmp = scratch();
      mkdirSync(join(outside, 'run'), { mode: 0o700 });
      symlinkSync(join(outside, 'run'), join(outside, 'link'));
      return { outside, tmp };
    }

    it.each([
      ['a real directory', 'run'],
      ['a symlink', 'link'],
      ['missing', 'missing'],
    ])('is ignored when it is %s', async (_name, entry) => {
      const { outside, tmp } = layout();
      const resolution = await resolveSocketDir({
        create: true,
        env: { XDG_RUNTIME_DIR: join(outside, entry) },
        tmpdir: tmp,
        uid,
        platform: 'darwin',
      });
      expect(resolution).toEqual({
        ok: true,
        source: 'tmp',
        dir: join(tmp, `book-socks-${uid}`),
        skipped: [],
      });
      expect(() => lstatSync(join(outside, entry, 'book-socks'))).toThrow();
    });

    it('is not a candidate on darwin, and is one elsewhere', () => {
      const env = { XDG_RUNTIME_DIR: '/run/user/1' };
      expect(socketDirCandidates({ env, tmpdir: '/t', uid: 7, platform: 'darwin' })).toEqual([
        { dir: join('/t', 'book-socks-7'), source: 'tmp' },
      ]);
      expect(socketDirCandidates({ env, tmpdir: '/t', uid: 7, platform: 'linux' })).toEqual([
        { dir: join('/run/user/1', 'book-socks'), source: 'xdg-runtime' },
        { dir: join('/t', 'book-socks-7'), source: 'tmp' },
      ]);
    });

    it('stays a candidate on Linux', async () => {
      const { outside, tmp } = layout();
      expect(
        await resolveSocketDir({
          create: true,
          env: { XDG_RUNTIME_DIR: join(outside, 'run') },
          tmpdir: tmp,
          uid,
          platform: 'linux',
        }),
      ).toMatchObject({ ok: true, source: 'xdg-runtime', skipped: [] });
    });
  });

  it('never falls back from the test override', async () => {
    const root = scratch();
    writeFileSync(join(root, 'socks'), '');
    const resolution = await resolveSocketDir({
      create: true,
      env: { BOOK_MESSAGING_SOCKET_DIR: join(root, 'socks') },
      tmpdir: scratch(),
      uid,
    });
    expect(resolution).toMatchObject({ ok: false, skipped: [{ reason: 'not-directory' }] });
  });
});
