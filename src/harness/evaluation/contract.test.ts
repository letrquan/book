import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HarnessEvaluationCaseSchema,
  evaluateCaseFinalState,
  evaluateContractComparison,
  evaluateHumanRubric,
  fingerprintEvaluationFixture,
  loadEvaluationCorpus,
  materializeEvaluationFixture,
  summarizeEvaluationNoiseFloor,
  type EvaluationComparisonIdentity,
} from './contract.js';

const temporaryDirectories: string[] = [];
const corpusRoot = resolve('evals/harness');

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), label));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

describe('Phase 0 evaluation contract', () => {
  it('loads the strict, version-aligned corpus with every representative task class', async () => {
    const corpus = await loadEvaluationCorpus(corpusRoot);
    expect(new Set(corpus.cases.map((item) => item.taskClass))).toEqual(
      new Set([
        'read-only',
        'simple-edit',
        'bug-fix',
        'multi-file',
        'review',
        'research',
        'long-horizon',
      ]),
    );
    expect(corpus.cases.some((item) => item.eligibility === 'blocked-tier-c')).toBe(true);
  });

  it('rejects unknown fields recursively', async () => {
    const corpus = await loadEvaluationCorpus(corpusRoot);
    const source = corpus.cases[0];
    expect(() =>
      HarnessEvaluationCaseSchema.parse({
        ...source,
        budgets: { ...source.budgets, unexpected: true },
      }),
    ).toThrow();
  });

  it('materializes fixtures reproducibly and grades expected final state', async () => {
    const corpus = await loadEvaluationCorpus(corpusRoot);
    const evaluationCase = corpus.cases.find((item) => item.id === 'simple-edit-heading');
    expect(evaluationCase).toBeDefined();
    const first = await temporaryDirectory('book-harness-fixture-a-');
    const second = await temporaryDirectory('book-harness-fixture-b-');
    const firstDigest = await materializeEvaluationFixture(corpus, evaluationCase!, first);
    const secondDigest = await materializeEvaluationFixture(corpus, evaluationCase!, second);
    expect(firstDigest).toBe(secondDigest);

    await writeFile(join(first, 'README.md'), '# Clear Title\n\nA small fixture.\n', 'utf8');
    await writeFile(join(second, 'README.md'), '# Wrong Title\n', 'utf8');
    await expect(evaluateCaseFinalState(evaluationCase!, first)).resolves.toMatchObject({
      status: 'success',
    });
    await expect(evaluateCaseFinalState(evaluationCase!, second)).resolves.toMatchObject({
      status: 'failure',
    });
  });

  it('keeps optional verifier failure visible as partial', async () => {
    const corpus = await loadEvaluationCorpus(corpusRoot);
    const evaluationCase = corpus.cases.find((item) => item.id === 'read-only-inventory');
    const workspace = await temporaryDirectory('book-harness-optional-');
    await writeFile(join(workspace, 'inventory.txt'), 'README.md\nsrc/value.ts\n', 'utf8');
    await writeFile(join(workspace, 'notes.txt'), 'unexpected', 'utf8');
    await expect(evaluateCaseFinalState(evaluationCase!, workspace)).resolves.toMatchObject({
      status: 'partial',
      verifiers: expect.arrayContaining([
        expect.objectContaining({ id: 'no-extra-notes', status: 'failed', required: false }),
      ]),
    });
  });

  it('keeps rubric disagreement unknown instead of converting it to success', () => {
    expect(
      evaluateHumanRubric([
        { reviewerId: 'reviewer-a', score: 4, independent: true },
        { reviewerId: 'reviewer-b', score: 1, independent: true },
      ]),
    ).toEqual({ status: 'unknown', detail: 'review-disagreement', scores: [4, 1] });
  });

  it('rejects duplicate reviewer identities even when the duplicate entries claim independence', () => {
    expect(
      evaluateHumanRubric([
        { reviewerId: 'reviewer-a', score: 4, independent: true },
        { reviewerId: ' reviewer-a ', score: 4, independent: true },
      ]),
    ).toEqual({ status: 'unknown', detail: 'duplicate-reviewer-identity', scores: [4, 4] });
  });

  it('invalidates comparisons when any frozen identity differs', () => {
    const identity: EvaluationComparisonIdentity = {
      armId: 'A/base',
      corpusVersion: 'harness-corpus-v1',
      evaluatorVersion: 'phase0-contract-v1',
      fixtureRevision: 'fixture-v1',
      fixtureDigest: 'fixture-digest',
      provider: 'provider',
      requestedModel: 'model',
      resolvedModel: 'model-2026-08-01',
      modelConfigDigest: 'model-config',
      runtimeFingerprint: 'runtime',
      environmentFingerprint: 'environment',
      toolSurfaceFingerprint: 'tools',
      policyFingerprint: 'policy',
      budgetFingerprint: 'budget',
      pricingVersion: 'pricing-v1',
      evaluationDate: '2026-08-05',
      randomSeed: 'seed-1',
    };
    expect(evaluateContractComparison([identity, { ...identity, armId: 'B/fixed' }])).toEqual({
      eligible: true,
      reasons: [],
    });
    expect(
      evaluateContractComparison([
        identity,
        { ...identity, armId: 'B/fixed', resolvedModel: 'different', randomSeed: 'seed-2' },
      ]),
    ).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining([
        'comparison_resolvedModel_mismatch',
        'comparison_randomSeed_mismatch',
      ]),
    });
    expect(evaluateContractComparison([identity, { ...identity }])).toMatchObject({
      eligible: false,
      reasons: ['comparison_arm_id_duplicate'],
    });
  });

  it('records a noise floor and refuses small-sample sufficiency', () => {
    expect(
      summarizeEvaluationNoiseFloor([
        { status: 'success', latencyMs: 100 },
        { status: 'success', latencyMs: 120 },
        { status: 'unknown', latencyMs: 110 },
      ]),
    ).toMatchObject({
      sampleCount: 3,
      sufficient: false,
      successRate: 2 / 3,
      unknownRate: 1 / 3,
      meanLatencyMs: 110,
    });
  });

  it('rejects symlinks in evaluator-owned fixture trees', async () => {
    const root = await temporaryDirectory('book-harness-symlink-');
    const target = join(root, 'target.txt');
    await writeFile(target, 'target', 'utf8');
    try {
      await symlink(target, join(root, 'link.txt'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    await expect(fingerprintEvaluationFixture(root)).rejects.toThrow('symlink is forbidden');
  });

  it('rejects a symlinked fixture source root before hashing or copying', async () => {
    const corpusRoot = await temporaryDirectory('book-harness-corpus-link-');
    const outside = await temporaryDirectory('book-harness-outside-fixture-');
    await writeFile(join(outside, 'result.txt'), 'outside', 'utf8');
    const linkedSource = join(corpusRoot, 'linked-fixture');
    try {
      await symlink(outside, linkedSource, 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const sourceCase = (await loadEvaluationCorpus(resolve('evals/harness'))).cases.find(
      (item) => item.id === 'simple-edit-heading',
    )!;
    await expect(
      materializeEvaluationFixture(
        { root: corpusRoot, manifest: {} as never, cases: [] },
        {
          ...sourceCase,
          fixture: { ...sourceCase.fixture, source: 'linked-fixture' },
        },
        join(corpusRoot, 'destination'),
      ),
    ).rejects.toThrow(/unsafe|symlink/i);
  });

  it('rejects a symlinked verifier ancestor instead of grading an outside file', async () => {
    const workspace = await temporaryDirectory('book-harness-workspace-link-');
    const outside = await temporaryDirectory('book-harness-outside-result-');
    await writeFile(join(outside, 'result.txt'), 'expected', 'utf8');
    try {
      await symlink(outside, join(workspace, 'out'), 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const sourceCase = (await loadEvaluationCorpus(corpusRoot)).cases.find(
      (item) => item.id === 'simple-edit-heading',
    )!;
    const result = await evaluateCaseFinalState(
      {
        ...sourceCase,
        verifiers: [
          {
            id: 'outside-result',
            kind: 'file',
            required: true,
            path: 'out/result.txt',
            assertion: 'utf8-equals',
            expectedText: 'expected',
          },
        ],
      },
      workspace,
    );
    expect(result).toMatchObject({
      status: 'failure',
      verifiers: [
        expect.objectContaining({
          id: 'outside-result',
          detail: expect.stringMatching(/symlink|escape/),
        }),
      ],
    });
  });

  it('requires non-empty evidence containers and promotion gates in the report schema', async () => {
    const schema = JSON.parse(await readFile(join(corpusRoot, 'report-schema.json'), 'utf8')) as {
      properties: Record<string, { minItems?: number; $ref?: string }>;
      $defs: Record<string, { additionalProperties?: boolean; required?: string[] }>;
      allOf: Array<{ then?: { properties?: Record<string, unknown> } }>;
    };
    expect(schema.properties.attempts.minItems).toBe(1);
    expect(schema.properties.slices.minItems).toBe(1);
    expect(schema.$defs.noiseFloor.required).toEqual(
      expect.arrayContaining(['sampleCount', 'successRate', 'minimumDetectableSuccessRateDelta']),
    );
    expect(schema.$defs.promotionChecks.required).toEqual(
      expect.arrayContaining(['comparisonEligible', 'localHeldOutPassed', 'effectAboveNoiseFloor']),
    );
    expect(schema.$defs.attempt.additionalProperties).toBe(false);
    expect(schema.$defs.slice.additionalProperties).toBe(false);
    const promotionRule = schema.allOf.find((rule) => Boolean(rule.then?.properties?.noiseFloor));
    expect(promotionRule).toBeDefined();
    expect(promotionRule?.then?.properties?.attempts).toMatchObject({ minItems: 6 });
  });

  it('keeps corpus prompts free of private session data', async () => {
    const corpus = await loadEvaluationCorpus(corpusRoot);
    const manifest = await readFile(join(corpusRoot, 'manifest.json'), 'utf8');
    expect(manifest).not.toContain('session transcript');
    expect(corpus.cases.every((item) => !item.prompt.includes('I:\\'))).toBe(true);
  });
});
