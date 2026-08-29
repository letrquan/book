export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;

  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(typeof signal.reason === 'string' ? signal.reason : 'Operation cancelled');
}

/**
 * Subscribe to `signal`, returning an unsubscribe function.
 *
 * Fires immediately when the signal has already aborted, so a caller that
 * subscribes after an `await` cannot miss an abort that landed during it.
 * Handlers must be idempotent for that reason.
 */
export function onAbort(signal: AbortSignal | undefined, handler: () => void): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    handler();
    return () => {};
  }
  signal.addEventListener('abort', handler, { once: true });
  return () => signal.removeEventListener('abort', handler);
}

/**
 * Sleep, resolving early if `signal` aborts.
 *
 * Resolves rather than throws on abort: callers use it for backoff and check the
 * signal themselves at the point where cancelling changes what they do next.
 */
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      unsubscribe();
      resolve();
    }, ms);
    const unsubscribe = onAbort(signal, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Yield a macrotask so terminal input, Ink rendering, timers, and aborts can run. */
export async function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfAborted(signal);
}
