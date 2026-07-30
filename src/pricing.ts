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
export const PRICING_VERSION = 'book-local-2026-07-29';

export interface ModelPricing {
  in: number;
  out: number;
  cacheRead?: number;
  cacheCreation?: number;
  reasoningOut?: number;
}

export const PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-opus-4-8': { in: 15, out: 75 },
  'claude-opus-4-7': { in: 15, out: 75 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
  'claude-fable-5': { in: 3, out: 15 },
  // OpenAI
  'gpt-4o': { in: 2.5, out: 10 },
  'gpt-5': { in: 5, out: 15 },
  // GLM / z-ai
  'glm-4.6': { in: 0.6, out: 2.2 },
  'z-ai/glm-5.2': { in: 0.6, out: 2.2 },
};

export type UsageCostEstimate =
  | {
      status: 'known';
      costUsd: number;
      model: string;
      pricingVersion: string;
    }
  | {
      status: 'unknown';
      costUsd: null;
      model: string;
      pricingVersion: string;
      reason: 'unknown-model' | 'cache-pricing-unavailable';
    };

export function hasKnownPricing(model: string): boolean {
  return PRICING[model] !== undefined;
}

/** Estimate one provider-reported usage event without guessing missing price dimensions. */
export function estimateUsageCost(model: string, usage: Usage): UsageCostEstimate {
  const rate = PRICING[model];
  if (!rate) {
    return {
      status: 'unknown',
      costUsd: null,
      model,
      pricingVersion: PRICING_VERSION,
      reason: 'unknown-model',
    };
  }

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
  return { status: 'known', costUsd, model, pricingVersion: PRICING_VERSION };
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
  const rate = PRICING[model];
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
  const rate = PRICING[model];
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
