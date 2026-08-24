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

import { sameStatus, useGitStatus } from './useGitStatus.js';

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

describe('sameStatus', () => {
  // The poll allocates a fresh object every five seconds. Without this
  // comparison the hook hands React a new reference on every tick, so the whole
  // app reconciles twelve times a minute in an idle session for no visual
  // change. (Reference stability itself is not asserted here: state updates do
  // not flush through this file's Ink harness — see the poll test above, which
  // asserts call counts for the same reason.)
  it('treats an unchanged report as the same status', () => {
    expect(sameStatus({ branch: 'main', status: '~1' }, { branch: 'main', status: '~1' })).toBe(
      true,
    );
    expect(sameStatus({ branch: '?', status: '' }, { branch: '?', status: '' })).toBe(true);
  });

  it('separates a changed branch, a changed tree, and a changed error', () => {
    const base = { branch: 'main', status: '~1' };
    expect(sameStatus(base, { branch: 'feat/x', status: '~1' })).toBe(false);
    expect(sameStatus(base, { branch: 'main', status: '~2' })).toBe(false);
    expect(sameStatus(base, { ...base, error: 'git error' })).toBe(false);
  });

  it('separates a clean tree from a dirty one', () => {
    expect(sameStatus({ branch: 'main', status: '✓' }, { branch: 'main', status: '+1' })).toBe(
      false,
    );
  });
});
