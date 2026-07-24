interface PendingPermit {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/** Session-scoped concurrency bound for tools explicitly reviewed as parallel-safe. */
export class ToolExecutionScheduler {
  private active = 0;
  private limit: number;
  private readonly queue: PendingPermit[] = [];

  constructor(limit = 4) {
    this.limit = normalizeLimit(limit);
  }

  setLimit(limit: number): void {
    this.limit = normalizeLimit(limit);
    this.drain();
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await task();
    } finally {
      release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(abortError(signal));
    if (this.active < this.limit && this.queue.length === 0) {
      this.active++;
      return Promise.resolve(this.releasePermit());
    }

    return new Promise((resolve, reject) => {
      const pending: PendingPermit = { resolve, reject, signal };
      if (signal) {
        pending.onAbort = () => {
          const index = this.queue.indexOf(pending);
          if (index >= 0) this.queue.splice(index, 1);
          reject(abortError(signal));
        };
        signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this.queue.push(pending);
      this.drain();
    });
  }

  private releasePermit(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.drain();
    };
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length > 0) {
      const pending = this.queue.shift()!;
      pending.signal?.removeEventListener('abort', pending.onAbort!);
      if (pending.signal?.aborted) {
        pending.reject(abortError(pending.signal));
        continue;
      }
      this.active++;
      pending.resolve(this.releasePermit());
    }
  }
}

function normalizeLimit(limit: number): number {
  return Math.max(1, Math.min(8, Math.floor(limit)));
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === 'string' ? signal.reason : 'Tool execution was cancelled');
}
