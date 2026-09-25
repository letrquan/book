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

  it('treats deterministic 4xx provider errors as non-recoverable', () => {
    // A 4xx pinned on the request itself cannot succeed on re-issue, while
    // server errors or unspecified provider errors are retried.
    expect(
      terminalRecovery(
        createTerminalOutcome('failed', 'provider_error', {
          partialOutput: false,
          providerCode: 'bad_request',
        }),
      ),
    ).toBe('none');
    expect(
      terminalRecovery(
        createTerminalOutcome('failed', 'provider_error', {
          partialOutput: false,
          providerCode: 'not_found',
        }),
      ),
    ).toBe('none');
    expect(
      terminalRecovery(
        createTerminalOutcome('failed', 'provider_error', {
          partialOutput: false,
          providerCode: 'server_error',
        }),
      ),
    ).toBe('reissue');
    expect(
      terminalRecovery(
        createTerminalOutcome('failed', 'provider_error', {
          partialOutput: false,
        }),
      ),
    ).toBe('reissue');
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

  it('ends on a filtered or error-envelope answer that repeated after its one re-issue', () => {
    // The loop already spent the turn's single re-issue on these; a stream-level
    // re-issue would send the same prompt again behind a host-written continuation.
    for (const providerCode of ['content_filter', 'error_envelope']) {
      expect(
        terminalRecovery(
          createTerminalOutcome('failed', 'provider_error', { partialOutput: false, providerCode }),
        ),
      ).toBe('none');
    }
  });

  it('ends on a 400, 404 or 422 verdict or a mid-stream invalid request, and re-sends every other 4xx', () => {
    const recoveryForCode = (providerCode: string) =>
      terminalRecovery(
        createTerminalOutcome('failed', 'provider_error', { partialOutput: false, providerCode }),
      );
    // `unprocessable` is a 422; `invalid_request_error` is Anthropic's mid-stream
    // verdict on the request. `unknown` (a 409, 423, 425 or 499) stays re-sendable:
    // 9router's antigravity route switches accounts on the third 409 within 60 s.
    for (const providerCode of [
      'bad_request',
      'not_found',
      'unprocessable',
      'invalid_request_error',
    ]) {
      expect(recoveryForCode(providerCode), providerCode).toBe('none');
    }
    for (const providerCode of [
      'unknown',
      'server_error',
      'overloaded',
      'rate_limited',
      'timeout',
      'network',
      'overloaded_error',
      'api_error',
      'provider_error',
    ]) {
      expect(recoveryForCode(providerCode), providerCode).toBe('reissue');
    }
  });
});
