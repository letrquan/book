import { createHash } from 'node:crypto';
import type {
  BoundedHarnessText,
  HarnessEvent,
  HarnessEventAttribute,
  HarnessEventType,
  HarnessPayloadClass,
  HarnessSourceClass,
  HarnessRunIdentity,
} from './contracts.js';
import { looksLikeSecretOrUnfit } from '../secret-detect.js';

/** Versioned independently so old evidence remains interpretable. */
export const REDACTION_POLICY_VERSION = 'allowlist-v1';
export const MAX_RECORD_BYTES = 64 * 1024;
export const MAX_TEXT_LENGTH = 1024;
export const MAX_ATTRIBUTES = 64;
export const MAX_REFERENCES = 32;

/** Canonical event names accepted by the persistence boundary. */
export const CANONICAL_HARNESS_EVENT_TYPES: readonly HarnessEventType[] = [
  'run_started',
  'turn_started',
  'model_usage',
  'provider_requested',
  'provider_retry',
  'provider_stream_stall',
  'tool_started',
  'tool_finished',
  'permission_resolved',
  'assistant_message_completed',
  'run_interrupted',
  'run_failed',
  'run_completed',
  'prompt_layer_rendered',
  'skill_activation_requested',
  'skill_activation_applied',
  'skill_activation_expired',
  'tool_discovery_requested',
  'tool_discovery_applied',
  'context_contribution_recorded',
  'verification_requested',
  'verification_completed',
  'subagent_handoff_created',
  'capability_clamped',
  'error',
];

const CANONICAL_EVENT_TYPE_SET = new Set<string>(CANONICAL_HARNESS_EVENT_TYPES);

/**
 * These are derived scalar facts, not payload-bearing fields.  Keep this set
 * intentionally explicit: a generic "safe-looking" key would turn the
 * redaction boundary into an accidental raw-data logger.
 */
const SAFE_ATTRIBUTE_KEYS = new Set([
  'turn',
  'provider',
  'requestedModel',
  'responseModel',
  'responseId',
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'contextTokens',
  'toolName',
  'toolCallId',
  'status',
  'durationMs',
  'retryAttempt',
  'phase',
  'attempt',
  'max',
  'delayMs',
  'countdownMs',
  'decision',
  'category',
  'role',
  'messageId',
  'hasToolCalls',
  'hasToolResults',
  'agentId',
  'agentName',
  'childRunId',
  'rootRunId',
  'parentRunId',
  'child',
  'workflowId',
  'workflowVersion',
  'reasonCode',
  'verifier',
  'sourceClass',
  'safeLabel',
  'safeCount',
  'runtimeFingerprint',
  'environmentFingerprint',
  'toolSurfaceFingerprint',
  'contextCapabilitiesVersion',
  'capabilityManifestDigest',
  'workspaceTrustFingerprint',
  'integrationFingerprint',
  'settingsFingerprint',
]);

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const QUERY_STRING = /[?&][A-Za-z0-9_%-]+=|^[^\s?&=]+=[^\s]+$/;
const PATH_LIKE =
  /(?:^|[\s("'=])(?:[A-Za-z]:[\\/]|\\\\|\/(?:[A-Za-z0-9_.-]+[\\/]|etc\b|tmp\b|var\b|home\b)|~[\\/])/;
const COMMAND_LIKE =
  /(?:^|\s)(?:bash|sh|zsh|powershell|pwsh|cmd|curl|wget|git|npm|pnpm|yarn|node|python|rm|cat|chmod|mkdir)\s+/i;

const LEGACY_EVENT_ALIASES: Readonly<Record<string, HarnessEventType>> = {
  'run-started': 'run_started',
  'provider-requested': 'provider_requested',
  'assistant-message-completed': 'assistant_message_completed',
  'tool-started': 'tool_started',
  'tool-completed': 'tool_finished',
  'verification-completed': 'verification_completed',
  'run-completed': 'run_completed',
};

/** Return a stable reason when text is not safe for the bounded ingress. */
export function harnessTextRejectionReason(value: string): string | undefined {
  const normalized = value.normalize('NFC').trim();
  if (!normalized) return 'empty';
  if (normalized.length > MAX_TEXT_LENGTH) return 'too-long';
  if (CONTROL_CHARS.test(normalized)) return 'control-characters';
  if (looksLikeSecretOrUnfit(normalized)) return 'secret-or-unfit';
  if (normalized.includes('://')) return 'url';
  if (QUERY_STRING.test(normalized)) return 'query-string';
  if (PATH_LIKE.test(normalized)) return 'path';
  if (COMMAND_LIKE.test(normalized)) return 'command';
  return undefined;
}

export interface ProtectedReference {
  readonly kind: 'protected-reference';
  readonly digest: string;
  readonly byteLength?: number;
  readonly sourceClass: HarnessSourceClass;
  readonly accessClass: 'session' | 'tool' | 'evaluator' | 'unknown';
}

export interface RedactedEventData {
  readonly summary?: string;
  readonly attributes?: Readonly<Record<string, HarnessEventAttribute>>;
  readonly evidenceRefs?: readonly string[];
  readonly omittedFields?: readonly string[];
}

export interface RedactedHarnessEvent {
  readonly eventType: HarnessEventType;
  readonly occurredAt: number;
  readonly runId?: string;
  readonly parentRunId?: string;
  readonly sessionId?: string;
  readonly sourceClass?: HarnessSourceClass;
  readonly payloadClass: HarnessPayloadClass;
  readonly data: RedactedEventData;
  readonly traceId?: string;
  readonly spanId?: string;
  readonly parentSpanId?: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Domain-separated digest suitable for equality correlation, not disclosure. */
export function protectedDigest(value: string, domain = 'book-harness-ref-v1'): string {
  return digest(`${domain}\0${value}`);
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFC').trim();
  if (harnessTextRejectionReason(normalized)) return undefined;
  return normalized;
}

function safeAttributeKey(key: string): boolean {
  return SAFE_ATTRIBUTE_KEYS.has(key);
}

function safeAttributeValue(value: unknown): HarnessEventAttribute | undefined {
  if (typeof value === 'boolean' || value === null) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const text = boundedString(value);
  return text as BoundedHarnessText;
}

function normalizeEventType(type: HarnessEvent['type']): HarnessEventType {
  const normalized = LEGACY_EVENT_ALIASES[type] ?? type;
  if (!CANONICAL_EVENT_TYPE_SET.has(normalized)) throw new Error('unknown-harness-event-type');
  return normalized as HarnessEventType;
}

function safeReference(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFC').trim();
  // References are opaque IDs, never paths or free-form text.  The colon is
  // reserved for a short namespace (for example `session-record:42`).
  if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}:[A-Za-z0-9_.~-]{1,191}$/.test(normalized)) {
    return undefined;
  }
  if (harnessTextRejectionReason(normalized)) return undefined;
  return normalized;
}

export function safeHarnessIdentityValue(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) return undefined;
  if (!/^[A-Za-z0-9._~:-]+$/.test(value)) return undefined;
  if (harnessTextRejectionReason(value)) return undefined;
  return value;
}

/**
 * Minimize an ingress event before it enters a queue or is used to compute a hash.
 * Unknown object payloads are intentionally discarded; callers must provide typed facts.
 */
export function redactHarnessEvent(event: HarnessEvent): RedactedHarnessEvent {
  const eventType = normalizeEventType(event.eventType ?? event.type);
  const sourceClass = event.sourceClass;
  const attributes: Record<string, HarnessEventAttribute> = {};
  const omitted: string[] = [];
  for (const [key, value] of Object.entries(event.attributes ?? {})) {
    if (Object.keys(attributes).length >= MAX_ATTRIBUTES) {
      omitted.push(key);
      continue;
    }
    if (!safeAttributeKey(key)) {
      omitted.push(key);
      continue;
    }
    const safe = safeAttributeValue(value);
    if (safe === undefined) {
      omitted.push(key);
      continue;
    }
    attributes[key] = safe;
  }
  const summary = boundedString(event.summary);
  if (event.summary !== undefined && summary === undefined) omitted.push('summary');
  const refs = (event.evidenceRefs ?? [])
    .slice(0, MAX_REFERENCES)
    .map((ref) => safeReference(ref))
    .filter((ref): ref is string => Boolean(ref));
  if ((event.evidenceRefs?.length ?? 0) > refs.length) omitted.push('evidenceRefs');
  const data: RedactedEventData = {
    ...(summary ? { summary } : {}),
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    ...(refs.length > 0 ? { evidenceRefs: refs } : {}),
    ...(omitted.length > 0 ? { omittedFields: [...new Set(omitted)].sort() } : {}),
  };
  return {
    eventType,
    occurredAt:
      Number.isSafeInteger(event.occurredAt) && event.occurredAt >= 0
        ? event.occurredAt
        : Date.now(),
    ...(safeHarnessIdentityValue(event.runId)
      ? { runId: safeHarnessIdentityValue(event.runId) }
      : {}),
    ...(safeHarnessIdentityValue(event.parentRunId)
      ? { parentRunId: safeHarnessIdentityValue(event.parentRunId) }
      : {}),
    ...(safeHarnessIdentityValue(event.sessionId)
      ? { sessionId: safeHarnessIdentityValue(event.sessionId) }
      : {}),
    ...(sourceClass &&
    ['user', 'system', 'repository', 'tool', 'web', 'derived'].includes(sourceClass)
      ? { sourceClass }
      : {}),
    payloadClass:
      event.payloadClass === 'safe-metadata' ||
      event.payloadClass === 'derived-summary' ||
      event.payloadClass === 'protected-reference'
        ? event.payloadClass
        : 'safe-metadata',
    data,
    ...(validTraceId(event.traceId) ? { traceId: event.traceId } : {}),
    ...(validSpanId(event.spanId) ? { spanId: event.spanId } : {}),
    ...(validSpanId(event.parentSpanId) ? { parentSpanId: event.parentSpanId } : {}),
  };
}

export function validTraceId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{32}$/.test(value) && !/^0+$/.test(value);
}

export function validSpanId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value) && !/^0+$/.test(value);
}

/** Build a privacy-safe protected reference without retaining the referenced bytes. */
export function makeProtectedReference(
  value: string,
  sourceClass: HarnessSourceClass,
  accessClass: ProtectedReference['accessClass'] = 'unknown',
): ProtectedReference {
  return {
    kind: 'protected-reference',
    digest: protectedDigest(value),
    byteLength: Buffer.byteLength(value, 'utf8'),
    sourceClass,
    accessClass,
  };
}

/** Stable identity projection used by the ledger header. */
export function redactIdentity(identity: HarnessRunIdentity): Record<string, string> {
  return Object.fromEntries(
    Object.entries(identity).filter((entry): entry is [string, string] =>
      Boolean(safeHarnessIdentityValue(entry[1])),
    ),
  );
}
