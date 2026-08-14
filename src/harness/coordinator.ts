import type {
  BoundedHarnessText,
  FinalizeRunInput,
  HarnessCoordinator,
  HarnessEvent,
  HarnessMode,
  HarnessObserverEnqueueResult,
  HarnessObserverFlushResult,
  HarnessRunContext,
  PrepareRunInput,
  PreparedRun,
  WorkflowDecision,
} from './contracts.js';
import { workspaceIdentity } from '../tools/file-provenance.js';
import { RunEvidenceStore, type RunLedgerMetadata, type RunLedgerWriter } from './run-store.js';
import { createWriterObserver, wrapAgentLoopCallbacks } from './observer.js';
import { harnessTextRejectionReason } from './redaction.js';

export const AVAILABLE_HARNESS_MODES = Object.freeze(['off', 'observe'] as const);
export const MAX_HARNESS_TEXT_LENGTH = 1024;

/** Accept only bounded, non-secret text at the harness contract boundary. */
export function createBoundedHarnessText(value: string): BoundedHarnessText {
  const normalized = value.trim();
  const rejectionReason = harnessTextRejectionReason(normalized);
  if (rejectionReason === 'too-long') {
    throw new Error(`Harness text exceeds ${MAX_HARNESS_TEXT_LENGTH} characters.`);
  }
  if (rejectionReason === 'control-characters') {
    throw new Error('Harness text contains forbidden control characters.');
  }
  if (rejectionReason) throw new Error(`Harness text rejected: ${rejectionReason}.`);
  return normalized as BoundedHarnessText;
}

export class HarnessModeUnavailableError extends Error {
  readonly code = 'harness_mode_unavailable';

  constructor(readonly mode: HarnessMode) {
    super(
      `Harness mode "${mode}" is valid but unavailable in this build. ` +
        `Available modes: ${AVAILABLE_HARNESS_MODES.join(', ')}.`,
    );
    this.name = 'HarnessModeUnavailableError';
  }
}

export function assertHarnessModeAvailable(mode: HarnessMode): void {
  if (!(AVAILABLE_HARNESS_MODES as readonly HarnessMode[]).includes(mode)) {
    throw new HarnessModeUnavailableError(mode);
  }
}

function freezeWorkflowDecision(decision: WorkflowDecision): WorkflowDecision {
  return Object.freeze({ ...decision });
}

/** Freeze host-prepared context without attaching coordinator or store state. */
export function freezeHarnessRunContext(context: HarnessRunContext): HarnessRunContext {
  return Object.freeze({
    ...context,
    workflow: context.workflow ? freezeWorkflowDecision(context.workflow) : undefined,
  });
}

const DISABLED_PREPARED_RUN = Object.freeze({ status: 'disabled', mode: 'off' } as const);
const DISABLED_OBSERVER_FLUSH_RESULT = Object.freeze({
  flushed: false,
  status: 'disabled' as const,
  droppedEventCount: 0,
  incomplete: false,
});

class DisabledHarnessCoordinator implements HarnessCoordinator {
  async prepareRun(input: PrepareRunInput): Promise<PreparedRun> {
    assertHarnessModeAvailable(input.mode);
    return DISABLED_PREPARED_RUN;
  }

  observe(_runId: string, _event: HarnessEvent): HarnessObserverEnqueueResult {
    return 'rejected';
  }

  async finalizeRun(
    _runId: string,
    _result: FinalizeRunInput,
  ): Promise<HarnessObserverFlushResult> {
    return DISABLED_OBSERVER_FLUSH_RESULT;
  }
}

const DISABLED_HARNESS_COORDINATOR = Object.freeze(new DisabledHarnessCoordinator());

class ObserveHarnessCoordinator implements HarnessCoordinator {
  private readonly store: RunEvidenceStore;
  private readonly writers = new Map<string, RunLedgerWriter>();
  private readonly rootWriters = new Map<string, RunLedgerWriter>();
  private readonly workspace: string;
  private readonly bookHome?: string;

  constructor(workspace: string, bookHome?: string) {
    this.workspace = workspace;
    this.bookHome = bookHome;
    this.store = new RunEvidenceStore({ workspace, bookHome });
  }

  async prepareRun(input: PrepareRunInput): Promise<PreparedRun> {
    assertHarnessModeAvailable(input.mode);
    if (input.mode === 'off') return DISABLED_PREPARED_RUN;
    if (!input.identity) {
      throw new Error('harness_context_missing_or_invalid');
    }
    if (input.identity.rootRunId !== input.identity.runId && !input.identity.parentRunId) {
      throw new Error('harness_child_parent_missing');
    }
    const identity = {
      workspaceId: input.identity.workspaceId ?? workspaceIdentity(this.workspace),
      rootRunId: input.identity.rootRunId,
      runId: input.identity.runId,
      parentRunId: input.identity.parentRunId,
      resumedFromRunId: input.identity.resumedFromRunId,
      sessionId: input.identity.sessionId,
      metadata: (input.metadata ?? { mode: 'observe' }) as RunLedgerMetadata,
    };
    let writer = this.rootWriters.get(identity.rootRunId);
    if (writer && writer.getSeal()) {
      // A stale sealed writer cannot accept new runs; evict it so the failure
      // below is deterministic instead of silently losing child events.
      this.rootWriters.delete(identity.rootRunId);
      for (const [staleRunId, staleWriter] of this.writers) {
        if (staleWriter === writer) this.writers.delete(staleRunId);
      }
      writer = undefined;
    }
    if (!writer) {
      if (identity.runId !== identity.rootRunId) {
        // A child run may only join an open root stream. Sealed or never-opened
        // roots make child evidence explicitly unavailable instead of colliding
        // with (or fabricating) a root stream on disk.
        throw new Error('harness_root_stream_unavailable');
      }
      writer = await this.store.startRun(identity);
      this.rootWriters.set(identity.rootRunId, writer);
    } else if (identity.runId !== identity.rootRunId) {
      // Child execution attribution is retained in the shared root stream; it
      // must never create a second append descriptor for the same root.
      writer.enqueue({
        type: 'subagent_handoff_created',
        runId: identity.runId,
        parentRunId: identity.parentRunId,
        occurredAt: Date.now(),
        attributes: { child: true },
      });
    }
    this.writers.set(identity.runId, writer);
    const context = freezeHarnessRunContext({
      runId: identity.runId,
      rootRunId: identity.rootRunId,
      parentRunId: identity.parentRunId,
      resumedFromRunId: identity.resumedFromRunId,
      sessionId: identity.sessionId,
      workspaceId: identity.workspaceId,
      mode: 'observe',
      workflow: { id: 'baseline', version: 1, reasonCode: 'observe', source: 'baseline' },
    });
    return {
      status: 'prepared',
      mode: 'observe',
      context,
      // Only the root observer may seal the stream. A child observer flushes;
      // the root terminal record and seal belong to the root run's finalization.
      observer:
        identity.runId === identity.rootRunId
          ? createWriterObserver(writer)
          : createWriterObserver(writer, { finalize: () => writer.flush() }),
    };
  }

  observe(runId: string, event: HarnessEvent): HarnessObserverEnqueueResult {
    return this.writers.get(runId)?.enqueue(event) ?? 'rejected';
  }

  async finalizeRun(runId: string, result: FinalizeRunInput): Promise<HarnessObserverFlushResult> {
    const writer = this.writers.get(runId);
    if (!writer) return DISABLED_OBSERVER_FLUSH_RESULT;
    const isRoot = writer.identity.rootRunId === runId;
    const final = isRoot ? await writer.finalize(result) : await writer.flush();
    this.writers.delete(runId);
    if (isRoot) {
      this.rootWriters.delete(writer.identity.rootRunId);
      // Child entries share the sealed root stream; they cannot outlive its writer.
      for (const [childRunId, childWriter] of this.writers) {
        if (childWriter === writer) this.writers.delete(childRunId);
      }
    }
    return final;
  }
}

/** Create the coordinator for the resolved mode. `observe` is Phase 2's sole enabled mode. */
export function createHarnessCoordinator(
  mode: HarnessMode,
  options: { workspace?: string; bookHome?: string } = {},
): HarnessCoordinator {
  assertHarnessModeAvailable(mode);
  if (mode === 'off') return DISABLED_HARNESS_COORDINATOR;
  if (!options.workspace) throw new Error('Harness observe mode requires a workspace.');
  return new ObserveHarnessCoordinator(options.workspace, options.bookHome);
}

/** Runtime-facing facade; keeps observer implementation behind this architecture boundary. */
export { wrapAgentLoopCallbacks };
export type { HarnessCallbackObserverOptions } from './observer.js';
