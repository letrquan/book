import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRewindSnapshotStore, RewindSnapshotStore } from './snapshot-store.js';

const roots: string[] = [];

function fixture(limits?: ConstructorParameters<typeof RewindSnapshotStore>[2]) {
  const root = mkdtempSync(join(tmpdir(), 'book-rewind-test-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  const storage = join(root, 'storage');
  mkdirSync(workspace);
  return { root, workspace, storage, store: new RewindSnapshotStore(workspace, storage, limits) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('RewindSnapshotStore', () => {
  it('degrades to conversation-only rewind when snapshot storage cannot initialize', () => {
    const { root, workspace } = fixture();
    const blockedRoot = join(root, 'blocked-root');
    writeFileSync(blockedRoot, 'not a directory');

    const store = createRewindSnapshotStore(workspace, blockedRoot);

    expect(store.capture()).toMatchObject({
      ok: false,
      reason: expect.stringContaining('snapshot storage could not be initialized'),
    });
  });

  it('captures hidden, gitignored, and secret-like files while hard-excluding .git', () => {
    const { workspace, store } = fixture();
    mkdirSync(join(workspace, '.git'));
    writeFileSync(join(workspace, '.git', 'config'), 'not-a-real-repo');
    writeFileSync(join(workspace, '.gitignore'), 'ignored.txt\n.env\n');
    writeFileSync(join(workspace, '.hidden'), 'hidden');
    writeFileSync(join(workspace, '.env'), 'TOKEN=secret');
    writeFileSync(join(workspace, 'ignored.txt'), 'included');

    const result = store.capture();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.entries.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(['.env', '.gitignore', '.hidden', 'ignored.txt']),
    );
    expect(result.manifest.entries.some((entry) => entry.path.startsWith('.git/'))).toBe(false);
    expect(JSON.stringify(result.manifest)).not.toContain('TOKEN=secret');
  });

  it('captures asynchronously without changing rewind semantics', async () => {
    const { workspace, store } = fixture();
    writeFileSync(join(workspace, 'tracked.txt'), 'before');

    const result = await store.captureAsync();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.entries.map((entry) => entry.path)).toContain('tracked.txt');
    writeFileSync(join(workspace, 'tracked.txt'), 'after');
    expect(store.restore(result.manifest.id)).toMatchObject({ ok: true });
    expect(readFileSync(join(workspace, 'tracked.txt'), 'utf-8')).toBe('before');
  });

  it('excludes workspace-local Book state unless explicitly opted in', () => {
    const { workspace, store } = fixture();
    mkdirSync(join(workspace, '.book', 'tool-output'), { recursive: true });
    writeFileSync(join(workspace, '.book', 'settings.local.json'), '{"apiKey":"secret"}');
    writeFileSync(join(workspace, '.book', 'debug.log'), 'large diagnostic output');
    writeFileSync(join(workspace, '.book', 'tool-output', 'result.txt'), 'tool output');
    writeFileSync(join(workspace, 'tracked.txt'), 'tracked');

    const result = store.capture();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.entries.map((entry) => entry.path)).toEqual(['tracked.txt']);
  });

  it('allows selected workspace-local Book files to be explicitly opted in', () => {
    const { workspace, store } = fixture();
    mkdirSync(join(workspace, '.book', 'commands'), { recursive: true });
    writeFileSync(
      join(workspace, '.book', 'rewindignore'),
      '.book/*\n!.book/commands/\n!.book/commands/review.md\n',
    );
    writeFileSync(join(workspace, '.book', 'commands', 'review.md'), 'include');
    writeFileSync(join(workspace, '.book', 'settings.local.json'), 'exclude');

    const result = store.capture();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.entries.map((entry) => entry.path)).toEqual([
      '.book/commands/review.md',
    ]);
  });

  it('reuses cached hashes for unchanged files', async () => {
    const { workspace, store } = fixture();
    const path = join(workspace, 'tracked.txt');
    writeFileSync(path, 'original!');
    const first = await store.captureAsync();
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = await store.captureAsync();

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.manifest.entries[0].blobHash).toBe(first.manifest.entries[0].blobHash);
  });

  it('allows .book/rewindignore negation to override default exclusions', () => {
    const { workspace, store } = fixture();
    mkdirSync(join(workspace, '.book'));
    mkdirSync(join(workspace, 'dist'));
    writeFileSync(join(workspace, '.book', 'rewindignore'), '!dist/\ndist/*\n!dist/keep.txt\n');
    writeFileSync(join(workspace, 'dist', 'keep.txt'), 'keep');
    writeFileSync(join(workspace, 'dist', 'skip.txt'), 'skip');

    const result = store.capture();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifest.entries.map((entry) => entry.path)).toContain('dist/keep.txt');
    expect(result.manifest.entries.map((entry) => entry.path)).not.toContain('dist/skip.txt');
  });

  it('enforces entry, per-file, and logical-content limits without losing conversation use', () => {
    const entryFixture = fixture({ maxEntries: 1 });
    writeFileSync(join(entryFixture.workspace, 'a.txt'), 'a');
    writeFileSync(join(entryFixture.workspace, 'b.txt'), 'b');
    expect(entryFixture.store.capture()).toMatchObject({ ok: false });

    const fileFixture = fixture({ maxFileBytes: 2 });
    writeFileSync(join(fileFixture.workspace, 'large.txt'), 'abc');
    expect(fileFixture.store.capture()).toMatchObject({ ok: false });

    const logicalFixture = fixture({ maxLogicalBytes: 3 });
    writeFileSync(join(logicalFixture.workspace, 'a.txt'), 'ab');
    writeFileSync(join(logicalFixture.workspace, 'b.txt'), 'cd');
    expect(logicalFixture.store.capture()).toMatchObject({ ok: false });
  });

  it('deduplicates identical content blobs across checkpoints', () => {
    const { workspace, storage, store } = fixture();
    writeFileSync(join(workspace, 'a.txt'), 'same');
    writeFileSync(join(workspace, 'b.txt'), 'same');

    expect(store.capture().ok).toBe(true);
    expect(store.capture().ok).toBe(true);

    expect(readdirSync(join(storage, 'blobs'))).toHaveLength(1);
    expect(readdirSync(join(storage, 'manifests'))).toHaveLength(2);
  });

  it('deduplicates unchanged manifest entry sets across checkpoints', async () => {
    const { workspace, storage, store } = fixture();
    writeFileSync(join(workspace, 'same.txt'), 'same');
    expect((await store.captureAsync()).ok).toBe(true);
    expect((await store.captureAsync()).ok).toBe(true);

    expect(
      readdirSync(join(storage, 'entry-sets')).filter((file) => file.endsWith('.json')),
    ).toHaveLength(1);
  });

  it('captures symlinks without following their targets', () => {
    const { root, workspace, store } = fixture();
    const outside = join(root, 'outside.txt');
    writeFileSync(outside, 'outside secret');
    try {
      symlinkSync(outside, join(workspace, 'outside-link'));
    } catch {
      return;
    }

    const result = store.capture();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const link = result.manifest.entries.find((entry) => entry.path === 'outside-link');
    expect(link?.kind).toBe('symlink');
    expect(link?.byteSize).toBe(Buffer.byteLength(outside));
    expect(JSON.stringify(result.manifest)).not.toContain('outside secret');
  });

  it('restores files and symlinks and removes included files created later', () => {
    const { workspace, store } = fixture();
    writeFileSync(join(workspace, 'tracked.txt'), 'before');
    try {
      symlinkSync('tracked.txt', join(workspace, 'link'));
    } catch {
      // Symlink restoration is exercised on platforms that permit it.
    }
    const captured = store.capture();
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;

    writeFileSync(join(workspace, 'tracked.txt'), 'after');
    writeFileSync(join(workspace, 'created.txt'), 'later');
    if (existsSync(join(workspace, 'link'))) rmSync(join(workspace, 'link'));

    const restored = store.restore(captured.manifest.id);

    expect(restored.ok).toBe(true);
    expect(readFileSync(join(workspace, 'tracked.txt'), 'utf-8')).toBe('before');
    expect(existsSync(join(workspace, 'created.txt'))).toBe(false);
    const linkEntry = captured.manifest.entries.find((entry) => entry.path === 'link');
    if (linkEntry) {
      expect(lstatSync(join(workspace, 'link')).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(workspace, 'link'))).toBe('tracked.txt');
    }
    if (restored.ok) store.discardManifest(restored.safetySnapshotId);
  });

  it('rejects traversal in a tampered manifest and rolls the workspace back', () => {
    const { root, workspace, storage, store } = fixture();
    writeFileSync(join(workspace, 'safe.txt'), 'before');
    const captured = store.capture();
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const manifestPath = join(storage, 'manifests', `${captured.manifest.id}.json`);
    const storedManifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      entrySetHash: string;
    };
    const entrySetPath = join(storage, 'entry-sets', `${storedManifest.entrySetHash}.json`);
    const tampered = JSON.parse(readFileSync(entrySetPath, 'utf-8'));
    tampered[0].path = '../escaped.txt';
    writeFileSync(entrySetPath, JSON.stringify(tampered));
    writeFileSync(join(workspace, 'safe.txt'), 'current');

    const restored = store.restore(captured.manifest.id);

    expect(restored.ok).toBe(false);
    expect(readFileSync(join(workspace, 'safe.txt'), 'utf-8')).toBe('current');
    expect(existsSync(join(root, 'escaped.txt'))).toBe(false);
  });

  it('rolls back atomically when a target blob is corrupt', () => {
    const { workspace, storage, store } = fixture();
    writeFileSync(join(workspace, 'file.txt'), 'target');
    const captured = store.capture();
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    writeFileSync(join(workspace, 'file.txt'), 'current');
    writeFileSync(
      join(storage, 'blobs', captured.manifest.entries[0].blobHash),
      'corrupt target blob',
    );

    const restored = store.restore(captured.manifest.id);

    expect(restored.ok).toBe(false);
    expect(readFileSync(join(workspace, 'file.txt'), 'utf-8')).toBe('current');
  });

  it('blocks restoration after Git HEAD drift without changing HEAD or the index', () => {
    const { workspace, store } = fixture();
    execFileSync('git', ['init'], { cwd: workspace, stdio: 'ignore' });
    writeFileSync(join(workspace, 'file.txt'), 'one');
    execFileSync('git', ['add', 'file.txt'], { cwd: workspace });
    execFileSync(
      'git',
      ['-c', 'user.name=Book Test', '-c', 'user.email=book@example.com', 'commit', '-m', 'one'],
      { cwd: workspace, stdio: 'ignore' },
    );
    const captured = store.capture();
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Book Test',
        '-c',
        'user.email=book@example.com',
        'commit',
        '--allow-empty',
        '-m',
        'two',
      ],
      { cwd: workspace, stdio: 'ignore' },
    );
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf-8' });
    const index = execFileSync('git', ['diff', '--cached'], { cwd: workspace, encoding: 'utf-8' });

    expect(store.restore(captured.manifest.id)).toMatchObject({ ok: false });
    expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf-8' })).toBe(
      head,
    );
    expect(execFileSync('git', ['diff', '--cached'], { cwd: workspace, encoding: 'utf-8' })).toBe(
      index,
    );
  });

  it('restores non-Git workspaces', () => {
    const { workspace, store } = fixture();
    writeFileSync(join(workspace, 'file.txt'), 'before');
    const captured = store.capture();
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    writeFileSync(join(workspace, 'file.txt'), 'after');

    expect(store.restore(captured.manifest.id).ok).toBe(true);
    expect(readFileSync(join(workspace, 'file.txt'), 'utf-8')).toBe('before');
  });

  it('garbage-collects old unreferenced manifests and blobs but retains session references', () => {
    const { workspace, storage, store } = fixture();
    writeFileSync(join(workspace, 'file.txt'), 'referenced');
    const referenced = store.capture();
    expect(referenced.ok).toBe(true);
    if (!referenced.ok) return;
    writeFileSync(join(workspace, 'file.txt'), 'unreferenced');
    const unreferenced = store.capture();
    expect(unreferenced.ok).toBe(true);
    if (!unreferenced.ok) return;
    const unreferencedPath = join(storage, 'manifests', `${unreferenced.manifest.id}.json`);
    writeFileSync(
      unreferencedPath,
      JSON.stringify({ ...unreferenced.manifest, createdAt: Date.now() - 31 * 86_400_000 }),
    );

    const cleaned = store.cleanup(new Set([referenced.manifest.id]), 30);

    expect(cleaned.manifests).toBe(1);
    expect(store.getManifest(referenced.manifest.id)).toBeDefined();
    expect(store.getManifest(unreferenced.manifest.id)).toBeUndefined();
    expect(existsSync(join(storage, 'blobs', unreferenced.manifest.entries[0].blobHash))).toBe(
      false,
    );
  });
});
