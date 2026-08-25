import type { AgentNotificationDisplay } from '../types/messages.js';
import type { AgentCompletionNotification } from './types.js';

export const AGENT_COMPLETION_BATCH_CHARS = 64 * 1024;

/**
 * Open a new terminal-result generation for `record`.
 *
 * An agent whose host owns its output (`notifyParentOnCompletion: false`) has
 * that generation marked delivered in the same step. Delivery is what
 * `listPendingCompletions` and the parent host's replay are keyed on, so
 * leaving it outstanding would resurface the agent as an undelivered completion
 * — the exact model turn the flag exists to avoid — and pin it in the session's
 * agent list forever.
 *
 * Shared rather than inlined at each call site because a terminal generation is
 * opened from three places with different lifetimes — a normal result, this
 * process exiting, and another process's abandoned agents being recovered at
 * startup — and a crash mid-`/review` reaches the third one.
 */
export function beginTerminalGeneration(record: {
  completionSequence?: number;
  completionDeliveredSequence?: number;
  notifyParentOnCompletion?: boolean;
}): void {
  record.completionSequence = (record.completionSequence ?? 0) + 1;
  if (record.notifyParentOnCompletion === false) {
    record.completionDeliveredSequence = record.completionSequence;
  }
}

function firstLine(value: string | undefined, fallback: string): string {
  const line = value?.split(/\r?\n/, 1)[0]?.trim();
  if (!line) return fallback;
  return line.length > 120 ? `${line.slice(0, 117).trimEnd()}...` : line;
}

export function buildAgentCompletionMessage(notification: AgentCompletionNotification): {
  displayMessage: string;
  contextMessage: string;
  display: AgentNotificationDisplay;
} {
  const { completion } = notification;
  const durationMs = completion.finishedAt
    ? Math.max(0, completion.finishedAt - (completion.startedAt ?? completion.createdAt))
    : undefined;
  const display: AgentNotificationDisplay = {
    deliveryId: notification.deliveryId,
    sequence: notification.sequence,
    agentId: completion.agentId,
    displayName: completion.displayName,
    status: completion.status as AgentNotificationDisplay['status'],
    summary: completion.summary,
    error: completion.error,
    evidenceIds: completion.evidenceIds,
    durationMs,
  };
  const detail =
    completion.status === 'completed'
      ? firstLine(completion.summary, 'Completed')
      : completion.status === 'failed'
        ? firstLine(completion.error, 'Failed')
        : completion.status === 'stopped'
          ? 'Stopped'
          : 'Interrupted';
  const payload = {
    delivery_id: notification.deliveryId,
    sequence: notification.sequence,
    agent_id: completion.agentId,
    display_name: completion.displayName,
    profile: completion.profile,
    status: completion.status,
    summary: completion.summary,
    summary_characters: completion.summaryCharacters,
    summary_truncated: completion.summaryTruncated,
    error: completion.error,
    error_characters: completion.errorCharacters,
    error_truncated: completion.errorTruncated,
    evidence_ids: completion.evidenceIds,
    application_status: completion.applicationStatus,
    durability_warning: completion.durabilityWarning,
    duration_ms: durationMs,
  };

  return {
    displayMessage: `${completion.displayName} ${completion.status}: ${detail}`,
    contextMessage: `<subagent_notification>\n${JSON.stringify(payload)}\n</subagent_notification>`,
    display,
  };
}

export function takeAgentCompletionBatch(
  notifications: AgentCompletionNotification[],
  maxCharacters = AGENT_COMPLETION_BATCH_CHARS,
): AgentCompletionNotification[] {
  const batch: AgentCompletionNotification[] = [];
  let characters = 0;
  for (const notification of notifications) {
    const size = buildAgentCompletionMessage(notification).contextMessage.length;
    if (batch.length > 0 && characters + size > maxCharacters) break;
    batch.push(notification);
    characters += size;
  }
  return batch;
}
