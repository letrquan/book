import { Writable } from 'node:stream';

/**
 * Has the reader of a print run's output gone?
 *
 * A closed pipe is only noticed on a write, and the notice arrives after the
 * write returns: `stdout.write` succeeds, the OS notices the far end is closed,
 * and the failure comes back on the write's callback and on the stream's
 * `error` event. A run that only watches the event hears about a reader that
 * left during a silent turn a whole tool call too late (#340), which is why
 * both this module and the CLI's pipe handler classify the same codes.
 */
const READER_GONE_CODES: ReadonlySet<string> = new Set([
  'EPIPE',
  'EOF',
  'ERR_STREAM_DESTROYED',
  'ECONNRESET',
]);

/**
 * True when `error` says nobody is reading this stream any more.
 *
 * Everything else is a real failure and belongs to whoever threw it: a
 * permission error on the pipe is not a reader that walked away, and swallowing
 * it would report a healthy run as cancelled.
 */
export function isReaderGoneError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return code !== undefined && READER_GONE_CODES.has(code);
}

/**
 * How long a tool boundary waits for the records announcing it to be taken.
 *
 * A reader that is gone answers within milliseconds — measured on Windows at
 * 1 to 2 ms after the write, for a native pipe and for Git Bash alike — while a
 * reader that is merely slow must not hold the run at a tool boundary. So the
 * wait ends at the first of: the write's callback, the run's signal, the cap.
 */
export const READER_FLUSH_CAP_MS = 1000;

/**
 * Watches a run's output stream for a reader that has gone, and lets a tool
 * boundary wait for the records it is about to announce.
 */
export interface ReaderFlush {
  /** Aborted the moment a write reports that the reader is gone. */
  readonly signal: AbortSignal;
  /**
   * Write one record. The write is made outside any promise, so a sink that
   * throws on `write` throws out of the caller exactly as a bare write does.
   */
  write(line: string): void;
  /**
   * Resolves once nothing this flush wrote is still outstanding, or at the cap.
   *
   * Free when the reader has caught up: no promise to settle, no timer, and no
   * listener on the run's signal. A reader that has made a hold wait the cap is
   * under backpressure rather than gone, so later holds stop waiting while its
   * writes are still pending — a live reader must not cost a cap at every call
   * of a run.
   */
  hold(signal: AbortSignal | undefined): Promise<void>;
}

/**
 * A flush for `stdout`, or `undefined` when it cannot report a failed write.
 *
 * Only a Node `Writable` qualifies — `process.stdout` and any `Writable` a host
 * passes do, and the SDK's bare `{ write }` sink does not. Guessing from the
 * `write` signature instead would take a wrapper that forwards nothing for a
 * writer that reports nothing, and read a two-parameter sink's `encoding` as a
 * callback it will never be handed.
 */
export function createReaderFlush(
  stdout: unknown,
  options: { capMs?: number } = {},
): ReaderFlush | undefined {
  if (!(stdout instanceof Writable)) return undefined;
  const capMs = options.capMs ?? READER_FLUSH_CAP_MS;
  const controller = new AbortController();
  /** Writes this flush has made and not yet been answered. */
  let pending = 0;
  /** Whether a hold has already spent the cap on this reader. */
  let slow = false;
  const waiters = new Set<() => void>();

  const drained = (): void => {
    if (pending > 0) return;
    // The reader caught up, so the next boundary waits again: a stall that ends
    // costs one cap, not the whole run.
    slow = false;
    for (const release of [...waiters]) release();
    waiters.clear();
  };

  return {
    signal: controller.signal,
    write(line: string): void {
      pending++;
      stdout.write(line, (error) => {
        if (error && isReaderGoneError(error)) controller.abort();
        pending--;
        drained();
      });
    },
    hold(signal: AbortSignal | undefined): Promise<void> {
      if (pending === 0 || slow || signal?.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener('abort', finish);
          waiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(() => {
          slow = true;
          finish();
        }, capMs);
        waiters.add(finish);
        signal?.addEventListener('abort', finish, { once: true });
        // An abort between the check above and the subscription would
        // otherwise leave the hold waiting out the cap.
        if (signal?.aborted) finish();
      });
    },
  };
}
