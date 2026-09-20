import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { resolveReadablePath } from './path-utils.js';

describe('resolveReadablePath', () => {
  let ws: string;
  let mem: string;
  let other: string;

  beforeEach(() => {
    ws = mkdtempSync(join(tmpdir(), 'book-test-ws-'));
    mem = mkdtempSync(join(tmpdir(), 'book-test-mem-'));
    other = mkdtempSync(join(tmpdir(), 'book-test-other-'));
  });

  afterEach(() => {
    rmSync(ws, { recursive: true, force: true });
    rmSync(mem, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  });

  it('resolves an absolute path inside readOnlyRoots with root set to that root', () => {
    const memFile = join(mem, 'a.md');
    writeFileSync(memFile, '# Memory note');
    const resolved = resolveReadablePath(ws, [mem], memFile);
    expect(resolved).not.toBeNull();
    expect(resolved?.root).toBe(mem);
    expect(resolved?.filePath).toBe(memFile);
  });

  it('returns null for an absolute path outside both workspace and read-only roots', () => {
    const otherFile = join(other, 'a.md');
    writeFileSync(otherFile, '# Other note');
    expect(resolveReadablePath(ws, [mem], otherFile)).toBeNull();
  });

  it('returns null for path escaping the roots', () => {
    expect(resolveReadablePath(ws, [mem], '../../../etc/passwd')).toBeNull();
  });

  it('resolves a relative path inside the workspace with root set to workspace', () => {
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'src', 'x.ts'), 'export const x = 1;');
    const resolved = resolveReadablePath(ws, [mem], 'src/x.ts');
    expect(resolved).not.toBeNull();
    expect(resolved?.root).toBe(ws);
    expect(resolved?.relativePath).toBe('src/x.ts');
  });
});
