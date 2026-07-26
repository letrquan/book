import { describe, it, expect } from 'vitest';
import { usageReport, costReport } from './pricing.js';

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
