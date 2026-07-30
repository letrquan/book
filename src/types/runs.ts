export type AgentRunSource = 'tui' | 'headless' | 'sdk' | 'internal';

export type AgentModelIdentityStatus = 'verified' | 'requested_only' | 'unverifiable';

export interface AgentModelIdentity {
  readonly provider: string;
  readonly requestedModel: string;
  readonly responseModel?: string;
  readonly responseId?: string;
  readonly finishReasons?: readonly string[];
  readonly status: AgentModelIdentityStatus;
}

export interface AgentRunAccounting {
  readonly rootRunIds: readonly string[];
  readonly runIds: readonly string[];
  readonly directUsage: import('./messages.js').Usage | null;
  readonly inclusiveUsage: import('./messages.js').Usage | null;
  readonly costUsd: number | null;
  readonly costStatus: 'known' | 'estimated' | 'unknown';
  readonly pricingVersion: string;
  readonly unknownModels: readonly string[];
  readonly budgetUsd?: number;
  readonly budgetStatus: 'not_configured' | 'within' | 'exceeded' | 'unknown';
  readonly modelIdentities: readonly AgentModelIdentity[];
  readonly completeness: 'partial' | 'complete';
  readonly missingSources: readonly string[];
}

/** Runtime attribution for one user request or a linked child execution. */
export interface AgentRunContext {
  /** Unique execution identity. A resumed request receives a new value. */
  readonly runId: string;
  /** Root request identity shared by linked child executions. */
  readonly rootRunId: string;
  /** Parent execution for a child continuation or managed agent. */
  readonly parentRunId?: string;
  /** Previous run when a host resumes a request/session. */
  readonly resumedFromRunId?: string;
  readonly sessionId: string;
  readonly source: AgentRunSource;
  readonly startedAt: number;
}

export interface AgentRunResult {
  readonly context: AgentRunContext;
  readonly outcome: import('./terminal.js').AgentTerminalOutcome;
  readonly usage: import('./messages.js').Usage | null;
  readonly accounting?: AgentRunAccounting;
}

export function createAgentRunContext(options: {
  sessionId: string;
  source?: AgentRunSource;
  runId?: string;
  rootRunId?: string;
  parentRunId?: string;
  resumedFromRunId?: string;
  startedAt?: number;
}): AgentRunContext {
  const runId = options.runId ?? crypto.randomUUID();
  return Object.freeze({
    runId,
    rootRunId: options.rootRunId ?? runId,
    parentRunId: options.parentRunId,
    resumedFromRunId: options.resumedFromRunId,
    sessionId: options.sessionId,
    source: options.source ?? 'internal',
    startedAt: options.startedAt ?? Date.now(),
  });
}
