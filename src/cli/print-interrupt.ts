import { exit } from './exit.js';
import type { AgentTerminalOutcome } from '../types/terminal.js';

type InterruptSignal = 'SIGINT' | 'SIGTERM';

export interface PrintInterrupt {
  /** Aborts on the first SIGINT or SIGTERM, with a `user_cancelled` reason. */
  signal: AbortSignal;
  /** The signal that cancelled the run, if one did. */
  interruptedBy(): InterruptSignal | undefined;
  /** Remove the listeners. */
  dispose(): void;
}

/**
 * Make Ctrl+C cancel a print run instead of killing it: the run is given the same
 * abort a cancelled stream gets, so it still runs SessionEnd hooks, and a second
 * Ctrl+C leaves at once rather than waiting on them (#248).
 */
export function installPrintInterrupt(
  options: {
    stderr?: { write(text: string): unknown };
    onSecondSignal?: (signal: InterruptSignal) => void;
  } = {},
): PrintInterrupt {
  const controller = new AbortController();
  let interrupted: InterruptSignal | undefined;
  const onSignal = (signal: InterruptSignal): void => {
    if (interrupted) {
      (
        options.onSecondSignal ??
        ((second: InterruptSignal) => exit(second === 'SIGINT' ? 130 : 143))
      )(signal);
      return;
    }
    interrupted = signal;
    (options.stderr ?? process.stderr).write(
      '\nCancelling: running SessionEnd hooks. Press Ctrl+C again to exit now.\n',
    );
    // The shape `classifyAbortReason` reads, so the run reports a `cancelled`
    // outcome rather than a bare `caller_cancelled`.
    controller.abort({ bookTerminalReason: 'user_cancelled' });
  };
  const onSigint = (): void => onSignal('SIGINT');
  const onSigterm = (): void => onSignal('SIGTERM');
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return {
    signal: controller.signal,
    interruptedBy: () => interrupted,
    dispose: () => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
    },
  };
}

/**
 * The exit code a print run leaves behind: 130 or 143 when a signal interrupted it
 * (what a shell reports for a process a signal ended), 1 for a failed or thrown run,
 * and 0 otherwise — a cancelled run is not a failed one, wherever the abort landed,
 * in the stream or inside a tool (#248).
 */
export function printExitCode(run: {
  outcome?: AgentTerminalOutcome;
  aborted: boolean;
  interruptedBy?: InterruptSignal;
}): number {
  if (run.interruptedBy) return run.interruptedBy === 'SIGINT' ? 130 : 143;
  if (run.aborted) return 0;
  if (!run.outcome) return 1;
  return run.outcome.status === 'failed' ? 1 : 0;
}
