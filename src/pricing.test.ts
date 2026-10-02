import { describe, it, expect } from 'vitest';
import {
  accumulateSessionUsage,
  usageReport,
  costReport,
  estimateUsageCost,
  hasKnownPricing,
  modelBreakdownLines,
  promptSizeTokens,
  resolveModelPricing,
  trafficTokens,
  usageCostUsd,
  PRICING,
  type ModelPricing,
} from './pricing.js';

const NO_CACHE = { promptTokens: 1_000, completionTokens: 500, totalTokens: 1_500 };

/**
 * Anthropic's published price list, $ per million tokens, as of 2026-09-25. Held
 * here as the expectation rather than read back out of `PRICING`, so a typo in the
 * table fails this suite instead of quietly defining it (#370).
 */
const ANTHROPIC_LIST_PRICING: Record<
  string,
  Required<Pick<ModelPricing, 'in' | 'out' | 'cacheRead' | 'cacheCreation'>>
> = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2, cacheCreation: 5 },
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.5, cacheCreation: 6.25 },
  'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.5, cacheCreation: 6.25 },
  'claude-opus-4-7': { in: 5, out: 25, cacheRead: 0.5, cacheCreation: 6.25 },
  'claude-opus-4-6': { in: 5, out: 25, cacheRead: 0.5, cacheCreation: 6.25 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.2, cacheCreation: 2.5 },
  'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.2, cacheCreation: 2.5 },
  'claude-sonnet-4-6': { in: 3, out: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.25, cacheCreation: 12.5 },
  'claude-fable-5': { in: 10, out: 50, cacheRead: 1, cacheCreation: 12.5 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5, cacheRead: 0.1, cacheCreation: 1.25 },
};

describe('published Claude rates (#370)', () => {
  for (const [model, expected] of Object.entries(ANTHROPIC_LIST_PRICING)) {
    it(`prices ${model} at its published rate`, () => {
      const resolved = resolveModelPricing(model);
      expect(resolved?.key).toBe(model);
      expect(resolved?.rate).toMatchObject(expected);
      expect(hasKnownPricing(model)).toBe(true);
    });
  }

  it('leaves no current Claude model unpriced, so a USD budget does not refuse the run', () => {
    // `checkBeforeModelCall` refuses every call for a model with no rate, which
    // made a budgeted run stop outright on any model the table had not caught up
    // with (#370).
    for (const model of ['claude-opus-5-5', 'claude-opus-4-6', 'claude-sonnet-4-6']) {
      expect(hasKnownPricing(model), model).toBe(true);
    }
  });
});

describe('estimateUsageCost with cache tokens', () => {
  it('prices a cached Anthropic turn instead of refusing it', () => {
    // Book sets cache_control on every Anthropic request, so this is the normal
    // path. With no cacheRead/cacheCreation rate this returned
    // 'cache-pricing-unavailable', which made checkBeforeModelCall refuse every
    // call after the first cached turn whenever a USD budget was set.
    const quote = estimateUsageCost('claude-sonnet-5', {
      ...NO_CACHE,
      cacheReadInputTokens: 40_000,
      cacheCreationInputTokens: 8_000,
    });
    expect(quote.status).toBe('known');
    // (1000*2 + 500*10 + 40000*0.2 + 8000*2.5) / 1e6
    expect(quote.costUsd).toBeCloseTo(0.035, 6);
  });

  it('prices every Claude entry when cache tokens are reported', () => {
    for (const [model, rate] of Object.entries(PRICING)) {
      if (!model.startsWith('claude-')) continue;
      const quote = estimateUsageCost(model, {
        ...NO_CACHE,
        cacheReadInputTokens: 1_000,
        cacheCreationInputTokens: 1_000,
      });
      expect(quote, model).toMatchObject({ status: 'known' });
      expect(rate.cacheRead, model).toBeGreaterThan(0);
      expect(rate.cacheCreation, model).toBeGreaterThan(0);
    }
  });

  it('prices cache reads at the input rate when the model has no cache-read rate', () => {
    // OpenAI-compatible providers report automatic cache reads. Refusing them would
    // make a USD budget refuse every gpt call; the input rate is an upper bound.
    const quote = estimateUsageCost('gpt-5', { ...NO_CACHE, cacheReadInputTokens: 10 });
    expect(quote.status).toBe('known');
    // (1000*5 + 500*15 + 10*5) / 1e6
    expect(quote.costUsd).toBeCloseTo(0.01255, 8);
  });

  it('prices a missing cache-write rate at twice the input rate instead of refusing it', () => {
    // An unknown estimate stops a USD-budgeted run; twice the input rate is the highest
    // cache-write premium a provider charges, so the figure is an upper bound.
    const quote = estimateUsageCost('gpt-5', { ...NO_CACHE, cacheCreationInputTokens: 10 });
    expect(quote.status).toBe('known');
    // (1000*5 + 500*15 + 10*5*2) / 1e6
    expect(quote.costUsd).toBeCloseTo(0.0126, 8);
    expect(
      usageCostUsd(PRICING['gpt-5'], { ...NO_CACHE, cacheCreationInputTokens: 10 }),
    ).toBeCloseTo(0.0126, 8);
  });
});

describe('model family resolution', () => {
  it('prices a dated model id from its family key', () => {
    const quote = estimateUsageCost('claude-sonnet-5-20260115', NO_CACHE);
    expect(quote).toMatchObject({ status: 'known', pricingKey: 'claude-sonnet-5' });
    expect(hasKnownPricing('claude-sonnet-5-20260115')).toBe(true);
  });

  it('prefers the longest matching family key', () => {
    expect(resolveModelPricing('claude-opus-4-8-20260101')?.key).toBe('claude-opus-4-8');
    expect(resolveModelPricing('claude-opus-4-7-20260101')?.key).toBe('claude-opus-4-7');
  });

  it('omits pricingKey on an exact hit so the common case stays quiet', () => {
    expect(estimateUsageCost('claude-sonnet-5', NO_CACHE)).not.toHaveProperty('pricingKey');
  });

  it('requires a separator boundary so a key cannot claim an unrelated id', () => {
    expect(resolveModelPricing('gpt-51')).toBeUndefined();
    expect(hasKnownPricing('gpt-51')).toBe(false);
  });

  it('prices Opus 5, which the provider already treats as a thinking model', () => {
    // provider/anthropic.ts lists claude-opus-5 as adaptive-thinking capable, so
    // Book sent it thinking parameters while hasKnownPricing said false — which
    // makes checkBeforeModelCall refuse every call once a USD budget is set.
    expect(hasKnownPricing('claude-opus-5')).toBe(true);
    expect(resolveModelPricing('claude-opus-5-20260101')?.key).toBe('claude-opus-5');
  });

  it('prices an undated alias from its dated entry', () => {
    // claude-haiku-4-5 -> claude-haiku-4-5-20251001: same model, and the alias is
    // what a user actually types.
    expect(resolveModelPricing('claude-haiku-4-5')?.key).toBe('claude-haiku-4-5-20251001');
  });

  it('does not let an alias match an unrelated longer key', () => {
    expect(resolveModelPricing('claude-opus')).toBeUndefined();
    expect(resolveModelPricing('gpt')).toBeUndefined();
  });

  it('matches a version suffix only when it is a real date stamp (#370)', () => {
    // The suffix matcher read any trailing digit run as a date, so
    // `claude-opus-5-5` resolved to the `claude-opus-5` row and `claude-fable-5-1`
    // to `claude-fable-5` — two different models, priced as one.
    expect(resolveModelPricing('claude-opus-5-5-20260301')?.key).toBe('claude-opus-5-5');
    expect(resolveModelPricing('claude-sonnet-5-2026-01-15')?.key).toBe('claude-sonnet-5');
  });

  it('refuses to price a version-suffixed id from its own prefix (#370)', () => {
    // Same failure the `gpt-4o-mini` rule exists for, on the Claude side: an
    // unknown model priced from a cheaper prefix is an enforced wrong figure, and
    // the budget rail acts on it.
    expect(resolveModelPricing('claude-opus-5-9')).toBeUndefined();
    expect(resolveModelPricing('claude-fable-5-7')).toBeUndefined();
    expect(hasKnownPricing('claude-opus-5-9')).toBe(false);
  });

  it('still reports genuinely unknown models as unknown', () => {
    expect(estimateUsageCost('made-up-model', NO_CACHE)).toMatchObject({
      status: 'unknown',
      reason: 'unknown-model',
    });
  });
});

describe('pricing overrides', () => {
  it('lets an override supply a rate for a model absent from the table', () => {
    const quote = estimateUsageCost('local/experiment', NO_CACHE, {
      'local/experiment': { in: 1, out: 2 },
    });
    expect(quote).toMatchObject({ status: 'known' });
    expect(quote.costUsd).toBeCloseTo(0.002, 6);
  });

  it('lets an override win over a built-in entry', () => {
    const quote = estimateUsageCost('claude-sonnet-5', NO_CACHE, {
      'claude-sonnet-5': { in: 30, out: 150 },
    });
    expect(quote.costUsd).toBeCloseTo(0.105, 6);
  });
});

describe('usageReport', () => {
  it('reports a placeholder before first response when usage is null', () => {
    const r = usageReport('claude-sonnet-5', null, {
      currentTurn: 0,
      messageCount: 2,
      turnDurationMs: 0,
    });
    expect(r).toContain('no model response yet');
    expect(r).toContain('claude-sonnet-5');
  });

  it('computes cost and shows turns / duration', () => {
    const r = usageReport(
      'claude-sonnet-5',
      { promptTokens: 10000, completionTokens: 2000, totalTokens: 12000 },
      { currentTurn: 3, messageCount: 7, turnDurationMs: 4200 },
    );
    expect(r).toContain('Turn: 3');
    expect(r).toContain('Messages: 7');
    expect(r).toContain('Last turn duration: 4.2s');
    expect(r).toContain('10,000');
    expect(r).toContain('2,000');
    // rate in * 2 /M, out * 10 /M → (10000*2 + 2000*10)/1e6 = 0.04
    expect(r).toContain('$0.0400');
  });

  it('labels unknown models honestly instead of guessing', () => {
    const r = usageReport(
      'made-up-model',
      { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      { currentTurn: 1, messageCount: 2, turnDurationMs: 0 },
    );
    expect(r).toContain('pricing unknown for "made-up-model"');
  });

  it('appends per-tool call and failure counters when provided', () => {
    const r = usageReport(
      'claude-sonnet-5',
      { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      { currentTurn: 1, messageCount: 2, turnDurationMs: 1000 },
      [
        { tool: 'Grep', calls: 8, failures: { invalid_arguments: 3 } },
        { tool: 'Read', calls: 5, failures: {} },
      ],
    );
    expect(r).toContain('Tool calls: 13 total  •  3 failed');
    expect(r).toContain('Grep: 8 (3 failed: invalid_arguments ×3)');
    expect(r).toContain('Read: 5');
  });

  it('shows cached tokens and prices them at the cache-read rate', () => {
    const r = usageReport(
      'claude-sonnet-5',
      {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
        cacheReadInputTokens: 9000,
      },
      { currentTurn: 1, messageCount: 2, turnDurationMs: 0 },
    );
    expect(r).toContain('•  9,000 cached');
    // (1000*2 + 500*10 + 9000*0.2) / 1e6 = 0.0088
    expect(r).toContain('$0.0088');
  });
});

describe('costReport (unchanged)', () => {
  it('still reports no usage before first response', () => {
    expect(costReport('claude-sonnet-5', null)).toContain('No token usage recorded');
  });

  it('counts cached tokens in the summary and the price', () => {
    const r = costReport('claude-sonnet-5', {
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      cacheReadInputTokens: 9000,
    });
    expect(r).toContain('(1,000 in, 9,000 cached, 500 out)');
    expect(r).toContain('10,500 tokens (1,000 in, 9,000 cached, 500 out)');
    expect(r).toContain('$0.0088 estimated');
  });

  it('prices cached tokens in the per-model breakdown', () => {
    const lines = modelBreakdownLines(
      'claude-sonnet-5',
      { promptTokens: 1000, completionTokens: 500, cacheReadInputTokens: 9000 },
      [
        {
          label: 'explorer',
          model: 'claude-haiku-4-5-20251001',
          usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
        },
      ],
    );
    expect(lines.join('\n')).toContain(
      'claude-sonnet-5 (session) - prompt 1,000, completion 500, cache read 9,000 - $0.0088',
    );
  });

  it('prices cache writes on a model with no cache-write rate in both reports', () => {
    const usage = {
      promptTokens: 1000,
      completionTokens: 20,
      totalTokens: 1020,
      cacheCreationInputTokens: 500,
    };
    // (1000*5 + 20*15 + 500*10) / 1e6 = 0.0103
    expect(costReport('gpt-5', usage)).toContain('$0.0103 estimated');
    expect(
      usageReport('gpt-5', usage, { currentTurn: 1, messageCount: 2, turnDurationMs: 0 }),
    ).toContain('Est. cost: $0.0103');
  });

  it('counts prompt size and traffic across cache tokens', () => {
    const usage = {
      promptTokens: 1000,
      completionTokens: 500,
      totalTokens: 1500,
      cacheReadInputTokens: 9000,
      cacheCreationInputTokens: 200,
    };
    expect(promptSizeTokens(usage)).toBe(10_200);
    expect(trafficTokens(usage)).toBe(10_700);
    expect(trafficTokens({ promptTokens: 10, completionTokens: 5, totalTokens: 15 })).toBe(15);
  });

  it('shows the larger of the provider total and the counted tokens', () => {
    // total_tokens counting hidden reasoning beyond completion_tokens
    expect(
      trafficTokens({
        promptTokens: 200,
        completionTokens: 50,
        totalTokens: 1400,
        cacheReadInputTokens: 800,
      }),
    ).toBe(1400);
    // no total_tokens at all
    expect(trafficTokens({ promptTokens: 1000, completionTokens: 50, totalTokens: 0 })).toBe(1050);
  });

  it('skips the lead counterfactual when the lead has no rate for the cache tokens', () => {
    const lines = modelBreakdownLines('gpt-5', { promptTokens: 1000, completionTokens: 100 }, [
      {
        label: 'explorer',
        model: 'claude-haiku-4-5-20251001',
        usage: {
          promptTokens: 50_000,
          completionTokens: 10_000,
          totalTokens: 60_000,
          cacheReadInputTokens: 2_000_000,
        },
      },
    ]).join('\n');
    expect(lines).toContain('Total - $');
    expect(lines).not.toContain('Same tokens entirely on gpt-5');
  });
});

describe('prefix pricing must not price a sibling model', () => {
  it('refuses to price gpt-4o-mini from gpt-4o', () => {
    // `gpt-4o-mini` starts with `gpt-4o` at a separator boundary, but it is a
    // different model roughly 16x cheaper. Pricing it from its prefix replaces an
    // honest `unknown` with an enforced figure wrong by an order of magnitude —
    // and the budget gate acts on that figure, terminating the run
    // `budget_exceeded` at a fraction of the real spend.
    expect(resolveModelPricing('gpt-4o-mini')).toBeUndefined();
    expect(resolveModelPricing('gpt-5-mini')).toBeUndefined();
    expect(resolveModelPricing('gpt-5-nano')).toBeUndefined();
    expect(hasKnownPricing('gpt-4o-mini')).toBe(false);
  });

  it('still prices a dated re-resolution of the same model', () => {
    // The case the forward direction exists for: providers resolve an alias to a
    // dated id, which is the same model and must keep its rate.
    expect(resolveModelPricing('claude-sonnet-5-20260115')).toMatchObject({
      key: 'claude-sonnet-5',
    });
    expect(resolveModelPricing('claude-sonnet-5-2026-01-15')).toMatchObject({
      key: 'claude-sonnet-5',
    });
  });
});

describe('session-cumulative usage', () => {
  it('sums every response into one session total', () => {
    // `/cost` used to price `context.usage`, which the TUI replaces on every
    // model response and nulls on every send: after turns of 1,100 and 2,200
    // tokens it reported 2,200 for the session (#370).
    const first = accumulateSessionUsage(null, {
      promptTokens: 1000,
      completionTokens: 100,
      totalTokens: 1100,
    });
    const second = accumulateSessionUsage(first, {
      promptTokens: 2000,
      completionTokens: 200,
      totalTokens: 2200,
    });
    expect(second).toEqual({
      promptTokens: 3000,
      completionTokens: 300,
      totalTokens: 3300,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    });
  });

  it('sums cache counts when the provider reports them', () => {
    const first = accumulateSessionUsage(null, {
      promptTokens: 10,
      completionTokens: 1,
      totalTokens: 11,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 200,
    });
    const second = accumulateSessionUsage(first, {
      promptTokens: 20,
      completionTokens: 2,
      totalTokens: 22,
      cacheReadInputTokens: 300,
    });
    expect(second.cacheReadInputTokens).toBe(400);
    expect(second.cacheCreationInputTokens).toBe(200);
  });
});

describe('usageReport counts delegated agents', () => {
  it('breaks the session down by the model each agent ran on', () => {
    // /usage priced the lead's per-request usage and dropped `delegatedUsage`
    // entirely, so a session that spawned agents under-reported itself (#370).
    const r = usageReport(
      'claude-sonnet-5',
      { promptTokens: 3000, completionTokens: 300, totalTokens: 3300 },
      { currentTurn: 2, messageCount: 4, turnDurationMs: 0 },
      undefined,
      [
        {
          label: 'explorer "map auth"',
          model: 'claude-haiku-4-5-20251001',
          usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
        },
      ],
    );
    expect(r).toContain('Per model');
    expect(r).toContain('claude-haiku-4-5-20251001 (1 delegated)');
    expect(r).toContain('3,300');
    expect(r).not.toContain('not yet wired');
  });
});
