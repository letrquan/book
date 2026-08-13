import { describe, expect, it } from 'vitest';
import {
  evaluateReview,
  findingIdsFromReport,
  groundTruthFromFixture,
  renderReviewEvaluation,
} from './evaluation.js';

describe('evaluateReview', () => {
  it('computes precision, recall, f1, usefulness, and SNR', () => {
    const metrics = evaluateReview([
      { id: 'a', expected: ['f1', 'f2'], actual: ['f1', 'f3'] },
      { id: 'b', expected: ['f1'], actual: [] },
    ]);
    expect(metrics.truePositives).toBe(1);
    expect(metrics.falsePositives).toBe(1);
    expect(metrics.falseNegatives).toBe(2);
    expect(metrics.precision).toBeCloseTo(0.5);
    expect(metrics.recall).toBeCloseTo(1 / 3);
    expect(metrics.usefulnessRate).toBe(0.5);
    expect(metrics.signalToNoiseRatio).toBe(1);
  });

  it('handles no findings without dividing by zero', () => {
    const metrics = evaluateReview([{ id: 'a', expected: [], actual: [] }]);
    expect(metrics.precision).toBe(0);
    expect(metrics.recall).toBe(1);
    expect(metrics.signalToNoiseRatio).toBe(0);
  });
});

describe('renderReviewEvaluation', () => {
  it('includes key metrics', () => {
    const text = renderReviewEvaluation(evaluateReview([]));
    expect(text).toContain('Precision:');
    expect(text).toContain('Signal-to-noise ratio:');
  });
});

describe('groundTruthFromFixture', () => {
  const finding = {
    id: 'finding-1',
    severity: 'major' as const,
    category: 'correctness' as const,
    file: 'src/user.ts',
    line: 42,
    summary: 'Missing null guard crashes on an empty profile',
    evidence: 'profile.displayName',
    failure: 'throws',
    suggestedFix: 'guard',
    confidence: 90,
  };

  it('keys expectations and produced findings into the same id space', () => {
    const truth = groundTruthFromFixture({
      id: 'missing-null-guard',
      expected: [
        {
          file: 'src/user.ts',
          line: 42,
          summary: 'Missing NULL guard crashes on an empty profile!',
        },
      ],
      report: { verdict: 'recommend', findings: [finding] },
    });
    expect(truth.actual).toEqual(truth.expected);
    expect(evaluateReview([truth]).precision).toBe(1);
  });

  it('scores an unreported expectation as a miss and an extra finding as noise', () => {
    const metrics = evaluateReview([
      groundTruthFromFixture({
        id: 'missed',
        expected: [{ file: 'src/cache.ts', line: 17, summary: 'Concurrent writes drop an entry' }],
        report: { verdict: 'recommend', findings: [finding] },
      }),
    ]);
    expect(metrics.truePositives).toBe(0);
    expect(metrics.falsePositives).toBe(1);
    expect(metrics.falseNegatives).toBe(1);
  });
});

describe('findingIdsFromReport', () => {
  it('uses stable finding content instead of positional ids', () => {
    const base = {
      severity: 'major' as const,
      category: 'correctness' as const,
      file: 'Src\\A.ts',
      line: 7,
      summary: 'Null value crashes',
      evidence: 'value.x',
      failure: 'crashes',
      suggestedFix: 'guard value',
      confidence: 90,
    };
    const first = findingIdsFromReport({
      verdict: 'recommend',
      findings: [{ id: 'finding-1', ...base }],
    });
    const second = findingIdsFromReport({
      verdict: 'recommend',
      findings: [{ id: 'finding-99', ...base }],
    });
    expect(first).toEqual(second);
    expect(first[0]).toContain('src/a.ts:7:null value crashes');
  });
});
