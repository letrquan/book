import { describe, expect, it } from 'vitest';
import { redactHarnessEvent, protectedDigest, validSpanId, validTraceId } from './redaction.js';
import { createBoundedHarnessText } from './coordinator.js';

describe('harness evidence redaction', () => {
  it('drops prompts, tool payloads, secrets, and forbidden keys before persistence', () => {
    const redacted = redactHarnessEvent({
      type: 'tool_finished',
      occurredAt: 1,
      summary: createBoundedHarnessText('safe summary'),
      attributes: {
        prompt: createBoundedHarnessText('do not persist this'),
        command: 'rm -rf /' as never,
        safeCount: 3,
        safeLabel: createBoundedHarnessText('bounded'),
      },
      evidenceRefs: [createBoundedHarnessText('session-record:42')],
    });
    expect(JSON.stringify(redacted)).not.toContain('do not persist');
    expect(JSON.stringify(redacted)).not.toContain('rm -rf');
    expect(redacted.data.attributes).toEqual({ safeCount: 3, safeLabel: 'bounded' });
    expect(redacted.data.evidenceRefs).toEqual(['session-record:42']);
    expect(redacted.data.omittedFields).toEqual(['command', 'prompt']);
  });

  it('uses a closed attribute allowlist even for safe-looking extension keys', () => {
    const redacted = redactHarnessEvent({
      type: 'verification_completed',
      occurredAt: 1,
      attributes: {
        safeUnregistered: 'bounded' as never,
        componentUnregistered: 1,
        referenceUnregistered: true,
        verifier: 'unit-tests' as never,
      },
    });
    expect(redacted.data.attributes).toEqual({ verifier: 'unit-tests' });
    expect(redacted.data.omittedFields).toEqual([
      'componentUnregistered',
      'referenceUnregistered',
      'safeUnregistered',
    ]);
  });

  it('keeps equality correlation pseudonymous and bounded', () => {
    expect(protectedDigest('same')).toBe(protectedDigest('same'));
    expect(protectedDigest('same')).not.toBe(protectedDigest('different'));
    expect(validTraceId('1'.repeat(32))).toBe(true);
    expect(validTraceId('0'.repeat(32))).toBe(false);
    expect(validSpanId('a'.repeat(16))).toBe(true);
    expect(validSpanId('0'.repeat(16))).toBe(false);
  });

  it('keeps token metrics while rejecting neutral-key payloads and unsafe references', () => {
    const redacted = redactHarnessEvent({
      type: 'model_usage',
      occurredAt: 10,
      summary: 'C:\\private\\prompt.txt' as never,
      attributes: {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        arbitrary: 'secret prompt text' as never,
      },
      evidenceRefs: [
        'session-record:42',
        'file:C:\\private\\prompt.txt',
        'web:https://example.test/?q=secret',
      ] as never,
    });
    expect(redacted.data.attributes).toEqual({ inputTokens: 12, outputTokens: 8, totalTokens: 20 });
    expect(redacted.data.summary).toBeUndefined();
    expect(redacted.data.evidenceRefs).toEqual(['session-record:42']);
    expect(redacted.data.omittedFields).toEqual(
      expect.arrayContaining(['summary', 'evidenceRefs']),
    );
  });

  it('rejects unknown event types instead of persisting unclassified payloads', () => {
    expect(() => redactHarnessEvent({ type: 'made_up_event' as never, occurredAt: 1 })).toThrow(
      'unknown-harness-event-type',
    );
  });
});
