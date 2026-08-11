import type { ChildProcess } from 'child_process';
import type { CompactStrategy, ProviderModelConfig, ResolvedSettings } from '../settings.js';
import type { LoadedMemoryContext } from '../memory-store.js';

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
  /** Optional provider/model used only for historical conversation compaction. */
  compactModel?: string;
  /** Historical context reduction strategy selected for this runtime. */
  compactStrategy: CompactStrategy;
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
}
