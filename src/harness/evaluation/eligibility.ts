import { createHash } from 'node:crypto';
import type { AgentRunResult } from '../../types/runs.js';

export interface EvaluationEligibilityOptions {
  requireSingleAgent?: boolean;
  requireUsage?: boolean;
  requireVerifiedIdentity?: boolean;
  requireKnownCost?: boolean;
}

export interface EvaluationEligibility {
  eligible: boolean;
  reasons: string[];
  rootRunId?: string;
  ambientFingerprint?: string;
  pricingVersion?: string;
  budgetUsd?: number;
  modelIdentityFingerprint?: string;
}

export interface EvaluationComparisonEligibility {
  eligible: boolean;
  reasons: string[];
  ambientFingerprint?: string;
  pricingVersion?: string;
  budgetUsd?: number;
  modelIdentityFingerprint?: string;
}

function fingerprintModelIdentities(accounting: AgentRunResult['accounting']): string | undefined {
  if (!accounting?.modelIdentities.length) return undefined;
  const identities = [
    ...new Set(
      accounting.modelIdentities.map((identity) =>
        JSON.stringify({
          provider: identity.provider,
          requestedModel: identity.requestedModel,
          responseModel: identity.responseModel,
          status: identity.status,
        }),
      ),
    ),
  ].sort();
  return createHash('sha256').update(JSON.stringify(identities)).digest('hex');
}

/** Fail closed when a provider-backed trial cannot support attributable comparison. */
export function evaluateRunEligibility(
  runs: readonly AgentRunResult[] | undefined,
  options: EvaluationEligibilityOptions = {},
): EvaluationEligibility {
  const reasons: string[] = [];
  const requireSingleAgent = options.requireSingleAgent ?? true;
  const requireUsage = options.requireUsage ?? true;
  const requireVerifiedIdentity = options.requireVerifiedIdentity ?? true;
  const requireKnownCost = options.requireKnownCost ?? true;

  if (!runs?.length) return { eligible: false, reasons: ['runs_missing'] };
  const rootRuns = runs.filter(
    (run) => run.context.runId === run.context.rootRunId && run.context.parentRunId === undefined,
  );
  if (rootRuns.length !== 1) reasons.push('root_run_boundary_invalid');
  const root = rootRuns[0] ?? runs[0];
  if (runs.some((run) => run.context.rootRunId !== root.context.rootRunId)) {
    reasons.push('multiple_root_runs');
  }
  if (requireSingleAgent && runs.length !== 1) reasons.push('child_runs_present');
  if (root.outcome.status !== 'completed') {
    reasons.push(`outcome_${root.outcome.status}:${root.outcome.reason}`);
  }

  const ambient = root.ambient;
  if (!ambient) reasons.push('ambient_missing');
  else {
    if (ambient.completeness !== 'complete' || ambient.missingSources.length > 0) {
      reasons.push(`ambient_partial:${ambient.missingSources.join(',') || 'unknown'}`);
    }
    if (
      requireSingleAgent &&
      (ambient.agents.mode !== 'off' || ambient.settings.agentsMode !== 'off')
    ) {
      reasons.push('agents_mode_not_off');
    }
    if (ambient.bookHome.isolation !== 'isolated') reasons.push('book_home_not_isolated');
    if (ambient.bookHome.contentsStatus !== 'captured') reasons.push('book_home_not_captured');
  }

  const accounting = root.accounting;
  if (!accounting) reasons.push('accounting_missing');
  else {
    if (accounting.completeness !== 'complete' || accounting.missingSources.length > 0) {
      reasons.push(`accounting_partial:${accounting.missingSources.join(',') || 'unknown'}`);
    }
    if (requireUsage && !accounting.inclusiveUsage) reasons.push('usage_missing');
    if (requireKnownCost && accounting.costStatus !== 'known') {
      reasons.push(`cost_${accounting.costStatus}`);
    } else if (requireKnownCost && accounting.costUsd === null) {
      reasons.push('cost_missing');
    }
    if (accounting.budgetStatus === 'unknown') reasons.push('budget_unknown');
    if (requireVerifiedIdentity) {
      if (accounting.modelIdentities.length === 0) reasons.push('model_identity_missing');
      else if (
        accounting.modelIdentities.some(
          (identity) => identity.status !== 'verified' || !identity.responseModel,
        )
      ) {
        reasons.push('model_identity_unverified');
      }
    }
    if (requireSingleAgent && accounting.runIds.length !== 1) {
      reasons.push('accounting_child_runs_present');
    }
    if (
      accounting.rootRunIds.length !== 1 ||
      accounting.rootRunIds[0] !== root.context.rootRunId ||
      !accounting.runIds.includes(root.context.runId)
    ) {
      reasons.push('accounting_run_boundary_invalid');
    }
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    rootRunId: root.context.rootRunId,
    ambientFingerprint: ambient?.fingerprint,
    pricingVersion: accounting?.pricingVersion,
    budgetUsd: accounting?.budgetUsd,
    modelIdentityFingerprint: fingerprintModelIdentities(accounting),
  };
}

/** Reject a paired comparison when otherwise valid arms do not share the same identity. */
export function evaluateComparisonEligibility(
  arms: readonly EvaluationEligibility[] | undefined,
): EvaluationComparisonEligibility {
  if (!arms || arms.length < 2) {
    return { eligible: false, reasons: ['comparison_arms_missing'] };
  }

  const reasons: string[] = [];
  for (const [index, arm] of arms.entries()) {
    if (!arm.eligible) {
      reasons.push(`arm_${index + 1}_ineligible:${arm.reasons.join(',') || 'unknown'}`);
    }
  }

  const compare = <T>(
    values: readonly (T | undefined)[],
    missingReason: string,
    mismatchReason: string,
  ): T | undefined => {
    if (values.some((value) => value === undefined)) {
      reasons.push(missingReason);
      return undefined;
    }
    const first = values[0] as T;
    if (values.some((value) => value !== first)) reasons.push(mismatchReason);
    return first;
  };

  const ambientFingerprint = compare(
    arms.map((arm) => arm.ambientFingerprint),
    'comparison_ambient_missing',
    'comparison_ambient_mismatch',
  );
  const pricingVersion = compare(
    arms.map((arm) => arm.pricingVersion),
    'comparison_pricing_version_missing',
    'comparison_pricing_version_mismatch',
  );
  const modelIdentityFingerprint = compare(
    arms.map((arm) => arm.modelIdentityFingerprint),
    'comparison_model_identity_missing',
    'comparison_model_identity_mismatch',
  );
  const budgets = arms.map((arm) => arm.budgetUsd ?? null);
  const budgetUsd = budgets[0];
  if (budgets.some((value) => value !== budgetUsd)) reasons.push('comparison_budget_mismatch');

  return {
    eligible: reasons.length === 0,
    reasons,
    ambientFingerprint,
    pricingVersion,
    budgetUsd: budgetUsd ?? undefined,
    modelIdentityFingerprint,
  };
}
