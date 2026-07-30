import type { AgentEvent } from '../session/agent-events.js';
import type { StreamJsonEvent } from '../stream-json.js';
import type { Message, Usage } from './messages.js';
import type { PermissionMode } from './runtime.js';
import type { CompactBoundary, SessionStoreInterface } from './sessions.js';
import type { UserQuestionHandler } from './tools.js';
import type { AgentTerminalOutcome } from './terminal.js';
import type { AgentRunAccounting, AgentRunResult, AgentRunSource } from './runs.js';

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
  /** Forward high-volume managed-agent text deltas. Defaults to false. */
  forwardSubagentText?: boolean;
  /** After completion, ask the model for follow-up prompt suggestions. */
  promptSuggestions?: boolean;
  /** Optional interactive host callback for AskUserQuestion. */
  onUserQuestionRequired?: UserQuestionHandler;
  /** Host surface used for run attribution; defaults to headless. */
  runSource?: AgentRunSource;
  /** Link the first request to a prior run when resuming a session. */
  resumedFromRunId?: string;
}

export interface HeadlessResult {
  messages: Message[];
  transcript?: Message[];
  compactBoundaries?: CompactBoundary[];
  usage: Usage | null;
  outcome: AgentTerminalOutcome;
  /** Per-request and linked-child outcomes; the aggregate fields remain for compatibility. */
  runs?: AgentRunResult[];
  costUsd?: number;
  accounting?: AgentRunAccounting;
  sessionId?: string;
  structured?: unknown;
  structuredError?: string;
}
