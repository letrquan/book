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

/** Yield a macrotask so terminal input, Ink rendering, timers, and aborts can run. */
export async function yieldToEventLoop(signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  throwIfAborted(signal);
}
