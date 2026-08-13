import { describe, expect, it } from 'vitest';
import { mapHarnessEventToTelemetry, OTEL_SEMANTIC_CONVENTIONS_VERSION } from './telemetry.js';
import type { HarnessEventEnvelope } from './contracts.js';

describe('OpenTelemetry mapping', () => {
  it('preserves trace/span relationships with bounded non-content attributes', () => {
    const envelope = {
      schemaVersion: 1,
      writerVersion: 'test',
      eventId: 'event',
      workspaceId: 'workspace',
      rootRunId: 'root',
      runId: 'run',
      traceId: '1'.repeat(32),
      spanId: '2'.repeat(16),
      parentSpanId: '3'.repeat(16),
      sequence: 1,
      occurredAt: 1,
      observedAt: 2,
      eventType: 'tool_finished',
      payloadClass: 'safe-metadata',
      redactionPolicyVersion: 'allowlist-v1',
      data: { toolName: 'Read', output: 'forbidden', durationMs: 4 },
      previousRecordHash: '0'.repeat(64),
      recordHash: 'a'.repeat(64),
    } satisfies HarnessEventEnvelope;
    const mapped = mapHarnessEventToTelemetry(envelope);
    expect(mapped.traceId).toBe(envelope.traceId);
    expect(mapped.spanId).toBe(envelope.spanId);
    expect(mapped.parentSpanId).toBe(envelope.parentSpanId);
    expect(mapped.attributes['otel.semconv.version']).toBe(OTEL_SEMANTIC_CONVENTIONS_VERSION);
    expect(mapped.attributes).not.toHaveProperty('book.output');
  });

  it('projects safe token counts while excluding token-like text', () => {
    const envelope = {
      schemaVersion: 1,
      writerVersion: 'test',
      eventId: 'event-usage',
      workspaceId: 'workspace',
      rootRunId: 'root',
      runId: 'run',
      sequence: 1,
      occurredAt: 1,
      observedAt: 2,
      eventType: 'model_usage',
      payloadClass: 'safe-metadata',
      redactionPolicyVersion: 'allowlist-v1',
      data: {
        inputTokens: 7,
        outputTokens: 3,
        totalTokens: 10,
        accessToken: 'must-not-export',
      },
      previousRecordHash: '0'.repeat(64),
      recordHash: 'a'.repeat(64),
    } satisfies HarnessEventEnvelope;
    const mapped = mapHarnessEventToTelemetry(envelope);
    expect(mapped.attributes).toMatchObject({
      'gen_ai.usage.input_tokens': 7,
      'gen_ai.usage.output_tokens': 3,
      'book.usage.total_tokens': 10,
    });
    expect(JSON.stringify(mapped.attributes)).not.toContain('must-not-export');
  });
});
