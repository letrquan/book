import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  addUsage,
  usageReport,
  costReport,
  estimateUsageCost,
  hasKnownPricing,
  modelBreakdownLines,
  pricingOverridesFromProviders,
  PRICING_SETTING_HINT,
  promptSizeTokens,
  resolveModelPricing,
  sessionTotals,
  trafficTokens,
  usageCostUsd,
  PRICING,
  type ModelPricing,
} from './pricing.js';
import { RunAccounting } from './session/run-accounting.js';
import { ignoredWorkspaceUserOnlyKeys, resolveSettings } from './settings-loader.js';
import {
  persistWorkspaceProviderChoice,
  workspaceProviderFingerprint,
} from './provider-approvals.js';
import type { AgentRunContext } from './types/runs.js';

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
  'claude-opus-4-5': { in: 5, out: 25, cacheRead: 0.5, cacheCreation: 6.25 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.1, cacheCreation: 2.5 },
  'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.2, cacheCreation: 2.5 },
  'claude-sonnet-4-6': { in: 3, out: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-sonnet-4-5': { in: 3, out: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  'claude-fable-5-1': { in: 10, out: 50, cacheRead: 0.25, cacheCreation: 12.5 },
  'claude-fable-5': { in: 10, out: 50, cacheRead: 1, cacheCreation: 12.5 },
  'claude-mythos-5-1': { in: 10, out: 50, cacheRead: 0.25, cacheCreation: 12.5 },
  'claude-mythos-5': { in: 10, out: 50, cacheRead: 1, cacheCreation: 12.5 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01, cacheCreation: 0.125 },
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

  it('prices claude-haiku-5-5 with a prompt-length tier', () => {
    const resolved = resolveModelPricing('claude-haiku-5-5');
    expect(resolved?.rate.longPrompt).toEqual({
      overPromptTokens: 100_000,
      rate: { in: 0.5, out: 2.5, cacheRead: 0.05, cacheCreation: 0.625 },
    });
  });

  it('leaves no current Claude model unpriced, so a USD budget does not refuse the run', () => {
    // `checkBeforeModelCall` refuses every call for a model with no rate, which
    // made a budgeted run stop outright on any model the table had not caught up
    // with (#370). Read the ids out of the table rather than restating them: a
    // row added without a test here would fail the budget rail silently.
    const claudeModels = [
      ...Object.keys(PRICING).filter((model) => model.startsWith('claude-')),
      'claude-mythos-5-1',
      'claude-mythos-5',
    ];
    for (const model of claudeModels) {
      expect(hasKnownPricing(model), model).toBe(true);
    }
  });

  it('resolves dated 4.5 model ids to their family keys', () => {
    expect(resolveModelPricing('claude-opus-4-5-20251101')?.key).toBe('claude-opus-4-5');
    expect(resolveModelPricing('claude-sonnet-4-5-20250929')?.key).toBe('claude-sonnet-4-5');
    expect(hasKnownPricing('claude-opus-4-5-20251101')).toBe(true);
    expect(hasKnownPricing('claude-sonnet-4-5-20250929')).toBe(true);
  });
});

describe('estimateUsageCost with cache tokens', () => {
  it('prices a cached Anthropic turn instead of refusing it', () => {
    // Book sets cache_control on every Anthropic request, so this is the normal
    // path. With no cacheRead/cacheCreation rate this returned
    // 'cache-pricing-unavailable', which made checkBeforeModelCall refuse every
    // call after the first cached turn whenever a USD budget was set.
    const quote = estimateUsageCost(
      'claude-sonnet-5',
      {
        ...NO_CACHE,
        cacheReadInputTokens: 40_000,
        cacheCreationInputTokens: 8_000,
      },
      'request',
    );
    expect(quote.status).toBe('known');
    // (1000*2 + 500*10 + 40000*0.2 + 8000*2.5) / 1e6
    expect(quote.costUsd).toBeCloseTo(0.035, 6);
  });

  it('prices every Claude entry when cache tokens are reported', () => {
    for (const [model, rate] of Object.entries(PRICING)) {
      if (!model.startsWith('claude-')) continue;
      const quote = estimateUsageCost(
        model,
        {
          ...NO_CACHE,
          cacheReadInputTokens: 1_000,
          cacheCreationInputTokens: 1_000,
        },
        'request',
      );
      expect(quote, model).toMatchObject({ status: 'known' });
      expect(rate.cacheRead, model).toBeGreaterThan(0);
      expect(rate.cacheCreation, model).toBeGreaterThan(0);
    }
  });

  it('prices cache reads at the input rate when the model has no cache-read rate', () => {
    // OpenAI-compatible providers report automatic cache reads. Refusing them would
    // make a USD budget refuse every gpt call; the input rate is an upper bound.
    const quote = estimateUsageCost('gpt-5', { ...NO_CACHE, cacheReadInputTokens: 10 }, 'request');
    expect(quote.status).toBe('known');
    // (1000*5 + 500*15 + 10*5) / 1e6
    expect(quote.costUsd).toBeCloseTo(0.01255, 8);
  });

  it('prices a missing cache-write rate at twice the input rate instead of refusing it', () => {
    // An unknown estimate stops a USD-budgeted run; twice the input rate is the highest
    // cache-write premium a provider charges, so the figure is an upper bound.
    const quote = estimateUsageCost(
      'gpt-5',
      { ...NO_CACHE, cacheCreationInputTokens: 10 },
      'request',
    );
    expect(quote.status).toBe('known');
    // (1000*5 + 500*15 + 10*5*2) / 1e6
    expect(quote.costUsd).toBeCloseTo(0.0126, 8);
    expect(
      usageCostUsd(PRICING['gpt-5'], { ...NO_CACHE, cacheCreationInputTokens: 10 }, 'request'),
    ).toBeCloseTo(0.0126, 8);
  });
});

describe('model family resolution', () => {
  it('prices a dated model id from its family key', () => {
    const quote = estimateUsageCost('claude-sonnet-5-20260115', NO_CACHE, 'request');
    expect(quote).toMatchObject({ status: 'known', pricingKey: 'claude-sonnet-5' });
    expect(hasKnownPricing('claude-sonnet-5-20260115')).toBe(true);
  });

  it('prefers the longest matching family key', () => {
    expect(resolveModelPricing('claude-opus-4-8-20260101')?.key).toBe('claude-opus-4-8');
    expect(resolveModelPricing('claude-opus-4-7-20260101')?.key).toBe('claude-opus-4-7');
  });

  it('omits pricingKey on an exact hit so the common case stays quiet', () => {
    expect(estimateUsageCost('claude-sonnet-5', NO_CACHE, 'request')).not.toHaveProperty(
      'pricingKey',
    );
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

  it('still accepts the short snapshot stamps providers append (#370)', () => {
    // Reading "date only" as "8 digits only" broke the stamps OpenAI ships: a
    // 4-digit MMDD (`gpt-4o-0806`) and a 3-digit zero-led snapshot
    // (`gpt-5-001`). Both are the same model as their prefix, and leaving them
    // unpriced makes a USD budget refuse the call.
    expect(resolveModelPricing('gpt-4o-0806')?.key).toBe('gpt-4o');
    expect(resolveModelPricing('gpt-4o-0613')?.key).toBe('gpt-4o');
    expect(resolveModelPricing('gpt-5-001')?.key).toBe('gpt-5');
    expect(hasKnownPricing('gpt-4o-0806')).toBe(true);
  });

  it('still refuses a short version suffix (#370)', () => {
    // The reason the matcher is date-only at all: 1 or 2 digits is a version, not
    // a stamp, and `-4-6` is two of them.
    expect(resolveModelPricing('gpt-4o-45')).toBeUndefined();
    expect(resolveModelPricing('gpt-5-5')).toBeUndefined();
    expect(resolveModelPricing('gpt-5-1')).toBeUndefined();
    expect(resolveModelPricing('gpt-5-4-6')).toBeUndefined();
    // An exact row is still its own row, not its prefix's.
    expect(resolveModelPricing('claude-opus-5-5')?.key).toBe('claude-opus-5-5');
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
    expect(estimateUsageCost('made-up-model', NO_CACHE, 'request')).toMatchObject({
      status: 'unknown',
      reason: 'unknown-model',
    });
  });
});

describe('pricing overrides', () => {
  it('lets an override supply a rate for a model absent from the table', () => {
    const quote = estimateUsageCost('local/experiment', NO_CACHE, 'request', {
      'local/experiment': { in: 1, out: 2 },
    });
    expect(quote).toMatchObject({ status: 'known' });
    expect(quote.costUsd).toBeCloseTo(0.002, 6);
  });

  it('lets an override win over a built-in entry', () => {
    const quote = estimateUsageCost('claude-sonnet-5', NO_CACHE, 'request', {
      'claude-sonnet-5': { in: 30, out: 150 },
    });
    expect(quote.costUsd).toBeCloseTo(0.105, 6);
  });
});

/** The model a daily-job run reaches through 9router: no entry in the built-in table. */
const ROUTER_MODEL = 'cmc/deepseek/deepseek-v4.1-flash';
const ROUTER_PROVIDERS = {
  r1: { models: { [ROUTER_MODEL]: { pricing: { in: 0.14, out: 0.28 } } } },
};

describe('pricing from settings (#663)', () => {
  describe('pricingOverridesFromProviders', () => {
    it('keys a rate by the model id a request carries, not by <provider>/<model>', () => {
      expect(pricingOverridesFromProviders(ROUTER_PROVIDERS)).toEqual({
        [ROUTER_MODEL]: { in: 0.14, out: 0.28 },
      });
    });

    it('reads the settings cacheWrite as the table cacheCreation', () => {
      const table = pricingOverridesFromProviders({
        r1: { models: { m: { pricing: { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 } } } },
      });
      expect(table?.m).toEqual({ in: 3, out: 15, cacheRead: 0.3, cacheCreation: 3.75 });
    });

    it('is undefined when no model declares a rate, so callers keep the table-only path', () => {
      expect(pricingOverridesFromProviders(undefined)).toBeUndefined();
      expect(pricingOverridesFromProviders({})).toBeUndefined();
      expect(pricingOverridesFromProviders({ r1: { models: { m: {} } } })).toBeUndefined();
      expect(pricingOverridesFromProviders({ r1: {} })).toBeUndefined();
    });

    it('applies the highest of each rate when two providers price one model id', () => {
      const a = { in: 1, out: 2 };
      const b = { in: 3, out: 1 };
      const both = (first: typeof a, second: typeof b) =>
        pricingOverridesFromProviders({
          x: { models: { m: { pricing: first } } },
          y: { models: { m: { pricing: second } } },
        })?.m;
      // The same answer whichever provider comes first in the file, and never below either one.
      expect(both(a, b)).toEqual({ in: 3, out: 2 });
      expect(
        pricingOverridesFromProviders({
          x: { models: { m: { pricing: b } } },
          y: { models: { m: { pricing: a } } },
        })?.m,
      ).toEqual({ in: 3, out: 2 });
    });

    it('reads a cache rate a provider leaves out as the upper bound it is billed at', () => {
      const merged = (first: object, second: object) =>
        pricingOverridesFromProviders({
          x: { models: { m: { pricing: first as never } } },
          y: { models: { m: { pricing: second as never } } },
        })?.m;
      // x lists a cheap cache read, y lists none and so bills a read at its own input rate (1).
      expect(merged({ in: 0.5, out: 1, cacheRead: 0.05 }, { in: 1, out: 1 })).toEqual({
        in: 1,
        out: 1,
        cacheRead: 1,
      });
      // Equal list prices do not make the cache-heavy reading order-dependent.
      expect(merged({ in: 1, out: 1, cacheRead: 0.9 }, { in: 0.5, out: 1.5 })).toEqual(
        merged({ in: 0.5, out: 1.5 }, { in: 1, out: 1, cacheRead: 0.9 }),
      );
      // A write left out is billed at twice the input rate: x's 1.25 is below y's 2 * 2.
      expect(merged({ in: 1, out: 1, cacheWrite: 1.25 }, { in: 2, out: 1 })).toEqual({
        in: 2,
        out: 1,
        cacheCreation: 4,
      });
    });

    it('does not let a model named __proto__ reach the table prototype', () => {
      const providers = JSON.parse(
        '{"r1":{"models":{"__proto__":{"pricing":{"in":9,"out":9}},"ok":{"pricing":{"in":1,"out":1}}}}}',
      ) as Parameters<typeof pricingOverridesFromProviders>[0];
      const table = pricingOverridesFromProviders(providers);
      expect(Object.keys(table ?? {})).toEqual(['ok']);
      expect(Object.getPrototypeOf(table)).toBe(Object.prototype);
    });
  });

  describe('resolution', () => {
    it('leaves a router model unknown until a rate is declared', () => {
      expect(resolveModelPricing(ROUTER_MODEL)).toBeUndefined();
      expect(estimateUsageCost(ROUTER_MODEL, NO_CACHE, 'request')).toMatchObject({
        status: 'unknown',
        costUsd: null,
      });
    });

    it('makes the cost known once the settings declare a rate', () => {
      const quote = estimateUsageCost(
        ROUTER_MODEL,
        NO_CACHE,
        'request',
        pricingOverridesFromProviders(ROUTER_PROVIDERS),
      );
      expect(quote).toMatchObject({ status: 'known', model: ROUTER_MODEL });
      // 1,000 in at $0.14/M plus 500 out at $0.28/M.
      expect(quote.costUsd).toBeCloseTo(0.00028, 8);
    });

    it('still prices a table model from the table when no rate is declared for it', () => {
      const overrides = pricingOverridesFromProviders(ROUTER_PROVIDERS);
      expect(estimateUsageCost('claude-sonnet-5', NO_CACHE, 'request', overrides)).toEqual(
        estimateUsageCost('claude-sonnet-5', NO_CACHE, 'request'),
      );
      expect(resolveModelPricing('claude-sonnet-5', overrides)?.rate).toBe(
        PRICING['claude-sonnet-5'],
      );
    });

    it('prefers a declared rate to the table entry of the same id', () => {
      const overrides = pricingOverridesFromProviders({
        corp: { models: { 'claude-sonnet-5': { pricing: { in: 0.5, out: 1 } } } },
      });
      expect(resolveModelPricing('claude-sonnet-5', overrides)?.rate).toEqual({ in: 0.5, out: 1 });
    });

    it('prices a dated id the router returns from the declared id', () => {
      const overrides = pricingOverridesFromProviders(ROUTER_PROVIDERS);
      expect(hasKnownPricing(`${ROUTER_MODEL}-20261101`, overrides)).toBe(true);
      // The sibling-name guard of the table holds for a declared id too.
      expect(hasKnownPricing(`${ROUTER_MODEL}-mini`, overrides)).toBe(false);
    });

    it('prices an undated alias only from a declared key that adds a date stamp', () => {
      const overrides = { 'my-model-20261101': { in: 1, out: 2 } };
      expect(resolveModelPricing('my-model', overrides)?.key).toBe('my-model-20261101');
    });

    it('does not price a sibling from a declared key that merely extends its id', () => {
      // `deepseek-v4.1` is not `deepseek-v4.1-flash`: reading it as one would enforce a budget
      // against another model's rate.
      const overrides = pricingOverridesFromProviders(ROUTER_PROVIDERS);
      const flash = 'deepseek-v4.1-flash';
      const declared = { [flash]: { in: 0.14, out: 0.28 } };
      expect(resolveModelPricing('deepseek-v4.1', declared)).toBeUndefined();
      expect(resolveModelPricing('cmc/deepseek', overrides)).toBeUndefined();
      expect(resolveModelPricing('foo', { 'foo-pro': { in: 1, out: 1 } })).toBeUndefined();
      expect(hasKnownPricing('cmc/deepseek/deepseek', overrides)).toBe(false);
    });

    it('does not read a built-in version-suffixed key as the alias either', () => {
      // `claude-haiku-5` used to price as `claude-haiku-5-5`, the one table key that extends it.
      expect(resolveModelPricing('claude-haiku-5')).toBeUndefined();
      expect(resolveModelPricing('claude-haiku-4-5')?.key).toBe('claude-haiku-4-5-20251001');
    });

    it('prices an id such as constructor as unknown instead of reading Object.prototype', () => {
      expect(resolveModelPricing('constructor')).toBeUndefined();
      expect(resolveModelPricing('toString', {})).toBeUndefined();
      expect(hasKnownPricing('hasOwnProperty')).toBe(false);
    });
  });

  describe('the USD budget', () => {
    const root: AgentRunContext = {
      runId: 'root',
      rootRunId: 'root',
      sessionId: 'session',
      source: 'headless',
      startedAt: 1,
    };
    const metadata = {
      provider: 'openai-compatible',
      requestedModel: ROUTER_MODEL,
      responseModel: ROUTER_MODEL,
      responseId: 'response-1',
    };
    const million = { promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000 };

    it('refuses a router model with no rate, and says how to price it', () => {
      const accounting = new RunAccounting();
      accounting.startRoot(root, 1);
      const check = accounting.checkBeforeModelCall('root', ROUTER_MODEL);
      expect(check).toMatchObject({ allowed: false, status: 'unknown' });
      expect(check.message).toContain(`pricing is unknown for ${ROUTER_MODEL}`);
      expect(check.message).toContain(PRICING_SETTING_HINT);
    });

    it('lets a router model with a declared rate run, and counts its spend against the cap', () => {
      const accounting = new RunAccounting();
      accounting.usePricing(pricingOverridesFromProviders(ROUTER_PROVIDERS));
      accounting.startRoot(root, 0.2);

      expect(accounting.checkBeforeModelCall('root', ROUTER_MODEL)).toMatchObject({
        allowed: true,
        status: 'within',
      });
      // A million input tokens at $0.14/M.
      accounting.record(root, million, metadata);
      expect(accounting.snapshotRoot('root')).toMatchObject({
        costStatus: 'known',
        unknownModels: [],
        budgetStatus: 'within',
      });
      expect(accounting.snapshotRoot('root').inclusiveCostUsd).toBeCloseTo(0.14, 8);

      accounting.record(root, million, { ...metadata, responseId: 'response-2' });
      expect(accounting.snapshotRoot('root').inclusiveCostUsd).toBeCloseTo(0.28, 8);
      expect(accounting.checkBeforeModelCall('root', ROUTER_MODEL)).toMatchObject({
        allowed: false,
        status: 'exceeded',
      });
    });

    it('prices a router model the endpoint reported under another name from the requested one', () => {
      const accounting = new RunAccounting();
      accounting.usePricing(pricingOverridesFromProviders(ROUTER_PROVIDERS));
      accounting.startRoot(root, 1);
      accounting.record(root, million, { ...metadata, responseModel: 'deepseek-flash-routed' });
      expect(accounting.snapshotRoot('root')).toMatchObject({ costStatus: 'known' });
      expect(accounting.snapshotRoot('root').inclusiveCostUsd).toBeCloseTo(0.14, 8);
    });

    it('stops pricing a model once the rates are withdrawn', () => {
      const accounting = new RunAccounting();
      accounting.usePricing(pricingOverridesFromProviders(ROUTER_PROVIDERS));
      accounting.startRoot(root, 1);
      accounting.usePricing(undefined);
      expect(accounting.checkBeforeModelCall('root', ROUTER_MODEL)).toMatchObject({
        allowed: false,
        status: 'unknown',
      });
    });

    it('names the declared rate when asked for the dearest model', () => {
      const accounting = new RunAccounting();
      accounting.usePricing(
        pricingOverridesFromProviders({
          r1: {
            models: {
              dear: { pricing: { in: 50, out: 50 } },
              cheap: { pricing: { in: 1, out: 1 } },
            },
          },
        }),
      );
      accounting.startRoot(root, 100);
      accounting.record(root, million, {
        ...metadata,
        requestedModel: 'cheap',
        responseModel: 'cheap',
      });
      accounting.record(root, million, {
        ...metadata,
        requestedModel: 'dear',
        responseModel: 'dear',
        responseId: 'r2',
      });
      expect(accounting.dearestModel('root')).toBe('dear');
    });
  });

  describe('/cost and /usage', () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 };
    const overrides = pricingOverridesFromProviders(ROUTER_PROVIDERS);

    it('shows dollars for a router model with a declared rate', () => {
      const report = costReport(ROUTER_MODEL, usage, [], {}, undefined, overrides);
      // $0.14 in plus $0.28 out.
      expect(report).toContain('$0.4200 estimated');
      expect(report).not.toContain('no price');
    });

    it('tells a reader with an unpriced model where the rate goes', () => {
      expect(costReport(ROUTER_MODEL, usage)).toContain(
        `${ROUTER_MODEL} has no price, so no dollar estimate (${PRICING_SETTING_HINT})`,
      );
      expect(
        usageReport(ROUTER_MODEL, usage, { currentTurn: 1, messageCount: 2, turnDurationMs: 0 }),
      ).toContain(
        `pricing unknown for "${ROUTER_MODEL}"; tokens are counted, dollars are not (${PRICING_SETTING_HINT})`,
      );
    });

    it('shows the declared rate on the /usage rate line', () => {
      const report = usageReport(
        ROUTER_MODEL,
        usage,
        { currentTurn: 1, messageCount: 2, turnDurationMs: 0 },
        undefined,
        [],
        {},
        undefined,
        overrides,
      );
      expect(report).toContain('Est. cost: $0.4200  (local estimate — $0.14/M in, $0.28/M out)');
    });

    it('prices a delegated agent on a declared model, and the whole session with it', () => {
      const delegated = [{ label: 'explorer', model: ROUTER_MODEL, usage }];
      expect(sessionTotals('claude-sonnet-5', null, delegated).usd).toBeNull();
      const totals = sessionTotals('claude-sonnet-5', null, delegated, undefined, overrides);
      expect(totals.usd).toBeCloseTo(0.42, 8);
      const lines = modelBreakdownLines(
        'claude-sonnet-5',
        { promptTokens: 1000, completionTokens: 100 },
        delegated,
        undefined,
        overrides,
      );
      expect(lines.join('\n')).toContain(`${ROUTER_MODEL} (1 delegated)`);
      expect(lines.join('\n')).not.toContain('pricing unknown');
    });
  });
});

describe('pricing from settings layers (#663)', () => {
  let workspace: string;
  let home: string;
  const files = () => ({
    userSettingsPath: join(home, '.book', 'settings.json'),
    projectSettingsPath: join(workspace, '.book', 'settings.json'),
    localSettingsPath: join(workspace, '.book', 'settings.local.json'),
    trustStorePath: join(home, '.book', 'trust.json'),
  });
  const priced = (rate: { in: number; out: number }) => ({
    provider: { r1: { models: { [ROUTER_MODEL]: { pricing: rate } } } },
  });
  /** The user's own provider, with no price on its model. */
  const userProvider = {
    provider: {
      r1: { type: 'openai', baseURL: 'https://router.example/v1', models: { [ROUTER_MODEL]: {} } },
    },
  };

  function write(path: string, document: unknown): void {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(document));
  }
  function resolved(overridePath?: string) {
    const settings = resolveSettings(workspace, overridePath, files());
    return {
      settings,
      cost: estimateUsageCost(
        ROUTER_MODEL,
        NO_CACHE,
        'request',
        pricingOverridesFromProviders(settings.provider),
      ),
    };
  }

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'book-pricing-workspace-'));
    home = mkdtempSync(join(tmpdir(), 'book-pricing-home-'));
  });
  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it('honours a rate in the user-global file', () => {
    write(files().userSettingsPath, priced({ in: 0.14, out: 0.28 }));
    expect(resolved().cost).toMatchObject({ status: 'known' });
  });

  it('honours a rate in the --settings file, over the user file', () => {
    write(files().userSettingsPath, priced({ in: 1, out: 1 }));
    const flagFile = join(home, 'flag.json');
    write(flagFile, priced({ in: 0.14, out: 0.28 }));
    expect(resolved(flagFile).cost.costUsd).toBeCloseTo(0.00028, 8);
  });

  it('ignores a rate in the checked-in project file: the cost stays unknown', () => {
    write(files().userSettingsPath, userProvider);
    write(files().projectSettingsPath, priced({ in: 0, out: 0 }));
    const { settings, cost } = resolved();
    expect(cost).toMatchObject({ status: 'unknown', costUsd: null });
    expect(settings.provider.r1.models[ROUTER_MODEL]).toEqual({});
  });

  it('ignores a rate in a force-added settings.local.json the same way', () => {
    write(files().userSettingsPath, userProvider);
    write(files().localSettingsPath, priced({ in: 0, out: 0 }));
    expect(resolved().cost).toMatchObject({ status: 'unknown', costUsd: null });
  });

  it('keeps the user rate when a workspace layer prices the same model at zero', () => {
    write(files().userSettingsPath, priced({ in: 0.14, out: 0.28 }));
    write(files().projectSettingsPath, priced({ in: 0, out: 0 }));
    write(files().localSettingsPath, priced({ in: 0, out: 0 }));
    const { settings, cost } = resolved();
    expect(settings.provider.r1.models[ROUTER_MODEL].pricing).toEqual({ in: 0.14, out: 0.28 });
    expect(cost.costUsd).toBeCloseTo(0.00028, 8);
  });

  it('ignores a rate on a provider only the repository declares, even once the user approved it', () => {
    const declaration = {
      type: 'openai',
      baseURL: 'https://corp.example/v1',
      apiKey: 'k',
      models: { [ROUTER_MODEL]: { pricing: { in: 0, out: 0 } } },
    } as const;
    write(files().projectSettingsPath, { provider: { corp: declaration } });
    persistWorkspaceProviderChoice(
      workspace,
      'corp',
      workspaceProviderFingerprint(declaration),
      'approved',
      files().trustStorePath,
    );
    const { settings, cost } = resolved();
    // Approved, so in effect: it is the price that does not come with the approval.
    expect(Object.keys(settings.provider)).toEqual(['corp']);
    expect(settings.provider.corp.models[ROUTER_MODEL]).toEqual({});
    expect(cost).toMatchObject({ status: 'unknown', costUsd: null });
  });

  it('reports each ignored rate with the model it was set on', () => {
    const document = {
      provider: {
        r1: {
          models: {
            [ROUTER_MODEL]: { pricing: { in: 0, out: 0 } },
            other: { label: 'no price here' },
          },
        },
        r2: { models: { m2: { pricing: { in: 1, out: 2 } } } },
      },
    };
    expect(ignoredWorkspaceUserOnlyKeys(document)).toEqual([
      {
        key: `provider.r1.models.${ROUTER_MODEL}.pricing`,
        value: { in: 0, out: 0 },
        path: ['provider', 'r1', 'models', ROUTER_MODEL, 'pricing'],
      },
      {
        key: 'provider.r2.models.m2.pricing',
        value: { in: 1, out: 2 },
        path: ['provider', 'r2', 'models', 'm2', 'pricing'],
      },
    ]);
  });
});

describe('prompt-length tiers (Haiku 5.5)', () => {
  it('prices exactly 100,000 prompt tokens at the base rate under basis request', () => {
    const quote = estimateUsageCost(
      'claude-haiku-5-5',
      {
        promptTokens: 100_000,
        completionTokens: 0,
        totalTokens: 100_000,
      },
      'request',
    );
    expect(quote.status).toBe('known');
    // 100,000 * 0.1 / 1e6 = 0.01
    expect(quote.costUsd).toBeCloseTo(0.01, 8);
  });

  it('prices 100,001 prompt tokens at the long rate under basis request', () => {
    const quote = estimateUsageCost(
      'claude-haiku-5-5',
      {
        promptTokens: 100_001,
        completionTokens: 0,
        totalTokens: 100_001,
      },
      'request',
    );
    expect(quote.status).toBe('known');
    // 100,001 * 0.5 / 1e6 = 0.0500005
    expect(quote.costUsd).toBeCloseTo(0.0500005, 8);
  });

  it('crosses into the long rate due to cache reads counting towards prompt size', () => {
    const quote = estimateUsageCost(
      'claude-haiku-5-5',
      {
        promptTokens: 50_000,
        completionTokens: 0,
        totalTokens: 110_000,
        cacheReadInputTokens: 60_000,
      },
      'request',
    );
    expect(quote.status).toBe('known');
    // promptSize = 110,000 > 100,000 -> longPrompt rate applies:
    // (50,000 * 0.5 + 60,000 * 0.05) / 1e6 = (25,000 + 3,000) / 1e6 = 0.028
    expect(quote.costUsd).toBeCloseTo(0.028, 8);
  });

  it('basis pool always uses the long rate for Haiku 5.5', () => {
    const quote = estimateUsageCost(
      'claude-haiku-5-5',
      {
        promptTokens: 10_000,
        completionTokens: 0,
        totalTokens: 10_000,
      },
      'pool',
    );
    expect(quote.status).toBe('known');
    // Pool always uses long rate: 10,000 * 0.5 / 1e6 = 0.005
    expect(quote.costUsd).toBeCloseTo(0.005, 8);
  });

  it('basis pool changes nothing for an untiered model', () => {
    const requestQuote = estimateUsageCost(
      'claude-sonnet-5',
      {
        promptTokens: 200_000,
        completionTokens: 10_000,
        totalTokens: 210_000,
      },
      'request',
    );
    const poolQuote = estimateUsageCost(
      'claude-sonnet-5',
      {
        promptTokens: 200_000,
        completionTokens: 10_000,
        totalTokens: 210_000,
      },
      'pool',
    );
    expect(requestQuote.costUsd).toBe(poolQuote.costUsd);
  });
});

describe('reports with tiered models', () => {
  it('costReport with lead cost shows base-rate total and no upper bound note', () => {
    // Two 60k requests: 60k * 0.1 / 1e6 = 0.006 each -> 0.012 lead cost
    const usage = {
      promptTokens: 120_000,
      completionTokens: 0,
      totalTokens: 120_000,
    };
    const report = costReport('claude-haiku-5-5', usage, [], {}, 0.012);
    expect(report).toContain('$0.0120 estimated');
    expect(report).not.toContain('upper bound:');
  });

  it('costReport without lead cost shows long-rate total plus upper-bound note', () => {
    const usage = {
      promptTokens: 120_000,
      completionTokens: 0,
      totalTokens: 120_000,
    };
    const report = costReport('claude-haiku-5-5', usage);
    // Pooled: 120,000 * 0.5 / 1e6 = 0.060
    expect(report).toContain('$0.0600 estimated');
    expect(report).toContain(
      '(upper bound: claude-haiku-5-5 bills prompts over 100,000 tokens at a higher rate, and the request sizes behind this figure are not known)',
    );
  });

  it('falls back to pool pricing when leadCostUsd is null', () => {
    const usage = {
      promptTokens: 120_000,
      completionTokens: 0,
      totalTokens: 120_000,
    };
    const sonnetReport = costReport('claude-sonnet-5-5', usage, [], {}, null);
    expect(sonnetReport).toContain('$0.2400 estimated');

    const haikuReport = costReport('claude-haiku-5-5', usage, [], {}, null);
    expect(haikuReport).toContain('$0.0600 estimated');
    expect(haikuReport).toContain(
      '(upper bound: claude-haiku-5-5 bills prompts over 100,000 tokens at a higher rate, and the request sizes behind this figure are not known)',
    );
  });

  it('skips the counterfactual when a tiered model is involved', () => {
    const linesLeadTiered = modelBreakdownLines(
      'claude-haiku-5-5',
      { promptTokens: 1000, completionTokens: 100 },
      [
        {
          label: 'explorer',
          model: 'claude-sonnet-5',
          usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 },
        },
      ],
    );
    expect(linesLeadTiered).toContain('Per model');
    expect(linesLeadTiered.join('\n')).not.toContain('Same tokens entirely on');

    const linesAgentTiered = modelBreakdownLines(
      'claude-sonnet-5',
      { promptTokens: 1000, completionTokens: 100 },
      [
        {
          label: 'explorer',
          model: 'claude-haiku-5-5',
          usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100 },
        },
      ],
    );
    expect(linesAgentTiered).toContain('Per model');
    expect(linesAgentTiered.join('\n')).not.toContain('Same tokens entirely on');
  });

  it('shows both tiers in the rate line for a tiered model in usageReport', () => {
    const r = usageReport(
      'claude-haiku-5-5',
      { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      { currentTurn: 1, messageCount: 2, turnDurationMs: 0 },
    );
    expect(r).toContain('$0.1/M in, $0.5/M out; $0.5/M in, $2.5/M out over 100,000-token prompts');
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
    const first = addUsage(null, {
      promptTokens: 1000,
      completionTokens: 100,
      totalTokens: 1100,
    });
    const second = addUsage(first, {
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
    const first = addUsage(null, {
      promptTokens: 10,
      completionTokens: 1,
      totalTokens: 11,
      cacheReadInputTokens: 100,
      cacheCreationInputTokens: 200,
    });
    const second = addUsage(first, {
      promptTokens: 20,
      completionTokens: 2,
      totalTokens: 22,
      cacheReadInputTokens: 300,
    });
    expect(second.cacheReadInputTokens).toBe(400);
    expect(second.cacheCreationInputTokens).toBe(200);
  });

  it('keeps the latest contextTokens, which is a gauge rather than a total (#370)', () => {
    // The one sum three callers share (`run-accounting.ts`, `store.ts`, the TUI
    // bill) has to keep this: contextTokens is the pressure the compaction gate
    // reads, so the latest response's figure is the only true one, and summing it
    // would report a context window far larger than any request.
    expect(
      addUsage(
        { promptTokens: 1, completionTokens: 0, totalTokens: 1, contextTokens: 90 },
        {
          promptTokens: 1,
          completionTokens: 0,
          totalTokens: 1,
          contextTokens: 40,
        },
      ).contextTokens,
    ).toBe(40);
    expect(
      addUsage(
        { promptTokens: 1, completionTokens: 0, totalTokens: 1, contextTokens: 90 },
        {
          promptTokens: 1,
          completionTokens: 0,
          totalTokens: 1,
        },
      ).contextTokens,
    ).toBe(90);
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
    // The headline is the session's whole spend now: the lead's 3,300 plus the
    // agent's 110, which is also why the lead alone no longer appears there.
    expect(r).toContain('total 3,410');
    expect(r).toContain('prompt 3,000');
    expect(r).not.toContain('not yet wired');
  });

  it('explains the breakdown footnote without numeric lead cost', () => {
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
    expect(r).toContain(
      "(Delegated agents are included above, each priced at the model it ran on. The session's own turns are priced at the active model, so a mid-session model switch is not split out.)",
    );
  });

  it('explains the breakdown footnote with numeric lead cost', () => {
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
      {},
      0.009,
    );
    expect(r).toContain(
      "(Delegated agents are included above, each priced at the model it ran on. The session's own responses are each priced at the model that served them, but are listed under the active model.)",
    );
  });
});
