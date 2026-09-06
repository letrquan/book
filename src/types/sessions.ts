import type { ImageAttachment, Message, Usage } from './messages.js';
import type { AgentTask } from './runtime.js';
import type { FileObservation } from './tools.js';

/** What triggered a compaction attempt. */
export type CompactTrigger = 'manual' | 'auto';

/**
 * What the agent loop knows about the request behind a compaction and the
 * compactor cannot see for itself. Hosts forward these into `RunCompactOptions`
 * unchanged.
 */
export interface CompactRequestHints {
  /**
   * The provider has just rejected the request as too large. The compactor
   * must keep only the short tail: the residual tail was sized for a window
   * the provider has said it does not have, and the loop gets one retry.
   */
  recovery?: boolean;
  /**
   * Estimated tokens of the request outside the history: system prompt, tool
   * schemas, session state. The compaction target is measured against the
   * preflight gate, which counts them.
   */
  requestOverheadTokens?: number;
  /**
   * The loop's estimate of the request whose provider-measured usage is being
   * passed as pressure. Together they measure how far the estimator undercounts
   * this session's text, and the target shrinks by that ratio.
   */
  estimatedRequestTokens?: number;
}

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
    | 'rewind'
    | 'plan';
  eventId?: string;
  timestamp: number;
  data: unknown;
}

/**
 * Payload stored in a SessionRecord of type `plan` — last record wins.
 *
 * The plan is the only long-horizon state with no other home: todos live on the
 * per-invocation ToolContext and the task graph on the in-process SessionRuntime,
 * so both die at process exit.
 *
 * Readers must tolerate absence: `SessionStore.load` dispatches record types with
 * no default branch, so an older binary ignores this record rather than failing.
 */
export interface PlanRecordData {
  version: 1;
  todos?: PersistedTodo[];
  tasks?: AgentTask[];
}

export interface PersistedTodo {
  content: string;
  status: string;
  activeForm?: string;
}

/**
 * Payload stored in a SessionRecord of type `usage` — one per provider response.
 *
 * Tokens only: pricing can change between processes, so USD is re-derived at
 * bootstrap rather than trusted from an older record.
 */
export interface UsageRecordData {
  version: 1;
  usage: Usage;
  requestedModel?: string;
  responseModel?: string;
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
  /** This generation's coverage. Answers "is the checkpoint I just made sound?" */
  status: 'complete' | 'degraded';
  reasons: CompactCoverageReason[];
  /**
   * The accumulated record across every generation of this conversation. Kept
   * separate because merging it into `status` made the signal saturate: one
   * degraded generation marked every later one, so within a few hours of a long
   * run everything read `degraded` and the flag stopped carrying information.
   * Optional: absent on checkpoints written before the split.
   */
  lifetime?: {
    status: 'complete' | 'degraded';
    reasons: CompactCoverageReason[];
  };
  processedMessages: number;
  omittedMessages: number;
  partiallyProcessedMessages: number;
  firstProcessedEventRef?: string;
  lastProcessedEventRef?: string;
}

/**
 * One user-authored constraint, recorded verbatim by the host.
 *
 * Host-owned: the reducer never writes this. It is extracted from the user's
 * own turns by `agent/carried-ledger.ts` and re-attached after every
 * generation, which is what lets it outlive the model-authored narrative that
 * `fitCheckpoint` is free to rewrite.
 */
export interface CarriedConstraint {
  /** Stable across generations: derived from the normalized text. */
  id: string;
  /** The user's sentence, unrewritten. Truncated only past `CARRIED_ENTRY_MAX_CHARS`. */
  text: string;
  /**
   * How explicit the user was. `strong` is an unambiguous directive ("must",
   * "never", "do not"); `weak` is a softer steer ("only", "avoid", "prefer").
   * The cap evicts `weak` before `strong`.
   */
  strength: 'strong' | 'weak';
  /** The user turn the text came from. Never minimized away by the fitter. */
  source: CheckpointSourceRef;
  /** Generation at which the entry was first recorded. */
  firstSeenGeneration: number;
  /** Generation at which the user last restated it. */
  lastSeenGeneration: number;
  /** Id of the later entry that restates this one, when the host detected one. */
  supersededBy?: string;
}

/**
 * The Carried Ledger: a monotonic, host-owned record of what the user asked
 * for, ordered oldest to newest and never reordered.
 *
 * `fitCheckpoint` may not evict from it. Its growth is bounded by its own cap
 * (`capCarriedLedger`) instead, so "the fitter cannot touch it" does not turn
 * into "it eats the checkpoint budget".
 */
export interface CarriedLedger {
  version: 1;
  /** Oldest first. Later entries win over earlier ones on conflict. */
  constraints: CarriedConstraint[];
  /** Entries the cap had to drop. Non-zero means the ledger is lossy. */
  droppedCount?: number;
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
  /**
   * Host-owned verbatim user constraints. Absent on checkpoints written before
   * the Carried Ledger, and absent when the conversation stated no constraint.
   */
  carried?: CarriedLedger;
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
  /**
   * The newest `plan` record, if the session ever wrote one. Absent means no plan
   * was ever recorded; present-but-empty means it was deliberately cleared. That
   * distinction is what lets a resumed run tell "nothing to do" from "my plan did
   * not survive the restart".
   */
  plan?: PlanRecordData;
  /**
   * Token totals recorded by earlier processes of this session, summed from the
   * `usage` records. USD is deliberately not stored: pricing changes between
   * processes, so cost is re-derived from these tokens at bootstrap.
   */
  carriedUsage?: Usage;
  /** Models those tokens were spent on, for re-deriving the cost. */
  carriedModels?: string[];
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
