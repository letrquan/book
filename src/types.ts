import type { ResolvedSettings } from './settings.js';

export type PermissionMode = 'default' | 'auto' | 'plan' | 'accept-edits' | 'dontAsk' | 'bypassPermissions';

/** What phase of retry is currently active (drives the TUI spinner label). */
export type RetryPhase = 'none' | 'transport' | 'stalled' | 'tool' | 'watchdog';

/**
 * Retry configuration — all tunables live here.
 * Mirrors Claude Code's env vars: CLAUDE_CODE_MAX_RETRIES, API_TIMEOUT_MS,
 * CLAUDE_CODE_RETRY_WATCHDOG, plus the stream-stall threshold.
 */
export interface RetryConfig {
  maxAttempts: number;         // default 10 (Claude Code default)
  baseDelayMs: number;         // default 1000
  maxDelayMs: number;          // default 30000
  totalBudgetMs: number;       // default 0 = no budget
  requestTimeoutMs: number;    // default 600000 (10 min)
  streamStallTimeoutMs: number;// default 20000 (20s, matches Claude Code)
  toolRetries: number;         // default 1
  watchdog: boolean;           // default false — CI mode: retry 429/529 indefinitely
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

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
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
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
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
}

export interface AgentConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTurns: number;
  maxTokens: number;
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
  flushMeta(id: string): void;
  load(id: string): { history: Message[]; meta: { id: string; name?: string; cwd: string; createdAt: number; updatedAt: number; messageCount: number } };
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
}

export interface HeadlessResult {
  messages: Message[];
  usage: Usage | null;
  costUsd?: number;
  sessionId?: string;
  structured?: unknown;
  structuredError?: string;
}
