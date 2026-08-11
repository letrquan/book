import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HarnessEvaluationCaseSchema,
  HarnessEvaluationVerifierSchema,
  canonicalJson,
  evaluateCaseFinalState,
  evaluateContractComparison,
  fingerprintEvaluationFixture,
  loadEvaluationCorpus,
  materializeEvaluationFixture,
  summarizeEvaluationNoiseFloor,
  type EvaluationComparisonIdentity,
} from './contract.js';

const temporaryDirectories: string[] = [];
const corpusRoot = resolve('evals/harness');
const verifierReleaseDigest =
  'sha256:a8735dca1237275076f604f23b5a300c025781d29a6eec0b4197c7ef0f5b002d';

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
  it('loads the content-addressed public corpus as calibration-only', async () => {
    const corpus = await loadEvaluationCorpus(corpusRoot);
    expect(corpus).toMatchObject({ designClass: 'calibration', promotionAuthority: 'none' });
    expect(corpus.manifest).toMatchObject({
      schemaVersion: 2,
      corpusVersion: 'calibration-public-v1',
      reportSchemaVersion: 2,
      splitRole: 'calibration-public',
      confirmatoryStatus: 'not-instantiated',
      statistics: {
        minimumControlRunsForNoiseFloor: 5,
        minimumMatchedAaBlocksForSizing: 20,
        minimumHeldOutFamiliesForPromotion: 20,
        minimumRepetitionsPerFamilyForPromotion: 5,
      },
    });
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
    expect(
      corpus.cases.every(
        (item) =>
          item.designClass === 'calibration' &&
          item.claimAuthority === 'none' &&
          item.trial.evidencePurpose === 'calibration-smoke-only' &&
          item.fixture.files.length > 0,
      ),
    ).toBe(true);
    expect(corpus.cases.some((item) => item.eligibility === 'blocked-tier-c')).toBe(true);
  });

  it('rejects unknown fields recursively and every executable verifier shape', async () => {
    const corpus = await loadEvaluationCorpus(corpusRoot);
    const source = corpus.cases[0];
    expect(() =>
      HarnessEvaluationCaseSchema.parse({
        ...source,
        budgets: { ...source.budgets, unexpected: true },
      }),
    ).toThrow();
    expect(() =>
      HarnessEvaluationVerifierSchema.parse({
        id: 'project-test',
        kind: 'command',
        required: true,
        command: { argv: ['npm', 'test'] },
      }),
    ).toThrow();
    expect(
      HarnessEvaluationCaseSchema.safeParse({
        ...source,
        verifiers: [source.verifiers[0], source.verifiers[0]],
      }).success,
    ).toBe(false);
    expect(
      HarnessEvaluationVerifierSchema.safeParse({
        id: 'ambiguous-file-check',
        kind: 'file',
        outcomeClass: 'machine-verifiable',
        authority: 'primary',
        verifierReleaseDigest,
        required: true,
        path: 'result.txt',
        assertion: 'exists',
        expectedText: 'must-not-be-ignored',
      }).success,
    ).toBe(false);
    expect(
      HarnessEvaluationVerifierSchema.safeParse({
        id: 'contradictory-diff',
        kind: 'diff',
        outcomeClass: 'machine-verifiable',
        authority: 'guardrail',
        verifierReleaseDigest,
        required: true,
        expectedChangedPaths: ['src/a.ts'],
        forbiddenChangedPaths: ['src/a.ts'],
      }).success,
    ).toBe(false);
  });

  it('uses deterministic RFC 8785-compatible JSON identity and rejects non-I-JSON values', () => {
    expect(canonicalJson({ z: 1, a: -0, nested: { b: true, a: null } })).toBe(
      '{"a":0,"nested":{"a":null,"b":true},"z":1}',
    );
    expect(
      canonicalJson({ numbers: [Number('333333333.33333329'), 1e30, 4.5, 0.002, 1e-27] }),
    ).toBe('{"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27]}');
    expect(() => canonicalJson({ missing: undefined })).toThrow('cannot encode undefined');
    expect(() => canonicalJson(Number.NaN)).toThrow('finite I-JSON');
    const accessor = {} as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 });
    expect(() => canonicalJson(accessor)).toThrow('data properties');
    const symbolKeyed = { value: 1 } as Record<PropertyKey, unknown>;
    symbolKeyed[Symbol('hidden')] = 2;
    expect(() => canonicalJson(symbolKeyed)).toThrow('data properties');
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

  it('keeps optional failures and missing diff evidence visible', async () => {
    const corpus = await loadEvaluationCorpus(corpusRoot);
    const readOnly = corpus.cases.find((item) => item.id === 'read-only-inventory')!;
    const workspace = await temporaryDirectory('book-harness-optional-');
    await writeFile(join(workspace, 'inventory.txt'), 'README.md\nsrc/value.ts\n', 'utf8');
    await writeFile(join(workspace, 'notes.txt'), 'unexpected', 'utf8');
    await expect(evaluateCaseFinalState(readOnly, workspace)).resolves.toMatchObject({
      status: 'partial',
      verifiers: expect.arrayContaining([
        expect.objectContaining({ id: 'no-extra-notes', status: 'failed', required: false }),
      ]),
    });

    const multiFile = corpus.cases.find((item) => item.id === 'multi-file-rename')!;
    const multiWorkspace = await temporaryDirectory('book-harness-diff-');
    await writeFile(join(multiWorkspace, 'placeholder'), 'keeps-root-present');
    const result = await evaluateCaseFinalState(multiFile, multiWorkspace);
    expect(result.verifiers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'changed-path-boundary',
          status: 'unknown',
          detail: 'changed-path-evidence-missing',
        }),
      ]),
    );
    expect(result.status).toBe('failure');
  });

  it('requires an immutable post-worker snapshot for confirmatory verifier authority', async () => {
    const corpus = await loadEvaluationCorpus(corpusRoot);
    const evaluationCase = corpus.cases.find((item) => item.id === 'simple-edit-heading')!;
    const workspace = await temporaryDirectory('book-harness-snapshot-');
    await writeFile(join(workspace, 'README.md'), '# Clear Title\n\nA small fixture.\n');
    await expect(
      evaluateCaseFinalState(evaluationCase, workspace, { verificationMode: 'confirmatory' }),
    ).resolves.toMatchObject({
      status: 'unknown',
      verifiers: [
        expect.objectContaining({
          status: 'unknown',
          detail: 'immutable-post-worker-snapshot-attestation-missing-or-invalid',
        }),
      ],
    });
  });

  it('invalidates comparisons when a locked identity differs but permits treatment digests', () => {
    const identity: EvaluationComparisonIdentity = {
      armId: 'a-base',
      corpusVersion: 'phase0-confirmatory-v1',
      splitRole: 'promotion-sealed',
      splitVersion: 'sealed-v1',
      splitDigest: 'split',
      evaluatorVersion: 'phase0-contract-v2',
      evaluatorReleaseDigest: 'evaluator',
      verifierReleaseDigest: 'verifier',
      workerRegistrationDigest: 'worker',
      brokerDigest: 'broker',
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
      compatibilityCellDigest: 'cell',
      treatmentDigest: 'baseline-workflow',
    };
    expect(
      evaluateContractComparison([
        identity,
        { ...identity, armId: 'b-fixed', treatmentDigest: 'candidate-workflow' },
      ]),
    ).toEqual({ eligible: true, reasons: [] });
    expect(
      evaluateContractComparison([
        identity,
        { ...identity, armId: 'b-fixed', resolvedModel: 'different', splitDigest: 'different' },
      ]),
    ).toMatchObject({
      eligible: false,
      reasons: expect.arrayContaining([
        'comparison_resolvedModel_mismatch',
        'comparison_splitDigest_mismatch',
      ]),
    });
  });

  it('separates five-run smoke calibration from twenty-block confirmatory sizing', () => {
    const observations = Array.from({ length: 19 }, () => ({ status: 'success' as const }));
    expect(summarizeEvaluationNoiseFloor(observations.slice(0, 5))).toMatchObject({
      sufficient: true,
      designClass: 'calibration',
      promotionEligible: false,
      requiredMatchedAaBlocks: 5,
    });
    expect(
      summarizeEvaluationNoiseFloor(observations, { designClass: 'confirmatory-sizing' }),
    ).toMatchObject({
      sufficient: false,
      designClass: 'confirmatory-sizing',
      promotionEligible: false,
      requiredMatchedAaBlocks: 20,
    });
    expect(
      summarizeEvaluationNoiseFloor([...observations, { status: 'unknown' }], {
        designClass: 'confirmatory-sizing',
      }),
    ).toMatchObject({ sufficient: true, sampleCount: 20, unknownRate: 0.05 });
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
    const linkedCorpusRoot = await temporaryDirectory('book-harness-corpus-link-');
    const outside = await temporaryDirectory('book-harness-outside-fixture-');
    await writeFile(join(outside, 'result.txt'), 'outside', 'utf8');
    const linkedSource = join(linkedCorpusRoot, 'linked-fixture');
    try {
      await symlink(outside, linkedSource, 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const sourceCase = (await loadEvaluationCorpus(corpusRoot)).cases.find(
      (item) => item.id === 'simple-edit-heading',
    )!;
    await expect(
      materializeEvaluationFixture(
        {
          root: linkedCorpusRoot,
          manifest: {} as never,
          cases: [],
          designClass: 'calibration',
          promotionAuthority: 'none',
        },
        { ...sourceCase, fixture: { ...sourceCase.fixture, source: 'linked-fixture' } },
        join(linkedCorpusRoot, 'destination'),
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
            outcomeClass: 'machine-verifiable',
            authority: 'primary',
            verifierReleaseDigest,
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

  it('makes promotion structurally unavailable to calibration reports', async () => {
    const raw = await readFile(join(corpusRoot, 'report-schema.json'), 'utf8');
    const schema = JSON.parse(raw) as {
      $id: string;
      oneOf: Array<{ $ref: string }>;
      $defs: Record<string, Record<string, unknown>>;
    };
    expect(schema.$id).toBe('book-harness-report-v2');
    expect(schema.oneOf).toHaveLength(2);
    expect(schema.$defs.calibrationReport).toMatchObject({
      additionalProperties: false,
      properties: {
        designClass: { const: 'calibration' },
        claimAuthority: { const: 'none' },
        disposition: { const: 'calibration-only' },
      },
    });
    expect(schema.$defs.confirmatoryDesign).toMatchObject({
      properties: {
        plannedIndependentFamilies: { type: 'integer', minimum: 20 },
        plannedRepetitionsPerFamily: { type: 'integer', minimum: 5 },
        plannedPower: { type: 'number', minimum: 0.8, maximum: 1 },
        familyWiseAlpha: { const: 0.05 },
        multiplicity: { const: 'holm' },
      },
    });
    expect(schema.$defs.confirmatoryReport).toMatchObject({
      required: expect.arrayContaining([
        'infrastructure',
        'aaEvidence',
        'multiplicity',
        'executionDiagnostics',
        'attestations',
        'approval',
        'revalidationTriggers',
      ]),
    });
    expect(schema.$defs.armOutcomes).toMatchObject({
      required: expect.arrayContaining([
        'role',
        'initialFixtureLedgerDigest',
        'finalSnapshotLedgerDigest',
        'rawOutcomeLedgerDigest',
      ]),
    });
    expect(schema.$defs.gate).toMatchObject({
      properties: {
        plannedPower: { type: 'number', minimum: 0, maximum: 1 },
        achievedPower: { type: 'number', minimum: 0, maximum: 1 },
        adjustedAlpha: { type: 'number', exclusiveMinimum: 0, maximum: 0.05 },
      },
    });
    expect(raw).not.toContain('"command"');
  });

  it('keeps corpus prompts free of private session data', async () => {
    const corpus = await loadEvaluationCorpus(corpusRoot);
    const manifest = await readFile(join(corpusRoot, 'manifest.json'), 'utf8');
    expect(manifest).not.toContain('session transcript');
    expect(corpus.cases.every((item) => !item.prompt.includes('I:\\'))).toBe(true);
  });
});
