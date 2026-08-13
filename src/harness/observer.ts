import type { AgentLoopCallbacks, ProviderResponseMetadata } from '../types/providers.js';
import type { AgentRuntimeEvent } from '../agents/types.js';
import type { Message, Usage } from '../types/messages.js';
import type { ToolResult } from '../types/tools.js';
import type {
  FinalizeRunInput,
  HarnessEvent,
  HarnessObserver,
  HarnessObserverEnqueueResult,
  HarnessSourceClass,
} from './contracts.js';
import type { RunLedgerWriter } from './run-store.js';

export interface HarnessCallbackObserverOptions {
  readonly observer: HarnessObserver;
  readonly runId: string;
  readonly sourceClass?: HarnessSourceClass;
  readonly now?: () => number;
}

function event(
  type: HarnessEvent['type'],
  options: HarnessCallbackObserverOptions,
  attributes?: Record<string, string | number | boolean | null>,
  summary?: string,
): HarnessEvent {
  return {
    type,
    eventType: type,
    runId: options.runId,
    occurredAt: options.now?.() ?? Date.now(),
    sourceClass: options.sourceClass ?? 'derived',
    payloadClass: 'safe-metadata',
    ...(summary ? { summary: summary as never } : {}),
    ...(attributes ? { attributes: attributes as never } : {}),
  };
}

function observe(observer: HarnessObserver, value: HarnessEvent): HarnessObserverEnqueueResult {
  try {
    return observer.enqueue(value);
  } catch {
    // Observer implementations must be non-throwing at runtime boundaries. Keep this
    // defensive guard so a faulty adapter cannot alter the agent result.
    return 'dropped';
  }
}

function safeProviderAttributes(metadata?: ProviderResponseMetadata): Record<string, string> {
  if (!metadata) return {};
  const result: Record<string, string> = {};
  if (metadata.provider.length <= 128) result.provider = metadata.provider;
  if (metadata.requestedModel.length <= 128) result.requestedModel = metadata.requestedModel;
  if (metadata.responseModel && metadata.responseModel.length <= 128)
    result.responseModel = metadata.responseModel;
  return result;
}

function wrapUsage(
  usage: Usage,
  metadata?: ProviderResponseMetadata,
): Record<string, number | string> {
  return {
    ...safeProviderAttributes(metadata),
    inputTokens: usage.promptTokens,
    outputTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
  };
}

/** Managed-agent child linkage is safe scalar identity, never child content. */
function wrapAgentHandoff(
  event: Extract<AgentRuntimeEvent, { type: 'agent_start' }>,
): Record<string, string | boolean> {
  const record = event.agent;
  return {
    agentId: record.id.slice(0, 128),
    agentName: record.name.slice(0, 128),
    ...(record.runId ? { childRunId: record.runId.slice(0, 128) } : {}),
    ...(record.rootRunId ? { rootRunId: record.rootRunId.slice(0, 128) } : {}),
    ...(record.parentRunId ? { parentRunId: record.parentRunId.slice(0, 128) } : {}),
    child: true,
  };
}

function wrapToolResult(result: ToolResult): Record<string, string | number | boolean> {
  return {
    toolCallId: result.toolCallId.slice(0, 128),
    status: result.status,
    ...(result.metrics?.durationMs !== undefined ? { durationMs: result.metrics.durationMs } : {}),
    ...(result.metrics?.retryAttempt !== undefined
      ? { retryAttempt: result.metrics.retryAttempt }
      : {}),
  };
}

/**
 * Wrap callbacks without changing the runtime contract. Original callbacks run first;
 * observer failures are contained and represented by the observer's counters.
 */
export function wrapAgentLoopCallbacks(
  callbacks: AgentLoopCallbacks,
  options: HarnessCallbackObserverOptions,
): AgentLoopCallbacks {
  // Attribute construction runs inside the containment guard: a malformed
  // runtime value may cost one event, never the run.
  const emit = (
    type: HarnessEvent['type'],
    attributes?: () => Record<string, string | number | boolean | null>,
    summary?: string,
  ) => {
    try {
      return observe(options.observer, event(type, options, attributes?.(), summary));
    } catch {
      return 'dropped' as const;
    }
  };
  return {
    ...callbacks,
    onTurnStart: (turn) => {
      callbacks.onTurnStart(turn);
      emit('turn_started', () => ({ turn }));
    },
    onUsage: (usage, metadata) => {
      callbacks.onUsage?.(usage, metadata);
      emit('model_usage', () => wrapUsage(usage, metadata));
    },
    onToolCall: (call) => {
      callbacks.onToolCall(call);
    },
    onToolResult: (result) => {
      callbacks.onToolResult(result);
      emit('tool_finished', () => wrapToolResult(result));
    },
    onPermissionRequired: async (call) => {
      return callbacks.onPermissionRequired(call);
    },
    onError: (error) => {
      callbacks.onError(error);
      emit('error', () => ({ category: 'runtime' }));
    },
    onRetry: (phase, attempt, max, delayMs) => {
      callbacks.onRetry?.(phase, attempt, max, delayMs);
      emit('provider_retry', () => ({ phase, attempt, max, delayMs }));
    },
    onStreamStall: (countdownMs) => {
      callbacks.onStreamStall?.(countdownMs);
      emit('provider_stream_stall', () => ({ countdownMs }));
    },
    onAssistantMessageComplete: (message: Message) => {
      callbacks.onAssistantMessageComplete?.(message);
      emit('assistant_message_completed', () => ({
        messageId: message.id.slice(0, 128),
        role: message.role,
        hasToolCalls: Boolean(message.toolCalls?.length),
        hasToolResults: Boolean(message.toolResults?.length),
      }));
    },
    onAgentEvent: (agentEvent) => {
      callbacks.onAgentEvent?.(agentEvent);
      if (agentEvent.type === 'agent_start') {
        emit('subagent_handoff_created', () => wrapAgentHandoff(agentEvent));
      }
    },
    // Terminal evidence is sealed by the shared session lifecycle after the
    // runtime outcome is known. Emitting it here would create two terminal
    // records (one callback event and one sealed terminal).
    onTerminal: (outcome) => callbacks.onTerminal?.(outcome),
    onDone: () => {
      callbacks.onDone?.();
    },
  };
}

/** Minimal adapter for tests and hosts that already own a writer. */
export function createWriterObserver(
  writer: RunLedgerWriter,
  options: {
    finalize?: (
      result: import('./contracts.js').FinalizeRunInput,
    ) => Promise<import('./contracts.js').HarnessObserverFlushResult>;
  } = {},
): HarnessObserver {
  return {
    policy: writer.policy,
    enqueue: (value) => writer.enqueue(value),
    flush: () => writer.flush(),
    close: () => writer.close(),
    ...(options.finalize
      ? { finalize: options.finalize }
      : { finalize: (result: FinalizeRunInput) => writer.finalize(result) }),
  };
}
