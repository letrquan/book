export type PermissionMode = 'default' | 'auto' | 'plan' | 'accept-edits' | 'dontAsk' | 'bypassPermissions';

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
  execute: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

export interface ToolContext {
  workspaceRoot: string;
  env: Record<string, string>;
  /** Glob patterns to ignore during file discovery (e.g. from .gitignore). */
  gitignorePatterns?: string[];
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
}

export type OutputFormat = 'text' | 'json' | 'stream-json';
export type InputFormat = 'text' | 'stream-json';

export interface SessionRecord {
  type: 'user' | 'assistant' | 'tool_call' | 'tool_result' | 'usage' | 'session_meta';
  timestamp: number;
  data: unknown;
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
  sessionStore?: unknown; // SessionStore instance (typed loosely to avoid circular import)
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
