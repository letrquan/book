import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { system32Executable } from './system32.js';

describe('system32Executable', () => {
  it('returns bare name on non-Windows platforms', () => {
    expect(system32Executable('taskkill', 'linux')).toBe('taskkill');
    expect(system32Executable('rundll32', 'darwin')).toBe('rundll32');
  });

  it('resolves an existing executable from System32 on Windows', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'system32-test-'));
    try {
      const system32Dir = join(tempRoot, 'System32');
      mkdirSync(system32Dir, { recursive: true });
      const targetFile = join(system32Dir, 'taskkill.exe');
      writeFileSync(targetFile, '');

      const resolved = system32Executable('taskkill', 'win32', { SystemRoot: tempRoot });
      expect(resolved).toBe(targetFile);

      const resolvedWithExt = system32Executable('taskkill.exe', 'win32', {
        SystemRoot: tempRoot,
      });
      expect(resolvedWithExt).toBe(targetFile);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('falls back to bare name when executable does not exist in System32 on Windows', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'system32-test-'));
    try {
      const resolved = system32Executable('custom-tool', 'win32', { SystemRoot: tempRoot });
      expect(resolved).toBe('custom-tool');
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('supports windir environment variable if SystemRoot is unset', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'system32-test-'));
    try {
      const system32Dir = join(tempRoot, 'System32');
      mkdirSync(system32Dir, { recursive: true });
      const targetFile = join(system32Dir, 'rundll32.exe');
      writeFileSync(targetFile, '');

      const resolved = system32Executable('rundll32', 'win32', { windir: tempRoot });
      expect(resolved).toBe(targetFile);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
