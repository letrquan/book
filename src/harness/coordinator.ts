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
import { looksLikeSecretOrUnfit } from '../secret-detect.js';

export const AVAILABLE_HARNESS_MODES = Object.freeze(['off'] as const);
export const MAX_HARNESS_TEXT_LENGTH = 1024;

const FORBIDDEN_HARNESS_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Accept only bounded, non-secret text at the harness contract boundary. */
export function createBoundedHarnessText(value: string): BoundedHarnessText {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error('Harness text rejected: empty.');
  if (normalized.length > MAX_HARNESS_TEXT_LENGTH) {
    throw new Error(`Harness text exceeds ${MAX_HARNESS_TEXT_LENGTH} characters.`);
  }
  if (FORBIDDEN_HARNESS_CONTROL_CHARACTERS.test(normalized)) {
    throw new Error('Harness text contains forbidden control characters.');
  }
  const rejectionReason = looksLikeSecretOrUnfit(normalized);
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
  flushed: true,
  droppedEventCount: 0,
});

class DisabledHarnessCoordinator implements HarnessCoordinator {
  async prepareRun(input: PrepareRunInput): Promise<PreparedRun> {
    assertHarnessModeAvailable(input.mode);
    return DISABLED_PREPARED_RUN;
  }

  observe(_runId: string, _event: HarnessEvent): HarnessObserverEnqueueResult {
    return 'closed';
  }

  async finalizeRun(
    _runId: string,
    _result: FinalizeRunInput,
  ): Promise<HarnessObserverFlushResult> {
    return DISABLED_OBSERVER_FLUSH_RESULT;
  }
}

const DISABLED_HARNESS_COORDINATOR = Object.freeze(new DisabledHarnessCoordinator());

/** Phase 1 exposes only the inert coordinator. */
export function createHarnessCoordinator(mode: HarnessMode): HarnessCoordinator {
  assertHarnessModeAvailable(mode);
  return DISABLED_HARNESS_COORDINATOR;
}
