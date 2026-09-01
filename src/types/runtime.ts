import type { ChildProcess } from 'child_process';
import type { CompactStrategy, ProviderModelConfig, ResolvedSettings } from '../settings.js';
import type { LoadedMemoryContext } from '../memory-store.js';
import type { AuthProfileInputs } from './auth.js';

export type PermissionMode =
  'default' | 'auto' | 'plan' | 'accept-edits' | 'dontAsk' | 'bypassPermissions';

/**
 * A command resolved to a direct argv spawn — no intermediate shell parses it.
 *
 * Sandboxed commands must use this form: joining a wrapper into one string and
 * spawning it with `shell: true` lets any metacharacter in the user's command
 * split at the *outer* shell, outside the sandbox. Callers that receive an
 * `exec` spawn `file` with `args` and `shell: false`; when it is absent the raw
 * command string goes to the platform shell as before.
 */
export interface CommandExecution {
  file: string;
  args: string[];
}

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
  /**
   * Re-sends of a turn after a transport failure that left the work intact.
   * Optional, and absent means 0 — a caller that builds a RetryConfig by hand
   * keeps the original end-the-run-on-any-stream-error behavior rather than
   * silently inheriting a retry policy it never asked for.
   */
  streamReissueAttempts?: number;
  /**
   * Continuations allowed after the provider's output cap, budgeted separately
   * from transport faults so a large generated file cannot drain the allowance a
   * real socket drop needs. Optional, and absent means 0.
   */
  outputCapContinuations?: number;
  /** Stall ceiling while the model is thinking; absent falls back to the chat one. */
  thinkingStallTimeoutMs?: number;
}

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

export type BackgroundShellStatus =
  'starting' | 'running' | 'stopping' | 'exited' | 'failed' | 'killed' | 'timed_out' | 'lost';

export type BackgroundShellLifetime = 'session' | 'persistent';
export type BackgroundShellNotify = 'none' | 'ui' | 'agent';

export interface BackgroundShellRecord {
  id: string;
  command: string;
  effectiveCommand: string;
  title?: string;
  workdir: string;
  pid?: number;
  runnerPid?: number;
  process?: ChildProcess;
  status: BackgroundShellStatus;
  lifetime?: BackgroundShellLifetime;
  notify?: BackgroundShellNotify;
  output: string;
  readOffset: number;
  truncatedBytes: number;
  outputRevision?: number;
  completionSequence?: number;
  completionAcknowledgedSequence?: number;
  completionDeliveredSequence?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | string | null;
  startedAt: number;
  finishedAt?: number;
  timeoutMs?: number;
  deadlineAt?: number;
  parentSessionId?: string;
  rootRunId?: string;
  parentRunId?: string;
  persistentRecordPath?: string;
  persistentControlPath?: string;
  persistentOutputPath?: string;
  persistentOutputRotationSequence?: number;
  controlToken?: string;
  timer?: NodeJS.Timeout;
  retentionTimer?: NodeJS.Timeout;
  sandboxed?: boolean;
}

export interface BackgroundShellStore {
  nextId: number;
  shells: Map<string, BackgroundShellRecord>;
}

export interface AgentConfig {
  /** May be empty until an interactive user adds a BYOK provider. */
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Raw picker/settings reference, including provider prefix when configured. */
  modelSelection?: string;
  /**
   * Set when the model id carries a `<prefix>/` matching no configured provider,
   * so the run fell back to the default endpoint. Reported rather than thrown:
   * the same spelling is a legitimate vendor-namespaced model id.
   */
  modelProviderWarning?: string;
  /** Optional provider/model used only for historical conversation compaction. */
  compactModel?: string;
  /** Supported production context-reduction strategy. */
  compactStrategy: CompactStrategy;
  /** Explicit capability gate for the experimental Zero-Mem runtime. */
  experimentalZeroMem: boolean;
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
  /**
   * Base URL to restore for a plain model selection while an auth profile is
   * active. Kept apart from `defaultBaseUrl` because that value is what a named
   * `provider.<id>` entry inherits when it declares none, and such an entry
   * must not inherit the subscription vendor's endpoint - it would post its own
   * API key there.
   */
  defaultProfileBaseUrl?: string;
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
  /**
   * Run-scoped harness workflow selection (`--harness-workflow`). It outranks
   * `settings.harness.workflow` and is never persisted; a resumed process
   * starts again from the settings value.
   */
  harnessWorkflowOverride?: string;
  /** Retry configuration (from settings.json + env vars). */
  retry: RetryConfig;
  /** Thinking effort level (Anthropic adaptive thinking / output_config.effort). */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Explicit provider override: 'anthropic' | 'openai' | 'auto' (default: auto-detect). */
  provider?: 'anthropic' | 'openai' | 'auto';
  /** Metadata from settings.provider.<id>.models.<model>, if selected. */
  modelInfo?: ProviderModelConfig;
  /**
   * Active subscription auth profile id, resolved once at config load. Unset
   * means API-key auth; see `src/auth/selection.ts`.
   */
  authProfile?: string;
  /**
   * Inputs that decided the auth-derived endpoint/model, retained so a login
   * performed *during* a session can re-run the same precedence rather than
   * re-deriving it from values the resolved config has already flattened.
   *
   * Required, not optional: the obvious fallback for an absent value is
   * `defaultProvider`, which is the *resolved* transport rather than the
   * `BOOK_PROVIDER` override — substituting one for the other would let an
   * Anthropic subscription token be spent through the OpenAI-compatible
   * transport. Every constructor must say what the inputs were.
   */
  authInputs: AuthProfileInputs;
  /** Approved memory snapshot loaded once at session start. */
  memoryContext?: LoadedMemoryContext;
}
