import { describe, expect, it } from 'vitest';
import { costReport, modelBreakdownLines, PRICING, usageReport } from './pricing.js';

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

/**
 * The headline is what a session that delegated is actually judged by. Pricing
 * only the lead's own usage there made an agent that ran on the lead's own model
 * invisible: `modelTotals` folded it into the lead's row, so no breakdown line
 * appeared either (#370).
 */
describe('the headline counts delegated agents', () => {
  it('totals an agent that ran on the lead model, with no breakdown to show for it', () => {
    const report = costReport('claude-sonnet-5', usage(1000, 100), [
      { label: 'explorer "map auth"', model: 'claude-sonnet-5', usage: usage(500_000, 0) },
    ]);
    // (1000*2 + 100*10 + 500_000*2) / 1e6 = 1.003
    expect(report).toContain('$1.0030 estimated');
    expect(report).toContain('501,100 tokens (501,000 in, 100 out)');
    expect(report).toContain('incl. 1 delegated agent');
    // One model ran, so there is nothing to split it into.
    expect(report).not.toContain('Per model');
  });

  it('names how many agents the figure includes', () => {
    const report = costReport('claude-sonnet-5', usage(1000, 100), [
      { label: 'explorer', model: 'claude-sonnet-5', usage: usage(1000, 0) },
      { label: 'patcher', model: 'claude-sonnet-5', usage: usage(1000, 0) },
    ]);
    expect(report).toContain('incl. 2 delegated agents');
  });

  it('leaves a session that delegated nothing alone', () => {
    const report = costReport('claude-sonnet-5', usage(1000, 100));
    expect(report).not.toContain('delegated');
  });

  it('totals a multi-model session in /usage as well', () => {
    const r = usageReport(
      'claude-sonnet-5',
      usage(1000, 100),
      { currentTurn: 2, messageCount: 4, turnDurationMs: 0 },
      undefined,
      [{ label: 'explorer', model: 'claude-haiku-4-5-20251001', usage: usage(50_000, 0) }],
    );
    // 1,000*2 + 100*10 + 50_000*1 = 0.053
    expect(r).toContain('Est. cost: $0.0530');
    expect(r).toContain('total 51,100');
    expect(r).toContain('incl. 1 delegated agent');
  });

  it('says a lead priced alone would not cover the session', () => {
    // The honest reading of a total that spans models is not "at the active
    // model": the agents ran somewhere else.
    const r = usageReport(
      'claude-sonnet-5',
      usage(1000, 100),
      { currentTurn: 1, messageCount: 2, turnDurationMs: 0 },
      undefined,
      [{ label: 'explorer', model: 'claude-haiku-4-5-20251001', usage: usage(50_000, 0) }],
    );
    expect(r).not.toContain('$2/M in, $10/M out)');
    expect(r).toContain('local estimate across 2 models');
  });

  it('prints the delegated trailer only when agents spent something', () => {
    const session = { currentTurn: 1, messageCount: 2, turnDurationMs: 0 };
    expect(usageReport('claude-sonnet-5', usage(1000, 100), session)).not.toContain(
      'Delegated agents',
    );
    expect(
      usageReport('claude-sonnet-5', usage(1000, 100), session, undefined, [
        { label: 'explorer', model: 'claude-sonnet-5', usage: usage(1, 0) },
      ]),
    ).toContain('Delegated agents are included');
  });
});

describe('a bill that starts at a resume says so', () => {
  const session = { currentTurn: 3, messageCount: 8, turnDurationMs: 0 };

  it('marks the /cost headline as counting from the resume', () => {
    const report = costReport('claude-sonnet-5', usage(1000, 100), [], { sinceResume: true });
    expect(report).toContain('since this session was resumed');
    expect(costReport('claude-sonnet-5', usage(1000, 100))).not.toContain('resumed');
  });

  it('marks the /usage report as counting from the resume', () => {
    expect(
      usageReport('claude-sonnet-5', usage(1000, 100), session, undefined, [], {
        sinceResume: true,
      }),
    ).toContain('since this session was resumed');
  });
});
