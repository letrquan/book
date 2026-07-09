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
  mdInlineCodeBg: string;
  mdInlineCodeText: string;
  mdHeading: string;
  mdBlockquoteBorder: string;
  mdBlockquoteText: string;
  mdLink: string;
  mdListMarker: string;
  mdHr: string;

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

  diffAdded: 'green',
  diffRemoved: 'red',
  diffAddedWord: '#4caf50',
  diffRemovedWord: '#f44336',
  diffAddedDimmed: '#2e7d32',
  diffRemovedDimmed: '#c62828',

  usageMeter: 'cyan',
  usageMeterHigh: 'yellow',
  usageMeterCritical: 'red',

  shimmerPair: ['cyan', '#5cf'],

  subagentColors: ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'],

  mdCodeBackground: '#1a1a2e',
  mdCodeBorder: '#333',
  mdCodeText: '#e0e0e0',
  mdInlineCodeBg: '#2a2a3e',
  mdInlineCodeText: '#f0c040',
  mdHeading: 'white',
  mdBlockquoteBorder: '#555',
  mdBlockquoteText: '#aaa',
  mdLink: 'cyan',
  mdListMarker: 'gray',
  mdHr: 'gray',

  userBg: '#1a1a2e',
};

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type PermissionResult = 'allow' | 'deny' | 'always';

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
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  timestamp: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
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
  /** Agent todo list — written by TodoWrite, read by the loop for context injection. */
  todos?: Array<{ content: string; status: string; activeForm?: string }>;
  /** Agent task list — written by TaskCreate/TaskUpdate and shared across tool calls. */
  tasks?: AgentTask[];
  /** Background shells started by Bash(run_in_background), shared across tool calls. */
  backgroundShells?: BackgroundShellStore;
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
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTurns: number;
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
  /** Called when the context approaches its limit; returns a compacted history. */
  onCompact?: (history: Message[], usage: Usage | null) => Promise<Message[]>;
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

export interface SessionRecord {
  type: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'usage' | 'session_meta';
  timestamp: number;
  data: unknown;
}

/** Minimal interface for SessionStore, defined here to avoid circular imports. */
export interface SessionStoreInterface {
  create(meta: { cwd: string; name?: string }): string;
  append(id: string, record: SessionRecord): void;
  load(id: string): {
    history: Message[];
    meta: {
      id: string;
      name?: string;
      cwd: string;
      createdAt: number;
      updatedAt: number;
      messageCount: number;
    };
  };
  findByName(name: string): { id: string } | undefined;
  findById(id: string): { id: string } | undefined;
  mostRecentInCwd(cwd: string): { id: string } | undefined;
  cleanup(days: number): number;
}

export interface HeadlessOptions {
  prompt?: string;
  inputFormat: InputFormat;
  outputFormat: OutputFormat;
  history: Message[];
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
