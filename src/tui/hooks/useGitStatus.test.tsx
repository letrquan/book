import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(
  () =>
    [] as Array<{
      args: string[];
      options: { signal: AbortSignal };
      callback: (error: Error | null, stdout: string) => void;
    }>,
);

vi.mock('node:child_process', () => ({
  execFile: (
    _file: string,
    args: string[],
    options: { signal: AbortSignal },
    callback: (error: Error | null, stdout: string) => void,
  ) => calls.push({ args, options, callback }),
}));

import { useGitStatus } from './useGitStatus.js';

const roots: string[] = [];

function Harness({ workspace }: { workspace: string }) {
  useGitStatus(workspace);
  return null;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  calls.length = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('useGitStatus', () => {
  it('skips overlapping polls and aborts owned work on unmount', async () => {
    vi.useFakeTimers();
    const workspace = mkdtempSync(join(tmpdir(), 'book-git-status-'));
    roots.push(workspace);
    mkdirSync(join(workspace, '.git'));
    const view = render(<Harness workspace={workspace} />);
    await vi.advanceTimersByTimeAsync(0);

    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);

    const signal = calls[0].options.signal;
    view.unmount();
    expect(signal.aborted).toBe(true);
  });
});
