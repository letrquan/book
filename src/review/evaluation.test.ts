import { describe, expect, it } from 'vitest';
import { evaluateReview, renderReviewEvaluation } from './evaluation.js';

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
