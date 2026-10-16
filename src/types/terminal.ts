export type AgentTerminalStatus =
  'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';

export type AgentTerminalReason =
  | 'normal_completion'
  | 'blocked_by_policy'
  | 'provider_error'
  | 'provider_timeout'
  | 'stream_stall'
  | 'protocol_error'
  | 'context_overflow'
  | 'budget_exceeded'
  | 'budget_unverifiable'
  | 'max_turns'
  | 'runtime_error'
  | 'caller_cancelled'
  | 'user_cancelled'
  | 'session_disposed'
  | 'session_replaced'
  | 'transport_interrupted'
  | 'output_cap'
  | 'credentials_rejected'
  /**
   * A usage or plan limit is spent, or the provider stated a wait longer than the
   * retry layer can sit out (provider codes `usage_limit` and `rate_limit_wait`).
   * Not a rejected key: nothing needs rotating, the run waits for the reset or an
   * operator picks another model. A 402 and `insufficient_quota` stay
   * `credentials_rejected`.
   */
  | 'quota_exhausted'
  | 'model_unavailable'
  | 'objective_complete'
  | 'continuation_limit'
  | 'blocked_plan'
  | 'no_progress'
  /** The run's `/goal` was judged impossible, or was still unmet at the check cap. */
  | 'goal_unmet'
  /**
   * The run's `/goal` check could not run (provider error, timeout, unreadable
   * answer). The run was let end rather than trapped, but nothing confirmed the goal.
   */
  | 'goal_unverified'
  | 'all_tools_blocked'
  | 'plan_stop'
  | 'handoff_requested'
  | 'missing_terminal';

/**
 * What a host may do about a terminal outcome.
 *
 * - `reissue` — a transport fault: the failure is about the wire, not the work,
 *   so the turn can be sent again against the history already on disk.
 * - `continue` — not a fault at all. The model was cut off mid-answer by the
 *   output cap and should carry on. Kept distinct from `reissue` so a large
 *   generated file cannot drain the budget reserved for real transport faults.
 * - `park` — the run cannot proceed but nothing is wrong with the work; it needs
 *   an operator or time (an expired credential, a model the provider no longer
 *   serves — the operator picks another — or a spent usage limit, which waits
 *   for the reset or another model). Distinguished from `none` so a supervisor
 *   can wait rather than declare failure.
 * - `none` — a genuine end: the budget is gone, policy refused, the user
 *   cancelled, the context will not fit.
 *
 * A function rather than a field on the readonly outcome, so no existing producer
 * or consumer of `AgentTerminalOutcome` has to change.
 */
export type TerminalRecovery = 'none' | 'reissue' | 'continue' | 'park';

/**
 * Provider error codes that a re-sent turn would only reproduce. Each is a
 * verdict on the request itself, or an answer the loop already re-issued once:
 * - `bad_request`, `not_found`, `unprocessable`: a 400, 404 or 422 the provider
 *   or its router pinned on the request.
 * - `invalid_request_error`: Anthropic's mid-stream error type for a malformed
 *   request, the same verdict delivered inside a 200 stream.
 * - `content_filter`, `error_envelope`: an answer that came back the same way
 *   after its one re-issue.
 * - `redirect`: a provider endpoint answered with a redirect Book refuses (#445).
 *
 * `unknown`, every other 4xx, stays re-sendable on purpose. 9router's antigravity
 * route treats a 409 like a 429 with a strike counter: it passes the first two
 * through and, on the third within 60 s, locks that account and switches to the
 * next one, so the third re-send is the one that can succeed. A 423, a 425 and
 * Google's 499 are transient by definition.
 */
export const NON_REISSUABLE_PROVIDER_CODES: ReadonlySet<string> = new Set([
  'bad_request',
  'not_found',
  'unprocessable',
  'invalid_request_error',
  'content_filter',
  'error_envelope',
  'redirect',
]);

export function terminalRecovery(outcome: AgentTerminalOutcome): TerminalRecovery {
  // `providerCode` is what the loop copied from the stream's error code, so only
  // the loop's provider outcomes carry it.
  if (
    outcome.reason === 'provider_error' &&
    outcome.providerCode !== undefined &&
    NON_REISSUABLE_PROVIDER_CODES.has(outcome.providerCode)
  ) {
    return 'none';
  }

  switch (outcome.reason) {
    case 'stream_stall':
    case 'provider_timeout':
    case 'transport_interrupted':
    case 'provider_error':
      return 'reissue';
    case 'output_cap':
      return 'continue';
    case 'credentials_rejected':
    case 'quota_exhausted':
    case 'model_unavailable':
      // A retired or unknown model is not a fault in the work either: re-sending
      // reproduces it, and only an operator choosing another model unblocks it.
      // A spent limit is the same: the reset or another model is the remedy, and
      // each re-send is one more refused request.
      return 'park';
    default:
      // Everything else — budget_exceeded, blocked_by_policy, user_cancelled,
      // max_turns, context_overflow, protocol_error — is a real end. Re-sending
      // would reproduce it, and for the budget it would also spend past the cap.
      return 'none';
  }
}

export interface AgentTerminalOutcome {
  readonly status: AgentTerminalStatus;
  readonly reason: AgentTerminalReason;
  readonly message?: string;
  readonly partialOutput: boolean;
  readonly providerCode?: string;
}

export function isTerminalStatus(status: string): status is AgentTerminalStatus {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'timed_out' ||
    status === 'interrupted'
  );
}

export function createTerminalOutcome(
  status: AgentTerminalStatus,
  reason: AgentTerminalReason,
  options: Omit<AgentTerminalOutcome, 'status' | 'reason'> = { partialOutput: false },
): AgentTerminalOutcome {
  return { status, reason, ...options };
}

export function classifyAbortReason(reason: unknown, partialOutput: boolean): AgentTerminalOutcome {
  if (reason && typeof reason === 'object' && 'bookTerminalReason' in reason) {
    const value = (reason as { bookTerminalReason?: unknown }).bookTerminalReason;
    if (value === 'session_disposed' || value === 'session_replaced') {
      return createTerminalOutcome('interrupted', value, { partialOutput });
    }
    if (value === 'user_cancelled') {
      return createTerminalOutcome('cancelled', value, { partialOutput });
    }
    if (value === 'caller_cancelled') {
      return createTerminalOutcome('cancelled', value, { partialOutput });
    }
  }

  if (reason instanceof DOMException && reason.name === 'TimeoutError') {
    return createTerminalOutcome('timed_out', 'provider_timeout', {
      partialOutput,
      message: reason.message || 'Agent execution timed out.',
    });
  }

  return createTerminalOutcome('cancelled', 'caller_cancelled', { partialOutput });
}

export function classifyRuntimeError(error: unknown, partialOutput: boolean): AgentTerminalOutcome {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return createTerminalOutcome('timed_out', 'provider_timeout', {
      partialOutput,
      message: error.message || 'Agent execution timed out.',
    });
  }
  return createTerminalOutcome('failed', 'runtime_error', {
    partialOutput,
    message: error instanceof Error ? error.message : String(error),
  });
}
