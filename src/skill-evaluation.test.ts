import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SkillLifecycleEvent } from './skill-registry.js';
import {
  SKILL_EVALUATION_CATEGORIES,
  evaluateSkillActivation,
  observeSkillEvaluation,
  renderSkillEvaluationReport,
  runSkillActivationEvaluation,
  writeSkillEvaluationReport,
  type SkillEvaluationCategory,
} from './skill-evaluation.js';

function applied(skill: string, bodyByteSize = 100): SkillLifecycleEvent {
  return {
    type: 'skill_activation_applied',
    timestamp: 1,
    skill,
    reason: 'model',
    details: { bodyByteSize, activationLatencyMs: 4 },
  };
}

function observation(category: SkillEvaluationCategory) {
  const expectedSkills =
    category === 'direct' || category === 'indirect'
      ? ['review']
      : category === 'conflicting'
        ? ['first']
        : category === 'missing-resource'
          ? ['missing-resource']
          : [];
  const blockedCode =
    category === 'conflicting'
      ? 'skill_tool_intersection_empty'
      : category === 'disabled'
        ? 'skill_disabled'
        : category === 'invalid'
          ? 'skill_invalid'
          : category === 'missing-body'
            ? 'skill_load_failed'
            : category === 'missing-resource'
              ? 'skill_resource_unreadable'
              : undefined;
  const events: SkillLifecycleEvent[] = expectedSkills.length ? [applied(expectedSkills[0])] : [];
  if (blockedCode) {
    events.push({
      type: category === 'missing-resource' ? 'skill_resource_blocked' : 'skill_activation_blocked',
      timestamp: 2,
      skill: category,
      reason: 'model',
      details: { code: blockedCode },
    });
  }
  return observeSkillEvaluation(
    {
      id: category,
      category,
      promptHash: `hash-${category}`,
      expectedSkills,
      expectedBlockedCodes: blockedCode ? [blockedCode] : undefined,
    },
    events,
    { promptChars: 120, taskCompleted: true, exposure: 'eager', activationTurns: 1 },
  );
}

describe('skill activation evaluation', () => {
  it('requires full fixture coverage and reports rollout metrics without prompt bodies', () => {
    const report = evaluateSkillActivation(SKILL_EVALUATION_CATEGORIES.map(observation));

    expect(report.fixtureCount).toBe(SKILL_EVALUATION_CATEGORIES.length);
    expect(report.precision).toBe(1);
    expect(report.recall).toBe(1);
    expect(report.rolloutReady).toBe(true);
    expect(report.activationLatencyMs.median).toBe(4);
    expect(renderSkillEvaluationReport(report)).toContain('All thresholds passed');
    expect(JSON.stringify(report)).not.toContain('raw prompt');
  });

  it('detects false activation cost and unnecessary consent prompts', () => {
    const negative = observeSkillEvaluation(
      { id: 'negative', category: 'negative', promptHash: 'hash', expectedSkills: [] },
      [
        applied('wrong-skill', 321),
        {
          type: 'skill_consent_requested',
          timestamp: 2,
          skill: 'wrong-skill',
          reason: 'model',
        },
      ],
    );
    const report = evaluateSkillActivation([
      negative,
      ...SKILL_EVALUATION_CATEGORIES.filter((category) => category !== 'negative').map(observation),
    ]);

    expect(report.falsePositives).toBe(1);
    expect(report.falseActivationBytes).toBe(321);
    expect(report.unnecessaryPermissionPrompts).toBe(1);
    expect(report.rolloutReady).toBe(false);
  });

  it('runs prompt fixtures while retaining only prompt hashes in the report', async () => {
    const report = await runSkillActivationEvaluation(
      [
        {
          id: 'direct',
          category: 'direct',
          prompt: 'secret evaluation prompt',
          expectedSkills: ['review'],
        },
      ],
      async () => ({ events: [applied('review')] }),
    );

    expect(report.observations[0].promptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(report)).not.toContain('secret evaluation prompt');
  });

  it('writes reproducible JSON and Markdown rollout evidence', () => {
    const directory = mkdtempSync(join(tmpdir(), 'book-skill-evaluation-'));
    try {
      const report = evaluateSkillActivation(SKILL_EVALUATION_CATEGORIES.map(observation));
      const jsonPath = join(directory, 'report.json');
      const markdownPath = join(directory, 'report.md');

      writeSkillEvaluationReport(report, jsonPath, markdownPath);

      expect(JSON.parse(readFileSync(jsonPath, 'utf8')).rolloutReady).toBe(true);
      expect(readFileSync(markdownPath, 'utf8')).toContain('All thresholds passed');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
