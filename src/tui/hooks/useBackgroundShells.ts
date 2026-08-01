import { useCallback, useEffect, useState } from 'react';
import type { BackgroundShellRecord } from '../../types/runtime.js';
import type { ShellJobManager } from '../../jobs/shell-manager.js';

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
  const refresh = useCallback(() => setShells(visible()), [visible]);

  useEffect(() => {
    refresh();
    setPendingUiCompletions(manager.listPendingUiCompletions());
    setPendingAgentCompletions(manager.listPendingAgentCompletions(parentSessionId));
    return manager.subscribe((event) => {
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
