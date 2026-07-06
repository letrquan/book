import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  findActiveFileMention,
  getFileMentionCandidates,
  replaceActiveFileMention,
  resolveWorkspaceMentionPath,
} from './file-mentions.js';

let dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-mentions-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe('file mention helpers', () => {
  it('finds the active unquoted mention at the end of input', () => {
    expect(findActiveFileMention('explain @src/too')).toEqual({
      start: 8,
      end: 16,
      query: 'src/too',
      quoted: false,
    });
  });

  it('finds an active quoted mention', () => {
    expect(findActiveFileMention('read @"my file')).toEqual({
      start: 5,
      end: 14,
      query: 'my file',
      quoted: true,
    });
  });

  it('ignores completed or non-boundary mentions', () => {
    expect(findActiveFileMention('email dev@example.com')).toBeNull();
    expect(findActiveFileMention('read @src/file.ts now')).toBeNull();
  });

  it('replaces active mention with the selected path', () => {
    const mention = findActiveFileMention('explain @src/too');
    expect(mention).not.toBeNull();
    expect(replaceActiveFileMention('explain @src/too', mention!, 'src/tools/file.ts')).toBe(
      'explain @src/tools/file.ts ',
    );
  });

  it('keeps workspace paths inside the workspace', () => {
    const ws = workspace();
    expect(resolveWorkspaceMentionPath(ws, '../outside')).toBeNull();
    expect(resolveWorkspaceMentionPath(ws, './src/app.ts')?.relativePath).toBe('src/app.ts');
  });

  it('returns gitignore-aware file candidates', () => {
    const ws = workspace();
    mkdirSync(join(ws, 'src'));
    mkdirSync(join(ws, 'dist'));
    writeFileSync(join(ws, '.gitignore'), 'dist\n');
    writeFileSync(join(ws, 'src', 'app.ts'), 'app');
    writeFileSync(join(ws, 'dist', 'app.js'), 'ignored');

    const candidates = getFileMentionCandidates(ws, 'app');

    expect(candidates.map((c) => c.path)).toContain('src/app.ts');
    expect(candidates.map((c) => c.path)).not.toContain('dist/app.js');
  });
});
