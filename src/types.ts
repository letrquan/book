import type { ChildProcess } from 'child_process';
import type { ProviderModelConfig, ResolvedSettings } from './settings.js';
import type { LoadedMemoryContext } from './memory-store.js';

export type PermissionMode =
  'default' | 'auto' | 'plan' | 'accept-edits' | 'dontAsk' | 'bypassPermissions';

/** What phase of retry is currently active (drives the TUI spinner label). */
export type RetryPhase = 'none' | 'transport' | 'stalled' | 'tool' | 'watchdog';

/**
 * Retry configuration — all tunables live here.
 * Mirrors Claude Code's env vars: CLAUDE_CODE_MAX_RETRIES, API_TIMEOUT_MS,
 * CLAUDE_CODE_RETRY_WATCHDOG, plus the stream-stall threshold.
 */
export interface RetryConfig {
  maxAttempts: number; // default 10 (Claude Code default)
  baseDelayMs: number; // default 1000
  maxDelayMs: number; // default 30000
  totalBudgetMs: number; // default 0 = no budget
  requestTimeoutMs: number; // default 600000 (10 min)
  streamStallTimeoutMs: number; // default 20000 (20s, matches Claude Code)
  toolRetries: number; // default 1
  watchdog: boolean; // default false — CI mode: retry 429/529 indefinitely
}

/**
 * A slash command loaded from .book/commands/*.md or ~/.book/commands/*.md.
 * Matches Claude Code's command loading model.
 */
export interface SlashCommand {
  /** File basename without extension — the command name invoked via /name */
  name: string;
  /** Human-readable description (from frontmatter `description`) */
  description: string;
  /** Argument hint shown in help and autocomplete (from frontmatter `argument-hint`) */
  argumentHint?: string;
  /** Named positional arguments for $name substitution (from frontmatter `arguments`) */
  arguments?: string[];
  /** Restrict which tools this command can use (from frontmatter `allowed-tools`) */
  allowedTools?: string[];
  /** Override model for this command (from frontmatter `model`) */
  model?: string;
  /** The raw Markdown body — injected as the prompt when invoked. */
  body: string;
  /** Source directory for priority/debugging (user vs project). */
  source: 'user' | 'project';
  /** Hide from / autocomplete and /help listing (default false). */
  isHidden?: boolean;
  /** Whether users can type /name to invoke (default true). */
  userInvocable?: boolean;
}

/**
 * Runtime context for an active command invocation.
 * Carries enforcement data through the agent loop.
 */
export interface CommandContext {
  /** The command that was invoked */
  command: SlashCommand;
  /** The resolved body after argument/shell/env substitution */
  resolvedBody: string;
  /** Model override from command frontmatter */
  modelOverride?: string;
  /** Tool allowlist from command frontmatter */
  allowedTools?: string[];
}

/**
 * Theme token system matching Claude Code's color token architecture.
 * All values are Ink-compatible color strings (named colors, hex, rgb, ansi256, ansi:<name>).
 */
export interface ThemeTokens {
  /** Identity */
  brand: string;
  brandShimmer: string;

  /** Text */
  text: string;
  inverseText: string;
  inactive: string;
  subtle: string;
  suggestion: string;
  permission: string;
  remember: string;

  /** Status */
  success: string;
  error: string;
  warning: string;
  merged: string;

  /** Mode borders */
  promptBorder: string;
  planMode: string;
  autoAccept: string;
  bashBorder: string;

  /** Permission mode colors (one per mode) */
  modeDefault: string;
  modePlan: string;
  modeAcceptEdits: string;
  modeAuto: string;
  modeDontAsk: string;
  modeBypass: string;

  /** Diff rendering */
  diffAdded: string;
  diffRemoved: string;
  diffAddedWord: string;
  diffRemovedWord: string;
  diffAddedDimmed: string;
  diffRemovedDimmed: string;

  /** Usage meter */
  usageMeter: string;
  usageMeterHigh: string;
  usageMeterCritical: string;

  /** Shimmer pairs for animated gradients */
  shimmerPair: [string, string];

  /** Subagent colors (8 named colors) */
  subagentColors: string[];

  /** Markdown rendering */
  mdCodeBackground: string;
  mdCodeBorder: string;
  mdCodeText: string;
  mdCodeKeyword: string;
  mdCodeString: string;
  mdCodeComment: string;
  mdCodeNumber: string;
  mdCodeFunction: string;
  mdCodeLineNumber: string;
  mdInlineCodeBg: string;
  mdInlineCodeText: string;
  mdHeading: string;
  mdHeadingH1: string;
  mdHeadingH2: string;
  mdBlockquoteBorder: string;
  mdBlockquoteText: string;
  mdLink: string;
  mdListMarker: string;
  mdHr: string;
  mdTableBorder: string;
  mdThinkBg: string;
  mdThinkBorder: string;
  mdThinkText: string;
  mdTurnSeparator: string;
  mdCheckboxChecked: string;
  mdCheckboxUnchecked: string;

  /** User message background */
  userBg: string;
}

export const DEFAULT_THEME: ThemeTokens = {
  brand: 'cyan',
  brandShimmer: '#5cf',
  text: 'white',
  inverseText: 'black',
  inactive: 'gray',
  subtle: 'gray',
  suggestion: 'gray',
  permission: 'yellow',
  remember: 'magenta',

  success: 'green',
  error: 'red',
  warning: 'yellow',
  merged: 'green',

  promptBorder: 'cyan',
  planMode: 'magenta',
  autoAccept: 'green',
  bashBorder: 'yellow',

  modeDefault: 'cyan',
  modePlan: 'magenta',
  modeAcceptEdits: 'green',
  modeAuto: 'green',
  modeDontAsk: 'red',
  modeBypass: 'yellow',

  diffAdded: '#12351f',
  diffRemoved: '#3b1818',
  diffAddedWord: '#1f6f3a',
  diffRemovedWord: '#7f2e2e',
  diffAddedDimmed: '#0c2515',
  diffRemovedDimmed: '#281010',

  usageMeter: 'cyan',
  usageMeterHigh: 'yellow',
  usageMeterCritical: 'red',

  shimmerPair: ['cyan', '#5cf'],

  subagentColors: ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'],

  mdCodeBackground: '#1a1a2e',
  mdCodeBorder: '#333',
  mdCodeText: '#e0e0e0',
  mdCodeKeyword: '#c678dd',
  mdCodeString: '#98c379',
  mdCodeComment: '#7f848e',
  mdCodeNumber: '#d19a66',
  mdCodeFunction: '#61afef',
  mdCodeLineNumber: '#666',
  mdInlineCodeBg: '#2a2a3e',
  mdInlineCodeText: '#f0c040',
  mdHeading: 'white',
  mdHeadingH1: 'cyan',
  mdHeadingH2: '#8fdfff',
  mdBlockquoteBorder: '#555',
  mdBlockquoteText: '#aaa',
  mdLink: 'cyan',
  mdListMarker: 'gray',
  mdHr: 'gray',
  mdTableBorder: '#555',
  mdThinkBg: '#15151f',
  mdThinkBorder: '#555',
  mdThinkText: '#aaa',
  mdTurnSeparator: '#444',
  mdCheckboxChecked: 'green',
  mdCheckboxUnchecked: 'gray',

  userBg: '#1a1a2e',
};

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Context-pressure metric for auto-compact (includes Anthropic cache tokens when known). */
  contextTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

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
      checkpoint: ConversationCheckpointV2;
      preContextTokens?: number;
      preMessageCount: number;
      retainedMessageCount: number;
      estimatedPostTokens: number;
      generation: number;
    }
  | {
      status: 'skipped';
      reason: 'too-short' | 'blocked' | 'disabled' | 'no-prefix';
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
        | 'ungrounded-checkpoint'
        | 'oversized-tail'
        | 'post-compact-overflow';
      error: string;
    };

export type PermissionResult = 'allow' | 'deny' | 'always';
export type PlanApprovalResult = 'approve' | 'reject';

export type AgentTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export interface AgentTask {
  id: string;
  subject: string;
  description?: string;
  status: AgentTaskStatus;
  activeForm?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
  blockedBy: string[];
  blocks: string[];
  createdAt: number;
  updatedAt: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Display-only trace for a tool invoked inside a Task subagent. */
export interface NestedToolInvocation {
  /** Globally unique UI identity. Raw provider tool-call ids may repeat across subagents. */
  traceId: string;
  /** Trace id of the Task invocation that directly launched this tool. */
  parentTraceId: string;
  call: ToolCall;
  result?: ToolResult;
}

/** Optional observer used by hosts that want live visibility into subagent tools. */
export interface NestedToolObserver {
  onToolCall: (invocation: NestedToolInvocation) => void;
  onToolResult: (traceId: string, result: ToolResult) => void;
}

export interface FileMutationSummary {
  kind: 'create' | 'update';
  filePath: string;
  addedLines: number;
  removedLines: number;
}

/** Exact coverage shown to the model while the fingerprint covers the whole file. */
export type FileObservationCoverage =
  | { kind: 'full' }
  | { kind: 'lines'; startLine: number; endLine: number; totalLines: number }
  | { kind: 'bytes'; startByte: number; endByte: number; totalBytes: number };

/** Provider-neutral provenance for file contents observed or successfully mutated in this session. */
export interface FileObservation {
  workspaceIdentity: string;
  path: string;
  sha256: string;
  sizeBytes: number;
  coverage: FileObservationCoverage;
  operation: 'read' | 'mention' | 'edit' | 'write' | 'create';
  sourceRef: string;
}

/** Explicit session-loop state. The newest observation for a normalized path wins. */
export interface FileObservationLedger {
  remember(observation: FileObservation): void;
  latest(path: string): FileObservation | undefined;
  all(): FileObservation[];
}

export interface SessionHistoryEntry {
  reference: string;
  type: string;
  text: string;
  ordinal?: number;
  timestamp?: number;
  path?: string;
  toolName?: string;
}

/** Narrow read-only host capability scoped to exactly one active persisted session. */
export interface SessionHistoryCapability {
  sessionId: string;
  workspaceIdentity: string;
  search(options: { query: string; limit: number }): Promise<SessionHistoryEntry[]>;
  read(options: {
    reference: string;
    maxEvents: number;
    maxOutputChars: number;
  }): Promise<SessionHistoryEntry[]>;
}

export type BackgroundShellStatus =
  'running' | 'stopping' | 'exited' | 'failed' | 'killed' | 'timed_out';

export interface BackgroundShellRecord {
  id: string;
  command: string;
  effectiveCommand: string;
  workdir: string;
  pid?: number;
  process?: ChildProcess;
  status: BackgroundShellStatus;
  output: string;
  readOffset: number;
  truncatedBytes: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  startedAt: number;
  finishedAt?: number;
  timer?: NodeJS.Timeout;
  sandboxed?: boolean;
}

export interface BackgroundShellStore {
  nextId: number;
  shells: Map<string, BackgroundShellRecord>;
}

export interface ToolResult {
  toolCallId: string;
  success: boolean;
  output: string;
  error?: string;
  /** Duration of the tool execution in milliseconds. */
  durationMs?: number;
  /** Which attempt succeeded (1 = first try, 2+ = retried). Only set on success after a retry. */
  retryAttempt?: number;
  /** Structured metadata for Write/Edit/MultiEdit file changes. */
  fileMutation?: FileMutationSummary;
  /** File fingerprints captured by this tool result. */
  fileObservations?: FileObservation[];
  /** Legacy metadata: whether a file creation occurred. Prefer fileMutation.kind. */
  isCreate?: boolean;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  /** User-facing text shown in the TUI/history. */
  content: string;
  /** Provider-facing text when it differs from the displayed content. */
  contextContent?: string;
  /** Whether this message is included in provider and compaction context. */
  includeInContext: boolean;
  /** Distinguishes ordinary chat, provider checkpoints, and transcript-only rows. */
  kind?: 'conversation' | 'checkpoint' | 'local';
  /** Structured checkpoint data when kind is `checkpoint`. */
  checkpoint?: ConversationCheckpointV2;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  /** UI-only subagent activity. Never serialized as provider tool calls. */
  nestedToolInvocations?: NestedToolInvocation[];
  /** File fingerprints introduced by input expansion or retained metadata. */
  fileObservations?: FileObservation[];
  timestamp: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** When true, the tool is safe to retry once on transient failure (Read, Grep, WebFetch, etc.). */
  idempotent?: boolean;
  /** Optional host-capability gate; unavailable tools are omitted from model-facing definitions. */
  isAvailable?: (context: ToolContext) => boolean;
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  workspaceRoot: string;
  env: Record<string, string>;
  /** Glob patterns to ignore during file discovery (e.g. from .gitignore). */
  gitignorePatterns?: string[];
  /** Resolved sandbox settings for the Bash tool. */
  sandbox?: ResolvedSettings['sandbox'];
  /** The active AgentConfig, set by the agent loop before tool execution. */
  agentConfig?: AgentConfig;
  /** Abort signal shared with nested Task subagents. */
  signal?: AbortSignal;
  /** Stable trace identity of the tool currently executing. */
  currentToolTraceId?: string;
  /** Observer for display-only tools invoked inside Task subagents. */
  nestedToolObserver?: NestedToolObserver;
  /** Active persisted-session history, when the host can provide it safely. */
  sessionHistory?: SessionHistoryCapability;
  /** File observations shared across tool calls in this session loop. */
  fileObservations?: FileObservationLedger;
  /** Agent todo list — written by TodoWrite, read by the loop for context injection. */
  todos?: Array<{ content: string; status: string; activeForm?: string }>;
  /** Agent task list — written by TaskCreate/TaskUpdate and shared across tool calls. */
  tasks?: AgentTask[];
  /** Background shells started by Bash(run_in_background), shared across tool calls. */
  backgroundShells?: BackgroundShellStore;
  /** Live permission mode for the active agent loop; tools may update this. */
  currentMode?: PermissionMode;
  /** Mode to restore after a tool-initiated plan-mode session exits. */
  previousMode?: PermissionMode;
  /** Plan text submitted by ExitPlanMode and awaiting host approval. */
  pendingPlanApproval?: { plan: string };
}

export interface SystemPromptZones {
  /** Cacheable session-stable system prompt prefix. */
  cachedPrefix: string;
  /** Dynamic per-turn system prompt suffix, such as the active todo list. */
  dynamicSuffix: string;
}

export interface ProviderMessage {
  role: string;
  content: string | SystemPromptZones | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface AgentConfig {
  /** May be empty until an interactive user adds a BYOK provider. */
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Raw picker/settings reference, including provider prefix when configured. */
  modelSelection?: string;
  /** Max agent turns per user message. Undefined = unlimited. */
  maxTurns?: number;
  maxTokens: number;
  /** True when maxTokens came from user config/env, not a default or model metadata. */
  maxTokensExplicit?: boolean;
  /** Default output-token limit to restore when selected model has no metadata. */
  defaultMaxTokens?: number;
  /** True when effort came from user config/env or an explicit runtime choice. */
  effortExplicit?: boolean;
  /** Default effort to restore when selected model has no metadata. */
  defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Plain-model fallback values used after provider/model switches. */
  defaultApiKey?: string;
  defaultBaseUrl?: string;
  defaultProvider?: 'anthropic' | 'openai' | 'auto';
  autoCompactEnabled: boolean;
  workspace: string;
  animation: {
    typewriterSpeed: number;
    spinnerStyle: 'braille' | 'dots';
  };
  accessibility: {
    screenReader: boolean;
    reducedMotion: boolean;
  };
  /** Resolved layered settings (permissions, sandbox, etc.). */
  settings: ResolvedSettings;
  /** Retry configuration (from settings.json + env vars). */
  retry: RetryConfig;
  /** Thinking effort level (Anthropic adaptive thinking / output_config.effort). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Explicit provider override: 'anthropic' | 'openai' | 'auto' (default: auto-detect). */
  provider?: 'anthropic' | 'openai' | 'auto';
  /** Metadata from settings.provider.<id>.models.<model>, if selected. */
  modelInfo?: ProviderModelConfig;
  /** Approved memory snapshot loaded once at session start. */
  memoryContext?: LoadedMemoryContext;
  /** Runtime-only agent tasks shared across agent-loop invocations in a session. */
  tasks?: AgentTask[];
  /** Runtime-only background shells shared across agent-loop invocations in a session. */
  backgroundShells?: BackgroundShellStore;
}

export interface ProviderStreamEvent {
  type: 'text' | 'tool_call' | 'done' | 'error';
  content?: string;
  toolCall?: ToolCall;
  error?: string;
  usage?: Usage;
}

export interface AgentLoopCallbacks {
  onText: (text: string) => void;
  onToolCall: (call: ToolCall) => void;
  onToolResult: (result: ToolResult) => void;
  onError: (error: string) => void;
  onTurnStart: (turn: number) => void;
  onDone: () => void;
  onPermissionRequired: (toolCall: ToolCall) => Promise<'allow' | 'deny' | 'always'>;
  /** @deprecated use onUsage for real token counts from the API. */
  onTokenCount?: (count: number) => void;
  onUsage?: (usage: Usage) => void;
  /** Called when a tool changes the live permission mode. */
  onModeChange?: (mode: PermissionMode) => void;
  /** Called when ExitPlanMode submits a plan for host approval. */
  onPlanApprovalRequired?: (plan: string) => Promise<PlanApprovalResult>;
  /**
   * Called when the context approaches its limit mid-loop.
   * Return a CompactResult; only `status: 'compacted'` replaces loop history.
   */
  onCompact?: (history: Message[], usage: Usage | null) => Promise<CompactResult>;
  /**
   * Called when an assistant turn (including tool results) is finalized.
   * Hosts should persist this immediately rather than slicing the final history.
   */
  onAssistantMessageComplete?: (message: Message) => void;
  /** Called after each tool execution with the current agent todo list. */
  onTodos?: (todos: Array<{ content: string; status: string; activeForm?: string }>) => void;
  /** Called when a transport-level retry starts (delay > 0). */
  onRetry?: (phase: RetryPhase, attempt: number, max: number, delayMs: number) => void;
  /** Called when the response stream stalls (no data for streamStallTimeoutMs). */
  onStreamStall?: (countdownMs: number) => void;
  /** Called when data resumes after a stream stall. */
  onStreamResume?: () => void;
  /**
   * Called when the user picks "always allow" at a permission prompt — so the
   * host can persist a Tool(specifier) rule (CC-aligned approval flow). The
   * `rule` string is canonical (e.g. `Bash(npm install)` or `Read`).
   */
  onPersistPermissionRule?: (rule: string) => void;
  /** Called when a hook lifecycle event fires (for --include-hook-events in stream-json mode). */
  onHookEvent?: (event: string, payload: Record<string, unknown>) => void;
}

export type OutputFormat = 'text' | 'json' | 'stream-json';
export type InputFormat = 'text' | 'stream-json';

export type CheckpointStateStatus =
  'in_progress' | 'completed' | 'blocked' | 'paused' | 'superseded';

export interface CheckpointConstraintV2 {
  exactText: string;
  scope: 'session' | 'task' | 'path' | 'unknown';
  status: 'active' | 'superseded';
  pathPatterns?: string[];
  sourceRef: string;
  supersededBy?: string;
}

export interface CheckpointFileV2 {
  path: string;
  workspaceIdentity: string;
  sha256: string;
  sizeBytes: number;
  symbols?: string[];
  relevanceNote: string;
  observations: string[];
  sourceRefs: string[];
}

export interface CheckpointEpisodeV2 {
  label: string;
  status: 'completed' | 'paused' | 'blocked' | 'superseded';
  outcome: string;
  paths: string[];
  sourceRange: string;
}

/** Provider-neutral structured summary of the compacted historical prefix. */
export interface ConversationCheckpointV2 {
  version: 2;
  generation: number;
  throughEventRef: string;
  stateAtCheckpoint: {
    taskSummary: string;
    status: CheckpointStateStatus;
    sourceRefs: string[];
  };
  constraints: CheckpointConstraintV2[];
  files: CheckpointFileV2[];
  episodes: CheckpointEpisodeV2[];
  openThreads: string[];
  stats: {
    summarizedMessages: number;
    retainedMessages: number;
    estimatedPrefixTokens: number;
    estimatedTailTokens: number;
  };
}

export interface CompactBoundary {
  id: string;
  timestamp: number;
  trigger: CompactTrigger;
  /** Number of visible transcript messages preceding this boundary. */
  afterTranscriptOrdinal: number;
  preContextMessages: number;
  retainedContextMessages: number;
  preContextTokens?: number;
  estimatedPostTokens?: number;
  checkpointVersion: 1 | 2;
  generation: number;
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
    | 'compact';
  /** Persisted event identity. Legacy records derive one from their JSONL ordinal. */
  eventId?: string;
  timestamp: number;
  data: unknown;
}

/** Legacy payload stored in a SessionRecord of type `compact`. */
export interface CompactRecordDataV1 {
  version: 1;
  trigger: CompactTrigger;
  summary: string;
  preContextTokens?: number;
  preMessageCount?: number;
  boundary?: CompactBoundary;
  /** Full post-compact history (summary message + any retained tail). */
  replacementHistory: Message[];
}

/** Reference-aware compact payload; checkpoint fields are stored alongside legacy fields. */
export interface CompactRecordDataV2 extends ConversationCheckpointV2 {
  trigger: CompactTrigger;
  summary: string;
  preContextTokens?: number;
  preMessageCount?: number;
  boundary?: CompactBoundary;
  replacementHistory: Message[];
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
  /** Full visible conversation, including transcript-only local rows. */
  transcript: Message[];
  /** Active provider-facing projection after replaying compact records. */
  contextHistory: Message[];
  /** Compatibility alias for contextHistory. */
  history: Message[];
  compactBoundaries: CompactBoundary[];
  meta: SessionMeta;
}

export interface SessionHistoryEvent {
  eventId: string;
  ref: string;
  /** One-based JSONL record ordinal, including the session header. */
  ordinal: number;
  type: SessionRecord['type'];
  timestamp: number;
  data: unknown;
  text: string;
  toolNames?: string[];
}

export interface SessionEventReadOptions {
  refs?: string[];
  startOrdinal?: number;
  limit?: number;
  maxChars?: number;
}

export interface SessionEventSearchOptions {
  query: string;
  limit?: number;
  previewChars?: number;
  maxChars?: number;
}

/** Minimal interface for SessionStore, defined here to avoid circular imports. */
export interface SessionStoreInterface {
  create(meta: { cwd: string; name?: string; id?: string }): string;
  append(id: string, record: SessionRecord): void;
  patchMeta(id: string, patch: { name?: string }): void;
  touch(id: string): void;
  load(id: string): LoadedSession;
  copyEvents(sourceId: string, targetId: string): void;
  readEvents(id: string, options?: SessionEventReadOptions): SessionHistoryEvent[];
  searchEvents(id: string, options: SessionEventSearchOptions): SessionHistoryEvent[];
  list(): SessionMeta[];
  findByName(name: string): SessionMeta | undefined;
  findById(id: string): SessionMeta | undefined;
  mostRecentInCwd(cwd: string): SessionMeta | undefined;
  cleanup(days: number): number;
}

export interface HeadlessOptions {
  prompt?: string;
  inputFormat: InputFormat;
  outputFormat: OutputFormat;
  /** Compatibility alias for provider-facing context history. */
  history: Message[];
  /** Full visible transcript, when the host supports split projections. */
  transcript?: Message[];
  /** Active provider-facing history. */
  contextHistory?: Message[];
  compactBoundaries?: CompactBoundary[];
  mode: PermissionMode;
  maxTurns?: number;
  maxBudgetUsd?: number;
  verbose?: boolean;
  signal?: AbortSignal;
  stdout?: { write: (s: string) => boolean };
  stdin?: NodeJS.ReadableStream;
  jsonSchema?: Record<string, unknown>;
  sessionStore?: SessionStoreInterface;
  sessionId?: string;
  sessionName?: string;
  forkSession?: boolean;
  /** True when the host created this session before invoking runHeadless. */
  sessionCreated?: boolean;
  persistSession?: boolean;
  /** Emit hook lifecycle events as stream-json lines. */
  includeHookEvents?: boolean;
  /** Emit partial assistant text deltas as stream-json lines (default: true for stream-json). */
  includePartialMessages?: boolean;
  /** After completion, ask the model for follow-up prompt suggestions. */
  promptSuggestions?: boolean;
}

export interface HeadlessResult {
  messages: Message[];
  usage: Usage | null;
  costUsd?: number;
  sessionId?: string;
  structured?: unknown;
  structuredError?: string;
}
