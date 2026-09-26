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
    // An Error, so a native `signal.throwIfAborted()` rethrows something a user
    // can read, that still carries the `bookTerminalReason` `classifyAbortReason`
    // reads so the run reports `cancelled` rather than a bare `caller_cancelled`.
    controller.abort(
      Object.assign(new Error(`Cancelled by ${signal}`), { bookTerminalReason: 'user_cancelled' }),
    );
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
 * (what a shell reports for a process a signal ended); otherwise whatever the run's
 * own outcome says, even if the signal aborted after it, so a reader that goes away
 * once a failed run has reported cannot turn it green; 1 for a run that threw; and
 * 0 for a run that was merely cancelled, wherever the abort landed, in the stream or
 * inside a tool — cancelling is not failing (#248).
 */
export function printExitCode(run: {
  outcome?: AgentTerminalOutcome;
  aborted: boolean;
  interruptedBy?: InterruptSignal;
}): number {
  if (run.interruptedBy) return run.interruptedBy === 'SIGINT' ? 130 : 143;
  if (run.outcome) return run.outcome.status === 'failed' ? 1 : 0;
  return run.aborted ? 0 : 1;
}
