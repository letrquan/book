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

export interface AgentRunAmbientSnapshot {
  readonly schemaVersion: 2;
  readonly fingerprint: string;
  readonly capturedAt: number;
  readonly model: {
    readonly provider: string;
    readonly requestedModel: string;
    readonly modelSelection?: string;
    readonly endpointFingerprint: string;
    readonly effort?: string;
    readonly maxTokens: number;
    readonly maxTurns?: number;
    readonly modelInfoFingerprint: string;
  };
  readonly settings: {
    readonly fingerprint: string;
    readonly agentsMode: 'adaptive' | 'manual' | 'off';
  };
  readonly tools: {
    readonly fingerprint: string;
    readonly count: number;
    readonly names: readonly string[];
    readonly activationState: 'fresh' | 'unverified';
  };
  readonly commands: {
    readonly fingerprint: string;
    readonly count: number;
    readonly names: readonly string[];
  };
  readonly skills: {
    readonly fingerprint: string;
    readonly count: number;
    readonly names: readonly string[];
    readonly activationState: 'disabled' | 'not-captured';
  };
  readonly mcp: {
    readonly fingerprint: string;
    readonly count: number;
    readonly names: readonly string[];
  };
  readonly agents: {
    readonly fingerprint: string;
    readonly count: number;
    readonly names: readonly string[];
    readonly mode: 'adaptive' | 'manual' | 'off';
  };
  readonly prompt: {
    readonly fingerprint: string;
    readonly systemPromptVersion: string;
    readonly date: string;
    readonly projectInstructionCount: number;
  };
  readonly memory: {
    readonly fingerprint: string;
    readonly enabled: boolean;
    readonly indexLoaded: boolean;
  };
  readonly policies: {
    readonly permissionMode: import('./runtime.js').PermissionMode;
    readonly hooksFingerprint: string;
    readonly contextFingerprint: string;
    readonly networkFingerprint: string;
    readonly delegationFingerprint: string;
  };
  readonly runtime: {
    readonly packageVersion: string;
    readonly runtimeRevision: string;
    readonly fixtureRevision: string;
    readonly randomSeed: string;
    readonly nodeVersion: string;
    readonly platform: NodeJS.Platform;
    readonly architecture: string;
    readonly timezone: string;
    readonly environmentFingerprint: string;
    readonly workspaceFingerprint: string;
  };
  readonly bookHome: {
    readonly pathFingerprint: string;
    readonly isolation: 'shared' | 'configured' | 'isolated';
    readonly contentsFingerprint?: string;
    readonly contentsStatus: 'not-captured' | 'captured' | 'incomplete';
    readonly fileCount?: number;
    readonly totalBytes?: number;
  };
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
  readonly ambient?: AgentRunAmbientSnapshot;
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
