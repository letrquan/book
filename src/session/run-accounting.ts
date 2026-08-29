import {
  estimateUsageCost,
  hasKnownPricing,
  PRICING_VERSION,
  type UsageCostEstimate,
} from '../pricing.js';
import type { Usage } from '../types/messages.js';
import type { ProviderResponseMetadata } from '../types/providers.js';
import type { AgentModelIdentity, AgentRunAccounting, AgentRunContext } from '../types/runs.js';

type BudgetStatus = AgentRunAccounting['budgetStatus'];

/**
 * The identity of a model call, ignoring which response it came from.
 *
 * Deliberately excludes `responseId`: the only consumer of `modelIdentities` is
 * the harness eligibility fingerprint, which already discards it and hashes
 * exactly this tuple. Keying on it instead bounds the retained set.
 */
/** Restored spend across every root, so an aggregate snapshot counts it once each. */
function mergeCarried(roots: readonly RootState[]): CarriedSpend | undefined {
  const carried = roots.map((root) => root.carried).filter((value) => value !== undefined);
  if (carried.length === 0) return undefined;
  let usage: Usage | null = null;
  let costUsd: number | null = 0;
  for (const entry of carried) {
    if (entry.usage) usage = addUsage(usage, entry.usage);
    // One unpriceable carry makes the whole aggregate unpriceable, which is the
    // fail-closed direction for anything a budget is compared against.
    if (entry.costUsd === null) costUsd = null;
    else if (costUsd !== null) costUsd += entry.costUsd;
  }
  return { usage, costUsd };
}

/** The single budget shared by these roots, or undefined if they disagree. */
function distinctBudget(roots: readonly RootState[]): number | undefined {
  const defined = new Set<number>();
  for (const root of roots) {
    if (root.budgetUsd !== undefined) defined.add(root.budgetUsd);
  }
  return defined.size === 1 ? [...defined][0] : undefined;
}

function modelIdentityKey(identity: AgentModelIdentity): string {
  // JSON rather than a joined string: a separator character could occur inside a
  // model or provider name and collide two distinct identities into one key.
  return JSON.stringify([
    identity.provider,
    identity.requestedModel,
    identity.responseModel ?? '',
    identity.status,
  ]);
}

interface ExecutionState {
  readonly context: AgentRunContext;
  usage: Usage | null;
  costUsd: number | null;
  costStatus: 'known' | 'estimated' | 'unknown';
  readonly unknownModels: Set<string>;
  /**
   * Distinct model identities, keyed by the tuple consumers actually read.
   *
   * This used to be an array deduped on `responseId`, which grew one entry per
   * provider response, per retry, and per compaction — and the predicate could
   * never match for an identity with no `responseId`, so those were appended
   * unconditionally. Both `record()` and `makeSnapshot()` then linear-scanned it
   * per element, and `makeSnapshot` runs inside `checkBeforeModelCall` before
   * every model call: quadratic work on the hot path of the spend rail, measured
   * at 8.4 s per call by 40k responses. Keyed by identity rather than by
   * response, the set is bounded by the number of distinct model/provider/status
   * combinations — a handful — and the only consumer, the harness fingerprint,
   * already discards `responseId`.
   */
  readonly modelIdentities: Map<string, AgentModelIdentity>;
  readonly missingSources: Set<string>;
}

interface RootState {
  readonly rootRunId: string;
  budgetUsd?: number;
  /**
   * Spend from earlier processes working the same objective, restored at
   * bootstrap. Without it `roots` is rebuilt with the process, so forty restarts
   * is forty independent caps and `--max-budget-usd` means "for this process"
   * rather than "for this objective".
   */
  carried?: CarriedSpend;
  readonly executions: Map<string, ExecutionState>;
}

export interface CarriedSpend {
  usage: Usage | null;
  /** Null when a prior process could not price some of its spend. */
  costUsd: number | null;
}

function addUsage(current: Usage | null, next: Usage): Usage {
  return {
    promptTokens: (current?.promptTokens ?? 0) + next.promptTokens,
    completionTokens: (current?.completionTokens ?? 0) + next.completionTokens,
    totalTokens: (current?.totalTokens ?? 0) + next.totalTokens,
    contextTokens: next.contextTokens ?? current?.contextTokens,
    cacheCreationInputTokens:
      (current?.cacheCreationInputTokens ?? 0) + (next.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens: (current?.cacheReadInputTokens ?? 0) + (next.cacheReadInputTokens ?? 0),
  };
}

function identityFor(
  metadata: ProviderResponseMetadata,
  quote: UsageCostEstimate,
): AgentModelIdentity {
  return {
    provider: metadata.provider,
    requestedModel: metadata.requestedModel,
    responseModel: metadata.responseModel,
    responseId: metadata.responseId,
    finishReasons: metadata.finishReasons,
    status: metadata.responseModel
      ? 'verified'
      : quote.status === 'known'
        ? 'requested_only'
        : 'unverifiable',
  };
}

function mergeCostStatus(
  current: ExecutionState['costStatus'],
  next: UsageCostEstimate,
  identity: AgentModelIdentity,
): ExecutionState['costStatus'] {
  if (current === 'unknown' || next.status === 'unknown' || identity.status === 'unverifiable') {
    return 'unknown';
  }
  if (current === 'estimated' || identity.status === 'requested_only') return 'estimated';
  return 'known';
}

function missingUsageIdentity(metadata: ProviderResponseMetadata): AgentModelIdentity {
  return {
    provider: metadata.provider,
    requestedModel: metadata.requestedModel,
    responseModel: metadata.responseModel,
    responseId: metadata.responseId,
    finishReasons: metadata.finishReasons,
    status: metadata.responseModel ? 'verified' : 'unverifiable',
  };
}

export interface BudgetCheck {
  allowed: boolean;
  status: Exclude<BudgetStatus, 'not_configured'>;
  message?: string;
}

/**
 * In-memory accounting shared by all executions in one logical session.
 *
 * Missing provider-attempt usage is recorded only when such an attempt actually occurs.
 */
export class RunAccounting {
  private readonly roots = new Map<string, RootState>();

  private ensureExecution(root: RootState, context: AgentRunContext): ExecutionState {
    const existing = root.executions.get(context.runId);
    if (existing) return existing;
    const execution = {
      context,
      usage: null,
      costUsd: 0,
      costStatus: 'known',
      unknownModels: new Set<string>(),
      modelIdentities: new Map<string, AgentModelIdentity>(),
      missingSources: new Set<string>(),
    } satisfies ExecutionState;
    root.executions.set(context.runId, execution);
    return execution;
  }

  startRoot(context: AgentRunContext, budgetUsd?: number): void {
    const current = this.roots.get(context.rootRunId);
    if (current) {
      if (budgetUsd !== undefined) current.budgetUsd = budgetUsd;
      this.ensureExecution(current, context);
      return;
    }
    this.roots.set(context.rootRunId, {
      rootRunId: context.rootRunId,
      budgetUsd,
      executions: new Map(),
    });
    this.ensureExecution(this.roots.get(context.rootRunId)!, context);
  }

  /**
   * Restore spend recorded by earlier processes of the same root.
   *
   * Idempotent per root: the seed replaces rather than accumulates, so calling it
   * twice with the same restored total cannot double-charge the budget.
   */
  seedRoot(rootRunId: string, carried: CarriedSpend): void {
    const root = this.roots.get(rootRunId) ?? {
      rootRunId,
      executions: new Map<string, ExecutionState>(),
    };
    root.carried = carried;
    this.roots.set(rootRunId, root);
  }

  startExecution(context: AgentRunContext): void {
    const root = this.roots.get(context.rootRunId) ?? {
      rootRunId: context.rootRunId,
      executions: new Map<string, ExecutionState>(),
    };
    this.roots.set(context.rootRunId, root);
    this.ensureExecution(root, context);
  }

  record(context: AgentRunContext, usage: Usage, metadata: ProviderResponseMetadata): void {
    const root = this.roots.get(context.rootRunId) ?? {
      rootRunId: context.rootRunId,
      executions: new Map<string, ExecutionState>(),
    };
    this.roots.set(context.rootRunId, root);
    const execution = this.ensureExecution(root, context);
    const responseQuote = metadata.responseModel
      ? estimateUsageCost(metadata.responseModel, usage)
      : undefined;
    // Providers commonly resolve aliases to dated model IDs. Prefer exact response pricing, but
    // retain the requested alias as the pricing fallback while preserving verified response identity.
    const quote =
      responseQuote?.status === 'known'
        ? responseQuote
        : estimateUsageCost(metadata.requestedModel, usage);
    const identity = identityFor(metadata, quote);
    execution.usage = addUsage(execution.usage, usage);
    execution.costStatus = mergeCostStatus(execution.costStatus, quote, identity);
    if (quote.status === 'known' && execution.costUsd !== null) {
      execution.costUsd += quote.costUsd;
    } else {
      execution.costUsd = null;
      execution.unknownModels.add(quote.model);
    }
    const identityKey = modelIdentityKey(identity);
    if (!execution.modelIdentities.has(identityKey)) {
      execution.modelIdentities.set(identityKey, identity);
    }
    root.executions.set(context.runId, execution);
  }

  markUsageUnknown(
    context: AgentRunContext,
    metadata: ProviderResponseMetadata,
    source: string,
  ): void {
    const root = this.roots.get(context.rootRunId) ?? {
      rootRunId: context.rootRunId,
      executions: new Map<string, ExecutionState>(),
    };
    this.roots.set(context.rootRunId, root);
    const execution = this.ensureExecution(root, context);
    const identity = missingUsageIdentity(metadata);
    // A provider attempt that reported no usage leaves the running total a lower
    // bound, not an unknown quantity. Latching to 'unknown' here — and nulling the
    // accumulated cost, which `makeSnapshot` independently re-derives 'unknown'
    // from — permanently disabled `checkBeforeModelCall`, because `mergeCostStatus`
    // never recovers from 'unknown'. Since this fires from the provider's
    // `onRetry`, one transient 429 turned a USD budget into a hard stop on every
    // later call: the reliability layer and the only spend rail were mutually
    // exclusive. Degrade to 'estimated' instead, which the budget gate allows while
    // still enforcing against the known floor. `missingSources` keeps the omission
    // visible in the snapshot.
    if (execution.costStatus !== 'unknown') execution.costStatus = 'estimated';
    execution.unknownModels.add(metadata.responseModel ?? metadata.requestedModel);
    execution.missingSources.add(source);
    const identityKey = modelIdentityKey(identity);
    if (!execution.modelIdentities.has(identityKey)) {
      execution.modelIdentities.set(identityKey, identity);
    }
    root.executions.set(context.runId, execution);
  }

  checkBeforeModelCall(rootRunId: string, requestedModel: string): BudgetCheck {
    const root = this.roots.get(rootRunId);
    if (!root || root.budgetUsd === undefined) {
      return { allowed: true, status: 'within' };
    }
    // A non-finite ceiling is not a ceiling. `NaN` is not `undefined`, so the budget
    // reads as configured while every comparison against it is false — the rail
    // reports itself active and permits everything. Fail closed instead.
    if (!Number.isFinite(root.budgetUsd) || root.budgetUsd < 0) {
      return {
        allowed: false,
        status: 'unknown',
        message: `Refusing to run: the USD budget is not a usable number (${root.budgetUsd}).`,
      };
    }
    if (!hasKnownPricing(requestedModel)) {
      return {
        allowed: false,
        status: 'unknown',
        message: `Cannot enforce the USD budget because pricing is unknown for ${requestedModel}.`,
      };
    }
    const snapshot = this.snapshotRoot(rootRunId);
    if (snapshot.costStatus === 'unknown') {
      return {
        allowed: false,
        status: 'unknown',
        message: 'Cannot enforce the USD budget because provider identity or pricing is unknown.',
      };
    }
    // Enforce against INCLUSIVE spend. `costUsd` is the root execution's own cost,
    // so a run that delegates could pass this gate indefinitely while its agents
    // spent without limit — the same snapshot would report `budgetStatus:
    // 'exceeded'` while this returned `{allowed: true}`.
    if (snapshot.inclusiveCostUsd !== null && snapshot.inclusiveCostUsd >= root.budgetUsd) {
      return {
        allowed: false,
        status: 'exceeded',
        message: `USD budget of $${root.budgetUsd.toFixed(4)} has been exhausted.`,
      };
    }
    return { allowed: true, status: 'within' };
  }

  /** Has a root by this id been started in THIS process? */
  hasRoot(rootRunId: string): boolean {
    return this.roots.has(rootRunId);
  }

  /**
   * The live budgeted root that work from a dead process should join.
   *
   * A managed agent re-driven after a restart still carries the previous
   * process's `rootRunId`. Nothing recreates that root here, so `startExecution`
   * would mint it with no `budgetUsd` and `checkBeforeModelCall` would then allow
   * every call unconditionally — while the host's own gate stayed green, because
   * the spend never reached its inclusive total either. Undefined when the answer
   * is ambiguous, so adoption is never a guess.
   */
  budgetedRootRunId(): string | undefined {
    const budgeted = [...this.roots.values()].filter((root) => root.budgetUsd !== undefined);
    return budgeted.length === 1 ? budgeted[0].rootRunId : undefined;
  }

  snapshotRun(runId: string): AgentRunAccounting | undefined {
    for (const root of this.roots.values()) {
      const execution = root.executions.get(runId);
      if (!execution) continue;
      // The root's `carried` is the OBJECTIVE's restored spend. Passing the whole
      // root here billed every per-agent `run_end` event with it, so a child that
      // spent two cents reported the objective's entire prior total as its own
      // inclusive cost — and `budgetStatus: 'exceeded'` for a child that spent
      // cents. A single execution's snapshot must describe that execution.
      return this.makeSnapshot(
        { rootRunId: root.rootRunId, budgetUsd: root.budgetUsd, executions: root.executions },
        [execution],
        execution,
      );
    }
    return undefined;
  }

  snapshotRoot(rootRunId: string): AgentRunAccounting {
    const root = this.roots.get(rootRunId) ?? {
      rootRunId,
      executions: new Map<string, ExecutionState>(),
    };
    return this.makeSnapshot(root, [...root.executions.values()], root.executions.get(rootRunId));
  }

  snapshotAll(): AgentRunAccounting {
    const roots = [...this.roots.values()];
    const executions = roots.flatMap((root) => [...root.executions.values()]);
    const snapshot = this.makeSnapshot(
      {
        rootRunId: roots[0]?.rootRunId ?? '',
        // Every root in a process carries the same cap: it comes from one flag. The
        // old `roots.length === 1` guard therefore reported `not_configured` for a
        // budgeted run the moment a second root existed - which headless creates
        // per submitted prompt. Report the cap whenever the defined ones agree, and
        // only fall back to undefined when they genuinely differ.
        budgetUsd: distinctBudget(roots),
        // Carry the restored spend of every root. Omitting it made
        // `HeadlessResult.accounting` report `budgetStatus: 'within'` in the same
        // JSON object as `outcome.reason: 'budget_exceeded'`, so a supervisor
        // gating on the status restarted a run that had already spent its ceiling.
        carried: mergeCarried(roots),
        executions: new Map(),
      },
      executions,
    );
    return {
      ...snapshot,
      rootRunIds: roots.map((root) => root.rootRunId),
    };
  }

  private makeSnapshot(
    root: RootState,
    executions: ExecutionState[],
    direct?: ExecutionState,
  ): AgentRunAccounting {
    let inclusiveUsage: Usage | null = root.carried?.usage ?? null;
    let inclusiveCost = root.carried?.costUsd ?? 0;
    let costStatus: AgentRunAccounting['costStatus'] = 'known';
    // A carry we could not price is NOT zero spend. Treating it as `estimated`
    // let the `?? 0` above launder an unknown amount into a $0 baseline that the
    // budget gate then permitted, so the cap re-armed from zero on every prompt
    // and every restart — the exact failure the objective-scoped carry exists to
    // prevent. `unknown` fails the gate closed, and only ever for a run that
    // actually set a budget: `checkBeforeModelCall` returns early without one.
    if (root.carried && root.carried.costUsd === null) costStatus = 'unknown';
    const unknownModels = new Set<string>();
    const modelIdentities = new Map<string, AgentModelIdentity>();
    const missingSources = new Set<string>();
    for (const execution of executions) {
      if (execution.usage) inclusiveUsage = addUsage(inclusiveUsage, execution.usage);
      if (execution.costUsd !== null) inclusiveCost += execution.costUsd;
      else costStatus = 'unknown';
      if (execution.costStatus === 'estimated' && costStatus === 'known') costStatus = 'estimated';
      for (const model of execution.unknownModels) unknownModels.add(model);
      for (const source of execution.missingSources) missingSources.add(source);
      for (const [key, identity] of execution.modelIdentities) {
        if (!modelIdentities.has(key)) modelIdentities.set(key, identity);
      }
    }
    const budgetStatus: BudgetStatus =
      root.budgetUsd === undefined
        ? 'not_configured'
        : costStatus === 'unknown'
          ? 'unknown'
          : inclusiveCost >= root.budgetUsd
            ? 'exceeded'
            : 'within';
    return {
      rootRunIds: root.rootRunId ? [root.rootRunId] : [],
      runIds: executions.map((execution) => execution.context.runId),
      directUsage: direct?.usage ?? null,
      inclusiveUsage,
      costUsd: costStatus === 'unknown' ? null : direct ? direct.costUsd : inclusiveCost,
      inclusiveCostUsd: costStatus === 'unknown' ? null : inclusiveCost,
      costStatus,
      pricingVersion: PRICING_VERSION,
      unknownModels: [...unknownModels],
      budgetUsd: root.budgetUsd,
      budgetStatus,
      modelIdentities: [...modelIdentities.values()],
      completeness: missingSources.size === 0 ? 'complete' : 'partial',
      missingSources: [...missingSources],
    };
  }
}
