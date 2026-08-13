import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackgroundShellRecord } from '../../types/runtime.js';
import type { ShellJobManager } from '../../jobs/shell-manager.js';

/**
 * Output chunks arrive at raw process frequency (hundreds/s for chatty
 * commands); every un-coalesced refresh forces a full App render + Yoga
 * layout pass. Consumers read live output via readTail/readOutput, never from
 * this list, so output events only need a slow safety-net refresh.
 */
const OUTPUT_REFRESH_COALESCE_MS = 250;

/**
 * Field-wise equality over everything the shell list UI renders. Deliberately
 * ignores output, readOffset, and outputRevision: cloneRecord makes every
 * list() call referentially fresh, and without this bail each output chunk
 * would re-render the whole App with no visible change.
 */
function shellListEquals(left: BackgroundShellRecord[], right: BackgroundShellRecord[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const previous = left[index];
    const next = right[index];
    if (
      previous.id !== next.id ||
      previous.status !== next.status ||
      previous.title !== next.title ||
      previous.command !== next.command ||
      previous.lifetime !== next.lifetime ||
      previous.notify !== next.notify ||
      previous.pid !== next.pid ||
      previous.startedAt !== next.startedAt ||
      previous.finishedAt !== next.finishedAt ||
      previous.exitCode !== next.exitCode ||
      previous.truncatedBytes !== next.truncatedBytes
    ) {
      return false;
    }
  }
  return true;
}

export interface BackgroundShellState {
  shells: BackgroundShellRecord[];
  lastCompletion?: BackgroundShellRecord;
  pendingUiCompletions: BackgroundShellRecord[];
  pendingAgentCompletions: BackgroundShellRecord[];
  refresh: () => void;
  stopOrDismiss: (shellId: string) => Promise<void>;
  acknowledge: (shellId: string) => void;
  acknowledgeAgentCompletion: (shellId: string, sequence?: number) => void;
}

export function useBackgroundShells(
  manager: ShellJobManager,
  parentSessionId: string,
): BackgroundShellState {
  const visible = useCallback(
    () =>
      manager
        .list()
        .filter(
          (shell) => !['exited', 'failed', 'killed', 'timed_out', 'lost'].includes(shell.status),
        ),
    [manager],
  );
  const [shells, setShells] = useState<BackgroundShellRecord[]>(visible);
  const [pendingUiCompletions, setPendingUiCompletions] = useState<BackgroundShellRecord[]>(() =>
    manager.listPendingUiCompletions(),
  );
  const [pendingAgentCompletions, setPendingAgentCompletions] = useState<BackgroundShellRecord[]>(
    () => manager.listPendingAgentCompletions(parentSessionId),
  );
  const lastCompletion = pendingUiCompletions[0];
  const refresh = useCallback(() => {
    setShells((current) => {
      const next = visible();
      return shellListEquals(current, next) ? current : next;
    });
  }, [visible]);
  const outputRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    refresh();
    setPendingUiCompletions(manager.listPendingUiCompletions());
    setPendingAgentCompletions(manager.listPendingAgentCompletions(parentSessionId));
    const scheduleOutputRefresh = () => {
      if (outputRefreshTimerRef.current !== null) return;
      outputRefreshTimerRef.current = setTimeout(() => {
        outputRefreshTimerRef.current = null;
        refresh();
      }, OUTPUT_REFRESH_COALESCE_MS);
    };
    const unsubscribe = manager.subscribe((event) => {
      if (event.type === 'background_job_output') {
        // Refresh on a timer only: the list renders nothing from output, but
        // the periodic pass still picks up side effects such as truncation
        // counters and persistent-job status reconciliation.
        scheduleOutputRefresh();
        return;
      }
      if (event.type === 'background_job_result') {
        if (event.job.notify !== 'none') {
          setPendingUiCompletions((current) => [
            ...current.filter((shell) => shell.id !== event.job.id),
            event.job,
          ]);
        }
        if (
          event.job.notify === 'agent' &&
          event.job.parentSessionId === parentSessionId &&
          (event.job.completionSequence ?? 0) > (event.job.completionDeliveredSequence ?? 0)
        ) {
          setPendingAgentCompletions((current) => [
            ...current.filter((shell) => shell.id !== event.job.id),
            event.job,
          ]);
        }
      }
      refresh();
    });
    return () => {
      unsubscribe();
      if (outputRefreshTimerRef.current !== null) {
        clearTimeout(outputRefreshTimerRef.current);
        outputRefreshTimerRef.current = null;
      }
    };
  }, [manager, parentSessionId, refresh]);

  const stopOrDismiss = useCallback(
    async (shellId: string) => {
      const shell = manager.get(shellId);
      if (!shell) return;
      if (['exited', 'failed', 'killed', 'timed_out', 'lost'].includes(shell.status)) {
        manager.dismiss(shellId);
      } else {
        await manager.stop(shellId);
      }
      refresh();
    },
    [manager, refresh],
  );

  const acknowledge = useCallback(
    (shellId: string) => {
      manager.acknowledgeCompletion(shellId);
      setPendingUiCompletions((current) => current.filter((shell) => shell.id !== shellId));
      refresh();
    },
    [manager, refresh],
  );

  const acknowledgeAgentCompletion = useCallback(
    (shellId: string, sequence?: number) => {
      manager.acknowledgeCompletion(shellId, sequence, 'agent');
      setPendingAgentCompletions((current) => current.filter((shell) => shell.id !== shellId));
    },
    [manager],
  );

  return {
    shells,
    lastCompletion,
    pendingUiCompletions,
    pendingAgentCompletions,
    refresh,
    stopOrDismiss,
    acknowledge,
    acknowledgeAgentCompletion,
  };
}
