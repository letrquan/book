import type { HarnessEventEnvelope, HarnessEventType } from './contracts.js';

export const OTEL_SEMANTIC_CONVENTIONS_VERSION = '1.44.0';

export type HarnessTelemetryKind = 'span' | 'event' | 'metric';

export interface HarnessTelemetryRecord {
  readonly kind: HarnessTelemetryKind;
  readonly name: string;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
  readonly timestamp: number;
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
  readonly status?: 'ok' | 'error' | 'unset';
}

const EVENT_MAPPING: Record<HarnessEventType, { kind: HarnessTelemetryKind; name: string }> = {
  run_started: { kind: 'span', name: 'book.agent.run' },
  turn_started: { kind: 'span', name: 'book.agent.turn' },
  model_usage: { kind: 'metric', name: 'gen_ai.client.token.usage' },
  provider_requested: { kind: 'span', name: 'gen_ai.chat' },
  provider_retry: { kind: 'event', name: 'book.provider.retry' },
  provider_stream_stall: { kind: 'event', name: 'book.provider.stream_stall' },
  tool_started: { kind: 'span', name: 'book.tool' },
  tool_finished: { kind: 'event', name: 'book.tool.finished' },
  permission_resolved: { kind: 'event', name: 'book.permission.resolved' },
  assistant_message_completed: { kind: 'event', name: 'book.assistant.completed' },
  run_interrupted: { kind: 'event', name: 'book.agent.interrupted' },
  run_failed: { kind: 'event', name: 'book.agent.failed' },
  run_completed: { kind: 'event', name: 'book.agent.completed' },
  prompt_layer_rendered: { kind: 'event', name: 'book.prompt.layer' },
  skill_activation_requested: { kind: 'event', name: 'book.skill.requested' },
  skill_activation_applied: { kind: 'event', name: 'book.skill.applied' },
  skill_activation_expired: { kind: 'event', name: 'book.skill.expired' },
  tool_discovery_requested: { kind: 'event', name: 'book.tool.discovery.requested' },
  tool_discovery_applied: { kind: 'event', name: 'book.tool.discovery.applied' },
  context_contribution_recorded: { kind: 'event', name: 'book.context.contribution' },
  verification_requested: { kind: 'event', name: 'book.verification.requested' },
  verification_completed: { kind: 'event', name: 'book.verification.completed' },
  subagent_handoff_created: { kind: 'span', name: 'book.agent.handoff' },
  capability_clamped: { kind: 'event', name: 'book.capability.clamped' },
  error: { kind: 'event', name: 'book.agent.error' },
};

const TOKEN_METRIC_ATTRIBUTES: Readonly<Record<string, string>> = {
  inputTokens: 'gen_ai.usage.input_tokens',
  outputTokens: 'gen_ai.usage.output_tokens',
  totalTokens: 'book.usage.total_tokens',
  contextTokens: 'book.usage.context_tokens',
};

function boundedAttributes(data: unknown): Readonly<Record<string, string | number | boolean>> {
  if (!data || typeof data !== 'object') return {};
  const source = data as Record<string, unknown>;
  const result: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(source)) {
    const metricKey = TOKEN_METRIC_ATTRIBUTES[key];
    if (metricKey) {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
        result[metricKey] = value;
      }
      continue;
    }
    if (
      Object.keys(result).length >= 32 ||
      /prompt|content|output|secret|token|path|command/i.test(key)
    ) {
      continue;
    }
    if (typeof value === 'string' && value.length <= 128 && !/[\r\n]/.test(value))
      result[`book.${key}`] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) result[`book.${key}`] = value;
    else if (typeof value === 'boolean') result[`book.${key}`] = value;
  }
  return result;
}

/** Convert a local envelope to an exporter-independent OTel-shaped record. */
export function mapHarnessEventToTelemetry(envelope: HarnessEventEnvelope): HarnessTelemetryRecord {
  const mapping = EVENT_MAPPING[envelope.eventType] ?? { kind: 'event', name: 'book.agent.event' };
  const attributes: Record<string, string | number | boolean> = {
    'book.schema_version': envelope.schemaVersion,
    'book.writer_version': envelope.writerVersion,
    'book.workspace_id': envelope.workspaceId,
    'book.root_run_id': envelope.rootRunId,
    'book.run_id': envelope.runId,
    'book.event_type': envelope.eventType,
    'book.payload_class': envelope.payloadClass,
    'book.redaction_policy': envelope.redactionPolicyVersion,
    'otel.semconv.version': OTEL_SEMANTIC_CONVENTIONS_VERSION,
  };
  Object.assign(attributes, boundedAttributes(envelope.data));
  const status =
    envelope.eventType === 'run_failed' || envelope.eventType === 'error'
      ? 'error'
      : envelope.eventType === 'run_completed'
        ? 'ok'
        : 'unset';
  return {
    kind: mapping.kind,
    name: mapping.name,
    traceId: envelope.traceId,
    spanId: envelope.spanId,
    parentSpanId: envelope.parentSpanId,
    timestamp: envelope.observedAt,
    attributes,
    status,
  };
}

export function telemetryMappingFor(type: HarnessEventType): string {
  return EVENT_MAPPING[type]?.name ?? 'book.agent.event';
}
