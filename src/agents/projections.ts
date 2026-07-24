import type { AgentCompletion, AgentRecord, AgentSummary } from './types.js';

const SUMMARY_PREVIEW_CHARS = 2000;
const COMPLETION_PREVIEW_CHARS = 50 * 1024;

function preview(
  value: string | undefined,
  limit: number,
): {
  value?: string;
  characters: number;
  truncated: boolean;
} {
  const characters = value?.length ?? 0;
  if (value === undefined || characters <= limit) {
    return { value, characters, truncated: false };
  }
  return {
    value: `${value.slice(0, limit - 3).trimEnd()}...`,
    characters,
    truncated: true,
  };
}

export function projectAgentSummary(record: AgentRecord): AgentSummary {
  const terminal = ['completed', 'failed', 'stopped', 'interrupted'].includes(record.status);
  const summary = preview(record.result, SUMMARY_PREVIEW_CHARS);
  const error = preview(record.error, SUMMARY_PREVIEW_CHARS);
  return {
    agentId: record.id,
    displayName: record.displayName ?? record.name,
    profile: record.profile ?? record.name,
    status: record.status,
    resolvedModel: record.resolvedModel ?? 'unknown',
    isolation: record.isolation ?? 'worktree',
    currentActivity: record.currentActivity,
    summary: summary.value,
    summaryCharacters: summary.characters,
    summaryTruncated: summary.truncated,
    error: error.value,
    errorCharacters: error.characters,
    errorTruncated: error.truncated,
    usage: record.runUsage ?? record.usage,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    finishedAt: terminal ? (record.finishedAt ?? record.updatedAt) : record.finishedAt,
  };
}

export function projectAgentCompletion(record: AgentRecord): AgentCompletion {
  const summary = preview(record.result, COMPLETION_PREVIEW_CHARS);
  const error = preview(record.error, COMPLETION_PREVIEW_CHARS);
  return {
    ...projectAgentSummary(record),
    summary: summary.value,
    summaryCharacters: summary.characters,
    summaryTruncated: summary.truncated,
    error: error.value,
    errorCharacters: error.characters,
    errorTruncated: error.truncated,
    evidenceIds: record.producedEvidenceIds ?? [],
    applicationStatus: record.applicationStatus,
  };
}

export function projectAgentResult(record: AgentRecord): AgentSummary | AgentCompletion {
  return ['completed', 'failed', 'stopped', 'interrupted'].includes(record.status)
    ? projectAgentCompletion(record)
    : projectAgentSummary(record);
}
