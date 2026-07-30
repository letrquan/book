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

interface ExecutionState {
  readonly context: AgentRunContext;
  usage: Usage | null;
  costUsd: number | null;
  costStatus: 'known' | 'estimated' | 'unknown';
  readonly unknownModels: Set<string>;
  readonly modelIdentities: AgentModelIdentity[];
}

interface RootState {
  readonly rootRunId: string;
  budgetUsd?: number;
  readonly executions: Map<string, ExecutionState>;
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

export interface BudgetCheck {
  allowed: boolean;
  status: Exclude<BudgetStatus, 'not_configured'>;
  message?: string;
}

/**
 * In-memory accounting shared by all executions in one logical session.
 *
 * This intentionally reports partial completeness until compaction and failed provider attempts
 * emit usage events. It is safer to expose that gap than to present a clean but incomplete total.
 */
export class RunAccounting {
  private readonly roots = new Map<string, RootState>();

  startRoot(context: AgentRunContext, budgetUsd?: number): void {
    const current = this.roots.get(context.rootRunId);
    if (current) {
      if (budgetUsd !== undefined) current.budgetUsd = budgetUsd;
      return;
    }
    this.roots.set(context.rootRunId, {
      rootRunId: context.rootRunId,
      budgetUsd,
      executions: new Map(),
    });
  }

  record(context: AgentRunContext, usage: Usage, metadata: ProviderResponseMetadata): void {
    const root = this.roots.get(context.rootRunId) ?? {
      rootRunId: context.rootRunId,
      executions: new Map<string, ExecutionState>(),
    };
    this.roots.set(context.rootRunId, root);
    const execution =
      root.executions.get(context.runId) ??
      ({
        context,
        usage: null,
        costUsd: 0,
        costStatus: 'known',
        unknownModels: new Set<string>(),
        modelIdentities: [],
      } satisfies ExecutionState);
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
    if (
      !execution.modelIdentities.some(
        (item) => item.responseId === identity.responseId && item.responseId !== undefined,
      )
    ) {
      execution.modelIdentities.push(identity);
    }
    root.executions.set(context.runId, execution);
  }

  checkBeforeModelCall(rootRunId: string, requestedModel: string): BudgetCheck {
    const root = this.roots.get(rootRunId);
    if (!root || root.budgetUsd === undefined) {
      return { allowed: true, status: 'within' };
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
    if (snapshot.costUsd !== null && snapshot.costUsd >= root.budgetUsd) {
      return {
        allowed: false,
        status: 'exceeded',
        message: `USD budget of $${root.budgetUsd.toFixed(4)} has been exhausted.`,
      };
    }
    return { allowed: true, status: 'within' };
  }

  snapshotRun(runId: string): AgentRunAccounting | undefined {
    for (const root of this.roots.values()) {
      const execution = root.executions.get(runId);
      if (!execution) continue;
      return this.makeSnapshot(root, [execution], execution);
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
        budgetUsd: roots.length === 1 ? roots[0]?.budgetUsd : undefined,
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
    let inclusiveUsage: Usage | null = null;
    let inclusiveCost = 0;
    let costStatus: AgentRunAccounting['costStatus'] = 'known';
    const unknownModels = new Set<string>();
    const modelIdentities: AgentModelIdentity[] = [];
    for (const execution of executions) {
      if (execution.usage) inclusiveUsage = addUsage(inclusiveUsage, execution.usage);
      if (execution.costUsd !== null) inclusiveCost += execution.costUsd;
      else costStatus = 'unknown';
      if (execution.costStatus === 'estimated' && costStatus === 'known') costStatus = 'estimated';
      for (const model of execution.unknownModels) unknownModels.add(model);
      for (const identity of execution.modelIdentities) {
        if (
          !modelIdentities.some(
            (item) => item.responseId === identity.responseId && item.responseId !== undefined,
          )
        )
          modelIdentities.push(identity);
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
      costStatus,
      pricingVersion: PRICING_VERSION,
      unknownModels: [...unknownModels],
      budgetUsd: root.budgetUsd,
      budgetStatus,
      modelIdentities,
      completeness: 'partial',
      missingSources: ['compaction_usage', 'failed_provider_attempt_usage'],
    };
  }
}
