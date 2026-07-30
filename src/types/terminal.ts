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
  | 'missing_terminal';

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
