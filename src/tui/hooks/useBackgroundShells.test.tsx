import { Text } from 'ink';
import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShellJobEvent, ShellJobManager } from '../../jobs/shell-manager.js';
import type { BackgroundShellRecord } from '../../types/runtime.js';
import { useBackgroundShells, type BackgroundShellState } from './useBackgroundShells.js';

afterEach(() => cleanup());

function shell(status: BackgroundShellRecord['status'], id = 'shell_1'): BackgroundShellRecord {
  return {
    id,
    command: 'printf done',
    effectiveCommand: 'printf done',
    title: 'Build assets',
    workdir: process.cwd(),
    status,
    lifetime: 'session',
    notify: 'ui',
    output: '',
    readOffset: 0,
    truncatedBytes: 0,
    completionSequence: status === 'running' ? 0 : 1,
    startedAt: 1,
    finishedAt: status === 'running' ? undefined : 2,
  };
}

describe('useBackgroundShells', () => {
  it('removes finished jobs from the active panel and consumes their notice once', async () => {
    let records = [shell('running')];
    let listener: ((event: ShellJobEvent) => void) | undefined;
    const manager = {
      list: vi.fn(() => records),
      listPendingAgentCompletions: vi.fn(() => []),
      listPendingUiCompletions: vi.fn(() => []),
      subscribe: vi.fn((next: (event: ShellJobEvent) => void) => {
        listener = next;
        return vi.fn();
      }),
      acknowledgeCompletion: vi.fn(),
      get: vi.fn((id: string) => records.find((record) => record.id === id)),
      dismiss: vi.fn(),
      stop: vi.fn(),
    } as unknown as ShellJobManager;
    let latest: BackgroundShellState | undefined;

    function Harness() {
      latest = useBackgroundShells(manager, 'session-1');
      return <Text>{latest.shells.map((item) => item.id).join(',') || 'empty'}</Text>;
    }

    render(<Harness />);
    await vi.waitFor(() => expect(latest?.shells).toHaveLength(1));

    const completed = shell('exited');
    records = [completed];
    listener?.({ type: 'background_job_result', job: completed });

    await vi.waitFor(() => expect(latest?.shells).toEqual([]));
    expect(latest?.lastCompletion?.id).toBe('shell_1');

    latest?.acknowledge('shell_1');
    await vi.waitFor(() => expect(latest?.lastCompletion).toBeUndefined());
    expect(manager.acknowledgeCompletion).toHaveBeenCalledWith('shell_1');
  });

  it('queues every UI completion and advances after each acknowledgement', async () => {
    const first = { ...shell('exited', 'shell_1'), finishedAt: 2 };
    const second = { ...shell('failed', 'shell_2'), finishedAt: 3 };
    const manager = {
      list: vi.fn(() => [first, second]),
      listPendingAgentCompletions: vi.fn(() => []),
      listPendingUiCompletions: vi.fn(() => [first, second]),
      subscribe: vi.fn(() => vi.fn()),
      acknowledgeCompletion: vi.fn(),
    } as unknown as ShellJobManager;
    let latest: BackgroundShellState | undefined;

    function Harness() {
      latest = useBackgroundShells(manager, 'session-1');
      return <Text>{latest.lastCompletion?.id ?? 'none'}</Text>;
    }

    render(<Harness />);
    await vi.waitFor(() => expect(latest?.pendingUiCompletions).toHaveLength(2));
    expect(latest?.lastCompletion?.id).toBe('shell_1');

    latest?.acknowledge('shell_1');
    await vi.waitFor(() => expect(latest?.lastCompletion?.id).toBe('shell_2'));
    latest?.acknowledge('shell_2');
    await vi.waitFor(() => expect(latest?.lastCompletion).toBeUndefined());
  });

  it('keeps shells state identity stable across output churn', async () => {
    vi.useFakeTimers();
    let listener: ((event: ShellJobEvent) => void) | undefined;
    const manager = {
      // list() clones records on every call, like the real manager.
      list: vi.fn(() => [{ ...shell('running') }]),
      listPendingAgentCompletions: vi.fn(() => []),
      listPendingUiCompletions: vi.fn(() => []),
      subscribe: vi.fn((next: (event: ShellJobEvent) => void) => {
        listener = next;
        return vi.fn();
      }),
    } as unknown as ShellJobManager;
    let latest: BackgroundShellState | undefined;

    function Harness() {
      latest = useBackgroundShells(manager, 'session-1');
      return <Text>{latest.shells.length}</Text>;
    }

    render(<Harness />);
    await vi.waitFor(() => expect(latest?.shells).toHaveLength(1));
    const initialList = latest?.shells;
    const initialListCalls = (manager.list as ReturnType<typeof vi.fn>).mock.calls.length;

    for (let index = 0; index < 50; index++) {
      listener?.({ type: 'background_job_output', jobId: 'shell_1', revision: index });
    }
    vi.advanceTimersByTime(1000);

    // Refreshes are coalesced (not one list() per chunk) and the state object
    // keeps its identity because nothing the list renders has changed.
    const listCallsDuringChurn =
      (manager.list as ReturnType<typeof vi.fn>).mock.calls.length - initialListCalls;
    expect(listCallsDuringChurn).toBeLessThanOrEqual(2);
    expect(latest?.shells).toBe(initialList);
    vi.useRealTimers();
  });

  it('ignores agent completions from another session', async () => {
    let listener: ((event: ShellJobEvent) => void) | undefined;
    const manager = {
      list: vi.fn(() => []),
      listPendingAgentCompletions: vi.fn(() => []),
      listPendingUiCompletions: vi.fn(() => []),
      subscribe: vi.fn((next: (event: ShellJobEvent) => void) => {
        listener = next;
        return vi.fn();
      }),
    } as unknown as ShellJobManager;
    let latest: BackgroundShellState | undefined;

    function Harness() {
      latest = useBackgroundShells(manager, 'session-b');
      return <Text>{latest.pendingAgentCompletions.length}</Text>;
    }

    render(<Harness />);
    const completed = {
      ...shell('exited'),
      notify: 'agent' as const,
      parentSessionId: 'session-a',
    };
    listener?.({ type: 'background_job_result', job: completed });
    await vi.waitFor(() => expect(latest?.pendingAgentCompletions).toEqual([]));

    listener?.({
      type: 'background_job_result',
      job: { ...completed, id: 'shell_2', parentSessionId: 'session-b' },
    });
    await vi.waitFor(() =>
      expect(latest?.pendingAgentCompletions.map((job) => job.id)).toEqual(['shell_2']),
    );
  });
});
