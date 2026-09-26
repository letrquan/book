import { afterEach, describe, expect, it, vi } from 'vitest';
import { installPrintInterrupt, printExitCode, type PrintInterrupt } from './print-interrupt.js';
import { classifyAbortReason, createTerminalOutcome } from '../types/terminal.js';

let installed: PrintInterrupt | undefined;

afterEach(() => {
  installed?.dispose();
  installed = undefined;
});

describe('installPrintInterrupt', () => {
  it('cancels the run on the first SIGINT and says how to leave at once', () => {
    const notices: string[] = [];
    installed = installPrintInterrupt({ stderr: { write: (text: string) => notices.push(text) } });

    process.emit('SIGINT', 'SIGINT');

    expect(installed.signal.aborted).toBe(true);
    expect(installed.interruptedBy()).toBe('SIGINT');
    expect(classifyAbortReason(installed.signal.reason, false)).toMatchObject({
      status: 'cancelled',
      reason: 'user_cancelled',
    });
    expect(notices.join('')).toContain('Ctrl+C again');
  });

  it('leaves at once on a second signal', () => {
    const onSecondSignal = vi.fn();
    installed = installPrintInterrupt({ stderr: { write: () => true }, onSecondSignal });

    process.emit('SIGINT', 'SIGINT');
    expect(onSecondSignal).not.toHaveBeenCalled();
    process.emit('SIGTERM', 'SIGTERM');

    expect(onSecondSignal).toHaveBeenCalledWith('SIGTERM');
    expect(installed.interruptedBy()).toBe('SIGINT');
  });

  it('removes its listeners when disposed', () => {
    const before = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    const interrupt = installPrintInterrupt({ stderr: { write: () => true } });
    expect(process.listenerCount('SIGINT')).toBe(before[0] + 1);

    interrupt.dispose();

    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(before);
  });
});

describe('printExitCode', () => {
  const completed = createTerminalOutcome('completed', 'normal_completion');
  const stalled = createTerminalOutcome('timed_out', 'stream_stall');
  const cancelled = createTerminalOutcome('cancelled', 'caller_cancelled');
  const failed = createTerminalOutcome('failed', 'max_turns');

  it('is 0 for a completed run, and for a stall, as documented', () => {
    expect(printExitCode({ outcome: completed, aborted: false })).toBe(0);
    expect(printExitCode({ outcome: stalled, aborted: false })).toBe(0);
  });

  it('is 1 for a failed run, and for a run that threw', () => {
    expect(printExitCode({ outcome: failed, aborted: false })).toBe(1);
    expect(printExitCode({ aborted: false })).toBe(1);
  });

  it('is 0 for an aborted run wherever the abort landed, since cancelling is not failing', () => {
    // In the stream the run returns a cancelled outcome; inside a tool it throws.
    expect(printExitCode({ outcome: cancelled, aborted: true })).toBe(0);
    expect(printExitCode({ aborted: true })).toBe(0);
  });

  it('is 130 or 143 when a signal interrupted the run, as a signal death would be', () => {
    expect(printExitCode({ outcome: cancelled, aborted: true, interruptedBy: 'SIGINT' })).toBe(130);
    expect(printExitCode({ aborted: true, interruptedBy: 'SIGTERM' })).toBe(143);
  });
});
