import { describe, expect, it, vi } from 'vitest';

// Run the classifier as it runs on Windows, where the platform `path` functions join with a
// backslash. Git's own operands are forward-slash paths whatever the platform.
vi.mock('path', async () => {
  const { win32 } = await import('node:path');
  return { ...win32, default: win32 };
});

const { classifyReadOnlyShellCommand, shellCommandPaths } = await import('./shell-readonly.js');

describe('git paths on a platform whose path separator is a backslash', () => {
  const pathsOf = (command: string) => shellCommandPaths(classifyReadOnlyShellCommand(command)!);

  it('joins an operand to the -C directory with a forward slash', () => {
    expect(pathsOf('git -C src diff -- a.js')).toEqual(['src', 'src/a.js']);
    expect(pathsOf('git -C a -C b status')).toEqual(['a', 'a/b']);
    expect(pathsOf('git -C src diff -- ../../x')).toEqual(['src', '../x']);
  });

  it('keeps an absolute operand as written', () => {
    expect(pathsOf('git -C src diff -- /etc/passwd')).toEqual(['src', '/etc/passwd']);
  });
});
