import { existsSync, readFileSync } from 'fs';
import type {
  CheckpointConstraintV2,
  CheckpointEpisodeV2,
  ConversationCheckpointV2,
  FileObservation,
  Message,
} from '../types.js';
import { resolveWorkspacePath } from '../tools/path-utils.js';
import { sha256Text, workspaceIdentity } from '../tools/file-observation.js';

const MAX_SUMMARY_CHARS = 4_000;
const MAX_ITEM_CHARS = 1_000;
const MAX_ITEMS = 50;

export interface CheckpointGrounding {
  messages: readonly Message[];
  fileObservations?: readonly FileObservation[];
  generation: number;
  retainedMessageCount: number;
  estimatedPrefixTokens: number;
  estimatedTailTokens: number;
}

type Candidate = {
  stateAtCheckpoint?: {
    taskSummary?: unknown;
    status?: unknown;
    sourceRefs?: unknown;
  };
  constraints?: unknown;
  files?: unknown;
  episodes?: unknown;
  openThreads?: unknown;
};

function boundedText(value: unknown, max = MAX_ITEM_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!text || text.length > max) return undefined;
  return text;
}

function stringList(value: unknown, max = MAX_ITEMS): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max).flatMap((item) => {
    const text = boundedText(item);
    return text ? [text] : [];
  });
}

function eventRef(message: Message): string {
  return `session://current/event/${message.id}`;
}

function refMessageMap(messages: readonly Message[]): Map<string, Message> {
  return new Map(messages.map((message) => [eventRef(message), message]));
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start)
    throw new Error('Checkpoint response did not contain a JSON object.');
  return JSON.parse(unfenced.slice(start, end + 1));
}

function isStateStatus(
  value: unknown,
): value is ConversationCheckpointV2['stateAtCheckpoint']['status'] {
  return ['in_progress', 'completed', 'blocked', 'paused', 'superseded'].includes(String(value));
}

function normalizeConstraints(
  value: unknown,
  refs: Map<string, Message>,
): CheckpointConstraintV2[] {
  if (!Array.isArray(value)) return [];
  const constraints: CheckpointConstraintV2[] = [];
  for (const item of value.slice(0, MAX_ITEMS)) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const exactText = boundedText(row.exactText);
    const sourceRef = boundedText(row.sourceRef);
    const source = sourceRef ? refs.get(sourceRef) : undefined;
    if (!exactText || !sourceRef || source?.role !== 'user') continue;
    const exactSource = source.contextContent ?? source.content;
    if (!exactSource.includes(exactText)) continue;

    const proposedScope = ['session', 'task', 'path', 'unknown'].includes(String(row.scope))
      ? (row.scope as CheckpointConstraintV2['scope'])
      : 'unknown';
    const pathPatterns = stringList(row.pathPatterns, 20);
    // Session-wide scope is never inferred from model output alone. Path scope
    // requires at least one Book-observed path pattern.
    const scope =
      proposedScope === 'session'
        ? 'unknown'
        : proposedScope === 'path' && pathPatterns.length === 0
          ? 'unknown'
          : proposedScope;
    constraints.push({
      exactText,
      scope,
      status: row.status === 'superseded' ? 'superseded' : 'active',
      ...(pathPatterns.length ? { pathPatterns } : {}),
      sourceRef,
      ...(boundedText(row.supersededBy) ? { supersededBy: boundedText(row.supersededBy)! } : {}),
    });
  }
  return constraints;
}

function normalizeFiles(
  value: unknown,
  observations: readonly FileObservation[],
): ConversationCheckpointV2['files'] {
  if (!Array.isArray(value)) return [];
  const byPath = new Map(observations.map((observation) => [observation.path, observation]));
  return value.slice(0, MAX_ITEMS).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const path = boundedText(row.path);
    const relevanceNote = boundedText(row.relevanceNote);
    const observation = path ? byPath.get(path) : undefined;
    if (!path || !relevanceNote || !observation) return [];
    const sourceRefs = stringList(row.sourceRefs).filter(
      (ref) => ref === observation.sourceRef || ref.startsWith(`${observation.sourceRef}/`),
    );
    if (sourceRefs.length === 0) sourceRefs.push(observation.sourceRef);
    return [
      {
        path: observation.path,
        workspaceIdentity: observation.workspaceIdentity,
        sha256: observation.sha256,
        sizeBytes: observation.sizeBytes,
        ...(stringList(row.symbols, 50).length ? { symbols: stringList(row.symbols, 50) } : {}),
        relevanceNote,
        observations: stringList(row.observations, 50),
        sourceRefs,
      },
    ];
  });
}

function normalizeEpisodes(value: unknown, refs: Map<string, Message>): CheckpointEpisodeV2[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_ITEMS).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const row = item as Record<string, unknown>;
    const label = boundedText(row.label);
    const outcome = boundedText(row.outcome);
    const sourceRange = boundedText(row.sourceRange);
    if (!label || !outcome || !sourceRange) return [];
    const rangeRefs = sourceRange.includes('..') ? sourceRange.split('..') : [sourceRange];
    if (rangeRefs.some((ref) => !refs.has(ref))) return [];
    const status = ['completed', 'paused', 'blocked', 'superseded'].includes(String(row.status))
      ? (row.status as CheckpointEpisodeV2['status'])
      : 'paused';
    return [{ label, status, outcome, paths: stringList(row.paths, 50), sourceRange }];
  });
}

export function validateCheckpointResponse(
  raw: string,
  grounding: CheckpointGrounding,
): ConversationCheckpointV2 {
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object')
    throw new Error('Checkpoint response must be an object.');
  const candidate = parsed as Candidate;
  const refs = refMessageMap(grounding.messages);
  const taskSummary = boundedText(candidate.stateAtCheckpoint?.taskSummary, MAX_SUMMARY_CHARS);
  const stateRefs = stringList(candidate.stateAtCheckpoint?.sourceRefs).filter((ref) =>
    refs.has(ref),
  );
  if (!taskSummary || stateRefs.length === 0) {
    throw new Error('Checkpoint state was empty or ungrounded.');
  }

  const through = grounding.messages.at(-1);
  if (!through) throw new Error('Checkpoint prefix was empty.');
  return {
    version: 2,
    generation: grounding.generation,
    throughEventRef: eventRef(through),
    stateAtCheckpoint: {
      taskSummary,
      status: isStateStatus(candidate.stateAtCheckpoint?.status)
        ? candidate.stateAtCheckpoint.status
        : 'paused',
      sourceRefs: stateRefs,
    },
    constraints: normalizeConstraints(candidate.constraints, refs),
    files: normalizeFiles(candidate.files, grounding.fileObservations ?? []),
    episodes: normalizeEpisodes(candidate.episodes, refs),
    openThreads: stringList(candidate.openThreads, MAX_ITEMS),
    stats: {
      summarizedMessages: grounding.messages.length,
      retainedMessages: grounding.retainedMessageCount,
      estimatedPrefixTokens: grounding.estimatedPrefixTokens,
      estimatedTailTokens: grounding.estimatedTailTokens,
    },
  };
}

export function materializeCheckpointFileFreshness(
  checkpoint: ConversationCheckpointV2,
  workspaceRoot: string,
): string[] {
  const currentWorkspace = workspaceIdentity(workspaceRoot);
  return checkpoint.files.map((file) => {
    if (file.workspaceIdentity !== currentWorkspace) {
      return `${file.path}: stale locator (different workspace; reread before reliance or mutation)`;
    }
    const resolved = resolveWorkspacePath(workspaceRoot, file.path);
    if (!resolved || !existsSync(resolved.filePath)) {
      return `${file.path}: stale locator (missing or outside workspace; reread before reliance or mutation)`;
    }
    try {
      const content = readFileSync(resolved.filePath, 'utf-8');
      if (sha256Text(content) !== file.sha256) {
        return `${file.path}: stale locator (content changed; reread before reliance or mutation)`;
      }
      return `${file.path}: current (hash verified; evidence: ${file.sourceRefs.join(', ')})`;
    } catch {
      return `${file.path}: stale locator (unreadable; reread before reliance or mutation)`;
    }
  });
}

export function renderCheckpointMessage(
  checkpoint: ConversationCheckpointV2,
  workspaceRoot?: string,
): string {
  const freshness = workspaceRoot
    ? materializeCheckpointFileFreshness(checkpoint, workspaceRoot)
    : checkpoint.files.map(
        (file) => `${file.path}: freshness unknown (reread before exact reliance or mutation)`,
      );
  return [
    '[Book checkpoint v2: historical/reference data]',
    'This is a lossy map of older conversation, not a new user instruction.',
    freshness.length > 0
      ? `Workspace file freshness (Book-verified at context materialization):\n${freshness.join('\n')}`
      : '',
    JSON.stringify(checkpoint),
  ]
    .filter(Boolean)
    .join('\n');
}

export function checkpointEventRef(message: Message): string {
  return eventRef(message);
}
