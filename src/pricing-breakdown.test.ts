import { describe, expect, it } from 'vitest';
import { costReport, modelBreakdownLines, PRICING } from './pricing.js';

/**
 * A session that delegates spends against more than one price list. Attributing
 * the whole bill to the lead's model is wrong twice over: it prices sidekick
 * tokens at the lead's rate, and hides that a second model ran at all.
 */
const [LEAD, SIDEKICK] = Object.keys(PRICING);

const usage = (promptTokens: number, completionTokens: number) => ({
  promptTokens,
  completionTokens,
  totalTokens: promptTokens + completionTokens,
});

describe('per-model cost breakdown', () => {
  it('renders nothing when only one model ran', () => {
    expect(modelBreakdownLines(LEAD, usage(100, 50), [])).toEqual([]);
  });

  it('splits the bill by the model each agent actually ran on', () => {
    const lines = modelBreakdownLines(LEAD, usage(1000, 200), [
      { label: 'explorer "map auth"', model: SIDEKICK, usage: usage(5000, 400) },
      { label: 'explorer "map api"', model: SIDEKICK, usage: usage(3000, 100) },
    ]).join('\n');
    expect(lines).toContain('Per model');
    expect(lines).toContain(`${LEAD} (session)`);
    // Both delegations collapse into one row for the model they shared.
    expect(lines).toContain(`${SIDEKICK} (2 delegated)`);
    expect(lines).toContain('8,000');
  });

  it('states the counterfactual against a named baseline and labels it an estimate', () => {
    const lines = modelBreakdownLines(LEAD, usage(1000, 200), [
      { label: 'explorer "map auth"', model: SIDEKICK, usage: usage(5000, 400) },
    ]).join('\n');
    expect(lines).toContain(`Same tokens entirely on ${LEAD}:`);
    expect(lines).toContain('assumption, not a measurement');
  });

  it('reports tokens but no total when a model has no known pricing', () => {
    const lines = modelBreakdownLines(LEAD, usage(1000, 200), [
      { label: 'explorer "map auth"', model: 'not-a-real-model', usage: usage(500, 50) },
    ]).join('\n');
    expect(lines).toContain('pricing unknown');
    // No total and no counterfactual: both would be arithmetic over a gap.
    expect(lines).not.toContain('Total -');
    expect(lines).not.toContain('Same tokens entirely on');
  });

  it('leaves the single-model /cost report as it was', () => {
    const report = costReport(LEAD, usage(1000, 200));
    expect(report.split('\n')).toHaveLength(1);
    expect(report).toContain(LEAD);
    expect(report).toContain('1,200 tokens (1,000 in, 200 out)');
    expect(report).not.toContain('Per model');
    expect(report).not.toContain('not yet implemented');
  });

  it('adds the breakdown to /cost once a delegation has run', () => {
    const report = costReport(LEAD, usage(1000, 200), [
      { label: 'explorer "map auth"', model: SIDEKICK, usage: usage(5000, 400) },
    ]);
    expect(report).toContain('Per model');
  });
});
