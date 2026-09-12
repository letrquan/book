import type { AgentActivity, AgentRecord } from '../agents/types.js';
import type { Message } from '../types/messages.js';
import type { ToolCall, ToolResult } from '../types/tools.js';

export interface ManagedAgentToolUse {
  id: string;
  call: ToolCall;
  result?: ToolResult;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  finishedAt?: number;
}

export interface ManagedAgentTrace {
  agentId: string;
  parentToolCallId: string;
  profile: string;
  purpose: string;
  status: AgentRecord['status'];
  startedAt: number;
  finishedAt?: number;
  toolUses: ManagedAgentToolUse[];
  /**
   * The parent turn is blocked on this child rather than running alongside it —
   * foreground delegation, where the lead has genuinely stopped. Drives the
   * "lead paused" wording; a background spawn leaves this false and the lead
   * keeps working.
   */
  blocking?: boolean;
}

function spawnAgentId(result: ToolResult | undefined): string | undefined {
  if (!result || typeof result.data !== 'object' || result.data === null) return undefined;
  const candidate = (result.data as { agentId?: unknown }).agentId;
  return typeof candidate === 'string' ? candidate : undefined;
}

function activityResult(activity: AgentActivity): ToolResult | undefined {
  return activity.result;
}

function activityCall(activity: AgentActivity): ToolCall | undefined {
  if (activity.kind !== 'tool' || !activity.toolCall) return undefined;
  return activity.toolCall;
}

function activityStatus(activity: AgentActivity): ManagedAgentToolUse['status'] {
  return activity.status === 'failed'
    ? 'failed'
    : activity.status === 'completed'
      ? 'completed'
      : 'running';
}

function resultStatus(result: ToolResult | undefined): ManagedAgentToolUse['status'] | undefined {
  if (!result) return undefined;
  return result.status === 'success' ? 'completed' : 'failed';
}

function projectChildToolUses(
  record: AgentRecord,
  activities: AgentActivity[],
): ManagedAgentToolUse[] {
  const byId = new Map<string, ManagedAgentToolUse>();
  let order = 0;

  const upsert = (use: ManagedAgentToolUse): void => {
    const existing = byId.get(use.id);
    if (!existing) {
      byId.set(use.id, use);
      return;
    }
    byId.set(use.id, {
      ...existing,
      call: use.call,
      result: use.result ?? existing.result,
      status:
        use.status === 'running' && existing.status !== 'running' ? existing.status : use.status,
      startedAt: Math.min(existing.startedAt, use.startedAt),
      finishedAt: use.finishedAt ?? existing.finishedAt,
    });
  };

  for (const activity of activities) {
    const call = activityCall(activity);
    if (!call) continue;
    upsert({
      id: call.id,
      call,
      result: activityResult(activity),
      status: activityStatus(activity),
      startedAt: activity.startedAt || order++,
      finishedAt: activity.finishedAt,
    });
    order++;
  }

  for (const message of record.transcript) {
    for (const call of message.toolCalls ?? []) {
      const result = message.toolResults?.find((candidate) => candidate.toolCallId === call.id);
      const status = resultStatus(result) ?? byId.get(call.id)?.status ?? 'running';
      upsert({
        id: call.id,
        call,
        result,
        status,
        startedAt: byId.get(call.id)?.startedAt ?? message.timestamp + order,
        finishedAt: byId.get(call.id)?.finishedAt ?? (result ? message.timestamp : undefined),
      });
      order++;
    }
  }

  return [...byId.values()].sort((left, right) => left.startedAt - right.startedAt);
}

const EMPTY_TRACES: ReadonlyMap<string, ManagedAgentTrace> = new Map();

/**
 * Build UI-only traces for managed delegation. Parent Message objects are left
 * untouched so child activity never enters provider context or persistence.
 *
 * Two linkages, because the two delegation modes publish the child id at
 * different times. Background (`AgentSpawn`) returns it in the settled tool
 * result. Foreground (`Task`) does not settle until the child is finished, so it
 * stamps `parentToolCallId` on the record at spawn time instead — the only link
 * available during the window the child is actually running.
 */
export function projectManagedAgentTraces(
  messages: Message[],
  records: ReadonlyMap<string, AgentRecord>,
  activities: ReadonlyMap<string, AgentActivity[]>,
): ReadonlyMap<string, ManagedAgentTrace> {
  // Traces require a live agent record; skip the transcript scan entirely (and
  // keep a stable identity) while no managed agents exist.
  if (records.size === 0) return EMPTY_TRACES;
  const byParentToolCall = new Map<string, AgentRecord>();
  for (const record of records.values()) {
    if (record.parentToolCallId) byParentToolCall.set(record.parentToolCallId, record);
  }
  const traces = new Map<string, ManagedAgentTrace>();
  const add = (callId: string, record: AgentRecord, blocking: boolean): void => {
    traces.set(callId, {
      agentId: record.id,
      parentToolCallId: callId,
      profile: record.profile ?? record.name,
      purpose: record.displayName ?? record.purpose ?? record.prompt,
      status: record.status,
      startedAt: record.startedAt ?? record.createdAt,
      finishedAt: record.finishedAt,
      toolUses: projectChildToolUses(record, activities.get(record.id) ?? []),
      blocking,
    });
  };
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      const foreground = byParentToolCall.get(call.id);
      if (foreground) {
        // The parent row is still open exactly while its result is absent, which
        // is the same condition as the lead still being blocked on the child.
        const settled = message.toolResults?.some((candidate) => candidate.toolCallId === call.id);
        add(call.id, foreground, !settled);
        continue;
      }
      if (call.name !== 'AgentSpawn') continue;
      const result = message.toolResults?.find((candidate) => candidate.toolCallId === call.id);
      const agentId = spawnAgentId(result);
      const record = agentId ? records.get(agentId) : undefined;
      if (!agentId || !record) continue;
      add(call.id, record, false);
    }
  }
  return traces;
}
