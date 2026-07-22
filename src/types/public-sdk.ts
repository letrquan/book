import type { AgentEvent } from '../session/agent-events.js';
import type { StreamJsonEvent } from '../stream-json.js';
import type { Message, Usage } from './messages.js';
import type { PermissionMode } from './runtime.js';
import type { CompactBoundary, SessionStoreInterface } from './sessions.js';
import type { UserQuestionHandler } from './tools.js';

export type OutputFormat = 'text' | 'json' | 'stream-json';

export type InputFormat = 'text' | 'stream-json';

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
  /** Stream-JSON event bridge used by wire-format embedding hosts. */
  onEvent?: (event: StreamJsonEvent) => void;
  /** Shared agent event bridge used by SDK hosts before wire-format encoding. */
  onAgentEvent?: (event: AgentEvent) => void;
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
