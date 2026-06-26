import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileTools } from './file.js';
import type { ToolContext } from '../types.js';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dir: string;
const ctx: ToolContext = { workspaceRoot: '', env: {} };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-file-'));
  ctx.workspaceRoot = dir;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = fileTools.find((t) => t.name === 'read_file')!;
const edit = fileTools.find((t) => t.name === 'edit_file')!;
const grep = fileTools.find((t) => t.name === 'grep')!;

describe('edit_file', () => {
  it('replaces the first occurrence by default', async () => {
    writeFileSync(join(dir, 'a.txt'), 'foo foo bar');
    const r = await edit.execute(
      { filePath: 'a.txt', oldString: 'foo', newString: 'qux' },
      ctx,
    );
    expect(r.success).toBe(true);
    const after = await read.execute({ filePath: 'a.txt' }, ctx);
    expect(after.output).toContain('qux foo bar');
  });

  it('fails when oldString is absent', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const r = await edit.execute(
      { filePath: 'a.txt', oldString: 'nope', newString: 'x' },
      ctx,
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/not found/);
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

  it('reports no matches found', async () => {
    writeFileSync(join(dir, 'a.ts'), 'nothing here');
    const r = await grep.execute({ pattern: 'zzzzz', include: '*.ts' }, ctx);
    expect(r.success).toBe(true);
    expect(r.output).toMatch(/No matches/);
  });
});
