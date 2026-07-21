import type { ChildProcess } from 'child_process';
import type { ProviderModelConfig, ResolvedSettings } from './settings.js';
import type { LoadedMemoryContext } from './memory-store.js';
import type { StreamJsonEvent } from './stream-json.js';

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

  /** Shared TUI chrome */
  surface: string;
  surfaceActive: string;
  border: string;
  selectionText: string;
  userAccent: string;
  assistantAccent: string;
  toolRail: string;

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
  brand: '#AFC19D',
  brandShimmer: '#C4D3B5',
  text: '#E7E1D4',
  inverseText: '#171815',
  inactive: '#6D6961',
  subtle: '#938E84',
  suggestion: '#7E7A72',
  permission: '#D1AA6C',
  remember: '#C09CAD',

  surface: '#20221D',
  surfaceActive: '#30362B',
  border: '#4B4D45',
  selectionText: '#F3EEE4',
  userAccent: '#D3A17E',
  assistantAccent: '#AFC19D',
  toolRail: '#6B7164',

  success: '#91B77C',
  error: '#D68174',
  warning: '#D1AA6C',
  merged: '#91B77C',

  promptBorder: '#AFC19D',
  planMode: '#C09CAD',
  autoAccept: '#91B77C',
  bashBorder: '#D1AA6C',

  modeDefault: '#AFC19D',
  modePlan: '#C09CAD',
  modeAcceptEdits: '#91B77C',
  modeAuto: '#7FA89C',
  modeDontAsk: '#D68174',
  modeBypass: '#D1AA6C',

  diffAdded: '#243326',
  diffRemoved: '#382624',
  diffAddedWord: '#36523A',
  diffRemovedWord: '#5B3430',
  diffAddedDimmed: '#1D2B20',
  diffRemovedDimmed: '#302120',

  usageMeter: '#AFC19D',
  usageMeterHigh: '#D1AA6C',
  usageMeterCritical: '#D68174',

  shimmerPair: ['#AFC19D', '#C4D3B5'],

  subagentColors: [
    '#D68174',
    '#7FA89C',
    '#91B77C',
    '#D1AA6C',
    '#C09CAD',
    '#D3A17E',
    '#B88FA4',
    '#AFC19D',
  ],

  mdCodeBackground: '#1B1D1A',
  mdCodeBorder: '#4B4D45',
  mdCodeText: '#E7E1D4',
  mdCodeKeyword: '#C09CAD',
  mdCodeString: '#91B77C',
  mdCodeComment: '#938E84',
  mdCodeNumber: '#D1AA6C',
  mdCodeFunction: '#AFC19D',
  mdCodeLineNumber: '#6D6961',
  mdInlineCodeBg: '#2B2C27',
  mdInlineCodeText: '#D3A17E',
  mdHeading: '#E7E1D4',
  mdHeadingH1: '#AFC19D',
  mdHeadingH2: '#C4D3B5',
  mdBlockquoteBorder: '#6B7164',
  mdBlockquoteText: '#938E84',
  mdLink: '#AFC19D',
  mdListMarker: '#D3A17E',
  mdHr: '#4B4D45',
  mdTableBorder: '#4B4D45',
  mdThinkBg: '#20221D',
  mdThinkBorder: '#4B4D45',
  mdThinkText: '#938E84',
  mdTurnSeparator: '#6B7164',
  mdCheckboxChecked: '#91B77C',
  mdCheckboxUnchecked: '#6D6961',

  userBg: '#2A231F',
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

export type PermissionResult = 'allow' | 'deny' | 'always';
export type PlanApprovalResult = 'approve' | 'reject' | { decision: 'revise'; feedback: string };

export interface UserQuestionOption {
  label: string;
  description: string;
}

export interface UserQuestion {
  question: string;
  header: string;
  options: UserQuestionOption[];
  multiSelect: boolean;
}

export type UserQuestionSource =
  { kind: 'root'; traceId?: string } | { kind: 'subagent'; agentPath: string[]; traceId?: string };

export interface UserQuestionRequest {
  id: string;
  questions: UserQuestion[];
  source: UserQuestionSource;
}

export type UserQuestionResponse =
  | { action: 'answer'; answers: Record<string, string | string[]> }
  | { action: 'decline'; message?: string }
  | { action: 'cancel'; message?: string };

export type UserQuestionHandler = (
  request: UserQuestionRequest,
  context: { signal?: AbortSignal },
) => Promise<UserQuestionResponse>;

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

export type ToolResultStatus = 'success' | 'error' | 'blocked' | 'cancelled' | 'timed_out';

export interface ToolResultError {
  code: string;
  message: string;
  retryable: boolean;
  remediation?: string;
  details?: Record<string, unknown>;
}

export interface ToolResultPresentation {
  kind: 'text' | 'markdown' | 'diff' | 'file' | 'command' | 'search' | 'task' | 'agent';
  summary: string;
  details?: string;
  metadata?: string[];
  target?: string;
}

export interface ToolResultArtifacts {
  fileMutation?: FileMutationSummary;
  fileObservations?: FileObservation[];
  eventRef?: string;
}

/** V2 result contract shared by runtime, persistence, SDK, and TUI. */
export interface ToolResult<TData = unknown> {
  version: 2;
  toolCallId: string;
  status: ToolResultStatus;
  /** Concise provider-facing content. */
  content: string;
  /** Machine-readable payload for consumers that should not parse content. */
  data?: TData;
  structuredError?: ToolResultError;
  presentation?: ToolResultPresentation;
  metrics?: {
    durationMs?: number;
    retryAttempt?: number;
  };
  artifacts?: ToolResultArtifacts;
  pagination?: {
    cursor?: string;
    nextCursor?: string;
    truncated?: boolean;
    omittedItems?: number;
    omittedBytes?: number;
  };
}

/** JSON-schema subset accepted by provider tool definitions. */
export interface JsonSchemaObject extends Record<string, unknown> {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  title?: string;
  description?: string;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaObject;
  items?: JsonSchemaObject;
  enum?: Array<string | number | boolean | null>;
  const?: string | number | boolean | null;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  oneOf?: JsonSchemaObject[];
  anyOf?: JsonSchemaObject[];
}

export type ToolCategory =
  | 'filesystem'
  | 'shell'
  | 'git'
  | 'web'
  | 'planning'
  | 'tasks'
  | 'skills'
  | 'agents'
  | 'evidence'
  | 'session'
  | 'notebook'
  | 'mcp'
  | 'other';

export type ToolEffect = 'read' | 'write' | 'execute' | 'network' | 'delegate' | 'interactive';

export interface ToolCatalogMetadata {
  /** Search terms in addition to the canonical tool name. */
  aliases?: string[];
  keywords?: string[];
  category?: ToolCategory;
  namespace?: string;
  /** Tool is always available in the practical core, normally deferred, or runtime-gated. */
  exposure?: 'core' | 'deferred' | 'runtime';
  /** Agent roles allowed to discover and invoke this definition. */
  roles?: Array<'root' | 'child'>;
  effects?: ToolEffect[];
  /** Optional runtime predicate for stateful tools such as background shells. */
  available?: (context: ToolContext) => boolean;
  /** Short catalog summary; descriptions remain the full provider-facing guidance. */
  summary?: string;
}

export interface ToolPolicy {
  idempotent?: boolean;
  concurrency?: 'parallel' | 'serial';
  requiresPermission?: boolean;
}

export type FileObservationOperation =
  'read' | 'mention' | 'edit' | 'write' | 'create' | 'notebook-read';

export interface FileObservation {
  path: string;
  workspaceId: string;
  sha256: string;
  byteSize: number;
  lineStart?: number;
  lineEnd?: number;
  operation: FileObservationOperation;
  sourceRef: string;
  timestamp: number;
}

/**
 * Structured presentation data for local slash-command output.
 *
 * These snapshots stay UI-only: local command messages are excluded from the
 * provider context and are never persisted as assistant turns.
 */
export interface ConfigCommandDisplay {
  kind: 'config';
  snapshot: Record<string, unknown>;
  runtime: {
    model: string;
    provider: string;
    effort?: string;
    mode: string;
    maxTokens: number;
    workspace: string;
  };
}

export interface ContextCommandDisplay {
  kind: 'context';
  model: string;
  maxTokens: number;
  estimatedTokens: number;
  totalMessages: number;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  userTokens: number;
  assistantTokens: number;
  ambient: {
    commandCount: number;
    skillCount?: number;
    subagentCount?: number;
    hasMemoryIndex?: boolean;
    hasClaudeMdLoader: boolean;
  };
}

export interface UsageCommandDisplay {
  kind: 'usage';
  model: string;
  currentTurn: number;
  messageCount: number;
  turnDurationMs: number;
  usage: Usage | null;
  rate?: { inputPerMillion: number; outputPerMillion: number };
  estimatedCostUsd?: number;
}

export type LocalCommandDisplay =
  ConfigCommandDisplay | ContextCommandDisplay | UsageCommandDisplay;

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  /** User-facing text shown in the TUI/history. */
  content: string;
  /** Provider-facing text when it differs from the displayed content. */
  contextContent?: string;
  /** Whether this message is included in provider and compaction context. */
  includeInContext: boolean;
  kind?: 'conversation' | 'checkpoint' | 'local';
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  /** UI-only subagent activity. Never serialized as provider tool calls. */
  nestedToolInvocations?: NestedToolInvocation[];
  /** UI-only visual treatment for local slash-command output. */
  localCommand?: LocalCommandDisplay;
  fileObservations?: FileObservation[];
  timestamp: number;
}

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

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** Typed provider schema. `parameters` remains accepted while tools migrate. */
  inputSchema?: JsonSchemaObject;
  catalog?: ToolCatalogMetadata;
  policy?: ToolPolicy;
  /** When true, the tool is safe to retry once on transient failure (Read, Grep, WebFetch, etc.). */
  idempotent?: boolean;
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
  /** Agent todo list — written by TodoWrite, read by the loop for context injection. */
  todos?: Array<{ content: string; status: string; activeForm?: string }>;
  /** Agent task list — written by TaskCreate/TaskUpdate and shared across tool calls. */
  tasks?: AgentTask[];
  /** Background shells started by Bash(run_in_background), shared across tool calls. */
  backgroundShells?: BackgroundShellStore;
  /** Runtime-only newest file observation per workspace/path. */
  fileObservationLedger?: Map<string, FileObservation>;
  /** Live permission mode for the active agent loop; tools may update this. */
  currentMode?: PermissionMode;
  /** Mode to restore after a tool-initiated plan-mode session exits. */
  previousMode?: PermissionMode;
  /** Plan text submitted by ExitPlanMode and awaiting host approval. */
  pendingPlanApproval?: { plan: string };
  /** Structured questions submitted by AskUserQuestion and awaiting the host. */
  pendingUserQuestion?: { questions: UserQuestion[] };
  /** Host interaction capability propagated into Task subagents. */
  userQuestionHandler?: UserQuestionHandler;
  /** Nested agent names from the root agent to this loop. */
  agentPath?: string[];
  /** Active definitions used to derive a child's capability intersection. */
  availableTools?: ToolDefinition[];
  /** Managed-agent runtime shared by the parent session. */
  agentManager?: import('./agents/manager.js').AgentManager;
  /** Identity set only inside a managed child. */
  agentId?: string;
  agentRole?: import('./agents/types.js').AgentRole;
  /** Parent session attribution for managed agents and hooks. */
  parentSessionId?: string;
  /** Host sink for managed-agent lifecycle and evidence events. */
  onAgentEvent?: (event: import('./agents/types.js').AgentRuntimeEvent) => void;
  /** Host sink used by lifecycle hooks started from managed-agent tools. */
  onHookEvent?: (event: string, payload: Record<string, unknown>) => void;
  /** Per-session capability/discovery controller installed by the agent loop. */
  toolDiscovery?: ToolDiscoveryContext;
}

export interface ToolSearchMatch {
  name: string;
  description: string;
  summary: string;
  category: ToolCategory;
  namespace?: string;
  loaded: boolean;
}

export interface ToolDiscoveryContext {
  /** Return authorized catalog matches without exposing their full schemas. */
  search(
    query: string,
    category?: ToolCategory,
    namespace?: string,
    limit?: number,
  ): ToolSearchMatch[];
  /** Activate selected definitions for the next provider request. */
  activate(names: string[]): string[];
  /** Intersect the current surface with an additional command/skill capability policy. */
  restrict(rules: string[]): void;
  /** Whether a tool is currently visible and executable for this turn. */
  canExecute(call: ToolCall): boolean;
  /** Definitions to send to the provider for the current request. */
  activeDefinitions(): ToolDefinition[];
  /** Compact catalog text used by the system prompt. */
  catalogSummary(): string;
}

export interface ToolDiscoveryState {
  /** Monotonic access counter used for deterministic LRU eviction. */
  clock: number;
  loaded: Map<string, number>;
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
  /** Settings-layer context retained for live TUI re-resolution. */
  settingsContext?: {
    overridePath?: string;
    noSettings?: boolean;
  };
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
  /** Runtime-only newest file observation per workspace/path. */
  fileObservationLedger?: Map<string, FileObservation>;
  /** Runtime-only managed-agent service, lazily created by agent tools. */
  agentManager?: import('./agents/manager.js').AgentManager;
  /** Runtime-only discovered definitions retained across turns in this session. */
  toolDiscoveryState?: ToolDiscoveryState;
}

export interface ProviderStreamEvent {
  type: 'text' | 'tool_call' | 'done' | 'error';
  content?: string;
  toolCall?: ToolCall;
  error?: string;
  usage?: Usage;
}

export interface ProviderStreamOptions {
  signal?: AbortSignal;
  onRetry?: (attempt: number, max: number, delayMs: number) => void;
  onStreamStall?: (countdownMs: number) => void;
  onStreamResume?: () => void;
  maxOutputTokens?: number;
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
  /** Called when the root agent or a Task subagent needs structured user input. */
  onUserQuestionRequired?: UserQuestionHandler;
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
  /** Called for managed-agent lifecycle, evidence, and application events. */
  onAgentEvent?: (event: import('./agents/types.js').AgentRuntimeEvent) => void;
}

export type OutputFormat = 'text' | 'json' | 'stream-json';
export type InputFormat = 'text' | 'stream-json';

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
  history: Message[];
  transcript?: Message[];
  compactBoundaries?: CompactBoundary[];
  mode: PermissionMode;
  maxTurns?: number;
  maxBudgetUsd?: number;
  verbose?: boolean;
  signal?: AbortSignal;
  stdout?: { write: (s: string) => boolean };
  stdin?: NodeJS.ReadableStream;
  /** Maximum accepted stream-json input record size. */
  maxInputLineBytes?: number;
  /** Direct runtime event bridge used by embedding hosts before output encoding. */
  onEvent?: (event: StreamJsonEvent) => void;
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
  /** Optional interactive host callback for AskUserQuestion. */
  onUserQuestionRequired?: UserQuestionHandler;
}

export interface HeadlessResult {
  messages: Message[];
  transcript?: Message[];
  compactBoundaries?: CompactBoundary[];
  usage: Usage | null;
  costUsd?: number;
  sessionId?: string;
  structured?: unknown;
  structuredError?: string;
}
