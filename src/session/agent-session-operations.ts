export type AgentSessionOperationKind = 'send' | 'compact' | 'rewind';

export interface AgentSessionOperation {
  readonly kind: AgentSessionOperationKind;
  readonly signal?: AbortSignal;
  isCurrent(): boolean;
  release(): boolean;
}

export interface CancelOperationResult {
  readonly kind: AgentSessionOperationKind | null;
  readonly aborted: boolean;
}

interface ActiveOperation {
  readonly kind: AgentSessionOperationKind;
  readonly controller?: AbortController;
}

/** Owns operation exclusion, cancellation, and stale-release protection for a session. */
export class AgentSessionOperations {
  private active: ActiveOperation | null = null;
  private readonly listeners = new Set<() => void>();

  /** Called whenever an operation starts or ends, after `activeKind` reflects it. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }

  get activeKind(): AgentSessionOperationKind | null {
    return this.active?.kind ?? null;
  }

  isRunning(kind?: AgentSessionOperationKind): boolean {
    return kind ? this.active?.kind === kind : this.active !== null;
  }

  tryStart(kind: AgentSessionOperationKind, abortable = false): AgentSessionOperation | null {
    if (this.active) return null;
    const operation: ActiveOperation = {
      kind,
      controller: abortable ? new AbortController() : undefined,
    };
    this.active = operation;
    this.publish();
    return {
      kind,
      signal: operation.controller?.signal,
      isCurrent: () => this.active === operation,
      release: () => {
        if (this.active !== operation) return false;
        this.active = null;
        this.publish();
        return true;
      },
    };
  }

  cancel(reason?: unknown): CancelOperationResult {
    const active = this.active;
    if (!active) return { kind: null, aborted: false };
    const aborted = active.controller !== undefined && !active.controller.signal.aborted;
    active.controller?.abort(reason);
    return { kind: active.kind, aborted };
  }

  /** Abort and release the active lease when replacing the whole session. */
  reset(reason?: unknown): AgentSessionOperationKind | null {
    const active = this.active;
    if (!active) return null;
    active.controller?.abort(reason);
    this.active = null;
    this.publish();
    return active.kind;
  }
}
