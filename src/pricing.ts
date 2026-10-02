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
 * A cache token with no rate for it is priced at an upper bound (see
 * `usageCostUsd`) rather than `unknown`, because an unknown estimate makes
 * `checkBeforeModelCall` refuse every call under a USD budget. Book caches on
 * every Anthropic request, so list real cache rates for Anthropic models.
 */
export const PRICING: Record<string, ModelPricing> = {
  // Anthropic — published price list, $ per million, cached 2026-09-25. `cacheCreation`
  // is the 5-minute TTL write, the only TTL Book requests; cache reads are each
  // model's own published rate. Re-verify against the live list before a release.
  // `claude-opus-4-5` and `claude-sonnet-4-5` are deliberately absent: our source
  // publishes no verified rate for either, and they price as unknown rather than
  // guess until one exists.
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
  'claude-mythos-5-1': { in: 10, out: 50, cacheRead: 0.25, cacheCreation: 12.5 },
  'claude-mythos-5': { in: 10, out: 50, cacheRead: 1, cacheCreation: 12.5 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5, cacheRead: 0.1, cacheCreation: 1.25 },
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
/**
 * A date stamp and nothing else. Accepted forms, each of which is a stamp a
 * provider actually appends: `-20260115`, `.20260115`, `@20260115`,
 * `-2026-01-15`, `-0806` (MMDD) and `-001` (a 3-digit zero-led snapshot).
 *
 * A version suffix is not a date: `-5`, `-1` and `-45` are different models from
 * their prefix, and matching one priced `claude-opus-5-5` as `claude-opus-5` and
 * `claude-fable-5-1` as `claude-fable-5` (#370). Neither is `-4-6`, two versions.
 */
const DATED_MODEL_SUFFIX = /^[-.@](?:\d{8}|\d{4}-\d{2}-\d{2}|\d{4}|0\d{2})$/;

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
 * The highest cache-write premium a provider charges, as a multiple of the input rate:
 * Anthropic's one-hour cache. A write on a model with no `cacheCreation` rate is priced at it.
 */
const MAX_CACHE_WRITE_MULTIPLIER = 2;

/**
 * USD for one usage figure at `rate`.
 *
 * A missing cache rate is priced at an upper bound rather than refused, because a refused
 * (`unknown`) estimate makes a USD budget stop the run: a cache read never bills above the input
 * rate, so it is priced at `in` (the figure Book reported before it could see cached tokens), and a
 * cache write never above twice it (`MAX_CACHE_WRITE_MULTIPLIER`).
 */
export function usageCostUsd(rate: ModelPricing, usage: CostedUsage): number {
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheCreation = usage.cacheCreationInputTokens ?? 0;
  return (
    (usage.promptTokens * rate.in +
      usage.completionTokens * rate.out +
      cacheRead * (rate.cacheRead ?? rate.in) +
      cacheCreation * (rate.cacheCreation ?? rate.in * MAX_CACHE_WRITE_MULTIPLIER)) /
    1_000_000
  );
}

/** Every input token of a usage, cached or not: the prompt's size, whatever the provider cached. */
export function promptSizeTokens(usage: CostedUsage): number {
  return (
    usage.promptTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0)
  );
}

/**
 * Add one provider-reported usage to a running total.
 *
 * The one usage sum every caller shares: `session/run-accounting.ts` for a run's
 * own accounting, `session/store.ts` for a session's persisted carry, and the
 * TUI's session-cumulative usage that `/cost` and `/usage` price (#370). The TUI
 * needs it because `context.usage` is per-request — every `onUsage` replaces it
 * and every send clears it, so pricing a session bill from it reported only the
 * final turn's tokens.
 *
 * Cache counts are summed when reported and counted as zero when not, so the
 * total is always fully additive. `contextTokens` is not: it is the gauge the
 * compaction gate reads, so the latest response's figure is the only true one.
 */
export function addUsage(current: Usage | null, next: Usage): Usage {
  return {
    promptTokens: (current?.promptTokens ?? 0) + next.promptTokens,
    completionTokens: (current?.completionTokens ?? 0) + next.completionTokens,
    totalTokens: (current?.totalTokens ?? 0) + next.totalTokens,
    contextTokens: next.contextTokens ?? current?.contextTokens,
    cacheReadInputTokens: (current?.cacheReadInputTokens ?? 0) + (next.cacheReadInputTokens ?? 0),
    cacheCreationInputTokens:
      (current?.cacheCreationInputTokens ?? 0) + (next.cacheCreationInputTokens ?? 0),
  };
}

/**
 * The token count a report shows as its total: every input and output token. `totalTokens` means
 * different things by provider (the Anthropic path counts uncached input plus output, OpenAI-style
 * usage counts the cache and sometimes hidden reasoning too), so the larger reading wins.
 */
export function trafficTokens(usage: CostedUsage & { totalTokens: number }): number {
  return Math.max(usage.totalTokens, promptSizeTokens(usage) + usage.completionTokens);
}

/** The rate and USD cost of a usage on `model`, or undefined for a model with no rate. */
export function usageCostForModel(
  model: string,
  usage: CostedUsage,
): { rate: ModelPricing; costUsd: number } | undefined {
  const rate = resolveModelPricing(model)?.rate;
  return rate ? { rate, costUsd: usageCostUsd(rate, usage) } : undefined;
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
      reason: 'unknown-model';
    };

export function hasKnownPricing(
  model: string,
  overrides?: Readonly<Record<string, ModelPricing>>,
): boolean {
  return resolveModelPricing(model, overrides) !== undefined;
}

/**
 * Estimate one provider-reported usage event. A missing cache rate is priced at an upper bound
 * (see `usageCostUsd`), so only a model with no rate at all is `unknown`.
 */
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
  return usageCostForModel(model, usage)?.costUsd ?? null;
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
      `  ${row.model} (${who}) - prompt ${row.promptTokens.toLocaleString()}, completion ${row.completionTokens.toLocaleString()}${row.cacheReadInputTokens > 0 ? `, cache read ${row.cacheReadInputTokens.toLocaleString()}` : ''}${row.cacheCreationInputTokens > 0 ? `, cache write ${row.cacheCreationInputTokens.toLocaleString()}` : ''} - ${cost}`,
    );
  }

  if (rows.some((row) => row.usd === null)) return lines;
  const actual = rows.reduce((sum, row) => sum + (row.usd ?? 0), 0);
  lines.push(`  Total - $${actual.toFixed(4)}`);

  // A cache rate the lead does not list would be priced at its upper bound, and the "saving"
  // would then be an artifact of that bound, not a comparison.
  const leadRate = resolveModelPricing(leadModel)?.rate;
  const boundedOnLead = rows.some(
    (row) =>
      (row.cacheReadInputTokens > 0 && leadRate?.cacheRead === undefined) ||
      (row.cacheCreationInputTokens > 0 && leadRate?.cacheCreation === undefined),
  );
  if (boundedOnLead) return lines;
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

/**
 * The cache counts of a usage as report fragments, each prefixed by `separator`: `, 9,000 cached`
 * (and `, 1,200 cache writes`); empty with no cache tokens.
 */
function cacheTokenNote(usage: CostedUsage, separator = ', '): string {
  const read = usage.cacheReadInputTokens ?? 0;
  const write = usage.cacheCreationInputTokens ?? 0;
  return (
    (read > 0 ? `${separator}${read.toLocaleString()} cached` : '') +
    (write > 0 ? `${separator}${write.toLocaleString()} cache writes` : '')
  );
}

/** Where a bill starts counting, so a report can say so when it is not the session's start. */
export interface BillScope {
  /**
   * Set when the bill counts from a resume in this process rather than from the
   * session's first turn: the TUI does not seed it from the persisted carry,
   * which is root-inclusive of delegated spend and would double-count the agents
   * reported separately (#370).
   */
  sinceResume?: boolean;
}

/** The session's whole spend: the lead plus every delegation, priced per model. */
export interface SessionTotals {
  /** Lead and delegated usage added together, for a report's headline counts. */
  usage: CostedUsage & { totalTokens: number };
  /** Summed over every row; null when any row's model has no rate in the table. */
  usd: number | null;
  /** Every model the session ran on, in the order it first appears. */
  models: string[];
  /** How many delegated entries the totals include. */
  delegatedAgents: number;
}

/**
 * Everything a session bill is made of: the lead's own usage plus every
 * delegated agent's, each priced at the model it actually ran on.
 *
 * The headline has to be the sum, not the lead's share (#370): an agent that ran
 * on the lead's own model folds into the lead's row, so nothing else on the
 * report mentioned it at all.
 */
export function sessionTotals(
  leadModel: string,
  leadUsage: (CostedUsage & { totalTokens: number }) | null,
  delegated: readonly DelegatedUsage[] = [],
): SessionTotals {
  const rows = modelTotals(leadModel, leadUsage, delegated);
  // Left as it was when there is nothing to add: a session that delegated nothing
  // reports its own usage verbatim rather than a re-summed copy of it.
  let usage: (CostedUsage & { totalTokens: number }) | null = leadUsage;
  if (delegated.length > 0) {
    usage = null;
    if (leadUsage) usage = addUsage(usage, leadUsage);
    for (const entry of delegated) usage = addUsage(usage, entry.usage);
  }
  const pricedRows = rows.map((row) => usdFor(row.model, row));
  const pricedEveryRow = pricedRows.every((priced): priced is number => priced !== null);
  return {
    usage: usage ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    // One row with no rate makes the whole sum unavailable: a partial total would
    // read as the bill, and it is smaller than what the session really spent.
    usd: pricedEveryRow ? pricedRows.reduce((sum, priced) => sum + priced, 0) : null,
    models: rows.map((row) => row.model),
    delegatedAgents: delegated.length,
  };
}

/** `incl. 2 delegated agents` on a headline whose totals cover agents, else nothing. */
function delegatedNote(totals: SessionTotals): string {
  return totals.delegatedAgents > 0
    ? `incl. ${totals.delegatedAgents} delegated agent${totals.delegatedAgents === 1 ? '' : 's'}`
    : '';
}

/** The one phrase a bill started at a resume needs, else nothing. */
function resumeNote(scope: BillScope): string {
  return scope.sinceResume ? 'since this session was resumed' : '';
}

/** The headline notes, joined, or '' when the bill needs none. */
function headlineNotes(totals: SessionTotals, scope: BillScope): string {
  return [delegatedNote(totals), resumeNote(scope)].filter(Boolean).join(' · ');
}

export function costReport(
  model: string,
  usage: (CostedUsage & { totalTokens: number }) | null,
  delegated: readonly DelegatedUsage[] = [],
  scope: BillScope = {},
): string {
  if (!usage && delegated.length === 0) {
    return 'No token usage recorded for this session yet.\n\n(USD estimate available after the first model response.)';
  }
  const totals = sessionTotals(model, usage, delegated);
  const bill = totals.usage;
  // One line: what it cost, what it used, on which model. It used to take
  // three labelled lines (Model, Tokens, Est. cost) to say the same thing.
  const tokens = `${trafficTokens(bill).toLocaleString()} tokens (${bill.promptTokens.toLocaleString()} in${cacheTokenNote(bill)}, ${bill.completionTokens.toLocaleString()} out)`;
  const models = totals.models.join(', ');
  const summary =
    totals.usd === null
      ? `${tokens} · ${models} ${totals.models.length > 1 ? 'have' : 'has'} no price, so no dollar estimate`
      : `$${totals.usd.toFixed(4)} estimated · ${tokens} · ${models}`;
  const notes = headlineNotes(totals, scope);
  const breakdown = modelBreakdownLines(model, usage, delegated);
  return [
    notes ? `${summary} · ${notes}` : summary,
    ...(breakdown.length ? ['', ...breakdown] : []),
  ].join('\n');
}

/**
 * /usage (/stats) report — like costReport but oriented toward session activity:
 * turns, last-turn duration, cumulative input/output split, and the running USD
 * estimate, plus the same per-model breakdown `/cost` prints. Alias /stats maps
 * to the same report. Unknown models label clearly rather than guess a rate (same
 * honesty rule as costReport).
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
  delegated: readonly DelegatedUsage[] = [],
  scope: BillScope = {},
): string {
  const lines: string[] = ['Session usage', ''];
  lines.push(`Model: ${model}`);
  lines.push(`Turn: ${session.currentTurn}  •  Messages: ${session.messageCount}`);
  if (session.turnDurationMs > 0) {
    lines.push(`Last turn duration: ${(session.turnDurationMs / 1000).toFixed(1)}s`);
  }
  lines.push('');
  const totals = sessionTotals(model, usage, delegated);
  if (!usage && totals.delegatedAgents === 0) {
    lines.push('Tokens: (no model response yet this session)');
    lines.push('');
    lines.push('Cost estimate appears after the first response.');
    return lines.join('\n');
  }
  const bill = totals.usage;
  lines.push(
    `Tokens: prompt ${bill.promptTokens.toLocaleString()}  •  completion ${bill.completionTokens.toLocaleString()}  •  total ${trafficTokens(bill).toLocaleString()}${cacheTokenNote(bill, '  •  ')}`,
  );
  if (totals.usd === null) {
    lines.push(unpricedLine(totals.models[0] ?? model));
  } else if (totals.models.length > 1) {
    // A per-model rate here would describe only the lead's slice of a figure that
    // now spans every model the session ran on (#370).
    lines.push(
      `Est. cost: $${totals.usd.toFixed(4)}  (local estimate across ${totals.models.length} models)`,
    );
  } else {
    // One model priced the whole total, so its rate describes the whole figure.
    const rate = resolveModelPricing(totals.models[0])?.rate;
    lines.push(
      rate
        ? `Est. cost: $${totals.usd.toFixed(4)}  (local estimate — $${rate.in}/M in, $${rate.out}/M out)`
        : unpricedLine(totals.models[0] ?? model),
    );
  }
  const notes = headlineNotes(totals, scope);
  if (notes) lines.push(`(${notes})`);
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
  // The same helper /cost uses, so a session that delegated reads identically in
  // both reports rather than one counting an agent and the other not (#370).
  const breakdown = modelBreakdownLines(model, usage, delegated);
  if (breakdown.length) lines.push(...breakdown);
  // Only true when agents are actually on the report: a session that delegated
  // nothing says nothing about them (#370).
  if (totals.delegatedAgents > 0) {
    lines.push(
      `(Delegated agents are included above, each priced at the model it ran on. The session's own turns are priced at the active model, so a mid-session model switch is not split out.)`,
    );
  }
  if (scope.sinceResume) {
    lines.push('(Counted since this session was resumed in this process.)');
  }
  return lines.join('\n');
}
