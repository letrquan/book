import { createHash } from 'crypto';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { AgentMode, AgentTopology, IssueQuality } from './types.js';

export interface EvaluationFixture {
  id: string;
  cohort: 'decomposable' | 'ambiguous' | 'sequential';
  prompt: string;
}

export interface EvaluationRunResult {
  passed: boolean;
  validationCorrect?: boolean;
  wallTimeMs: number;
  totalTokens?: number;
  costUsd?: number;
  spawnCount?: number;
  route?: AgentTopology;
  issueQuality?: IssueQuality;
  conflicts?: number;
  interruptions?: number;
  unvalidatedApplications?: number;
}

export interface EvaluationMetric extends Omit<EvaluationRunResult, 'route' | 'issueQuality'> {
  fixtureId: string;
  promptHash: string;
  cohort: EvaluationFixture['cohort'];
  mode: Extract<AgentMode, 'adaptive' | 'off'>;
  route?: AgentTopology;
  issueQuality?: IssueQuality;
}

/** Run each fixture with the single-agent control and adaptive treatment. */
export async function runPairedEvaluation(
  fixtures: EvaluationFixture[],
  execute: (
    fixture: EvaluationFixture,
    mode: Extract<AgentMode, 'adaptive' | 'off'>,
  ) => Promise<EvaluationRunResult>,
  outputPath: string,
): Promise<EvaluationMetric[]> {
  const metrics: EvaluationMetric[] = [];
  for (const fixture of fixtures) {
    for (const mode of ['off', 'adaptive'] as const) {
      const result = await execute(fixture, mode);
      metrics.push({
        fixtureId: fixture.id,
        promptHash: createHash('sha256').update(fixture.prompt).digest('hex'),
        cohort: fixture.cohort,
        mode,
        ...result,
      });
    }
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(
    outputPath,
    `${metrics.map((metric) => JSON.stringify(metric)).join('\n')}\n`,
    'utf8',
  );
  return metrics;
}

export function evaluateSuccess(metrics: EvaluationMetric[]): {
  successful: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  const byMode = (cohorts: EvaluationFixture['cohort'][], mode: EvaluationMetric['mode']) =>
    metrics.filter((metric) => cohorts.includes(metric.cohort) && metric.mode === mode);
  const rate = (items: EvaluationMetric[]) =>
    items.length === 0 ? 0 : items.filter((item) => item.passed).length / items.length;
  const median = (values: number[]) => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
  };

  const treatment = byMode(['decomposable', 'ambiguous'], 'adaptive');
  const control = byMode(['decomposable', 'ambiguous'], 'off');
  const passGain = rate(treatment) - rate(control);
  const treatmentWall = median(treatment.map((item) => item.wallTimeMs));
  const controlWall = median(control.map((item) => item.wallTimeMs));
  if (passGain < 0.05 && !(passGain >= 0 && treatmentWall <= controlWall * 0.8)) {
    reasons.push('Decomposable/ambiguous cohort missed the pass-rate or wall-time target.');
  }

  const sequentialTreatment = byMode(['sequential'], 'adaptive');
  const sequentialControl = byMode(['sequential'], 'off');
  if (rate(sequentialTreatment) < rate(sequentialControl) - 0.02) {
    reasons.push('Sequential cohort regressed by more than two pass-rate points.');
  }

  const adaptiveTokens = median(
    metrics.filter((item) => item.mode === 'adaptive').map((item) => item.totalTokens ?? 0),
  );
  const controlTokens = median(
    metrics.filter((item) => item.mode === 'off').map((item) => item.totalTokens ?? 0),
  );
  if (controlTokens > 0 && adaptiveTokens >= controlTokens * 3) {
    reasons.push('Median adaptive token overhead is not below 3x.');
  }
  if (metrics.some((item) => (item.unvalidatedApplications ?? 0) > 0)) {
    reasons.push('At least one unvalidated patch was applied.');
  }
  return { successful: reasons.length === 0, reasons };
}
