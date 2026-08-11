import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { estimateHistoryTokens } from '../src/agent/compact.js';
import { loadConfig, resolveCompactModelConfig } from '../src/config.js';
import { runEvaluationProcess } from '../src/harness/evaluation/runner.js';
import {
  benchmarkFailed,
  breakEvenProbeCount,
  buildCompactEvalFixture,
  COMPACT_EVAL_FIXTURE_FILENAME,
  createCompactEvaluationSettings,
  gradeProbe,
  parseArgs,
  renderBenchmarkReport,
  runCompactEvaluationIsolated,
  type CompactEvalBundle,
  type CompactEvalRunResult,
  type ProbeRunResult,
} from './compact-eval.js';

vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(),
  resolveCompactModelConfig: vi.fn((config) => config),
}));
vi.mock('../src/harness/evaluation/runner.js', () => ({
  runEvaluationProcess: vi.fn(),
  evaluationControlsFromResult: vi.fn((result) => ({
    evaluationDate: result.evaluationDate,
    randomSeed: result.randomSeed,
    runtimeRevision: result.runtimeRevision,
    fixtureRevision: result.fixtureRevision,
    fixtureRevisionStatus: result.fixtureRevisionStatus,
  })),
}));

const usage = (totalTokens: number) => ({
  promptTokens: totalTokens,
  completionTokens: 0,
  totalTokens,
});

const attribution = {
  eligible: true,
  reasons: [],
  rootRunId: 'root-run',
  ambientFingerprint: 'ambient',
  pricingVersion: 'pricing-v1',
  budgetUsd: undefined,
  modelIdentityFingerprint: 'model-identity',
};

const comparison = {
  eligible: true,
  reasons: [],
  ambientFingerprint: 'ambient',
  pricingVersion: 'pricing-v1',
  budgetUsd: undefined,
  modelIdentityFingerprint: 'model-identity',
};

const controls = {
  evaluationDate: '2026-08-05',
  randomSeed: 'seed-1',
  runtimeRevision: 'runtime-1',
  fixtureRevision: 'fixture-1',
  fixtureRevisionStatus: 'captured' as const,
};

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
    attribution,
  };
}

function reportFixture(): CompactEvalBundle {
  const run: CompactEvalRunResult = {
    version: 3,
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
      attribution,
    },
    probes: [
      {
        name: 'static-probe',
        category: 'static-recall',
        evidencePosition: 'early',
        evidenceMessageIds: ['message-1'],
        control: probeRun(true),
        treatment: probeRun(false, 'invalid-format'),
        comparison,
      },
      {
        name: 'abstention-probe',
        category: 'abstention',
        evidencePosition: 'absent',
        evidenceMessageIds: [],
        control: probeRun(false),
        treatment: probeRun(true),
        noHistory: probeRun(true),
        comparison,
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
    version: 3,
    createdAt: '2026-08-01T00:00:00.000Z',
    options: {
      suite: 'standard',
      contextWindow: 24_000,
      repetitions: 1,
      includeNoHistory: true,
    },
    controls: [
      {
        ...controls,
        model: 'model-a',
        compactModel: 'model-a',
        repetition: 1,
      },
    ],
    runs: [run],
  };
}

describe('compact eval', () => {
  beforeEach(() => {
    vi.mocked(loadConfig).mockReset();
    vi.mocked(resolveCompactModelConfig).mockReset();
    vi.mocked(resolveCompactModelConfig).mockImplementation((config) => config);
    vi.mocked(runEvaluationProcess).mockReset();
  });

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
      gradeProbe('{"answer":"The patch is not active after the Thursday reversion."}', {
        kind: 'contains-all-any',
        groups: [['not active', 'inactive'], ['reverted', 'reversion'], ['Thursday']],
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
      '| static-probe | static-recall | early | eligible | PASS | FAIL:invalid-format |',
    );
    expect(report).toContain('20.0%');
    expect(report).toContain('Checkpoint output cap: production default');
    expect(report).not.toContain('n/a%');
  });

  it('amortizes compaction cost using average savings per probe', () => {
    expect(breakEvenProbeCount(1_000, 5_000, 3_000, 4)).toBe(2);
    expect(breakEvenProbeCount(1_000, 3_000, 3_000, 4)).toBeNull();
  });

  it('fails closed when semantically valid probe evidence is ineligible', () => {
    const bundle = reportFixture();
    for (const probe of bundle.runs[0]!.probes) probe.treatment = { ...probe.control };
    expect(benchmarkFailed(bundle)).toBe(false);

    bundle.runs[0]!.probes[0]!.treatment.attribution = {
      eligible: false,
      reasons: ['model_identity_unverified'],
    };

    expect(bundle.runs[0]!.probes[0]!.treatment.semanticPass).toBe(true);
    expect(benchmarkFailed(bundle)).toBe(true);
  });

  it('fails closed when paired arms have different ambient identities', () => {
    const bundle = reportFixture();
    for (const probe of bundle.runs[0]!.probes) probe.treatment = { ...probe.control };
    bundle.runs[0]!.probes[0]!.comparison = {
      eligible: false,
      reasons: ['comparison_ambient_mismatch'],
    };

    expect(benchmarkFailed(bundle)).toBe(true);
  });

  it('ships the isolated worker entrypoint', () => {
    expect(existsSync(fileURLToPath(new URL('./compact-eval-worker.ts', import.meta.url)))).toBe(
      true,
    );
  });

  it('runs provider-backed probes in the isolated evaluation worker', async () => {
    const probeConfig = {
      apiKey: 'probe-secret',
      baseUrl: 'https://probe.example/v1',
      model: 'probe-model-id',
      modelSelection: 'gateway/probe-model-id',
      provider: 'openai',
      modelInfo: { contextWindow: 64_000, maxOutputTokens: 8_192 },
      retry: { maxAttempts: 3, watchdog: false },
    } as never;
    const compactConfig = {
      apiKey: 'compact-secret',
      baseUrl: 'https://compact.example/v1',
      model: 'compact-model-id',
      modelSelection: 'gateway/compact-model-id',
      provider: 'anthropic',
      modelInfo: { contextWindow: 128_000, maxOutputTokens: 16_000 },
      retry: { maxAttempts: 2, watchdog: true },
    } as never;
    vi.mocked(loadConfig).mockReturnValueOnce(probeConfig).mockReturnValueOnce(compactConfig);
    vi.mocked(runEvaluationProcess).mockResolvedValue({
      status: 'completed',
      stdout: `${JSON.stringify(reportFixture())}\n`,
      stderr: '',
      ...controls,
    } as never);

    const options = parseArgs([
      '--model',
      'gateway/probe-model-id',
      '--compact-model',
      'gateway/compact-model-id',
      '--suite',
      'standard',
      '--repeat',
      '2',
    ]);
    const bundle = await runCompactEvaluationIsolated(options);

    expect(bundle.runs[0]).toMatchObject({
      model: 'gateway/probe-model-id',
      compact: { model: 'gateway/compact-model-id' },
    });
    expect(bundle.controls[0]).toMatchObject({
      model: 'gateway/probe-model-id',
      compactModel: 'gateway/compact-model-id',
      repetition: 1,
      ...controls,
    });
    expect(bundle.controls).toHaveLength(2);
    expect(bundle.runs.map((run) => run.repetition)).toEqual([1, 2]);
    expect(runEvaluationProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        command: process.execPath,
        timeoutMs: expect.any(Number),
        env: {
          BOOK_EVAL_PROBE_API_KEY: 'probe-secret',
          BOOK_EVAL_COMPACT_API_KEY: 'compact-secret',
        },
      }),
    );
    const processOptions = vi.mocked(runEvaluationProcess).mock.calls[0]?.[0];
    expect(processOptions?.args?.[2]).toMatch(/compact-eval-worker\.ts$/);
    expect(processOptions?.args).toContain('evaluation-probe/probe-model-id');
    expect(processOptions?.args).toContain('evaluation-compact/compact-model-id');

    const preparedRoot = await mkdtemp(join(tmpdir(), 'book-compact-eval-prepare-'));
    try {
      const workspace = join(preparedRoot, 'workspace');
      const bookHome = join(preparedRoot, 'book-home');
      const temporaryDirectory = join(preparedRoot, 'tmp');
      await Promise.all([mkdir(workspace), mkdir(bookHome), mkdir(temporaryDirectory)]);
      await processOptions?.prepare?.({
        runId: 'run-1',
        root: preparedRoot,
        workspace,
        bookHome,
        temporaryDirectory,
      });
      expect(
        JSON.parse(await readFile(join(workspace, COMPACT_EVAL_FIXTURE_FILENAME), 'utf8')),
      ).toEqual(buildCompactEvalFixture());
    } finally {
      await rm(preparedRoot, { recursive: true, force: true });
    }

    const settings = createCompactEvaluationSettings(probeConfig, compactConfig);
    expect(settings).toMatchObject({
      model: 'evaluation-probe/probe-model-id',
      compactModel: 'evaluation-compact/compact-model-id',
      provider: {
        'evaluation-probe': {
          type: 'openai',
          apiKey: '{env:BOOK_EVAL_PROBE_API_KEY}',
          models: { 'probe-model-id': probeConfig.modelInfo },
        },
        'evaluation-compact': {
          type: 'anthropic',
          apiKey: '{env:BOOK_EVAL_COMPACT_API_KEY}',
          models: { 'compact-model-id': compactConfig.modelInfo },
        },
      },
      agents: { mode: 'off' },
      memory: { enabled: false },
      skills: { enabled: false },
    });
    expect(JSON.stringify(settings)).not.toContain('probe-secret');
    expect(JSON.stringify(settings)).not.toContain('compact-secret');
  });

  it('preserves unauthenticated local-provider evaluation support', async () => {
    const config = {
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local-model',
      modelSelection: 'local/local-model',
      provider: 'openai',
      retry: { maxAttempts: 1, watchdog: false },
    } as never;
    vi.mocked(loadConfig).mockReturnValue(config);
    vi.mocked(runEvaluationProcess).mockResolvedValue({
      status: 'completed',
      stdout: `${JSON.stringify(reportFixture())}\n`,
      stderr: '',
      ...controls,
    } as never);

    await runCompactEvaluationIsolated(parseArgs(['--model', 'local/local-model']));

    expect(loadConfig).toHaveBeenCalledWith(expect.any(String), {
      modelOverride: 'local/local-model',
      allowMissingApiKey: true,
    });
    expect(runEvaluationProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          BOOK_EVAL_PROBE_API_KEY: '',
          BOOK_EVAL_COMPACT_API_KEY: '',
        },
      }),
    );
  });

  it('rejects stale worker report schemas', async () => {
    const config = {
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local-model',
      modelSelection: 'local/local-model',
      provider: 'openai',
      retry: { maxAttempts: 1, watchdog: false },
    } as never;
    vi.mocked(loadConfig).mockReturnValue(config);
    vi.mocked(runEvaluationProcess).mockResolvedValue({
      status: 'completed',
      stdout: `${JSON.stringify({ ...reportFixture(), version: 2 })}\n`,
      stderr: '',
      ...controls,
    } as never);

    await expect(
      runCompactEvaluationIsolated(parseArgs(['--model', 'local/local-model'])),
    ).rejects.toThrow('unsupported report schema');
  });

  it('rejects empty schema-v3 worker bundles', async () => {
    const config = {
      apiKey: '',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local-model',
      modelSelection: 'local/local-model',
      provider: 'openai',
      retry: { maxAttempts: 1, watchdog: false },
    } as never;
    vi.mocked(loadConfig).mockReturnValue(config);
    vi.mocked(runEvaluationProcess).mockResolvedValue({
      status: 'completed',
      stdout: `${JSON.stringify({ ...reportFixture(), runs: [] })}\n`,
      stderr: '',
      ...controls,
    } as never);

    await expect(
      runCompactEvaluationIsolated(parseArgs(['--model', 'local/local-model'])),
    ).rejects.toThrow('unsupported report schema');
  });

  it('preserves the configured reducer model when no CLI reducer override is provided', async () => {
    const probeConfig = {
      apiKey: 'probe-secret',
      baseUrl: 'https://probe.example/v1',
      model: 'probe-model-id',
      modelSelection: 'gateway/probe-model-id',
      compactModel: 'reducer/reducer-model-id',
      provider: 'openai',
      retry: { maxAttempts: 1, watchdog: false },
    } as never;
    const reducerConfig = {
      apiKey: 'reducer-secret',
      baseUrl: 'https://reducer.example/v1',
      model: 'reducer-model-id',
      modelSelection: 'reducer/reducer-model-id',
      compactModel: 'reducer/reducer-model-id',
      provider: 'anthropic',
      modelInfo: { contextWindow: 128_000, maxOutputTokens: 8_192 },
      retry: { maxAttempts: 1, watchdog: false },
    } as never;
    vi.mocked(loadConfig).mockReturnValue(probeConfig);
    vi.mocked(resolveCompactModelConfig).mockReturnValue(reducerConfig);
    vi.mocked(runEvaluationProcess).mockResolvedValue({
      status: 'completed',
      stdout: `${JSON.stringify(reportFixture())}\n`,
      stderr: '',
      ...controls,
    } as never);

    const bundle = await runCompactEvaluationIsolated(
      parseArgs(['--model', 'gateway/probe-model-id']),
    );

    expect(resolveCompactModelConfig).toHaveBeenCalledWith(probeConfig);
    expect(bundle.options.compactModel).toBe('reducer/reducer-model-id');
    expect(bundle.runs[0]?.compact.model).toBe('reducer/reducer-model-id');
    expect(runEvaluationProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          BOOK_EVAL_PROBE_API_KEY: 'probe-secret',
          BOOK_EVAL_COMPACT_API_KEY: 'reducer-secret',
        },
      }),
    );
    const processOptions = vi.mocked(runEvaluationProcess).mock.calls[0]?.[0];
    expect(processOptions?.args).toContain('evaluation-compact/reducer-model-id');
  });
});
