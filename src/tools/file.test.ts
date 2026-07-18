import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileTools } from './file.js';
import type { ToolContext } from '../types.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { createFileObservationLedger, workspaceIdentity } from './file-observation.js';

let dir: string;
const ctx: ToolContext = { workspaceRoot: '', env: {} };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-file-'));
  ctx.workspaceRoot = dir;
  ctx.fileObservationLedger = new Map();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = fileTools.find((t) => t.name === 'Read')!;
const write = fileTools.find((t) => t.name === 'Write')!;
const edit = fileTools.find((t) => t.name === 'Edit')!;
const multiEditTool = fileTools.find((t) => t.name === 'MultiEdit')!;
const glob = fileTools.find((t) => t.name === 'Glob')!;
const grep = fileTools.find((t) => t.name === 'Grep')!;

describe('read_file', () => {
  it('reads a file by workspace-relative path', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const r = await read.execute({ filePath: 'a.txt' }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('1: hello');
  });

  it('reads a file by absolute in-workspace path', async () => {
    const filePath = join(dir, 'a.txt');
    writeFileSync(filePath, 'hello absolute');
    const r = await read.execute({ filePath }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('1: hello absolute');
  });

  it('rejects a relative path outside the workspace', async () => {
    const outsidePath = join(dirname(dir), 'outside-relative.txt');
    writeFileSync(outsidePath, 'outside');

    try {
      const r = await read.execute({ filePath: '../outside-relative.txt' }, ctx);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/outside workspace/);
    } finally {
      rmSync(outsidePath, { force: true });
    }
  });

  it('rejects an absolute path outside the workspace', async () => {
    const outsidePath = join(dirname(dir), 'outside-absolute.txt');
    writeFileSync(outsidePath, 'outside');

    try {
      const r = await read.execute({ filePath: outsidePath }, ctx);
      expect(r.success).toBe(false);
      expect(r.error).toMatch(/outside workspace/);
    } finally {
      rmSync(outsidePath, { force: true });
    }
  });

  it('yields while formatting large reads', async () => {
    writeFileSync(
      join(dir, 'large.txt'),
      Array.from({ length: 5_000 }, (_, index) => `line ${index}`).join('\n'),
    );
    let timerFired = false;
    const timer = setTimeout(() => {
      timerFired = true;
    }, 0);

    try {
      const result = await read.execute({ filePath: 'large.txt', limit: 5_000 }, ctx);
      expect(result.success).toBe(true);
      expect(timerFired).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  it('hashes the full file while recording partial line coverage', async () => {
    writeFileSync(join(dir, 'partial.txt'), 'one\ntwo\nthree');
    const result = await read.execute({ filePath: 'partial.txt', offset: 2, limit: 1 }, ctx);

    expect(result.fileObservations).toHaveLength(1);
    expect(result.fileObservations?.[0]).toMatchObject({
      path: 'partial.txt',
      workspaceIdentity: workspaceIdentity(dir),
      sizeBytes: 13,
      coverage: { kind: 'lines', startLine: 2, endLine: 2, totalLines: 3 },
      operation: 'read',
    });
    expect(result.fileObservations?.[0].sha256).toHaveLength(64);
  });
});

describe('write_file', () => {
  it('returns create metadata for new files', async () => {
    const r = await write.execute({ filePath: 'new.txt', content: 'one\ntwo' }, ctx);

    expect(r.success).toBe(true);
    expect(r.fileMutation).toEqual({
      kind: 'create',
      filePath: 'new.txt',
      addedLines: 2,
      removedLines: 0,
    });
  });

  it('allows legitimate in-workspace directories beginning with two dots', async () => {
    mkdirSync(join(dir, '..data'));
    const r = await write.execute({ filePath: '..data/new.txt', content: 'inside' }, ctx);

    expect(r.success).toBe(true);
    expect(readFileSync(join(dir, '..data', 'new.txt'), 'utf-8')).toBe('inside');
  });

  it('rejects writes through an outside-pointing directory link', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'book-file-outside-'));
    try {
      symlinkSync(
        outsideDir,
        join(dir, 'linked'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const r = await write.execute({ filePath: 'linked/new.txt', content: 'escaped' }, ctx);

      expect(r.success).toBe(false);
      expect(r.error).toMatch(/outside workspace/);
      expect(existsSync(join(outsideDir, 'new.txt'))).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('allows links whose canonical target remains inside the workspace', async () => {
    const target = join(dir, 'target');
    mkdirSync(target);
    symlinkSync(
      target,
      join(dir, 'linked-inside'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const r = await write.execute({ filePath: 'linked-inside/new.txt', content: 'inside' }, ctx);

    expect(r.success).toBe(true);
    expect(readFileSync(join(target, 'new.txt'), 'utf-8')).toBe('inside');
  });

  it('returns update metadata for existing files', async () => {
    writeFileSync(join(dir, 'a.txt'), 'old\nkeep');
    const r = await write.execute({ filePath: 'a.txt', content: 'new\nkeep\nextra' }, ctx);

    expect(r.success).toBe(true);
    expect(r.fileMutation).toEqual({
      kind: 'update',
      filePath: 'a.txt',
      addedLines: 2,
      removedLines: 1,
    });
  });

  it('does not write when cancellation arrives during a large diff', async () => {
    const path = join(dir, 'large.txt');
    const before = Array.from({ length: 500 }, (_, index) => `old ${index}`).join('\n');
    const after = Array.from({ length: 500 }, (_, index) => `new ${index}`).join('\n');
    writeFileSync(path, before);
    const controller = new AbortController();
    const pending = write.execute(
      { filePath: 'large.txt', content: after },
      { ...ctx, signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error('write cancelled')), 0);

    await expect(pending).rejects.toThrow('write cancelled');
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('rejects writes outside the workspace', async () => {
    const outsidePath = resolve(dir, '..', 'escape.txt');
    const r = await write.execute({ filePath: '../escape.txt', content: 'escaped' }, ctx);

    expect(r.success).toBe(false);
    expect(r.error).toMatch(/outside workspace/);
    expect(r.fileMutation).toBeUndefined();
    expect(existsSync(outsidePath)).toBe(false);
  });

  it('preserves current behavior when no observation exists', async () => {
    writeFileSync(join(dir, 'unobserved.txt'), 'before');
    const result = await write.execute(
      { filePath: 'unobserved.txt', content: 'after' },
      { ...ctx, fileObservations: createFileObservationLedger() },
    );

    expect(result.success).toBe(true);
    expect(readFileSync(join(dir, 'unobserved.txt'), 'utf-8')).toBe('after');
    expect(result.fileObservations?.[0]).toMatchObject({ operation: 'write' });
  });

  it('rejects a stale remembered mutation then permits it after a fresh reread', async () => {
    const path = join(dir, 'stale.txt');
    writeFileSync(path, 'observed');
    const ledger = createFileObservationLedger();
    const observed = await read.execute(
      { filePath: 'stale.txt' },
      { ...ctx, fileObservations: ledger },
    );
    expect(observed.success).toBe(true);

    writeFileSync(path, 'external change');
    const stale = await write.execute(
      { filePath: 'stale.txt', content: 'rejected' },
      { ...ctx, fileObservations: ledger },
    );
    expect(stale.success).toBe(false);
    expect(stale.error).toMatch(/changed since it was last observed/i);
    expect(readFileSync(path, 'utf-8')).toBe('external change');

    await read.execute({ filePath: 'stale.txt' }, { ...ctx, fileObservations: ledger });
    const recovered = await write.execute(
      { filePath: 'stale.txt', content: 'accepted' },
      { ...ctx, fileObservations: ledger },
    );
    expect(recovered.success).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe('accepted');
  });

  it('rejects remembered observations from another workspace', async () => {
    writeFileSync(join(dir, 'same.txt'), 'same');
    const other = mkdtempSync(join(tmpdir(), 'book-file-other-'));
    try {
      writeFileSync(join(other, 'same.txt'), 'same');
      const ledger = createFileObservationLedger();
      await read.execute(
        { filePath: 'same.txt' },
        { workspaceRoot: other, env: {}, fileObservations: ledger },
      );

      const result = await write.execute(
        { filePath: 'same.txt', content: 'nope' },
        { ...ctx, fileObservations: ledger },
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/different workspace/i);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('edit_file', () => {
  it('blocks a stale mutation until an explicit reread refreshes provenance', async () => {
    const path = join(dir, 'stale.txt');
    writeFileSync(path, 'original');
    const observed = await read.execute({ filePath: 'stale.txt' }, ctx);
    expect(observed.fileObservations?.[0].sha256).toMatch(/^[a-f0-9]{64}$/);

    writeFileSync(path, 'changed externally');
    const blocked = await edit.execute(
      { filePath: 'stale.txt', oldString: 'changed', newString: 'updated' },
      ctx,
    );
    expect(blocked.success).toBe(false);
    expect(blocked.error).toMatch(/^SKIPPED:.*Read/);

    await read.execute({ filePath: 'stale.txt' }, ctx);
    const allowed = await edit.execute(
      { filePath: 'stale.txt', oldString: 'changed', newString: 'updated' },
      ctx,
    );
    expect(allowed.success).toBe(true);
    expect(readFileSync(path, 'utf-8')).toBe('updated externally');
  });
  it('replaces the single occurrence when oldString is unique', async () => {
    writeFileSync(join(dir, 'a.txt'), 'foo bar baz');
    const r = await edit.execute({ filePath: 'a.txt', oldString: 'bar', newString: 'qux' }, ctx);
    expect(r.success).toBe(true);
    expect(r.fileMutation).toEqual({
      kind: 'update',
      filePath: 'a.txt',
      addedLines: 1,
      removedLines: 1,
    });
    const after = await read.execute({ filePath: 'a.txt' }, ctx);
    expect(after.output).toContain('foo qux baz');
  });

  it('fails when oldString is absent', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const r = await edit.execute({ filePath: 'a.txt', oldString: 'nope', newString: 'x' }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/);
    expect(r.fileMutation).toBeUndefined();
  });

  it('returns aggregate update metadata for MultiEdit', async () => {
    writeFileSync(join(dir, 'a.txt'), 'first\nsecond\nthird');
    const r = await multiEditTool.execute(
      {
        filePath: 'a.txt',
        edits: [
          { oldString: 'first', newString: 'FIRST' },
          { oldString: 'third', newString: 'third\nfourth' },
        ],
      },
      ctx,
    );

    expect(r.success).toBe(true);
    expect(r.fileMutation).toEqual({
      kind: 'update',
      filePath: 'a.txt',
      addedLines: 2,
      removedLines: 1,
    });
  });
});

describe('glob', () => {
  it('caps broad output and reports truncation', async () => {
    for (let i = 0; i < 1005; i++) {
      writeFileSync(join(dir, `file-${i}.txt`), String(i));
    }

    const r = await glob.execute({ pattern: '**/*' }, ctx);

    expect(r.success).toBe(true);
    expect(r.output).toContain('truncated at 1000 files');
    expect(r.output?.split('\n')).toHaveLength(1001);
  });

  it('does not return out-of-workspace paths', async () => {
    writeFileSync(join(dir, 'inside.txt'), 'inside');
    const outsidePath = join(dirname(dir), 'outside-glob.txt');
    writeFileSync(outsidePath, 'outside');

    try {
      const r = await glob.execute({ pattern: '../*.txt' }, ctx);
      expect(r.success).toBe(true);
      const output = r.output ?? '';
      expect(output).not.toContain('outside-glob.txt');
      output
        .split('\n')
        .filter(Boolean)
        .forEach((line) => expect(line.startsWith('..')).toBe(false));
    } finally {
      rmSync(outsidePath, { force: true });
    }
  });
});

describe('grep', () => {
  it('matches a regex across files', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const x = 1;\nconst y = 2;');
    writeFileSync(join(dir, 'b.ts'), 'let z = 3;');
    const r = await grep.execute({ pattern: 'const', include: '*.ts' }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('a.ts:1: const x = 1;');
    expect(r.output).not.toContain('b.ts');
  });

  it('matches files after workspace path normalization', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const x = 1;');
    const r = await grep.execute({ pattern: 'const', include: '**/*.ts' }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toContain('a.ts:1: const x = 1;');
  });

  it('reports no matches found', async () => {
    writeFileSync(join(dir, 'a.ts'), 'nothing here');
    const r = await grep.execute({ pattern: 'zzzzz', include: '*.ts' }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/No matches/);
  });

  it('preserves count, files-only, context, multiline, and limit behavior', async () => {
    writeFileSync(join(dir, 'a.ts'), 'before\nconst first = 1;\nafter\nconst second = 2;');
    writeFileSync(join(dir, 'b.ts'), 'const third = 3;');

    const count = await grep.execute(
      { pattern: 'const', include: '*.ts', output_mode: 'count' },
      ctx,
    );
    expect(count.output).toContain('a.ts:2');
    expect(count.output).toContain('b.ts:1');

    const files = await grep.execute(
      { pattern: 'second', include: '*.ts', output_mode: 'files_with_matches' },
      ctx,
    );
    expect(files.output).toBe('a.ts');

    const context = await grep.execute({ pattern: 'first', include: '*.ts', A: 1, B: 1 }, ctx);
    expect(context.output).toContain('a.ts:1- before');
    expect(context.output).toContain('a.ts:2: const first = 1;');
    expect(context.output).toContain('a.ts:3- after');

    const multiline = await grep.execute(
      { pattern: 'before\\nconst', include: '*.ts', multiline: true },
      ctx,
    );
    expect(multiline.output).toContain('a.ts:1: before');

    const limited = await grep.execute({ pattern: 'const', include: '*.ts', head_limit: 1 }, ctx);
    expect(limited.output?.split('\n')).toHaveLength(1);
  });

  it('keeps timers responsive and observes abort during a broad scan', async () => {
    for (let index = 0; index < 160; index++) {
      writeFileSync(join(dir, `file-${index}.txt`), 'no match here\n'.repeat(10));
    }

    let timerFired = false;
    const timer = setTimeout(() => {
      timerFired = true;
    }, 0);
    try {
      const result = await grep.execute({ pattern: 'missing-token', include: '*.txt' }, ctx);
      expect(result.success).toBe(true);
      expect(timerFired).toBe(true);
    } finally {
      clearTimeout(timer);
    }

    const controller = new AbortController();
    const pending = grep.execute(
      { pattern: 'missing-token', include: '*.txt' },
      { ...ctx, signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error('grep cancelled')), 0);
    await expect(pending).rejects.toThrow('grep cancelled');
  });
});
