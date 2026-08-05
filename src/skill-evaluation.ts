import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SkillLifecycleEvent } from './skill-registry.js';

export const SKILL_EVALUATION_CATEGORIES = [
  'direct',
  'indirect',
  'negative',
  'ambiguous',
  'conflicting',
  'disabled',
  'invalid',
  'missing-body',
  'missing-resource',
] as const;

export type SkillEvaluationCategory = (typeof SKILL_EVALUATION_CATEGORIES)[number];

export interface SkillEvaluationFixture {
  id: string;
  category: SkillEvaluationCategory;
  promptHash: string;
  expectedSkills: string[];
  expectedBlockedCodes?: string[];
}

export interface SkillEvaluationPromptFixture {
  id: string;
  category: SkillEvaluationCategory;
  prompt: string;
  expectedSkills: string[];
  expectedBlockedCodes?: string[];
}

export interface SkillEvaluationOutcome {
  promptChars?: number;
  promptTokens?: number;
  bodyTokens?: number;
  taskCompleted?: boolean;
  userCorrections?: number;
  skillToolFailures?: number;
  exposure?: 'eager' | 'deferred';
  activationTurns?: number;
}

export interface SkillEvaluationObservation extends SkillEvaluationFixture {
  activatedSkills: string[];
  blockedCodes: string[];
  promptChars: number;
  promptTokens: number;
  bodyBytes: number;
  bodyTokens: number;
  falseActivationBytes: number;
  activationLatencyMs: number[];
  consentRequests: number;
  unnecessaryPermissionPrompts: number;
  taskCompleted?: boolean;
  userCorrections: number;
  skillToolFailures: number;
  blockingMismatch: boolean;
  exposure?: 'eager' | 'deferred';
  activationTurns?: number;
}

export interface SkillEvaluationThresholds {
  minimumPrecision: number;
  minimumRecall: number;
  maximumFalseActivations: number;
  maximumUnnecessaryPermissionPrompts: number;
  maximumSkillToolFailures: number;
}

export interface SkillEvaluationExecution {
  evidenceKind: 'offline-observation';
  providerRunEligibility: 'not-applicable';
  controls: {
    evaluationDate: string;
    randomSeed: string;
    runtimeRevision: string;
    fixtureRevision: string;
    fixtureRevisionStatus: 'captured' | 'incomplete';
  };
}

export interface SkillEvaluationReport {
  generatedAt: string;
  fixtureCount: number;
  categoryCounts: Record<SkillEvaluationCategory, number>;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  precision: number;
  recall: number;
  falseActivationBytes: number;
  promptChars: { total: number; median: number };
  promptTokens: { total: number; median: number };
  bodyBytes: { total: number; median: number };
  bodyTokens: { total: number; median: number };
  activationLatencyMs: { median: number; p95: number };
  consentRequests: number;
  unnecessaryPermissionPrompts: number;
  taskCompletionRate?: number;
  userCorrections: number;
  skillToolFailures: number;
  blockingMismatches: number;
  exposure: Record<
    'eager' | 'deferred',
    { samples: number; activationRate: number; medianActivationTurns: number }
  >;
  thresholds: SkillEvaluationThresholds;
  rolloutReady: boolean;
  reasons: string[];
  observations: SkillEvaluationObservation[];
  evaluation?: SkillEvaluationExecution;
}

export const DEFAULT_SKILL_EVALUATION_THRESHOLDS: SkillEvaluationThresholds = {
  minimumPrecision: 0.95,
  minimumRecall: 0.8,
  maximumFalseActivations: 0,
  maximumUnnecessaryPermissionPrompts: 0,
  maximumSkillToolFailures: 0,
};

export const DEFAULT_SKILL_EVALUATION_FIXTURES: readonly SkillEvaluationPromptFixture[] = [
  {
    id: 'direct-review',
    category: 'direct',
    prompt: '$review inspect the current change',
    expectedSkills: ['review'],
  },
  {
    id: 'indirect-review',
    category: 'indirect',
    prompt: 'Inspect this diff for correctness regressions and missing tests',
    expectedSkills: ['review'],
  },
  {
    id: 'negative-general-question',
    category: 'negative',
    prompt: 'Explain what this function returns',
    expectedSkills: [],
  },
  {
    id: 'ambiguous-review-word',
    category: 'ambiguous',
    prompt: 'Review the available deployment choices with me',
    expectedSkills: [],
  },
  {
    id: 'conflicting-tool-ceilings',
    category: 'conflicting',
    prompt: '$read-review $write-review inspect the change',
    expectedSkills: ['read-review'],
    expectedBlockedCodes: ['skill_tool_intersection_empty'],
  },
  {
    id: 'disabled-skill',
    category: 'disabled',
    prompt: '$disabled-skill run the workflow',
    expectedSkills: [],
    expectedBlockedCodes: ['skill_disabled'],
  },
  {
    id: 'invalid-skill',
    category: 'invalid',
    prompt: '$invalid-skill run the workflow',
    expectedSkills: [],
    expectedBlockedCodes: ['skill_invalid'],
  },
  {
    id: 'missing-body',
    category: 'missing-body',
    prompt: '$missing-body run the workflow',
    expectedSkills: [],
    expectedBlockedCodes: ['skill_load_failed'],
  },
  {
    id: 'missing-resource',
    category: 'missing-resource',
    prompt: '$missing-resource load references/checklist.md',
    expectedSkills: ['missing-resource'],
    expectedBlockedCodes: ['skill_resource_unreadable'],
  },
];

function numberDetail(event: SkillLifecycleEvent, key: string): number {
  const value = event.details?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}

/** Convert bounded lifecycle evidence into one prompt-free evaluation observation. */
export function observeSkillEvaluation(
  fixture: SkillEvaluationFixture,
  events: readonly SkillLifecycleEvent[],
  outcome: SkillEvaluationOutcome = {},
): SkillEvaluationObservation {
  const applied = events.filter(
    (event) => event.type === 'skill_activation_applied' && event.skill,
  );
  const activatedSkills = [...new Set(applied.map((event) => event.skill!))];
  const expected = new Set(fixture.expectedSkills);
  const falseActivations = applied.filter((event) => event.skill && !expected.has(event.skill));
  const consentEvents = events.filter((event) => event.type === 'skill_consent_requested');
  const blockedCodes = events
    .filter(
      (event) =>
        event.type === 'skill_activation_blocked' || event.type === 'skill_resource_blocked',
    )
    .map((event) => event.details?.code)
    .filter((code): code is string => typeof code === 'string');
  const expectedBlockedCodes = fixture.expectedBlockedCodes ?? [];
  const promptChars = outcome.promptChars ?? 0;
  const bodyBytes = applied.reduce(
    (total, event) => total + numberDetail(event, 'bodyByteSize'),
    0,
  );
  return {
    ...fixture,
    expectedSkills: [...fixture.expectedSkills],
    activatedSkills,
    expectedBlockedCodes: [...expectedBlockedCodes],
    blockedCodes,
    promptChars,
    promptTokens: outcome.promptTokens ?? Math.ceil(promptChars / 4),
    bodyBytes,
    bodyTokens: outcome.bodyTokens ?? Math.ceil(bodyBytes / 4),
    falseActivationBytes: falseActivations.reduce(
      (total, event) => total + numberDetail(event, 'bodyByteSize'),
      0,
    ),
    activationLatencyMs: applied.map((event) => numberDetail(event, 'activationLatencyMs')),
    consentRequests: consentEvents.length,
    unnecessaryPermissionPrompts: consentEvents.filter(
      (event) => !event.skill || !expected.has(event.skill),
    ).length,
    taskCompleted: outcome.taskCompleted,
    userCorrections: outcome.userCorrections ?? 0,
    skillToolFailures: outcome.skillToolFailures ?? 0,
    blockingMismatch:
      expectedBlockedCodes.some((code) => !blockedCodes.includes(code)) ||
      blockedCodes.some((code) => !expectedBlockedCodes.includes(code)),
    exposure: outcome.exposure,
    activationTurns: outcome.activationTurns,
  };
}

export function evaluateSkillActivation(
  observations: readonly SkillEvaluationObservation[],
  thresholds: SkillEvaluationThresholds = DEFAULT_SKILL_EVALUATION_THRESHOLDS,
): SkillEvaluationReport {
  const categoryCounts = Object.fromEntries(
    SKILL_EVALUATION_CATEGORIES.map((category) => [
      category,
      observations.filter((observation) => observation.category === category).length,
    ]),
  ) as Record<SkillEvaluationCategory, number>;
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  for (const observation of observations) {
    const expected = new Set(observation.expectedSkills);
    const activated = new Set(observation.activatedSkills);
    truePositives += [...activated].filter((skill) => expected.has(skill)).length;
    falsePositives += [...activated].filter((skill) => !expected.has(skill)).length;
    falseNegatives += [...expected].filter((skill) => !activated.has(skill)).length;
  }
  const precision =
    truePositives + falsePositives === 0 ? 1 : truePositives / (truePositives + falsePositives);
  const recall =
    truePositives + falseNegatives === 0 ? 1 : truePositives / (truePositives + falseNegatives);
  const completed = observations.filter(
    (observation): observation is SkillEvaluationObservation & { taskCompleted: boolean } =>
      observation.taskCompleted !== undefined,
  );
  const exposure = Object.fromEntries(
    (['eager', 'deferred'] as const).map((mode) => {
      const samples = observations.filter((observation) => observation.exposure === mode);
      return [
        mode,
        {
          samples: samples.length,
          activationRate:
            samples.length === 0
              ? 0
              : samples.filter((observation) => observation.activatedSkills.length > 0).length /
                samples.length,
          medianActivationTurns: median(
            samples.map((observation) => observation.activationTurns ?? 0),
          ),
        },
      ];
    }),
  ) as SkillEvaluationReport['exposure'];
  const reasons: string[] = [];
  const missingCategories = SKILL_EVALUATION_CATEGORIES.filter(
    (category) => categoryCounts[category] === 0,
  );
  if (missingCategories.length)
    reasons.push(`Missing fixture categories: ${missingCategories.join(', ')}.`);
  if (precision < thresholds.minimumPrecision) {
    reasons.push(
      `Activation precision ${precision.toFixed(3)} is below ${thresholds.minimumPrecision}.`,
    );
  }
  if (recall < thresholds.minimumRecall) {
    reasons.push(`Activation recall ${recall.toFixed(3)} is below ${thresholds.minimumRecall}.`);
  }
  if (falsePositives > thresholds.maximumFalseActivations) {
    reasons.push(
      `False activations ${falsePositives} exceed ${thresholds.maximumFalseActivations}.`,
    );
  }
  const unnecessaryPermissionPrompts = observations.reduce(
    (total, observation) => total + observation.unnecessaryPermissionPrompts,
    0,
  );
  if (unnecessaryPermissionPrompts > thresholds.maximumUnnecessaryPermissionPrompts) {
    reasons.push(
      `Unnecessary permission prompts ${unnecessaryPermissionPrompts} exceed ${thresholds.maximumUnnecessaryPermissionPrompts}.`,
    );
  }
  const skillToolFailures = observations.reduce(
    (total, observation) => total + observation.skillToolFailures,
    0,
  );
  if (skillToolFailures > thresholds.maximumSkillToolFailures) {
    reasons.push(
      `Skill-caused tool failures ${skillToolFailures} exceed ${thresholds.maximumSkillToolFailures}.`,
    );
  }
  const blockingMismatches = observations.filter(
    (observation) => observation.blockingMismatch,
  ).length;
  if (blockingMismatches > 0) {
    reasons.push(`${blockingMismatches} fixture(s) had unexpected or missing block outcomes.`);
  }
  const latencies = observations.flatMap((observation) => observation.activationLatencyMs);
  return {
    generatedAt: new Date().toISOString(),
    fixtureCount: observations.length,
    categoryCounts,
    truePositives,
    falsePositives,
    falseNegatives,
    precision,
    recall,
    falseActivationBytes: observations.reduce(
      (total, observation) => total + observation.falseActivationBytes,
      0,
    ),
    promptChars: {
      total: observations.reduce((total, observation) => total + observation.promptChars, 0),
      median: median(observations.map((observation) => observation.promptChars)),
    },
    promptTokens: {
      total: observations.reduce((total, observation) => total + observation.promptTokens, 0),
      median: median(observations.map((observation) => observation.promptTokens)),
    },
    bodyBytes: {
      total: observations.reduce((total, observation) => total + observation.bodyBytes, 0),
      median: median(observations.map((observation) => observation.bodyBytes)),
    },
    bodyTokens: {
      total: observations.reduce((total, observation) => total + observation.bodyTokens, 0),
      median: median(observations.map((observation) => observation.bodyTokens)),
    },
    activationLatencyMs: { median: median(latencies), p95: percentile(latencies, 0.95) },
    consentRequests: observations.reduce(
      (total, observation) => total + observation.consentRequests,
      0,
    ),
    unnecessaryPermissionPrompts,
    taskCompletionRate:
      completed.length === 0
        ? undefined
        : completed.filter((observation) => observation.taskCompleted).length / completed.length,
    userCorrections: observations.reduce(
      (total, observation) => total + observation.userCorrections,
      0,
    ),
    skillToolFailures,
    blockingMismatches,
    exposure,
    thresholds: { ...thresholds },
    rolloutReady: reasons.length === 0,
    reasons,
    observations: observations.map((observation) => ({
      ...observation,
      expectedSkills: [...observation.expectedSkills],
      expectedBlockedCodes: observation.expectedBlockedCodes
        ? [...observation.expectedBlockedCodes]
        : undefined,
      activatedSkills: [...observation.activatedSkills],
      blockedCodes: [...observation.blockedCodes],
      activationLatencyMs: [...observation.activationLatencyMs],
    })),
  };
}

export async function runSkillActivationEvaluation(
  fixtures: readonly SkillEvaluationPromptFixture[],
  execute: (
    fixture: SkillEvaluationPromptFixture,
  ) => Promise<{ events: readonly SkillLifecycleEvent[]; outcome?: SkillEvaluationOutcome }>,
  thresholds: SkillEvaluationThresholds = DEFAULT_SKILL_EVALUATION_THRESHOLDS,
): Promise<SkillEvaluationReport> {
  const observations: SkillEvaluationObservation[] = [];
  for (const fixture of fixtures) {
    const result = await execute(fixture);
    observations.push(
      observeSkillEvaluation(
        {
          id: fixture.id,
          category: fixture.category,
          promptHash: createHash('sha256').update(fixture.prompt).digest('hex'),
          expectedSkills: [...fixture.expectedSkills],
          expectedBlockedCodes: fixture.expectedBlockedCodes
            ? [...fixture.expectedBlockedCodes]
            : undefined,
        },
        result.events,
        result.outcome,
      ),
    );
  }
  return evaluateSkillActivation(observations, thresholds);
}

export function renderSkillEvaluationReport(report: SkillEvaluationReport): string {
  const categories = SKILL_EVALUATION_CATEGORIES.map(
    (category) => `- ${category}: ${report.categoryCounts[category]}`,
  ).join('\n');
  return [
    '# Skill Activation Evaluation',
    '',
    `Generated: ${report.generatedAt}`,
    `Rollout ready: ${report.rolloutReady ? 'yes' : 'no'}`,
    `Precision: ${report.precision.toFixed(3)}`,
    `Recall: ${report.recall.toFixed(3)}`,
    `False activations: ${report.falsePositives}`,
    `False-activation body bytes: ${report.falseActivationBytes}`,
    `Median prompt tokens: ${report.promptTokens.median}`,
    `Median activated body tokens: ${report.bodyTokens.median}`,
    `Median activation latency: ${report.activationLatencyMs.median} ms`,
    `Unnecessary permission prompts: ${report.unnecessaryPermissionPrompts}`,
    `Skill-caused tool failures: ${report.skillToolFailures}`,
    `Blocking mismatches: ${report.blockingMismatches}`,
    ...(report.evaluation
      ? [
          `Evidence kind: ${report.evaluation.evidenceKind}`,
          `Provider run eligibility: ${report.evaluation.providerRunEligibility}`,
          `Evaluation date: ${report.evaluation.controls.evaluationDate}`,
          `Evaluation seed: ${report.evaluation.controls.randomSeed}`,
          `Runtime revision: ${report.evaluation.controls.runtimeRevision}`,
          `Fixture revision: ${report.evaluation.controls.fixtureRevision} (${report.evaluation.controls.fixtureRevisionStatus})`,
        ]
      : []),
    '',
    '## Fixture Coverage',
    '',
    categories,
    '',
    '## Gate',
    '',
    ...(report.reasons.length
      ? report.reasons.map((reason) => `- ${reason}`)
      : ['- All thresholds passed.']),
    '',
  ].join('\n');
}

export function writeSkillEvaluationReport(
  report: SkillEvaluationReport,
  jsonPath: string,
  markdownPath?: string,
): void {
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  if (markdownPath) {
    mkdirSync(dirname(markdownPath), { recursive: true });
    writeFileSync(markdownPath, renderSkillEvaluationReport(report), 'utf8');
  }
}
