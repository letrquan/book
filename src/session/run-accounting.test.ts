import { describe, expect, it } from 'vitest';
import { RunAccounting } from './run-accounting.js';
import type { AgentRunContext } from '../types/runs.js';
import type { ProviderResponseMetadata } from '../types/providers.js';

function context(runId: string, rootRunId = 'root'): AgentRunContext {
  return {
    runId,
    rootRunId,
    sessionId: 'session',
    source: 'headless',
    startedAt: 1,
  };
}

const usage = (promptTokens: number, completionTokens: number) => ({
  promptTokens,
  completionTokens,
  totalTokens: promptTokens + completionTokens,
});

describe('RunAccounting', () => {
  it('keeps direct execution usage separate from root-inclusive usage', () => {
    const accounting = new RunAccounting();
    const root = context('root');
    const child = context('child', root.rootRunId);
    accounting.startRoot(root, 0.001);

    accounting.record(root, usage(10, 5), {
      provider: 'openai-compatible',
      requestedModel: 'gpt-5',
      responseModel: 'gpt-5',
      responseId: 'response-root',
    });
    accounting.record(child, usage(4, 2), {
      provider: 'openai-compatible',
      requestedModel: 'gpt-5',
      responseModel: 'gpt-5',
      responseId: 'response-child',
    });

    expect(accounting.snapshotRun(child.runId)).toMatchObject({
      directUsage: usage(4, 2),
      inclusiveUsage: usage(4, 2),
      costStatus: 'known',
    });
    expect(accounting.snapshotRoot(root.rootRunId)).toMatchObject({
      directUsage: usage(10, 5),
      inclusiveUsage: usage(14, 7),
      runIds: ['root', 'child'],
      budgetStatus: 'within',
      completeness: 'complete',
      missingSources: [],
    });
  });

  it('marks requested-only identity as estimated rather than verified', () => {
    const accounting = new RunAccounting();
    const root = context('root');
    accounting.record(root, usage(10, 5), {
      provider: 'openai-compatible',
      requestedModel: 'gpt-5',
    });

    expect(accounting.snapshotRoot(root.rootRunId)).toMatchObject({
      costStatus: 'estimated',
      modelIdentities: [{ status: 'requested_only' }],
    });
  });

  it('keeps enforcing against the known floor when a compaction omits usage', () => {
    const accounting = new RunAccounting();
    const root = context('root');
    accounting.startRoot(root, 1);

    accounting.markUsageUnknown(
      root,
      {
        provider: 'openai-compatible',
        requestedModel: 'gpt-5',
        responseModel: 'gpt-5-2025-08-07',
        responseId: 'compact-without-usage',
      },
      'compaction_usage',
    );

    // Missing usage makes the running total a lower bound, not an unknown
    // quantity. The omission stays visible via completeness/unknownModels/
    // missingSources, but it no longer latches the run into a permanent refusal.
    expect(accounting.snapshotRoot(root.rootRunId)).toMatchObject({
      completeness: 'partial',
      costStatus: 'estimated',
      budgetStatus: 'within',
      unknownModels: ['gpt-5-2025-08-07'],
      modelIdentities: [{ responseId: 'compact-without-usage', status: 'verified' }],
      missingSources: ['compaction_usage'],
    });
    expect(accounting.checkBeforeModelCall(root.rootRunId, 'gpt-5')).toMatchObject({
      allowed: true,
      status: 'within',
    });
  });

  it('becomes partial only when a provider attempt has unknown usage', () => {
    const accounting = new RunAccounting();
    const root = context('root');
    accounting.startRoot(root, 1);

    accounting.markUsageUnknown(
      root,
      { provider: 'openai-compatible', requestedModel: 'gpt-5' },
      'failed_provider_attempt_usage',
    );

    expect(accounting.snapshotRoot(root.rootRunId)).toMatchObject({
      completeness: 'partial',
      costStatus: 'estimated',
      budgetStatus: 'within',
      missingSources: ['failed_provider_attempt_usage'],
    });
  });

  it('survives a transient retry and still stops at the cap', () => {
    // The reported failure: markUsageUnknown fires from the provider's onRetry, so
    // one transient 429 used to refuse every later call — making the reliability
    // layer and the USD budget mutually exclusive.
    const accounting = new RunAccounting();
    const root = context('root');
    accounting.startRoot(root, 1);

    accounting.record(root, usage(1_000, 100), {
      provider: 'anthropic',
      requestedModel: 'claude-sonnet-5',
      responseModel: 'claude-sonnet-5',
      responseId: 'turn-1',
    });
    accounting.markUsageUnknown(
      root,
      { provider: 'anthropic', requestedModel: 'claude-sonnet-5' },
      'failed_provider_attempt_usage',
    );

    expect(accounting.checkBeforeModelCall(root.rootRunId, 'claude-sonnet-5')).toMatchObject({
      allowed: true,
    });

    for (let i = 0; i < 300; i++) {
      accounting.record(root, usage(1_000_000, 100_000), {
        provider: 'anthropic',
        requestedModel: 'claude-sonnet-5',
        responseModel: 'claude-sonnet-5',
        responseId: `turn-over-${i}`,
      });
    }
    expect(accounting.checkBeforeModelCall(root.rootRunId, 'claude-sonnet-5')).toMatchObject({
      allowed: false,
      status: 'exceeded',
    });
  });

  it('still fails closed when the model itself cannot be priced', () => {
    const accounting = new RunAccounting();
    const root = context('root');
    accounting.startRoot(root, 1);

    expect(accounting.checkBeforeModelCall(root.rootRunId, 'not-a-real-model')).toMatchObject({
      allowed: false,
      status: 'unknown',
    });
  });

  it('uses requested alias pricing for a versioned response model', () => {
    const accounting = new RunAccounting();
    const root = context('root');
    accounting.startRoot(root, 1);

    accounting.record(root, usage(10, 5), {
      provider: 'openai-compatible',
      requestedModel: 'gpt-4o',
      responseModel: 'gpt-4o-2024-08-06',
      responseId: 'response-versioned',
    });

    expect(accounting.snapshotRoot(root.rootRunId)).toMatchObject({
      costStatus: 'known',
      unknownModels: [],
      budgetStatus: 'within',
      modelIdentities: [
        {
          status: 'verified',
          requestedModel: 'gpt-4o',
          responseModel: 'gpt-4o-2024-08-06',
        },
      ],
    });
    expect(accounting.checkBeforeModelCall(root.rootRunId, 'gpt-4o')).toMatchObject({
      allowed: true,
      status: 'within',
    });
  });

  it('fails closed before a budgeted call when pricing is unknown', () => {
    const accounting = new RunAccounting();
    const root = context('root');
    accounting.startRoot(root, 1);

    expect(accounting.checkBeforeModelCall(root.rootRunId, 'vendor/unknown')).toEqual({
      allowed: false,
      status: 'unknown',
      message: expect.stringContaining('pricing is unknown'),
    });
  });

  it('stops the next call after inclusive spend reaches the budget', () => {
    const accounting = new RunAccounting();
    const root = context('root');
    accounting.startRoot(root, 0.0001);
    accounting.record(root, usage(10, 5), {
      provider: 'openai-compatible',
      requestedModel: 'gpt-5',
      responseModel: 'gpt-5',
      responseId: 'response-root',
    });

    expect(accounting.checkBeforeModelCall(root.rootRunId, 'gpt-5')).toMatchObject({
      allowed: false,
      status: 'exceeded',
    });
  });
});

describe('the budget rail actually caps', () => {
  const ctx = (rootRunId: string, runId: string): AgentRunContext => context(runId, rootRunId);
  const meta = {
    provider: 'anthropic',
    requestedModel: 'claude-sonnet-5',
    responseModel: 'claude-sonnet-5',
    responseId: 'resp-1',
    status: 'verified',
  } as unknown as ProviderResponseMetadata;
  const usage = { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 };

  it('counts spend by delegated agents against the cap', () => {
    // `costUsd` is the root execution's OWN spend. Enforcing on it let a run that
    // delegates pass the gate forever while its agents spent without limit — the
    // same snapshot reported `budgetStatus: 'exceeded'` while the check allowed.
    const accounting = new RunAccounting();
    const root = ctx('root-1', 'root-1');
    accounting.startRoot(root, 2);

    // All of it spent by a child, none by the root itself.
    accounting.record(ctx('root-1', 'child-1'), usage, meta);

    const snapshot = accounting.snapshotRoot('root-1');
    expect(snapshot.costUsd).toBe(0); // the root turn alone
    expect(snapshot.inclusiveCostUsd).toBeCloseTo(3, 5); // $3/M prompt tokens
    expect(snapshot.budgetStatus).toBe('exceeded');
    // The gate must agree with the snapshot.
    expect(accounting.checkBeforeModelCall('root-1', 'claude-sonnet-5')).toMatchObject({
      allowed: false,
      status: 'exceeded',
    });
  });

  it('refuses to run against a budget that is not a usable number', () => {
    // `NaN` is not `undefined`, so the budget reads as configured while every
    // comparison against it is false: the rail reports itself on and permits
    // everything. Fail closed instead.
    const accounting = new RunAccounting();
    accounting.startRoot(ctx('root-2', 'root-2'), Number.NaN);
    expect(accounting.checkBeforeModelCall('root-2', 'claude-sonnet-5')).toMatchObject({
      allowed: false,
      status: 'unknown',
    });
  });

  it('treats an explicit zero as a real zero cap, not as absent', () => {
    const accounting = new RunAccounting();
    accounting.startRoot(ctx('root-3', 'root-3'), 0);
    expect(accounting.checkBeforeModelCall('root-3', 'claude-sonnet-5')).toMatchObject({
      allowed: false,
      status: 'exceeded',
    });
  });

  it('reports the cap in snapshotAll once more than one root exists', () => {
    // Headless mints a root per submitted prompt, and the old `roots.length === 1`
    // guard reported a budgeted run as `not_configured` from the second one on.
    const accounting = new RunAccounting();
    accounting.startRoot(ctx('root-a', 'root-a'), 50);
    accounting.startRoot(ctx('root-b', 'root-b'), 50);
    const all = accounting.snapshotAll();
    expect(all.budgetUsd).toBe(50);
    expect(all.budgetStatus).not.toBe('not_configured');
  });

  it('keeps the pre-call check flat as responses accumulate', () => {
    // `makeSnapshot` runs inside `checkBeforeModelCall` before every model call.
    // It used to linear-scan a `modelIdentities` array that grew one entry per
    // response and deduped with `.some()` — quadratic on the hot path of the spend
    // rail, measured at 8.4s per call by 40k responses. The identity set is now
    // keyed by the tuple its only consumer reads, so it stays bounded.
    const accounting = new RunAccounting();
    const root = ctx('root-perf', 'root-perf');
    accounting.startRoot(root, 1_000_000);
    for (let i = 0; i < 20_000; i++) {
      accounting.record(root, { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, {
        ...meta,
        responseId: `resp-${i}`,
      } as unknown as ProviderResponseMetadata);
    }
    expect(accounting.snapshotRoot('root-perf').modelIdentities).toHaveLength(1);

    const started = performance.now();
    for (let i = 0; i < 50; i++) accounting.checkBeforeModelCall('root-perf', 'claude-sonnet-5');
    const elapsed = performance.now() - started;
    // Generous: the point is that it is not seconds per call.
    expect(elapsed).toBeLessThan(1000);
  });
});

describe('a carry that could not be priced', () => {
  it('fails the budget closed instead of restarting the cap from zero', () => {
    // `inclusiveCost = root.carried?.costUsd ?? 0` turned "we know spend happened
    // but not how much" into "$0 spent". Paired with a status the gate permits,
    // the cap re-armed from zero on every prompt and every restart — so N prompts
    // authorised N x the budget, which is the exact failure the objective-scoped
    // carry exists to prevent.
    const accounting = new RunAccounting();
    accounting.startRoot(context('root-c', 'root-c'), 50);
    accounting.seedRoot('root-c', { usage: null, costUsd: null });

    const snapshot = accounting.snapshotRoot('root-c');
    expect(snapshot.costStatus).toBe('unknown');
    expect(accounting.checkBeforeModelCall('root-c', 'claude-sonnet-5')).toMatchObject({
      allowed: false,
      status: 'unknown',
    });
  });

  it('leaves an unbudgeted run alone', () => {
    // Failing closed is only correct where a ceiling was actually asked for.
    const accounting = new RunAccounting();
    accounting.startRoot(context('root-d', 'root-d'));
    accounting.seedRoot('root-d', { usage: null, costUsd: null });
    expect(accounting.checkBeforeModelCall('root-d', 'claude-sonnet-5')).toMatchObject({
      allowed: true,
    });
  });
});
