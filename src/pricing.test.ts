import { describe, it, expect } from 'vitest';
import {
  usageReport,
  costReport,
  estimateUsageCost,
  hasKnownPricing,
  resolveModelPricing,
  PRICING,
} from './pricing.js';

const NO_CACHE = { promptTokens: 1_000, completionTokens: 500, totalTokens: 1_500 };

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
    // (1000*3 + 500*15 + 40000*0.3 + 8000*3.75) / 1e6
    expect(quote.costUsd).toBeCloseTo(0.0525, 6);
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

  it('still refuses to guess a missing cache rate', () => {
    const quote = estimateUsageCost('gpt-5', { ...NO_CACHE, cacheReadInputTokens: 10 });
    expect(quote).toMatchObject({ status: 'unknown', reason: 'cache-pricing-unavailable' });
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
    // rate in * 3 /M, out * 15 /M → (10000*3 + 2000*15)/1e6 = 0.06
    expect(r).toContain('$0.0600');
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
});

describe('costReport (unchanged)', () => {
  it('still reports no usage before first response', () => {
    expect(costReport('claude-sonnet-5', null)).toContain('No token usage recorded');
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
