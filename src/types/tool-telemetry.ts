import type { ToolResultStatus } from './tools.js';

/**
 * One persisted record per finalized tool call. Written to a machine-readable
 * JSONL log so tool use can be inspected and measured across sessions, separate
 * from the ephemeral in-session `toolCallStats` counters that feed `/usage`.
 *
 * Records are captured at the final-status choke point in the agent loop, after
 * plan-approval / user-question / PostToolUse mutations can flip a result's
 * status — so `status` and `isFailure` reflect the outcome the model actually saw.
 */
export interface ToolUseRecord {
  /** Wall-clock time the record was captured (ms since epoch). */
  ts: number;
  /** Session trace id (`SessionRuntime.traceId`); distinct per logical session. */
  session: string;
  /** Canonical tool name (PascalCase). */
  tool: string;
  /** Final result status the model observed. */
  status: ToolResultStatus;
  /**
   * True only for genuine reliability failures (`error` / `timed_out`). Blocked
   * (permission denial, plan-mode, user decline) and cancelled outcomes are not
   * failures and must never inflate the fail rate.
   */
  isFailure: boolean;
  /** Structured error code when the call failed; omitted on success/blocked. */
  errorCode?: string;
  /** Execution wall time in ms when measured. */
  durationMs?: number;
  /** Retries beyond the first attempt (0 when the first attempt succeeded). */
  retries: number;
  /** Model that issued the call. */
  model: string;
  /** True when the call was issued by a subagent (Task tool) rather than the root loop. */
  subagent: boolean;
  /** Managed-agent role when the call originated from one (explorer/patcher/…). */
  agentRole?: string;
}

/** Per-tool rollup produced by {@link aggregateToolUse}. */
export interface ToolStatRow {
  tool: string;
  calls: number;
  failures: number;
  /** failures / calls, 0..1. */
  failRate: number;
  /** Median execution time across timed calls, if any. */
  p50Ms?: number;
  /** 95th-percentile execution time across timed calls, if any. */
  p95Ms?: number;
  /** Calls that needed at least one retry. */
  retried: number;
  /** retried / calls, 0..1. */
  retryRate: number;
  /** Error-code histogram for this tool's failures. */
  errorCodes: Record<string, number>;
}

/** Per-model rollup produced by {@link aggregateToolUse}. */
export interface ModelStatRow {
  model: string;
  calls: number;
  failures: number;
  failRate: number;
}

/** Full aggregate over a set of {@link ToolUseRecord}s. */
export interface ToolUseAggregate {
  totalCalls: number;
  totalFailures: number;
  /** Distinct session ids observed. */
  sessions: number;
  /** Earliest / latest record timestamps, if any records were present. */
  firstTs?: number;
  lastTs?: number;
  /** Per-tool rows, failing tools first. */
  tools: ToolStatRow[];
  /** Per-model rows, most calls first. */
  models: ModelStatRow[];
  /** Global error-code histogram, most frequent first. */
  errorCodes: Array<{ code: string; count: number }>;
}
