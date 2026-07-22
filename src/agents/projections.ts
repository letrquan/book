import type { AgentCompletion, AgentRecord, AgentSummary } from './types.js';

const COMPLETION_PREVIEW_CHARS = 2000;

function completionPreview(value: string | undefined): string | undefined {
  if (!value || value.length <= COMPLETION_PREVIEW_CHARS) return value;
  return `${value.slice(0, COMPLETION_PREVIEW_CHARS - 3).trimEnd()}...`;
}

export function projectAgentSummary(record: AgentRecord): AgentSummary {
  const terminal = ['completed', 'failed', 'stopped', 'interrupted'].includes(record.status);
  return {
    agentId: record.id,
    displayName: record.displayName ?? record.name,
    profile: record.profile ?? record.name,
    status: record.status,
    resolvedModel: record.resolvedModel ?? 'unknown',
    isolation: record.isolation ?? 'worktree',
    currentActivity: record.currentActivity,
    summary: record.result,
    error: record.error,
    usage: record.usage,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    finishedAt: terminal ? (record.finishedAt ?? record.updatedAt) : record.finishedAt,
  };
}

export function projectAgentCompletion(record: AgentRecord): AgentCompletion {
  return {
    ...projectAgentSummary(record),
    summary: completionPreview(record.result),
    error: completionPreview(record.error),
    evidenceIds: record.producedEvidenceIds ?? [],
    applicationStatus: record.applicationStatus,
  };
}

export function projectAgentResult(record: AgentRecord): AgentSummary | AgentCompletion {
  return ['completed', 'failed', 'stopped', 'interrupted'].includes(record.status)
    ? projectAgentCompletion(record)
    : projectAgentSummary(record);
}
