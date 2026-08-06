import { describe, expect, it } from 'vitest';
import type { CompactEvalRunResult, ProbeRunResult } from './compact-eval.js';
import {
  buildZeroMemEvalFixture,
  parseZeroMemEvalArgs,
  renderZeroMemEvalReport,
  type ZeroMemEvalBundle,
} from './zero-mem-eval.js';

const attribution = {
  eligible: true,
  reasons: [],
  rootRunId: 'run',
  ambientFingerprint: 'ambient',
  pricingVersion: 'pricing',
  modelIdentityFingerprint: 'model',
};

function probeRun(pass: boolean, promptTokens: number): ProbeRunResult {
  return {
    pass,
    semanticPass: pass,
    failureKind: pass ? 'none' : 'wrong-answer',
    answer: pass ? 'correct' : 'wrong',
    formatCompliant: true,
    missingTerms: pass ? [] : ['correct'],
    outputPreview: pass ? 'correct' : 'wrong',
    toolCalls: [],
    errors: [],
    usage: { promptTokens, completionTokens: 10, totalTokens: promptTokens + 10 },
    attribution,
  };
}

function compactRun(): CompactEvalRunResult {
  return {
    version: 3,
    model: 'model-a',
    repetition: 1,
    suite: 'standard',
    fixture: 'fixture',
    historyTokens: 8_000,
    historyMessages: 60,
    compact: {
      status: 'compacted',
      model: 'model-a',
      preContextTokens: 8_000,
      postContextTokens: 2_000,
      compressionRatio: 0.25,
      summarizedCount: 50,
      retainedCount: 10,
      modelCalls: 1,
      strategy: 'single-pass',
      usage: { promptTokens: 900, completionTokens: 100, totalTokens: 1_000 },
      estimatedPromptTokens: 900,
      costUsd: 0.01,
      timeMs: 500,
      attribution,
    },
    probes: [
      {
        name: 'fact',
        category: 'static-recall',
        evidencePosition: 'early',
        evidenceMessageIds: ['message-1'],
        control: probeRun(true, 2_000),
        treatment: probeRun(false, 1_000),
        comparison: { ...attribution },
      },
    ],
    control: {
      calls: [],
      usage: { promptTokens: 2_000, completionTokens: 10, totalTokens: 2_010 },
      costUsd: 0.02,
      costStatus: 'known',
    },
    treatment: {
      calls: [],
      usage: { promptTokens: 1_900, completionTokens: 110, totalTokens: 2_010 },
      costUsd: 0.02,
      costStatus: 'known',
    },
  };
}

describe('zero-mem eval', () => {
  it('uses only authoritative package-manager corrections as expected evidence', () => {
    const fixture = buildZeroMemEvalFixture();
    const packageProbe = fixture.probes.find(
      (candidate) => candidate.name === 'package-manager-correction',
    );
    const patchProbe = fixture.probes.find((candidate) => candidate.name === 'current-patch-state');

    expect(packageProbe?.evidenceMessageIds).toEqual(['compact-eval-28', 'compact-eval-29']);
    expect(patchProbe?.evidenceMessageIds).toEqual(['compact-eval-58', 'compact-eval-59']);
  });

  it('parses comparison and retrieval controls', () => {
    expect(
      parseZeroMemEvalArgs([
        '--models',
        'model-a,model-b',
        '--compact-model',
        'reducer-a',
        '--suite',
        'smoke',
        '--repeat',
        '2',
        '--probes',
        '4',
        '--context-window',
        '32000',
        '--checkpoint-tokens',
        '1024',
        '--compact-effort',
        'low',
        '--top-k',
        '6',
        '--closure-k',
        '2',
        '--json',
      ]),
    ).toEqual({
      models: ['model-a', 'model-b'],
      compactModel: 'reducer-a',
      suite: 'smoke',
      contextWindow: 32_000,
      repetitions: 2,
      probeLimit: 4,
      checkpointTokens: 1_024,
      compactEffort: 'low',
      topK: 6,
      closureK: 2,
      json: true,
    });
  });

  it('renders answer quality and memory-operation efficiency side by side', () => {
    const bundle: ZeroMemEvalBundle = {
      version: 2,
      createdAt: '2026-08-06T00:00:00.000Z',
      options: parseZeroMemEvalArgs([]),
      semanticModel: 'bge-m3+bert-ner',
      semanticModelLoadMs: 100,
      runs: [
        {
          model: 'model-a',
          repetition: 1,
          compact: compactRun(),
          zeroMem: {
            indexMs: 10,
            retrievalMs: 5,
            memoryOperationTokens: 0,
            reader: {
              calls: [],
              usage: { promptTokens: 500, completionTokens: 10, totalTokens: 510 },
              costUsd: 0.005,
              costStatus: 'known',
            },
            probes: [
              {
                name: 'fact',
                category: 'static-recall',
                evidenceMessageIds: ['message-1'],
                retrievedMessageIds: ['message-1'],
                evidenceHits: 1,
                evidenceRecall: 1,
                evidenceSufficient: true,
                contextTokens: 500,
                contextBudgetTokens: 2_000,
                retrievalMs: 5,
                calibration: {
                  initialAnswer: 'correct',
                  answer: 'correct',
                  output: '{"answer":"correct"}',
                  changed: false,
                  supported: true,
                  formatCompliant: true,
                  reason: 'supported',
                  candidates: [],
                },
                reader: probeRun(true, 500),
              },
            ],
          },
        },
      ],
    };
    const report = renderZeroMemEvalReport(bundle);

    expect(report).toContain(
      '| model-a | 1/1 | 0/1 | 1/1 | 2,000 | 500 | 75.0% | 1,000 | 0 | 500 ms | 15 ms | 1/1 | 100.0% | 0/1 |',
    );
    expect(report).toContain('| model-a | 2,000 | 1,000 | 500 | 50.0% |');
    expect(report).toContain(
      '| model-a | 1 | fact | PASS: correct | FAIL: wrong | PASS: correct | 1/1 | 500 / 2,000 | supported |',
    );
  });
});
