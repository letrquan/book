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
  | 'objective_complete'
  | 'continuation_limit'
  | 'blocked_plan'
  | 'no_progress'
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
 *   an operator (an expired credential). Distinguished from `none` so a
 *   supervisor can wait rather than declare failure.
 * - `none` — a genuine end: the budget is gone, policy refused, the user
 *   cancelled, the context will not fit.
 *
 * A function rather than a field on the readonly outcome, so no existing producer
 * or consumer of `AgentTerminalOutcome` has to change.
 */
export type TerminalRecovery = 'none' | 'reissue' | 'continue' | 'park';

export function terminalRecovery(outcome: AgentTerminalOutcome): TerminalRecovery {
  switch (outcome.reason) {
    case 'stream_stall':
    case 'provider_timeout':
    case 'transport_interrupted':
    case 'provider_error':
      return 'reissue';
    case 'output_cap':
      return 'continue';
    case 'credentials_rejected':
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
