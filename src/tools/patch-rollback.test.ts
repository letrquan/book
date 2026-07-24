import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../types/tools.js';

const fault = vi.hoisted(() => ({
  failAt: Number.POSITIVE_INFINITY,
  calls: 0,
  afterSuccess: undefined as (() => void) | undefined,
}));

vi.mock('./mutation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./mutation.js')>();
  return {
    ...actual,
    writeFileAtomically: async (...args: Parameters<typeof actual.writeFileAtomically>) => {
      fault.calls++;
      if (fault.calls === fault.failAt) throw new Error('injected write failure');
      const result = await actual.writeFileAtomically(...args);
      fault.afterSuccess?.();
      return result;
    },
  };
});

const { patchTools } = await import('./patch.js');
const execute = patchTools[0].execute;
let root: string;
let context: ToolContext;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'book-patch-rollback-'));
  context = { workspaceRoot: root, env: {}, fileObservationLedger: new Map() };
  fault.calls = 0;
  fault.failAt = Number.POSITIVE_INFINITY;
  fault.afterSuccess = undefined;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('ApplyPatch transaction rollback', () => {
  it('restores earlier files when a later atomic write fails', async () => {
    await writeFile(join(root, 'a.txt'), 'old a\n');
    await writeFile(join(root, 'b.txt'), 'old b\n');
    fault.failAt = 2;

    const result = await execute(
      {
        patch:
          '*** Begin Patch\n*** Update File: a.txt\n@@\n-old a\n+new a\n*** Update File: b.txt\n@@\n-old b\n+new b\n*** End Patch',
      },
      context,
    );

    expect(result.status).toBe('error');
    expect(result.structuredError?.message).toContain('was rolled back');
    await expect(readFile(join(root, 'a.txt'), 'utf8')).resolves.toBe('old a\n');
    await expect(readFile(join(root, 'b.txt'), 'utf8')).resolves.toBe('old b\n');
  });

  it('leaves no temporary files when cancellation interrupts a multi-file commit', async () => {
    await writeFile(join(root, 'a.txt'), 'old a\n');
    await writeFile(join(root, 'b.txt'), 'old b\n');
    const controller = new AbortController();
    fault.afterSuccess = () => controller.abort(new Error('cancelled after first commit'));

    const result = await execute(
      {
        patch:
          '*** Begin Patch\n*** Update File: a.txt\n@@\n-old a\n+new a\n*** Update File: b.txt\n@@\n-old b\n+new b\n*** End Patch',
      },
      { ...context, signal: controller.signal },
    );

    expect(result.status).toBe('error');
    await expect(readFile(join(root, 'a.txt'), 'utf8')).resolves.toBe('old a\n');
    await expect(readFile(join(root, 'b.txt'), 'utf8')).resolves.toBe('old b\n');
    expect((await readdir(root)).filter((name) => name.includes('.book-tmp-'))).toEqual([]);
  });
});
