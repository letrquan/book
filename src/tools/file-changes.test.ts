import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileChangeTracker, changeSnippet, MAX_CHANGED_FILES_PER_TURN } from './file-changes.js';
import { observeFile, requireFreshObservation } from './file-provenance.js';
import type { SessionRuntime } from '../session/runtime.js';
import type { PeerAwarenessHandle } from '../types/messaging.js';
import type { FileObservation, ToolContext } from '../types/tools.js';

let workspace: string;
let tracker: FileChangeTracker;
let ledger: Map<string, FileObservation>;
let ctx: ToolContext;

beforeEach(() => {
  workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-file-changes-')));
  tracker = new FileChangeTracker();
  ledger = new Map();
  ctx = {
    workspaceRoot: workspace,
    env: {},
    fileObservationLedger: ledger,
    runtime: { fileChanges: tracker } as unknown as SessionRuntime,
  };
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function write(name: string, text: string): string {
  const path = join(workspace, name);
  writeFileSync(path, text);
  return path;
}

const lines = (count: number, tag = 'line') =>
  Array.from({ length: count }, (_, index) => `${tag} ${index + 1}`).join('\n') + '\n';

const collect = async () => (await tracker.collect({ ledger, workspace })).files;

describe('changed-on-disk detection (#620 4a)', () => {
  it('reports an external edit of an observed file once, with a short diff', async () => {
    const file = write('a.ts', lines(10));
    await observeFile(ctx, file, 'read');
    expect(await collect()).toEqual([]);

    writeFileSync(file, lines(10).replace('line 5\n', 'line five\n'));
    const [changed, ...rest] = await collect();

    expect(rest).toEqual([]);
    expect(changed).toMatchObject({ path: 'a.ts', absolutePath: file });
    expect(changed.snippet).toEqual(['@@ -4 +4 @@', ' line 4', '-line 5', '+line five', ' line 6']);
    // The same change is never reported again.
    expect(await collect()).toEqual([]);
  });

  it("never reports the model's own edit: the mutation re-observes the file", async () => {
    const file = write('a.ts', 'one\n');
    await observeFile(ctx, file, 'read');
    expect(await collect()).toEqual([]);

    writeFileSync(file, 'two\n');
    await observeFile(ctx, file, 'write');

    expect(await collect()).toEqual([]);
  });

  it('reports a second change of the same file, and a file put back says nothing', async () => {
    const file = write('a.ts', 'one\n');
    await observeFile(ctx, file, 'read');

    writeFileSync(file, 'two\n');
    expect(await collect()).toHaveLength(1);
    writeFileSync(file, 'three\n');
    expect(await collect()).toHaveLength(1);
    writeFileSync(file, 'one\n');
    expect(await collect()).toEqual([]);
  });

  it(`names at most ${MAX_CHANGED_FILES_PER_TURN} files a turn, newest observation first, and counts the rest once`, async () => {
    const files = Array.from({ length: 12 }, (_, index) => write(`f${index}.ts`, 'before\n'));
    for (const [index, file] of files.entries()) {
      await observeFile(ctx, file, 'read');
      ledger.forEach((observation) => {
        if (observation.path === `f${index}.ts`) observation.timestamp = 1_000 + index;
      });
    }
    for (const file of files) writeFileSync(file, 'after\n');

    const first = await tracker.collect({ ledger, workspace });
    expect(first.files.map((file) => file.path)).toEqual(
      Array.from({ length: 10 }, (_, index) => `f${11 - index}.ts`),
    );
    expect(first.unlisted).toBe(2);
    expect(await tracker.collect({ ledger, workspace })).toEqual({ files: [], unlisted: 0 });
  });

  it('leaves the diff out when the change is long', async () => {
    const file = write('a.ts', lines(40));
    await observeFile(ctx, file, 'read');
    writeFileSync(file, lines(40, 'changed'));

    const [changed] = await collect();

    expect(changed.path).toBe('a.ts');
    expect(changed.snippet).toBeUndefined();
  });

  it('reports a deleted file, and ignores outlines and other workspaces', async () => {
    const gone = write('gone.ts', 'x\n');
    const outlined = write('outlined.ts', 'x\n');
    await observeFile(ctx, gone, 'read');
    await observeFile(ctx, outlined, 'outline');
    ledger.set('elsewhere:b.ts', {
      ...ledger.values().next().value!,
      workspaceId: 'elsewhere',
      path: 'b.ts',
    });

    unlinkSync(gone);
    writeFileSync(outlined, 'y\n');

    expect(await collect()).toEqual([expect.objectContaining({ path: 'gone.ts', deleted: true })]);
  });

  it('skips the paths another line already reports', async () => {
    const file = write('a.ts', 'one\n');
    await observeFile(ctx, file, 'read');
    writeFileSync(file, 'two\n');

    expect(
      (await tracker.collect({ ledger, workspace, exclude: new Set(['a.ts']) })).files,
    ).toEqual([]);
  });

  it('redacts provider keys from the diff', async () => {
    const key = 'sk-live-0123456789abcdef';
    const file = write('.env', 'A=1\n');
    await observeFile(ctx, file, 'read');
    writeFileSync(file, `A=1\nKEY=${key}\n`);

    const [changed] = (await tracker.collect({ ledger, workspace, secrets: [key] })).files;

    expect(changed.snippet?.join('\n')).not.toContain(key);
    expect(changed.snippet?.join('\n')).toContain('+KEY=');
  });

  it('only diffs a change measured short, before diffing it', () => {
    expect(changeSnippet('a\nb\n', 'a\nc\n')).toEqual(['@@ -1 +1 @@', ' a', '-b', '+c']);
    expect(changeSnippet(lines(500), lines(500, 'x'))).toBeUndefined();
    expect(changeSnippet('same\n', 'same\n')).toBeUndefined();
  });
});

describe('stale-file refusal attribution (#620 4d)', () => {
  function peerHandle(messaging: boolean, at: (since: number) => boolean): PeerAwarenessHandle {
    return {
      recordEdits: () => {},
      snapshot: async () => ({
        attribute: (_path, since) =>
          at(since)
            ? { peer: messaging ? 'book-36 [a1b2c3]' : 'book-36', ageMs: 61_000, messaging }
            : undefined,
      }),
    };
  }

  it('names the peer that recorded an edit, pointing at SessionSend with messaging on', async () => {
    const file = write('a.ts', 'one\n');
    await observeFile(ctx, file, 'read');
    writeFileSync(file, 'two\n');

    const stale = await requireFreshObservation(
      { ...ctx, peerAwareness: peerHandle(true, () => true) },
      file,
      'a.ts',
    );

    expect(stale).toContain('changed or disappeared');
    expect(stale).toContain(
      'book-36 [a1b2c3] recorded an edit to a.ts 1m ago. Re-read it; if your changes overlap, coordinate with SessionSend to book-36 [a1b2c3].',
    );
  });

  it('points at the user with messaging off, and says nothing of a peer edit older than the read', async () => {
    const file = write('a.ts', 'one\n');
    await observeFile(ctx, file, 'read');
    const observedAt = [...ledger.values()][0]!.timestamp;
    writeFileSync(file, 'two\n');

    const off = await requireFreshObservation(
      { ...ctx, peerAwareness: peerHandle(false, (since) => since === observedAt) },
      file,
      'a.ts',
    );
    const older = await requireFreshObservation(
      { ...ctx, peerAwareness: peerHandle(false, () => false) },
      file,
      'a.ts',
    );

    expect(off).toContain('tell the user another session is editing it');
    expect(off).not.toContain('SessionSend');
    expect(older).not.toContain('recorded an edit');
  });
});
