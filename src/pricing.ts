import type { Usage } from './types/messages.js';

/**
 * Local per-model pricing table ($ per million tokens, input/output).
 *
 * Convention: Claude Code and Aider both estimate USD locally from a hardcoded
 * table — no API, no live billing. Figures are illustrative and WILL go stale
 * as prices change; the displayed USD is always labeled an estimate.
 * ponytail: ceiling = user-overridable pricing via settings.json (PRICING or
 * a pricing.<model> key); add when a model not in the table needs a custom rate.
 */
export const PRICING_VERSION = 'book-local-2026-08-27';

export interface ModelPricing {
  in: number;
  out: number;
  cacheRead?: number;
  cacheCreation?: number;
  reasoningOut?: number;
}

/**
 * Anthropic cache multipliers against the base input rate: a cache read bills at
 * 0.1x and a 5-minute cache write at 1.25x. Written out per entry rather than
 * derived so a provider changing the ratio stays expressible, but any edit to
 * `in` should carry them along.
 *
 * A model that reports cache tokens with no rate for them is priced `unknown`,
 * which makes `checkBeforeModelCall` refuse every call — so an omission here
 * disables the USD budget rather than merely blurring a report. Book caches on
 * every Anthropic request, so that is the normal path, not an edge case.
 */
export const PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-sonnet-5': { in: 3, out: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  // Opus 5 was reachable but unpriced: `provider/anthropic.ts` already lists it as
  // an adaptive-thinking model, so Book sent it thinking parameters while
  // `hasKnownPricing` returned false — which makes `checkBeforeModelCall` refuse
  // every call whenever a USD budget is set. Rated at the Opus family figure;
  // RE-VERIFY against published pricing before a release.
  'claude-opus-5': { in: 15, out: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  'claude-opus-4-8': { in: 15, out: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  'claude-opus-4-7': { in: 15, out: 75, cacheRead: 1.5, cacheCreation: 18.75 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5, cacheRead: 0.1, cacheCreation: 1.25 },
  'claude-fable-5': { in: 3, out: 15, cacheRead: 0.3, cacheCreation: 3.75 },
  // OpenAI — no cache rates: only the Anthropic client populates the cache token
  // fields (`provider/anthropic.ts`), so these dimensions are never exercised
  // here and a guessed number would be unverifiable noise.
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-5': { in: 5, out: 15 },
  // GLM / z-ai
  'glm-4.6': { in: 0.6, out: 2.2 },
  'z-ai/glm-5.2': { in: 0.6, out: 2.2 },
};

/**
 * Characters that may follow a table key inside a longer model id. Requiring one
 * keeps `gpt-5` from claiming `gpt-51`.
 */
/** `-20260115`, `-2026-01-15`, `.20260115` — a version stamp, not a variant name. */
const DATED_MODEL_SUFFIX = /^[-.@]\d[\d-]*$/;

const PRICING_KEY_BOUNDARY = new Set(['-', '.', ':', '@', '/', '_']);

export interface ResolvedModelPricing {
  /** The table key the rate came from; differs from the model id on a family match. */
  key: string;
  rate: ModelPricing;
}

/**
 * Resolve a model id to a rate, falling back to the longest table key the id
 * extends at a separator boundary.
 *
 * Providers routinely resolve an alias to a dated id (`claude-sonnet-5` ->
 * `claude-sonnet-5-20260115`). Without family resolution every dated id prices as
 * unknown, and because `checkBeforeModelCall` fails closed on unknown pricing, a
 * USD budget then refuses the run outright rather than degrading to an unpriced
 * report.
 */
export function resolveModelPricing(
  model: string,
  overrides?: Readonly<Record<string, ModelPricing>>,
): ResolvedModelPricing | undefined {
  const tables = overrides ? [overrides, PRICING] : [PRICING];
  for (const table of tables) {
    const exact = table[model];
    if (exact) return { key: model, rate: exact };
  }
  for (const table of tables) {
    let best: ResolvedModelPricing | undefined;
    for (const [key, rate] of Object.entries(table)) {
      if (key.length >= model.length || !model.startsWith(key)) continue;
      if (!PRICING_KEY_BOUNDARY.has(model.charAt(key.length))) continue;
      // Only a DATE stamp, never a sibling name. `gpt-4o-mini` starts with `gpt-4o`
      // at a separator boundary, but it is a different, far cheaper model: pricing
      // it from its prefix replaces an honest `unknown` with an enforced figure
      // wrong by more than an order of magnitude, which the budget rail then acts
      // on. A dated re-resolution always continues with digits.
      if (!DATED_MODEL_SUFFIX.test(model.slice(key.length))) continue;
      if (!best || key.length > best.key.length) best = { key, rate };
    }
    if (best) return best;
  }
  // The reverse direction: an undated alias whose only table entry is dated
  // (`claude-haiku-4-5` -> `claude-haiku-4-5-20251001`). Same model, so pricing it
  // from the dated entry is correct; without this the alias is unpriced and a USD
  // budget refuses the run outright.
  for (const table of tables) {
    const candidates: ResolvedModelPricing[] = [];
    for (const [key, rate] of Object.entries(table)) {
      if (model.length >= key.length || !key.startsWith(model)) continue;
      if (!PRICING_KEY_BOUNDARY.has(key.charAt(model.length))) continue;
      candidates.push({ key, rate });
    }
    // Exactly one, or not at all. Unlike the forward direction — where a provider
    // appended a date to an id we know — a bare family name like `claude-opus`
    // could mean any generation, and guessing which would silently mis-price.
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) return undefined;
  }
  return undefined;
}

export type UsageCostEstimate =
  | {
      status: 'known';
      costUsd: number;
      model: string;
      pricingVersion: string;
      /** Set when the rate came from a family key rather than an exact entry. */
      pricingKey?: string;
    }
  | {
      status: 'unknown';
      costUsd: null;
      model: string;
      pricingVersion: string;
      reason: 'unknown-model' | 'cache-pricing-unavailable';
    };

export function hasKnownPricing(
  model: string,
  overrides?: Readonly<Record<string, ModelPricing>>,
): boolean {
  return resolveModelPricing(model, overrides) !== undefined;
}

/** Estimate one provider-reported usage event without guessing missing price dimensions. */
export function estimateUsageCost(
  model: string,
  usage: Usage,
  overrides?: Readonly<Record<string, ModelPricing>>,
): UsageCostEstimate {
  const resolved = resolveModelPricing(model, overrides);
  if (!resolved) {
    return {
      status: 'unknown',
      costUsd: null,
      model,
      pricingVersion: PRICING_VERSION,
      reason: 'unknown-model',
    };
  }
  const { key, rate } = resolved;

  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheCreation = usage.cacheCreationInputTokens ?? 0;
  if (
    (cacheRead > 0 && rate.cacheRead === undefined) ||
    (cacheCreation > 0 && rate.cacheCreation === undefined)
  ) {
    return {
      status: 'unknown',
      costUsd: null,
      model,
      pricingVersion: PRICING_VERSION,
      reason: 'cache-pricing-unavailable',
    };
  }

  const costUsd =
    (usage.promptTokens * rate.in +
      usage.completionTokens * rate.out +
      cacheRead * (rate.cacheRead ?? 0) +
      cacheCreation * (rate.cacheCreation ?? 0)) /
    1_000_000;
  return {
    status: 'known',
    costUsd,
    model,
    pricingVersion: PRICING_VERSION,
    ...(key === model ? {} : { pricingKey: key }),
  };
}

/**
 * Build the /cost report string: token counts + a local USD estimate.
 * Unknown models fall back to "(pricing unknown)" rather than guessing.
 * Per-skill/subagent attribution breakdown is deferred (genuinely needs
 * accounting plumbing); surfaced honestly instead of silently omitted.
 */
export function costReport(
  model: string,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null,
): string {
  if (!usage) {
    return 'No token usage recorded for this session yet.\n\n(USD estimate available after the first model response.)';
  }
  const rate = resolveModelPricing(model)?.rate;
  const usd = rate
    ? ((usage.promptTokens * rate.in + usage.completionTokens * rate.out) / 1e6).toFixed(4)
    : null;
  const modelLine = `Model: ${model}`;
  const tokenLine = `Tokens — prompt: ${usage.promptTokens}  completion: ${usage.completionTokens}  total: ${usage.totalTokens}`;
  const usdLine =
    usd !== null
      ? `Est. cost: $${usd}  (estimate computed locally; may differ from your actual bill)`
      : `Est. cost: (pricing unknown for "${model}" — add it to PRICING in src/pricing.ts)`;
  return [
    modelLine,
    tokenLine,
    usdLine,
    '',
    '(Per-skill/subagent attribution breakdown — not yet implemented.)',
  ].join('\n');
}

/**
 * /usage (/stats) report — like costReport but oriented toward session activity:
 * turns, last-turn duration, cumulative input/output split, and the running USD
 * estimate. Alias /stats maps to the same report. Unknown models label clearly
 * rather than guess a rate (same honesty rule as costReport).
 */
/** Render a failure-code count map as "code ×N, code ×M" (shared by all /usage surfaces). */
export function formatFailureCounts(failures: Record<string, number>): string {
  return Object.entries(failures)
    .map(([code, count]) => `${code} ×${count}`)
    .join(', ');
}

/** Sum a failure-code count map. */
export function failureTotal(failures: Record<string, number>): number {
  return Object.values(failures).reduce((sum, count) => sum + count, 0);
}

export function usageReport(
  model: string,
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null,
  session: { currentTurn: number; messageCount: number; turnDurationMs: number },
  toolCallStats?: Array<{ tool: string; calls: number; failures: Record<string, number> }>,
): string {
  const lines: string[] = ['Session usage', ''];
  lines.push(`Model: ${model}`);
  lines.push(`Turn: ${session.currentTurn}  •  Messages: ${session.messageCount}`);
  if (session.turnDurationMs > 0) {
    lines.push(`Last turn duration: ${(session.turnDurationMs / 1000).toFixed(1)}s`);
  }
  lines.push('');
  if (!usage) {
    lines.push('Tokens: (no model response yet this session)');
    lines.push('');
    lines.push('Cost estimate appears after the first response.');
    return lines.join('\n');
  }
  lines.push(
    `Tokens: prompt ${usage.promptTokens.toLocaleString()}  •  completion ${usage.completionTokens.toLocaleString()}  •  total ${usage.totalTokens.toLocaleString()}`,
  );
  const rate = resolveModelPricing(model)?.rate;
  if (rate) {
    const usd = ((usage.promptTokens * rate.in + usage.completionTokens * rate.out) / 1e6).toFixed(
      4,
    );
    lines.push(`Est. cost: $${usd}  (local estimate — $${rate.in}/M in, $${rate.out}/M out)`);
  } else {
    lines.push(`Est. cost: (pricing unknown for "${model}" — add it to PRICING in src/pricing.ts)`);
  }
  if (toolCallStats && toolCallStats.length > 0) {
    const totalCalls = toolCallStats.reduce((sum, entry) => sum + entry.calls, 0);
    const totalFailures = toolCallStats.reduce(
      (sum, entry) => sum + failureTotal(entry.failures),
      0,
    );
    lines.push('');
    lines.push(`Tool calls: ${totalCalls} total  •  ${totalFailures} failed`);
    for (const entry of toolCallStats) {
      const failed = failureTotal(entry.failures);
      const failureDetail =
        failed > 0 ? ` (${failed} failed: ${formatFailureCounts(entry.failures)})` : '';
      lines.push(`  ${entry.tool}: ${entry.calls}${failureDetail}`);
    }
  }
  lines.push('');
  lines.push(
    '(Per-model breakdown across a multi-model session is not yet wired — tracks the active model only.)',
  );
  return lines.join('\n');
}
