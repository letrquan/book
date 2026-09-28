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

describe('spend attribution across snapshot kinds', () => {
  const meta = {
    provider: 'anthropic',
    requestedModel: 'claude-sonnet-5',
    responseModel: 'claude-sonnet-5',
    responseId: 'r1',
    status: 'verified',
  } as unknown as ProviderResponseMetadata;
  const oneDollar = { promptTokens: 333_334, completionTokens: 0, totalTokens: 333_334 };

  it('does not bill a child with the objective\u2019s restored spend', () => {
    // `snapshotRun` passed the whole ROOT to `makeSnapshot`, so every per-agent
    // `run_end` event reported a child that spent cents as having spent the entire
    // objective's carried total — and `budgetStatus: 'exceeded'` for that child.
    const accounting = new RunAccounting();
    accounting.startRoot(context('root-e', 'root-e'), 50);
    accounting.seedRoot('root-e', { usage: null, costUsd: 49 });
    accounting.record(context('child-e', 'root-e'), oneDollar, meta);

    const child = accounting.snapshotRun('child-e');
    expect(child?.inclusiveCostUsd).toBeCloseTo(1, 4);
    expect(child?.budgetStatus).toBe('within');
  });

  it('counts restored spend in the aggregate snapshot', () => {
    // `snapshotAll` built a synthetic root that omitted `carried`, so
    // `HeadlessResult.accounting` could report `within` in the same object as
    // `outcome.reason: 'budget_exceeded'` — and a supervisor gating on the status
    // restarted a run that had already spent its ceiling.
    const accounting = new RunAccounting();
    accounting.startRoot(context('root-f', 'root-f'), 50);
    accounting.seedRoot('root-f', { usage: null, costUsd: 49.5 });
    accounting.record(context('root-f', 'root-f'), oneDollar, meta);

    const all = accounting.snapshotAll();
    expect(all.inclusiveCostUsd).toBeCloseTo(50.5, 4);
    expect(all.budgetStatus).toBe('exceeded');
  });

  it('lets a re-driven agent join the live budgeted root', () => {
    // A resumed agent carries the dead process's rootRunId; nothing recreates it,
    // so it would run with `budgetUsd: undefined` — unbounded, and invisible to
    // the host's own gate.
    const accounting = new RunAccounting();
    accounting.startRoot(context('host-root', 'host-root'), 25);
    expect(accounting.hasRoot('dead-process-root')).toBe(false);
    expect(accounting.budgetedRootRunId()).toBe('host-root');
  });

  it('refuses to guess when more than one budgeted root is live', () => {
    const accounting = new RunAccounting();
    accounting.startRoot(context('r1', 'r1'), 25);
    accounting.startRoot(context('r2', 'r2'), 10);
    expect(accounting.budgetedRootRunId()).toBeUndefined();
  });

  describe('the unpersisted-usage watermark', () => {
    const meta = {
      provider: 'anthropic',
      requestedModel: 'claude-sonnet-5',
      responseModel: 'claude-sonnet-5',
      responseId: 'r1',
      status: 'verified',
    } as unknown as ProviderResponseMetadata;

    it('never hands back the carry a seeded root restored', () => {
      // The carry is what earlier processes already wrote as `usage` records.
      // Handing it back would write those tokens again on this process's first
      // response, and the next restart would restore an inflated total.
      const accounting = new RunAccounting();
      accounting.startRoot(context('root-g', 'root-g'));
      accounting.seedRoot('root-g', { usage: usage(1_000, 100), costUsd: 0.5 });
      accounting.record(context('root-g', 'root-g'), usage(10, 1), meta);

      expect(accounting.peekUnpersistedUsage('root-g')).toMatchObject(usage(10, 1));
      accounting.commitPersistedUsage('root-g');
      expect(accounting.peekUnpersistedUsage('root-g')).toMatchObject(usage(0, 0));
    });

    it('records a second run under a shared root only for what that run spent', () => {
      // A managed agent's completion is delivered to the model as a new run under
      // the root the spawning turn already used, in the same process. The spawn's
      // spend is on disk; re-persisting the root's whole inclusive total would
      // bill it twice.
      const accounting = new RunAccounting();
      const root = context('parent-run', 'shared-root');
      accounting.startRoot(root, 5);
      accounting.record(root, usage(100, 10), meta);
      expect(accounting.peekUnpersistedUsage('shared-root')).toMatchObject(usage(100, 10));
      accounting.commitPersistedUsage('shared-root');

      const continuation = context('continuation-run', 'shared-root');
      accounting.startExecution(continuation);
      accounting.record(continuation, usage(20, 2), meta);

      expect(accounting.peekUnpersistedUsage('shared-root')).toMatchObject(usage(20, 2));
    });

    it('picks up spend recorded after the last read, never dropping it', () => {
      // A background agent that answers between two runs: its usage reaches the
      // root's total without any `usage` record of its own, so the next read has
      // to carry it or the restored carry is short by exactly that much.
      const accounting = new RunAccounting();
      const root = context('root-h', 'root-h');
      accounting.startRoot(root, 5);
      accounting.record(root, usage(10, 1), meta);
      accounting.commitPersistedUsage('root-h');

      accounting.startExecution(context('late-agent', 'root-h'));
      accounting.record(context('late-agent', 'root-h'), usage(7, 3), meta);

      expect(accounting.peekUnpersistedUsage('root-h')).toMatchObject(usage(7, 3));
    });

    it('leaves a peek that was never committed for the next reader', () => {
      // A writer that decides not to append — the session moved on, or it has
      // nowhere to write — must not consume the delta. Committing on the peek
      // would mark those tokens written for every later writer under the root
      // while no record ever held them, so nothing would restore them after a
      // restart.
      const accounting = new RunAccounting();
      const root = context('root-i', 'root-i');
      accounting.startRoot(root, 5);
      accounting.record(root, usage(10, 1), meta);

      expect(accounting.peekUnpersistedUsage('root-i')).toMatchObject(usage(10, 1));
      // The skipped append: no commit.
      accounting.record(context('root-i', 'root-i'), usage(5, 1), meta);

      expect(accounting.peekUnpersistedUsage('root-i')).toMatchObject(usage(15, 2));
    });

    it("seeds the watermark from the carry's own persisted figure", () => {
      // The multi-prompt stream-json carry is a previous root's in-memory total,
      // which can exceed what that root wrote: a background agent or a compaction
      // judge can spend after its last `onUsage`. Seeding the watermark with the
      // whole carry skipped that remainder for good.
      const accounting = new RunAccounting();
      accounting.startRoot(context('root-j', 'root-j'));
      accounting.seedRoot('root-j', {
        usage: usage(1_000, 100),
        costUsd: 0.5,
        persistedUsage: usage(900, 90),
      });
      accounting.record(context('root-j', 'root-j'), usage(10, 1), meta);

      // The previous root's unwritten 100/10, then this root's own 10/1.
      expect(accounting.peekUnpersistedUsage('root-j')).toMatchObject(usage(110, 11));
    });

    it('peeks the same total the snapshot reports, so the two cannot drift', () => {
      // The unpersisted figure is the snapshot's inclusive total less the
      // watermark. Computing the sum a second way let the two disagree, and the
      // record set then stopped adding up to what the budget rail believed.
      const accounting = new RunAccounting();
      const root = context('root-k', 'root-k');
      accounting.startRoot(root, 5);
      accounting.seedRoot('root-k', { usage: usage(100, 10), costUsd: 0.1 });
      accounting.record(root, usage(20, 2), meta);
      accounting.startExecution(context('child-k', 'root-k'));
      accounting.record(context('child-k', 'root-k'), usage(3, 1), meta);

      const peeked = accounting.peekUnpersistedUsage('root-k');
      accounting.commitPersistedUsage('root-k');

      expect(accounting.persistedUsage('root-k')).toEqual(
        accounting.snapshotRoot('root-k').inclusiveUsage,
      );
      // The carried 100 was already on disk, so only this process's spend was new.
      expect(peeked).toMatchObject(usage(23, 3));
    });

    it('reports nothing for a root it has never seen', () => {
      const accounting = new RunAccounting();
      expect(accounting.peekUnpersistedUsage('missing')).toBeNull();
      expect(accounting.persistedUsage('missing')).toBeUndefined();
      // Committing an unknown root must not mint one with a watermark.
      accounting.commitPersistedUsage('missing');
      expect(accounting.hasRoot('missing')).toBe(false);
    });

    it('stops the handing-over root at the figure it handed on', () => {
      // Root 1's total at the hand-over is inside root 2's carry, so root 2 is
      // the one that records it. Root 1 writes only what it spends above that
      // line — a background child answering after the hand-over is still its own,
      // and root 2's commit must not swallow it.
      const accounting = new RunAccounting();
      const rootOne = context('root-1-turn', 'root-1');
      accounting.startRoot(rootOne);
      accounting.record(rootOne, usage(100, 10), meta);
      accounting.commitPersistedUsage('root-1');

      // The carry a host hands on is the source's own inclusive total, which is
      // what `headless.ts` snapshots — not a figure reconstructed by hand.
      const inclusive = accounting.snapshotRoot('root-1').inclusiveUsage;
      accounting.seedRoot('root-2', {
        usage: inclusive,
        costUsd: 0.1,
        persistedUsage: accounting.persistedUsage('root-1'),
        fromRootRunId: 'root-1',
      });
      // Charged after the hand-over: above the line, so still root 1's to write.
      accounting.startExecution(context('root-1-late', 'root-1'));
      accounting.record(context('root-1-late', 'root-1'), usage(7, 3), meta);
      expect(accounting.peekUnpersistedUsage('root-1')).toMatchObject(usage(7, 3));

      // Root 2 reports a turn, and the remainder it inherited.
      const rootTwo = context('root-2-turn', 'root-2');
      accounting.startRoot(rootTwo);
      accounting.record(rootTwo, usage(20, 2), meta);
      expect(accounting.peekUnpersistedUsage('root-2')).toMatchObject(usage(20, 2));
      accounting.commitPersistedUsage('root-2');

      // The commit advanced root 1 no further than the hand-over, so the child's
      // 7/3 survives to be written rather than being marked written unwritten.
      expect(accounting.peekUnpersistedUsage('root-1')).toMatchObject(usage(7, 3));
    });

    it('leaves the handed-over remainder to the successor, so it is written once', () => {
      // The reverse order: root 1 still owes something when it hands over. That
      // remainder is inside root 2's carry, so root 2 writes it and root 1 writes
      // nothing — whichever root a sweep happens to reach first.
      const accounting = new RunAccounting();
      const rootOne = context('root-1-turn', 'root-1');
      accounting.startRoot(rootOne);
      accounting.record(rootOne, usage(100, 10), meta);
      accounting.commitPersistedUsage('root-1');
      accounting.startExecution(context('root-1-late', 'root-1'));
      accounting.record(context('root-1-late', 'root-1'), usage(5, 1), meta);

      accounting.seedRoot('root-2', {
        usage: usage(105, 11),
        costUsd: 0.1,
        persistedUsage: usage(100, 10),
        fromRootRunId: 'root-1',
      });
      accounting.startRoot(context('root-2-turn', 'root-2'));

      expect(accounting.peekUnpersistedUsage('root-1')).toMatchObject(usage(0, 0));
      expect(accounting.peekUnpersistedUsage('root-2')).toMatchObject(usage(5, 1));
    });

    it('stamps the hand-over with the figure handed on, never a later total', () => {
      // A handled command (`/review`) and every prompt after it re-seed the same
      // source. Stamping the source's floor with whatever its total had grown to
      // by then seals spend the successor's carry never contained — it sits under
      // the floor, in nobody's delta, and is lost. The figure handed on is the
      // carry's own: that is precisely what the successor inherited.
      const accounting = new RunAccounting();
      const rootOne = context('root-1-turn', 'root-1');
      accounting.startRoot(rootOne);
      accounting.record(rootOne, usage(100, 10), meta);
      accounting.commitPersistedUsage('root-1');
      // Its background agent answers after the first prompt: inclusive 110.
      accounting.startExecution(context('root-1-late', 'root-1'));
      accounting.record(context('root-1-late', 'root-1'), usage(10, 1), meta);

      // A stale carry is re-seeded by a later prompt; the figure it carries is
      // what the successor is to write, so the floor may not move past it.
      accounting.seedRoot('root-2', {
        usage: usage(110, 11),
        costUsd: 0.1,
        persistedUsage: usage(100, 10),
        fromRootRunId: 'root-1',
      });
      // Root 1 is charged again, during the review.
      accounting.startExecution(context('root-1-review', 'root-1'));
      accounting.record(context('root-1-review', 'root-1'), usage(20, 2), meta);
      // And the stale carry is seeded once more.
      accounting.seedRoot('root-3', {
        usage: usage(110, 11),
        costUsd: 0.1,
        persistedUsage: usage(100, 10),
        fromRootRunId: 'root-1',
      });

      // The 20/2 above the handed-on 110/11 is still root 1's to write: sealing
      // it under the floor would drop it from every delta in the process.
      expect(accounting.peekUnpersistedUsage('root-1')).toMatchObject(usage(20, 2));
    });
  });

  describe('dearestModel', () => {
    it('names the dearest model the root spent on, a child included', () => {
      // A `usage` record is written whole, so it carries one model name for a
      // pool that may span several. `carriedCostUsd` prices a restored carry at
      // the most expensive model in `carriedModels` whatever the record said, so
      // naming the dearest keeps the restored total an upper bound.
      const accounting = new RunAccounting();
      const root = context('root');
      accounting.startRoot(root);
      accounting.record(root, usage(100, 10), {
        provider: 'openai-compatible',
        requestedModel: 'gpt-5-mini',
        responseModel: 'gpt-5-mini',
        responseId: 'cheap',
      } as unknown as ProviderResponseMetadata);
      accounting.startExecution(context('child', 'root'));
      accounting.record(context('child', 'root'), usage(10, 1), {
        provider: 'anthropic',
        requestedModel: 'claude-opus-5',
        responseModel: 'claude-opus-5',
        responseId: 'dear',
      } as unknown as ProviderResponseMetadata);

      expect(accounting.dearestModel('root')).toBe('claude-opus-5');
      expect(accounting.dearestModel('missing')).toBeUndefined();
    });

    it('names a model the root spent under even when no rate card prices it', () => {
      // An unpriced name makes the restored carry unknown and fails every budget
      // closed, so a model Book cannot rank is still better than none.
      const accounting = new RunAccounting();
      const root = context('root');
      accounting.startRoot(root);
      accounting.record(root, usage(10, 1), {
        provider: 'openai-compatible',
        requestedModel: 'some-local-model',
        responseModel: 'some-local-model',
        responseId: 'unpriced',
      } as unknown as ProviderResponseMetadata);

      expect(accounting.dearestModel('root')).toBe('some-local-model');
    });

    it('names the source models for a successor that spent nothing itself', () => {
      // A successor that only inherited a remainder still has to write it, and
      // the models that spent it are the source's. Naming none would leave the
      // restored carry priced at nothing.
      const accounting = new RunAccounting();
      const rootOne = context('root-1-turn', 'root-1');
      accounting.startRoot(rootOne);
      accounting.record(rootOne, usage(100, 10), meta);
      const inclusive = accounting.snapshotRoot('root-1').inclusiveUsage;
      accounting.seedRoot('root-2', {
        usage: inclusive,
        costUsd: 0.1,
        persistedUsage: undefined,
        fromRootRunId: 'root-1',
      });
      // Root 2 never runs a turn of its own.
      accounting.startRoot(context('root-2', 'root-2'));

      expect(accounting.modelsFor('root-2')).toEqual(['claude-sonnet-5']);
      expect(accounting.dearestModel('root-2')).toBe('claude-sonnet-5');
      // A root nobody seeded still names only what it spent itself.
      expect(accounting.modelsFor('root-1')).toEqual(['claude-sonnet-5']);
      expect(accounting.modelsFor('missing')).toEqual([]);
    });
  });
});
