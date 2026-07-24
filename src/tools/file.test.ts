import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileTools } from './file.js';
import type { ToolContext } from '../types/tools.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

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
    expect(r.status).toBe('success');
    expect(r.content).toContain('1: hello');
  });

  it('reads a file by absolute in-workspace path', async () => {
    const filePath = join(dir, 'a.txt');
    writeFileSync(filePath, 'hello absolute');
    const r = await read.execute({ filePath }, ctx);
    expect(r.status).toBe('success');
    expect(r.content).toContain('1: hello absolute');
  });

  it('rejects a relative path outside the workspace', async () => {
    const outsidePath = join(dirname(dir), 'outside-relative.txt');
    writeFileSync(outsidePath, 'outside');

    try {
      const r = await read.execute({ filePath: '../outside-relative.txt' }, ctx);
      expect(r.status).toBe('error');
      expect(r.structuredError?.message).toMatch(/outside workspace/);
    } finally {
      rmSync(outsidePath, { force: true });
    }
  });

  it('rejects an absolute path outside the workspace', async () => {
    const outsidePath = join(dirname(dir), 'outside-absolute.txt');
    writeFileSync(outsidePath, 'outside');

    try {
      const r = await read.execute({ filePath: outsidePath }, ctx);
      expect(r.status).toBe('error');
      expect(r.structuredError?.message).toMatch(/outside workspace/);
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
      expect(result.status).toBe('success');
      expect(timerFired).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });
});

describe('write_file', () => {
  it('returns create metadata for new files', async () => {
    const r = await write.execute({ filePath: 'new.txt', content: 'one\ntwo' }, ctx);

    expect(r.status).toBe('success');
    expect(r.artifacts?.fileMutation).toEqual({
      kind: 'create',
      filePath: 'new.txt',
      addedLines: 2,
      removedLines: 0,
    });
  });

  it('allows legitimate in-workspace directories beginning with two dots', async () => {
    mkdirSync(join(dir, '..data'));
    const r = await write.execute({ filePath: '..data/new.txt', content: 'inside' }, ctx);

    expect(r.status).toBe('success');
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

      expect(r.status).toBe('error');
      expect(r.structuredError?.message).toMatch(/outside workspace/);
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

    expect(r.status).toBe('success');
    expect(readFileSync(join(target, 'new.txt'), 'utf-8')).toBe('inside');
  });

  it('returns update metadata for existing files', async () => {
    writeFileSync(join(dir, 'a.txt'), 'old\nkeep');
    const r = await write.execute({ filePath: 'a.txt', content: 'new\nkeep\nextra' }, ctx);

    expect(r.status).toBe('success');
    expect(r.artifacts?.fileMutation).toEqual({
      kind: 'update',
      filePath: 'a.txt',
      addedLines: 2,
      removedLines: 1,
    });
  });

  it('normalizes CRLF replacement content before preserving CRLF', async () => {
    const path = join(dir, 'windows.txt');
    writeFileSync(path, 'old\r\ncontent\r\n');

    const result = await write.execute(
      { filePath: 'windows.txt', content: 'new\r\ncontent\r\n' },
      ctx,
    );

    expect(result.status).toBe('success');
    expect(readFileSync(path, 'utf8')).toBe('new\r\ncontent\r\n');
  });

  it.skipIf(process.platform === 'win32')(
    'updates a file symlink target without replacing the symlink',
    async () => {
      const target = join(dir, 'target.txt');
      const link = join(dir, 'link.txt');
      writeFileSync(target, 'old\n');
      symlinkSync(target, link, 'file');

      const result = await write.execute({ filePath: 'link.txt', content: 'new\n' }, ctx);

      expect(result.status).toBe('success');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('new\n');
    },
  );

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

    expect(r.status).toBe('error');
    expect(r.structuredError?.message).toMatch(/outside workspace/);
    expect(r.artifacts?.fileMutation).toBeUndefined();
    expect(existsSync(outsidePath)).toBe(false);
  });
});

describe('edit_file', () => {
  it.skipIf(process.platform === 'win32')(
    'edits a file symlink target without replacing the symlink',
    async () => {
      const target = join(dir, 'target.txt');
      const link = join(dir, 'link.txt');
      writeFileSync(target, 'old value\n');
      symlinkSync(target, link, 'file');

      const result = await edit.execute(
        { filePath: 'link.txt', oldString: 'old', newString: 'new' },
        ctx,
      );

      expect(result.status).toBe('success');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('new value\n');
    },
  );

  it('matches LF model text against CRLF files and preserves CRLF', async () => {
    const path = join(dir, 'windows.txt');
    writeFileSync(path, 'one\r\ntwo\r\nthree\r\n');
    const result = await edit.execute(
      { filePath: 'windows.txt', oldString: 'one\ntwo', newString: 'one\nchanged' },
      ctx,
    );
    expect(result.status).toBe('success');
    expect(readFileSync(path, 'utf8')).toBe('one\r\nchanged\r\nthree\r\n');
  });

  it('preserves a UTF-8 BOM when editing CRLF text', async () => {
    const path = join(dir, 'bom.txt');
    writeFileSync(path, Buffer.from('\ufeffalpha\r\nbeta\r\n', 'utf8'));
    const result = await edit.execute(
      { filePath: 'bom.txt', oldString: 'alpha\nbeta', newString: 'alpha\ngamma' },
      ctx,
    );
    expect(result.status).toBe('success');
    expect(readFileSync(path, 'utf8')).toBe('\ufeffalpha\r\ngamma\r\n');
  });

  it('blocks a stale mutation until an explicit reread refreshes provenance', async () => {
    const path = join(dir, 'stale.txt');
    writeFileSync(path, 'original');
    const observed = await read.execute({ filePath: 'stale.txt' }, ctx);
    expect(observed.artifacts?.fileObservations?.[0].sha256).toMatch(/^[a-f0-9]{64}$/);

    writeFileSync(path, 'changed externally');
    const blocked = await edit.execute(
      { filePath: 'stale.txt', oldString: 'changed', newString: 'updated' },
      ctx,
    );
    expect(blocked.status).toBe('error');
    expect(blocked.structuredError?.message).toMatch(/^SKIPPED:.*Read/);

    await read.execute({ filePath: 'stale.txt' }, ctx);
    const allowed = await edit.execute(
      { filePath: 'stale.txt', oldString: 'changed', newString: 'updated' },
      ctx,
    );
    expect(allowed.status).toBe('success');
    expect(readFileSync(path, 'utf-8')).toBe('updated externally');
  });
  it('replaces the single occurrence when oldString is unique', async () => {
    writeFileSync(join(dir, 'a.txt'), 'foo bar baz');
    const r = await edit.execute({ filePath: 'a.txt', oldString: 'bar', newString: 'qux' }, ctx);
    expect(r.status).toBe('success');
    expect(r.artifacts?.fileMutation).toEqual({
      kind: 'update',
      filePath: 'a.txt',
      addedLines: 1,
      removedLines: 1,
    });
    const after = await read.execute({ filePath: 'a.txt' }, ctx);
    expect(after.content).toContain('foo qux baz');
  });

  it('fails when oldString is absent', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const r = await edit.execute({ filePath: 'a.txt', oldString: 'nope', newString: 'x' }, ctx);
    expect(r.status).toBe('error');
    expect(r.structuredError?.message).toMatch(/not found/);
    expect(r.artifacts?.fileMutation).toBeUndefined();
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

    expect(r.status).toBe('success');
    expect(r.artifacts?.fileMutation).toEqual({
      kind: 'update',
      filePath: 'a.txt',
      addedLines: 2,
      removedLines: 1,
    });
  });

  it.skipIf(process.platform === 'win32')(
    'applies MultiEdit through a file symlink without replacing it',
    async () => {
      const target = join(dir, 'target.txt');
      const link = join(dir, 'link.txt');
      writeFileSync(target, 'first second\n');
      symlinkSync(target, link, 'file');

      const result = await multiEditTool.execute(
        {
          filePath: 'link.txt',
          edits: [
            { oldString: 'first', newString: 'FIRST' },
            { oldString: 'second', newString: 'SECOND' },
          ],
        },
        ctx,
      );

      expect(result.status).toBe('success');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('FIRST SECOND\n');
    },
  );
});

describe('glob', () => {
  it('caps broad output and reports truncation', async () => {
    for (let i = 0; i < 1005; i++) {
      writeFileSync(join(dir, `file-${i}.txt`), String(i));
    }

    const r = await glob.execute({ pattern: '**/*' }, ctx);

    expect(r.status).toBe('success');
    expect(r.content).toContain('truncated at 1000 files');
    expect(r.content.split('\n')).toHaveLength(1001);
  });

  it('does not return out-of-workspace paths', async () => {
    writeFileSync(join(dir, 'inside.txt'), 'inside');
    const outsidePath = join(dirname(dir), 'outside-glob.txt');
    writeFileSync(outsidePath, 'outside');

    try {
      const r = await glob.execute({ pattern: '../*.txt' }, ctx);
      expect(r.status).toBe('success');
      const output = r.content;
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
    expect(r.status).toBe('success');
    expect(r.content).toContain('a.ts:1: const x = 1;');
    expect(r.content).not.toContain('b.ts');
  });

  it('returns only match records in structured data, not complete matched files', async () => {
    writeFileSync(join(dir, 'a.ts'), 'unrelated secret\nconst visible = 1;\nanother secret');
    const result = await grep.execute({ pattern: 'const', include: '*.ts' }, ctx);
    const data = result.data as {
      matches: Record<string, { matches: Array<{ line: number; text: string }>; lines?: string[] }>;
    };

    expect(data.matches['a.ts']).toEqual({
      matches: [{ line: 2, text: 'const visible = 1;' }],
    });
    expect(data.matches['a.ts']).not.toHaveProperty('lines');
    expect(JSON.stringify(result.data)).not.toContain('unrelated secret');
  });

  it('skips binary files even when their bytes contain the pattern', async () => {
    writeFileSync(join(dir, 'native.dll'), Buffer.from('prefix\0needle\0suffix'));

    const result = await grep.execute({ pattern: 'needle', include: '**/*' }, ctx);

    expect(result.content).toBe('No matches found');
    expect(JSON.stringify(result.data)).not.toContain('native.dll');
  });

  it('searches supported project files under .book', async () => {
    mkdirSync(join(dir, '.book', 'commands'), { recursive: true });
    writeFileSync(join(dir, '.book', 'commands', 'review.md'), 'project-command-marker');

    const result = await grep.execute(
      { pattern: 'project-command-marker', include: '.book/**/*.md' },
      ctx,
    );

    expect(result.content).toContain('.book/commands/review.md');
  });

  it('caps individual lines and total provider-facing output', async () => {
    for (let index = 0; index < 100; index++) {
      writeFileSync(join(dir, `large-${index}.txt`), `needle ${'x'.repeat(10_000)}`);
    }

    const result = await grep.execute(
      { pattern: 'needle', include: '*.txt', head_limit: 100 },
      ctx,
    );
    const data = result.data as {
      matches: Record<string, { matches: Array<{ line: number; text: string }> }>;
    };

    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(50 * 1024);
    expect(result.content).toContain('line truncated');
    expect(result.pagination?.truncated).toBe(true);
    for (const file of Object.values(data.matches)) {
      for (const match of file.matches) expect(match.text.length).toBeLessThanOrEqual(2_000);
    }
  });

  it('matches files after workspace path normalization', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const x = 1;');
    const r = await grep.execute({ pattern: 'const', include: '**/*.ts' }, ctx);
    expect(r.status).toBe('success');
    expect(r.content).toContain('a.ts:1: const x = 1;');
  });

  it('reports no matches found', async () => {
    writeFileSync(join(dir, 'a.ts'), 'nothing here');
    const r = await grep.execute({ pattern: 'zzzzz', include: '*.ts' }, ctx);
    expect(r.status).toBe('success');
    expect(r.content).toMatch(/No matches/);
  });

  it('preserves the portable TypeScript fallback backend', async () => {
    writeFileSync(join(dir, 'fallback.txt'), 'portable-backend-marker');

    const result = await grep.execute(
      { pattern: 'portable-backend-marker', include: '*.txt' },
      { ...ctx, env: { BOOK_GREP_BACKEND: 'typescript' } },
    );

    expect(result.content).toContain('fallback.txt:1: portable-backend-marker');
  });

  it('preserves count, files-only, context, multiline, and limit behavior', async () => {
    writeFileSync(join(dir, 'a.ts'), 'before\nconst first = 1;\nafter\nconst second = 2;');
    writeFileSync(join(dir, 'b.ts'), 'const third = 3;');

    const count = await grep.execute(
      { pattern: 'const', include: '*.ts', output_mode: 'count' },
      ctx,
    );
    expect(count.content).toContain('a.ts:2');
    expect(count.content).toContain('b.ts:1');

    const files = await grep.execute(
      { pattern: 'second', include: '*.ts', output_mode: 'files_with_matches' },
      ctx,
    );
    expect(files.content).toBe('a.ts');

    const context = await grep.execute({ pattern: 'first', include: '*.ts', A: 1, B: 1 }, ctx);
    expect(context.content).toContain('a.ts:1- before');
    expect(context.content).toContain('a.ts:2: const first = 1;');
    expect(context.content).toContain('a.ts:3- after');

    const multiline = await grep.execute(
      { pattern: 'before\\nconst', include: '*.ts', multiline: true },
      ctx,
    );
    expect(multiline.content).toContain('a.ts:1: before');

    const limited = await grep.execute({ pattern: 'const', include: '*.ts', head_limit: 1 }, ctx);
    expect(limited.content.split('\n')).toHaveLength(1);
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
      expect(result.status).toBe('success');
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
