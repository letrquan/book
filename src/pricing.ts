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
 * A cache write with no `cacheCreation` rate is priced `unknown`, which makes
 * `checkBeforeModelCall` refuse every call — so an omission here disables the USD
 * budget rather than merely blurring a report. Book caches on every Anthropic
 * request, so that is the normal path, not an edge case. A cache read with no
 * `cacheRead` rate is priced at `in` instead (see `usageCostUsd`).
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
  // OpenAI — no cache rates. OpenAI-compatible providers report automatic cache
  // reads (`prompt_tokens_details.cached_tokens`); without a `cacheRead` rate they
  // price at `in`, an upper bound. Add a verified rate rather than a guessed one.
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

/** The usage fields a cost needs; cache counts are optional because most callers lack them. */
export type CostedUsage = Pick<Usage, 'promptTokens' | 'completionTokens'> &
  Partial<Pick<Usage, 'cacheReadInputTokens' | 'cacheCreationInputTokens'>>;

/**
 * USD for one usage figure at `rate`, or null when it carries cache writes the rate cannot price.
 *
 * A cache read never bills above the input rate on any provider Book talks to, so a rate without
 * `cacheRead` prices reads at `in`: the figure Book reported before it could see cached tokens at
 * all, and an upper bound a USD budget can enforce. A cache write can bill above input (Anthropic's
 * 1.25x), so there is no safe stand-in for a missing `cacheCreation` rate.
 */
export function usageCostUsd(rate: ModelPricing, usage: CostedUsage): number | null {
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheCreation = usage.cacheCreationInputTokens ?? 0;
  if (cacheCreation > 0 && rate.cacheCreation === undefined) return null;
  return (
    (usage.promptTokens * rate.in +
      usage.completionTokens * rate.out +
      cacheRead * (rate.cacheRead ?? rate.in) +
      cacheCreation * (rate.cacheCreation ?? 0)) /
    1_000_000
  );
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

  const costUsd = usageCostUsd(rate, usage);
  if (costUsd === null) {
    return {
      status: 'unknown',
      costUsd: null,
      model,
      pricingVersion: PRICING_VERSION,
      reason: 'cache-pricing-unavailable',
    };
  }
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

export interface DelegatedUsage {
  /** Human label for the delegation, e.g. `explorer "map the auth module"`. */
  label: string;
  model: string;
  usage: CostedUsage & { totalTokens: number };
}

interface ModelTotal {
  model: string;
  promptTokens: number;
  completionTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  agents: number;
  usd: number | null;
}

function usdFor(model: string, usage: CostedUsage): number | null {
  const rate = resolveModelPricing(model)?.rate;
  if (!rate) return null;
  return usageCostUsd(rate, usage);
}

/**
 * Fold the session's own usage and every delegation into one row per model.
 *
 * A session that delegates spends against more than one price list, and a single
 * total attributed to the lead's model is wrong in both directions -- it bills
 * sidekick tokens at the lead's rate and hides that a second model ran at all.
 */
function modelTotals(
  leadModel: string,
  leadUsage: CostedUsage | null,
  delegated: readonly DelegatedUsage[],
): ModelTotal[] {
  const byModel = new Map<string, ModelTotal>();
  const bump = (model: string, usage: CostedUsage, isAgent: boolean): void => {
    const row = byModel.get(model) ?? {
      model,
      promptTokens: 0,
      completionTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      agents: 0,
      usd: null,
    };
    row.promptTokens += usage.promptTokens;
    row.completionTokens += usage.completionTokens;
    row.cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
    row.cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
    if (isAgent) row.agents += 1;
    byModel.set(model, row);
  };
  if (leadUsage) bump(leadModel, leadUsage, false);
  for (const entry of delegated) {
    bump(entry.model, entry.usage, true);
  }
  return [...byModel.values()].map((row) => ({ ...row, usd: usdFor(row.model, row) }));
}

/**
 * Per-model breakdown, plus what the same tokens would have cost on the lead's
 * model alone.
 *
 * The counterfactual is the only way a two-model session is legible -- otherwise
 * the user sees a bill and cannot tell whether delegating helped. It is stated
 * against an explicit baseline and labelled an estimate, never as a headline
 * saving: it assumes the same token counts on a different model, which is an
 * assumption, not a measurement.
 */
export function modelBreakdownLines(
  leadModel: string,
  leadUsage: CostedUsage | null,
  delegated: readonly DelegatedUsage[],
): string[] {
  const rows = modelTotals(leadModel, leadUsage, delegated);
  if (rows.length <= 1) return [];

  const lines = ['Per model'];
  for (const row of rows) {
    const who = row.agents > 0 ? `${row.agents} delegated` : 'session';
    const cost = row.usd === null ? 'pricing unknown' : `$${row.usd.toFixed(4)}`;
    lines.push(
      `  ${row.model} (${who}) - prompt ${row.promptTokens.toLocaleString()}, completion ${row.completionTokens.toLocaleString()}${row.cacheReadInputTokens > 0 ? `, cache read ${row.cacheReadInputTokens.toLocaleString()}` : ''} - ${cost}`,
    );
  }

  if (rows.some((row) => row.usd === null)) return lines;
  const actual = rows.reduce((sum, row) => sum + (row.usd ?? 0), 0);
  lines.push(`  Total - $${actual.toFixed(4)}`);

  const allOnLead = rows.reduce((sum, row) => sum + (usdFor(leadModel, row) ?? Number.NaN), 0);
  if (!Number.isFinite(allOnLead)) return lines;
  const delta = allOnLead - actual;
  const pct = allOnLead > 0 ? Math.round((delta / allOnLead) * 100) : 0;
  lines.push('');
  lines.push(
    `Same tokens entirely on ${leadModel}: $${allOnLead.toFixed(4)} ` +
      `(${delta >= 0 ? 'est. saving' : 'est. extra'} $${Math.abs(delta).toFixed(4)}, ${Math.abs(pct)}%).`,
  );
  lines.push(
    'Estimate only: it assumes identical token counts on the other model, which is an assumption, not a measurement.',
  );
  return lines;
}

/**
 * What /cost and /usage say for a model the table has no rate for. It speaks to
 * the person reading the report: pointing them at a source file they cannot
 * edit in an installed build only explained how the table is maintained.
 */
function unpricedLine(model: string): string {
  return `Est. cost: pricing unknown for "${model}"; tokens are counted, dollars are not`;
}

/** `, 9,000 cached` (and `, 1,200 cache writes`) for a token summary; empty with no cache tokens. */
function cacheTokenNote(usage: CostedUsage): string {
  const read = usage.cacheReadInputTokens ?? 0;
  const write = usage.cacheCreationInputTokens ?? 0;
  return (
    (read > 0 ? `, ${read.toLocaleString()} cached` : '') +
    (write > 0 ? `, ${write.toLocaleString()} cache writes` : '')
  );
}

export function costReport(
  model: string,
  usage: (CostedUsage & { totalTokens: number }) | null,
  delegated: readonly DelegatedUsage[] = [],
): string {
  if (!usage) {
    return 'No token usage recorded for this session yet.\n\n(USD estimate available after the first model response.)';
  }
  const rate = resolveModelPricing(model)?.rate;
  const cost = rate ? usageCostUsd(rate, usage) : null;
  const usd = cost === null ? null : cost.toFixed(4);
  // One line: what it cost, what it used, on which model. It used to take
  // three labelled lines (Model, Tokens, Est. cost) to say the same thing.
  const tokens = `${usage.totalTokens.toLocaleString()} tokens (${usage.promptTokens.toLocaleString()} in${cacheTokenNote(usage)}, ${usage.completionTokens.toLocaleString()} out)`;
  const summary =
    usd !== null
      ? `$${usd} estimated · ${tokens} · ${model}`
      : `${tokens} · ${model} has no price, so no dollar estimate`;
  const breakdown = modelBreakdownLines(model, usage, delegated);
  return [summary, ...(breakdown.length ? ['', ...breakdown] : [])].join('\n');
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
  usage: (CostedUsage & { totalTokens: number }) | null,
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
    `Tokens: prompt ${usage.promptTokens.toLocaleString()}  •  completion ${usage.completionTokens.toLocaleString()}  •  total ${usage.totalTokens.toLocaleString()}${cacheTokenNote(usage).replace(/, /g, '  •  ')}`,
  );
  const rate = resolveModelPricing(model)?.rate;
  const cost = rate ? usageCostUsd(rate, usage) : null;
  if (rate && cost !== null) {
    lines.push(
      `Est. cost: $${cost.toFixed(4)}  (local estimate — $${rate.in}/M in, $${rate.out}/M out)`,
    );
  } else {
    lines.push(unpricedLine(model));
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
