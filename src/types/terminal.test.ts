import { describe, it, expect } from 'vitest';
import { createTerminalOutcome, terminalRecovery, type AgentTerminalReason } from './terminal.js';

function recoveryFor(reason: AgentTerminalReason) {
  return terminalRecovery(createTerminalOutcome('failed', reason, { partialOutput: false }));
}

describe('terminalRecovery', () => {
  it('re-issues transport faults, which say nothing about the work', () => {
    for (const reason of [
      'stream_stall',
      'provider_timeout',
      'transport_interrupted',
      'provider_error',
    ] as const) {
      expect(recoveryFor(reason), reason).toBe('reissue');
    }
  });

  it('separates an output cap from a transport fault', () => {
    // Not a fault at all — the model was cut off mid-answer and should carry on.
    // Kept distinct so a large generated file, which hits the cap turn after turn,
    // cannot drain the allowance a real socket drop needs.
    expect(recoveryFor('output_cap')).toBe('continue');
  });

  it('parks on a rejected credential instead of calling it a failure', () => {
    // Retrying a rejected key is pointless, but non-retryable must not mean
    // run-ending: a supervisor should be able to wait for an operator.
    expect(recoveryFor('credentials_rejected')).toBe('park');
  });

  it('never re-issues a genuine end', () => {
    // Re-sending these either reproduces the same result or, for the budget,
    // spends past the cap that exists to stop it.
    for (const reason of [
      'budget_exceeded',
      'budget_unverifiable',
      'blocked_by_policy',
      'user_cancelled',
      'caller_cancelled',
      'max_turns',
      'context_overflow',
      'protocol_error',
      'normal_completion',
      'session_disposed',
      'session_replaced',
      'runtime_error',
      'missing_terminal',
    ] as const) {
      expect(recoveryFor(reason), reason).toBe('none');
    }
  });
});
