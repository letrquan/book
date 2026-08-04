import { describe, expect, it } from 'vitest';
import { estimateHistoryTokens } from '../src/agent/compact.js';
import {
  breakEvenProbeCount,
  buildCompactEvalFixture,
  gradeProbe,
  parseArgs,
  renderBenchmarkReport,
  type CompactEvalBundle,
  type CompactEvalRunResult,
  type ProbeRunResult,
} from './compact-eval.js';

const usage = (totalTokens: number) => ({
  promptTokens: totalTokens,
  completionTokens: 0,
  totalTokens,
});

function probeRun(
  pass: boolean,
  failureKind: ProbeRunResult['failureKind'] = pass ? 'none' : 'wrong-answer',
): ProbeRunResult {
  return {
    pass,
    semanticPass: pass || failureKind === 'invalid-format',
    failureKind,
    answer: pass ? 'correct' : 'incorrect',
    formatCompliant: failureKind !== 'invalid-format',
    missingTerms: pass ? [] : ['expected'],
    outputPreview: pass ? '{"answer":"correct"}' : '{"answer":"incorrect"}',
    toolCalls: [],
    errors: [],
    usage: usage(500),
  };
}

function reportFixture(): CompactEvalBundle {
  const run: CompactEvalRunResult = {
    version: 2,
    model: 'model-a',
    repetition: 1,
    suite: 'standard',
    fixture: 'fixture-a',
    historyTokens: 7_000,
    historyMessages: 60,
    compact: {
      status: 'compacted',
      model: 'model-a',
      preContextTokens: 7_000,
      postContextTokens: 2_000,
      compressionRatio: 2 / 7,
      summarizedCount: 50,
      retainedCount: 10,
      modelCalls: 1,
      strategy: 'single-pass',
      usage: usage(100),
      estimatedPromptTokens: 90,
      costUsd: 0.002,
    },
    probes: [
      {
        name: 'static-probe',
        category: 'static-recall',
        evidencePosition: 'early',
        evidenceMessageIds: ['message-1'],
        control: probeRun(true),
        treatment: probeRun(false, 'invalid-format'),
      },
      {
        name: 'abstention-probe',
        category: 'abstention',
        evidencePosition: 'absent',
        evidenceMessageIds: [],
        control: probeRun(false),
        treatment: probeRun(true),
        noHistory: probeRun(true),
      },
    ],
    control: {
      calls: [],
      usage: usage(1_000),
      costUsd: 0.01,
      costStatus: 'known',
    },
    treatment: {
      calls: [],
      usage: usage(700),
      costUsd: 0.008,
      costStatus: 'known',
    },
    noHistory: {
      calls: [],
      usage: usage(500),
      costUsd: 0.005,
      costStatus: 'known',
    },
  };
  return {
    version: 2,
    createdAt: '2026-08-01T00:00:00.000Z',
    options: {
      suite: 'standard',
      contextWindow: 24_000,
      repetitions: 1,
      includeNoHistory: true,
    },
    runs: [run],
  };
}

describe('compact eval', () => {
  it('grades all expectation kinds and tracks JSON protocol compliance', () => {
    expect(
      gradeProbe('{"answer":"Redis was rejected because the run must work offline."}', {
        kind: 'contains-all',
        terms: ['Redis', 'offline'],
      }),
    ).toMatchObject({ pass: true, formatCompliant: true, missingTerms: [] });
    expect(
      gradeProbe('{"answer":"Use the fallback option."}', {
        kind: 'contains-any',
        terms: ['primary', 'fallback'],
      }).pass,
    ).toBe(true);
    expect(
      gradeProbe('{"answer":"  EU-WEST-1  "}', {
        kind: 'exact',
        values: ['eu-west-1'],
      }).pass,
    ).toBe(true);
    expect(
      gradeProbe('{"answer":"The password was not recorded."}', {
        kind: 'abstain',
        markers: ['unknown', 'not recorded'],
      }).pass,
    ).toBe(true);

    const rawText = gradeProbe('Redis was rejected because the run must work offline.', {
      kind: 'contains-all',
      terms: ['Redis', 'offline'],
    });
    expect(rawText).toMatchObject({ pass: true, formatCompliant: false });
    expect(
      gradeProbe('{"answer":"Redis was rejected."}', {
        kind: 'contains-all',
        terms: ['Redis', 'offline'],
      }),
    ).toMatchObject({ pass: false, missingTerms: ['offline'] });
  });

  it('covers state, conflict, time, synthesis, and abstention in a long fixture', () => {
    const fixture = buildCompactEvalFixture();
    const probes = new Map(fixture.probes.map((probe) => [probe.name, probe]));

    expect(fixture.probes).toHaveLength(11);
    expect(fixture.probes.filter((probe) => probe.tier === 'smoke')).toHaveLength(5);
    expect(new Set(fixture.probes.map((probe) => probe.category))).toEqual(
      new Set([
        'static-recall',
        'knowledge-update',
        'conflict-resolution',
        'temporal-reasoning',
        'multi-hop',
        'abstention',
      ]),
    );
    expect(fixture.history.length).toBeGreaterThan(50);
    expect(estimateHistoryTokens(fixture.history)).toBeGreaterThan(6_000);
    expect(fixture.history[0]?.content).toContain('Node.js 20');
    expect(fixture.history.at(-1)?.content).not.toContain('workspaceHash:modelId:v3');

    expect(probes.get('current-region-update')?.expectation).toEqual({
      kind: 'exact',
      values: ['eu-west-1'],
    });
    expect(probes.get('package-manager-correction')?.evidenceMessageIds).toHaveLength(3);
    expect(probes.get('first-passing-day')?.expectation).toEqual({
      kind: 'exact',
      values: ['Wednesday'],
    });
    expect(probes.get('unit-conversion-reasoning')?.evidencePosition).toBe('distributed');
    expect(probes.get('missing-secret-abstention')?.evidenceMessageIds).toEqual([]);
  });

  it('parses multiple models, repetitions, suites, and leakage options', () => {
    expect(
      parseArgs([
        '--model',
        'model-a',
        '--compact-model',
        'reducer-a',
        '--models',
        'model-b, model-c',
        '--model',
        'model-a',
        '--suite',
        'standard',
        '--repeat',
        '3',
        '--probes',
        '7',
        '--context-window',
        '32000',
        '--checkpoint-tokens',
        '1024',
        '--compact-effort',
        'low',
        '--include-no-history',
        '--json',
      ]),
    ).toEqual({
      models: ['model-a', 'model-b', 'model-c'],
      compactModel: 'reducer-a',
      suite: 'standard',
      contextWindow: 32_000,
      repetitions: 3,
      includeNoHistory: true,
      probeLimit: 7,
      checkpointTokens: 1_024,
      compactEffort: 'low',
      json: true,
    });
  });

  it('reports paired accuracy, categories, protocol failures, and cost savings', () => {
    const report = renderBenchmarkReport(reportFixture());

    expect(report).toContain('| model-a | 1/2 | 1/2 | 0/1 | 1 | 1 |');
    expect(report).toContain('| static-recall | 1/1 | 0/1 | 0/1 | 1 | 0 | 0/1 | 0/1 |');
    expect(report).toContain('| abstention | 0/1 | 1/1 | 0/0 | 0 | 1 | 0/0 | 1/1 |');
    expect(report).toContain(
      '| static-probe | static-recall | early | PASS | FAIL:invalid-format |',
    );
    expect(report).toContain('20.0%');
    expect(report).toContain('Checkpoint output cap: production default');
    expect(report).not.toContain('n/a%');
  });

  it('amortizes compaction cost using average savings per probe', () => {
    expect(breakEvenProbeCount(1_000, 5_000, 3_000, 4)).toBe(2);
    expect(breakEvenProbeCount(1_000, 3_000, 3_000, 4)).toBeNull();
  });
});
