import type { ReviewReport } from './types.js';

/**
 * Review evaluation harness.
 *
 * Measures precision, recall, F1, usefulness rate, and signal-to-noise ratio
 * against a small golden-diff set. This is the loop that prevents prompt and
 * pipeline regressions, mirroring the skill-evaluation module.
 */

export interface ReviewGroundTruth {
  /** A stable id for reporting. */
  id: string;
  /** Findings a reviewer should catch. */
  expected: string[];
  /** Finding ids the model actually produced. */
  actual: string[];
}

export interface ReviewEvaluationMetrics {
  fixtureCount: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  f1: number;
  usefulnessRate: number;
  signalToNoiseRatio: number;
}

export function evaluateReview(fixtures: readonly ReviewGroundTruth[]): ReviewEvaluationMetrics {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let useful = 0;

  for (const fixture of fixtures) {
    const expected = new Set(fixture.expected);
    const actual = new Set(fixture.actual);
    const hits = [...actual].filter((id) => expected.has(id)).length;
    truePositives += hits;
    falsePositives += fixture.actual.length - hits;
    falseNegatives += fixture.expected.length - hits;
    if (hits > 0) useful++;
  }

  const total = truePositives + falsePositives;
  const precision = total === 0 ? 0 : truePositives / total;
  const coverageTotal = truePositives + falseNegatives;
  const recall = coverageTotal === 0 ? 1 : truePositives / coverageTotal;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const usefulnessRate = fixtures.length === 0 ? 0 : useful / fixtures.length;
  const signalToNoiseRatio = falsePositives === 0 ? truePositives : truePositives / falsePositives;

  return {
    fixtureCount: fixtures.length,
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    f1,
    usefulnessRate,
    signalToNoiseRatio,
  };
}

export function renderReviewEvaluation(metrics: ReviewEvaluationMetrics): string {
  return [
    '# Review Evaluation',
    '',
    `Fixtures: ${metrics.fixtureCount}`,
    `True positives: ${metrics.truePositives}`,
    `False positives: ${metrics.falsePositives}`,
    `False negatives: ${metrics.falseNegatives}`,
    `Precision: ${metrics.precision.toFixed(3)}`,
    `Recall: ${metrics.recall.toFixed(3)}`,
    `F1: ${metrics.f1.toFixed(3)}`,
    `Usefulness rate: ${metrics.usefulnessRate.toFixed(3)}`,
    `Signal-to-noise ratio: ${metrics.signalToNoiseRatio.toFixed(3)}`,
  ].join('\n');
}

/** Extract a compact finding-id set from a report for golden-diff matching. */
export function findingIdsFromReport(report: ReviewReport): string[] {
  return report.findings.map((finding) => finding.id);
}
