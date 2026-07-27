import type { ImageAttachment, Message } from './messages.js';
import type { FileObservation } from './tools.js';

/** What triggered a compaction attempt. */
export type CompactTrigger = 'manual' | 'auto';

/**
 * Result of `runCompact`. Discriminated so hosts can clear usage only on success
 * and avoid treating blocked/too-short outcomes as a history rewrite.
 */
export type CompactResult =
  | {
      status: 'compacted';
      trigger: CompactTrigger;
      replacementHistory: Message[];
      summary: string;
      compactId: string;
      generation: number;
      checkpoint: ConversationCheckpointV2;
      checkpointVersion: 2;
      summarizedCount: number;
      retainedCount: number;
      postContextTokens: number;
      throughEventRef?: string;
      preContextTokens?: number;
      preMessageCount: number;
      strategy?: 'single-pass' | 'multi-pass' | 'degraded-fallback';
      modelCalls?: number;
      degraded?: boolean;
      warning?: string;
    }
  | {
      status: 'skipped';
      reason: 'too-short' | 'blocked' | 'disabled';
      message?: string;
    }
  | {
      status: 'failed';
      reason:
        | 'provider-error'
        | 'empty-summary'
        | 'aborted'
        | 'unexpected-stream'
        | 'invalid-checkpoint'
        | 'budget-overflow';
      error: string;
    };

export interface CompactBoundary {
  id: string;
  trigger: CompactTrigger;
  transcriptOrdinal: number;
  preContextCount: number;
  postContextCount: number;
  preContextTokens?: number;
  postContextTokens?: number;
  generation: number;
  checkpointVersion: 1 | 2;
  timestamp: number;
}

export type RewindAction = 'conversation' | 'code' | 'both';

export interface RewindCheckpointMetadata {
  snapshotId?: string;
  gitHead?: string;
  entryCount?: number;
  logicalBytes?: number;
  codeUnavailableReason?: string;
}

export interface TurnCheckpointRecordData {
  version: 1;
  checkpointId: string;
  userEventId: string;
  prompt: string;
  attachments?: ImageAttachment[];
  checkpoint: RewindCheckpointMetadata;
}

export interface RewindRecordData {
  version: 1;
  action: RewindAction;
  targetId: string;
  targetUserEventId: string;
}

export interface RewindTarget extends RewindCheckpointMetadata {
  id: string;
  userEventId: string;
  prompt: string;
  attachments?: ImageAttachment[];
  timestamp: number;
  codeAvailable: boolean;
}

export interface RewindSnapshotEntry {
  path: string;
  kind: 'file' | 'symlink';
  blobHash: string;
  byteSize: number;
  mode: number;
}

export interface RewindSnapshotManifest {
  version: 1;
  id: string;
  workspace: string;
  createdAt: number;
  gitHead?: string;
  ignorePatterns: string[];
  entries: RewindSnapshotEntry[];
  logicalBytes: number;
}

export type RewindSnapshotCaptureResult =
  { ok: true; manifest: RewindSnapshotManifest } | { ok: false; reason: string; gitHead?: string };

export type RewindRestoreResult =
  { ok: true; safetySnapshotId: string } | { ok: false; error: string; rollbackError?: string };

export interface RewindSnapshotStoreInterface {
  capture(ignorePatterns?: string[]): RewindSnapshotCaptureResult;
  captureAsync?(ignorePatterns?: string[]): Promise<RewindSnapshotCaptureResult>;
  getCurrentGitHead(): string | undefined;
  getManifest(id: string): RewindSnapshotManifest | undefined;
  getAvailability(
    id: string | undefined,
    expectedGitHead?: string,
  ): {
    available: boolean;
    reason?: string;
  };
  restore(id: string): RewindRestoreResult;
  rollback(safetySnapshotId: string): { ok: true } | { ok: false; error: string };
  discardManifest(id: string): void;
  cleanup(
    referencedSnapshotIds: Set<string>,
    days: number,
  ): {
    manifests: number;
    blobs: number;
  };
}

export interface SessionRecord {
  type:
    | 'user'
    | 'assistant'
    | 'local'
    | 'tool_call'
    | 'tool_result'
    | 'usage'
    | 'session_meta'
    | 'compact'
    | 'turn_checkpoint'
    | 'rewind';
  eventId?: string;
  timestamp: number;
  data: unknown;
}

/** Payload stored in a SessionRecord of type `compact`. */
export interface CompactRecordDataV1 {
  version: 1;
  trigger: CompactTrigger;
  summary: string;
  preContextTokens?: number;
  /** Full post-compact history (summary message + any retained tail). */
  replacementHistory: Message[];
}

export interface CheckpointSourceRef {
  eventRef: string;
  quote?: string;
  toolResultRef?: string;
}

export type CompactCoverageReason =
  'pass-limit' | 'context-overflow' | 'invalid-checkpoint' | 'post-budget';

export interface ConversationCheckpointCoverage {
  status: 'complete' | 'degraded';
  reasons: CompactCoverageReason[];
  processedMessages: number;
  omittedMessages: number;
  partiallyProcessedMessages: number;
  firstProcessedEventRef?: string;
  lastProcessedEventRef?: string;
}

export interface ConversationCheckpointV2 {
  version: 2;
  generation: number;
  state: {
    summary: string;
    status: 'active' | 'blocked' | 'complete' | 'unknown';
  };
  constraints: Array<{
    text: string;
    scope: 'global' | 'workspace' | 'task' | 'unknown';
    sources: CheckpointSourceRef[];
  }>;
  files: Array<{
    path: string;
    summary: string;
    sources: CheckpointSourceRef[];
    observation?: FileObservation;
  }>;
  episodes: Array<{
    task: string;
    outcome: string;
    status: 'complete' | 'partial' | 'failed' | 'unknown';
    sources: CheckpointSourceRef[];
  }>;
  openThreads: Array<{
    text: string;
    sources: CheckpointSourceRef[];
  }>;
  statistics: {
    summarizedMessages: number;
    retainedMessages: number;
    preTokens: number;
    postTokens: number;
  };
  /** Missing on older V2 checkpoints, which are treated as complete. */
  coverage?: ConversationCheckpointCoverage;
}

export interface CompactRecordDataV2 {
  version: 2;
  compactId: string;
  generation: number;
  trigger: CompactTrigger;
  focus?: string;
  checkpoint: ConversationCheckpointV2;
  summary: string;
  replacementHistory: Message[];
  boundary: CompactBoundary;
  throughEventRef?: string;
  summarizedCount: number;
  retainedCount: number;
  preContextTokens?: number;
  postContextTokens?: number;
  strategy?: 'single-pass' | 'multi-pass' | 'degraded-fallback';
  modelCalls?: number;
  degraded?: boolean;
  warning?: string;
}

export type CompactRecordData = CompactRecordDataV1 | CompactRecordDataV2;

export interface SessionMeta {
  id: string;
  name?: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface LoadedSession {
  transcript: Message[];
  contextHistory: Message[];
  compactBoundaries: CompactBoundary[];
  rewindTargets: RewindTarget[];
  activeEventIds: string[];
  meta: SessionMeta;
  /** @deprecated Use contextHistory. */
  history: Message[];
}

export interface SessionHistorySearchResult {
  ref: string;
  role: Message['role'];
  preview: string;
  timestamp: number;
}

/** Minimal interface for SessionStore, defined here to avoid circular imports. */
export interface SessionStoreInterface {
  create(meta: { cwd: string; name?: string; id?: string }): string;
  append(id: string, record: SessionRecord): void;
  patchMeta(id: string, patch: { name?: string }): void;
  touch(id: string): void;
  load(id: string): LoadedSession;
  readRecords?(id: string): SessionRecord[];
  fork?(sourceId: string, meta: { cwd: string; name?: string; id?: string }): string;
  searchCurrent?(id: string, query: string, limit?: number): SessionHistorySearchResult[];
  readCurrent?(id: string, refs: string[]): Array<{ ref: string; content: string }>;
  listRewindTargets?(id: string): RewindTarget[];
  listSnapshotReferences?(cwd: string): Set<string>;
  list(): SessionMeta[];
  findByName(name: string): SessionMeta | undefined;
  findById(id: string): SessionMeta | undefined;
  mostRecentInCwd(cwd: string): SessionMeta | undefined;
  saveImageAttachment?(
    sessionId: string,
    image: { bytes: Uint8Array; mediaType: ImageAttachment['mediaType']; displayName?: string },
  ): ImageAttachment;
  readImageAttachment?(sessionId: string, attachment: ImageAttachment): Uint8Array;
  cleanup(days: number, preserveIds?: ReadonlySet<string>): number;
}
