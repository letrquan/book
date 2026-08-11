import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  SAFE_ID_PATTERN,
  SHA256_PATTERN,
  SafeEvaluationIdSchema,
  Sha256DigestSchema,
  canonicalJson,
  evaluationDigest,
} from './identity.js';
import { Phase0EvaluationReportSchema } from './report.js';
import {
  HumanRubricArtifactSchema,
  evaluateHumanRubric,
  type HumanRubricDecision,
  type HumanRubricEvaluationInput,
} from './review.js';

export { canonicalJson, evaluationDigest } from './identity.js';
export { evaluateHumanRubric } from './review.js';
export type {
  HumanRubricDecision,
  HumanRubricEvaluationInput,
  HumanRubricReviewRecord,
} from './review.js';

const strictStringRecord = z.record(z.string(), z.string());
const MAX_FIXTURE_FILES = 1_000;
const MAX_FIXTURE_ENTRIES = 2_000;
const MAX_FIXTURE_BYTES = 10 * 1024 * 1024;
const MAX_FIXTURE_DEPTH = 32;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

const FileVerifierSchema = z
  .object({
    id: SafeEvaluationIdSchema,
    kind: z.literal('file'),
    outcomeClass: z.literal('machine-verifiable'),
    authority: z.enum(['primary', 'guardrail']),
    verifierReleaseDigest: Sha256DigestSchema,
    required: z.boolean(),
    path: z.string().min(1),
    assertion: z.enum(['exists', 'absent', 'sha256', 'utf8-equals']),
    expectedDigest: Sha256DigestSchema.optional(),
    expectedText: z.string().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.assertion === 'sha256' && !value.expectedDigest) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'sha256 requires expectedDigest' });
    }
    if (value.assertion === 'utf8-equals' && value.expectedText === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'utf8-equals requires expectedText',
      });
    }
    if (value.assertion !== 'sha256' && value.expectedDigest !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'expectedDigest is permitted only for a sha256 assertion',
      });
    }
    if (value.assertion !== 'utf8-equals' && value.expectedText !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'expectedText is permitted only for a utf8-equals assertion',
      });
    }
  });

const DiffVerifierSchema = z
  .object({
    id: SafeEvaluationIdSchema,
    kind: z.literal('diff'),
    outcomeClass: z.literal('machine-verifiable'),
    authority: z.literal('guardrail'),
    verifierReleaseDigest: Sha256DigestSchema,
    required: z.boolean(),
    expectedChangedPaths: z.array(z.string().min(1)),
    forbiddenChangedPaths: z.array(z.string().min(1)),
  })
  .strict()
  .superRefine((value, context) => {
    const expected = new Set(value.expectedChangedPaths);
    const forbidden = new Set(value.forbiddenChangedPaths);
    if (expected.size !== value.expectedChangedPaths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Expected changed paths must differ.',
      });
    }
    if (forbidden.size !== value.forbiddenChangedPaths.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Forbidden changed paths must differ.',
      });
    }
    if ([...expected].some((path) => forbidden.has(path))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A changed path cannot be both required and forbidden.',
      });
    }
  });

const HumanRubricVerifierSchema = z
  .object({
    id: SafeEvaluationIdSchema,
    kind: z.literal('human-rubric'),
    outcomeClass: z.literal('human-rubric'),
    authority: z.enum(['calibration-only', 'confirmatory-eligible']),
    required: z.boolean(),
    rubricId: SafeEvaluationIdSchema,
    rubricVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    rubricDigest: Sha256DigestSchema,
    reviewProtocol: z.literal('phase0-human-v1'),
  })
  .strict();

const ObservationalVerifierSchema = z
  .object({
    id: SafeEvaluationIdSchema,
    kind: z.literal('observational'),
    outcomeClass: z.literal('observational'),
    authority: z.literal('none'),
    required: z.literal(false),
    evidenceId: SafeEvaluationIdSchema,
  })
  .strict();

export const HarnessEvaluationVerifierSchema = z.union([
  FileVerifierSchema,
  DiffVerifierSchema,
  HumanRubricVerifierSchema,
  ObservationalVerifierSchema,
]);

const MetricPolicySchema = z
  .object({
    primary: z.string().min(1),
    guardrails: z.array(z.string().min(1)).min(1),
    minimumAttemptsPerArm: z.literal(3),
    minimumDetectableEffect: z.string().min(1),
    maximumCostIncreaseRatio: z.number().min(0),
    maximumLatencyIncreaseRatio: z.number().min(0),
    nonInferiorityMargins: strictStringRecord,
  })
  .strict();

const FixtureFileSchema = z
  .object({
    path: z.string().min(1),
    type: z.literal('regular'),
    bytes: z.number().int().nonnegative(),
    digest: Sha256DigestSchema,
    modeClass: z.literal('data'),
  })
  .strict();

export const HarnessEvaluationCaseSchema = z
  .object({
    schemaVersion: z.literal(2),
    corpusVersion: z.string().min(1),
    evaluatorVersion: z.string().min(1),
    id: z.string().regex(SAFE_ID_PATTERN),
    taskClass: z.enum([
      'read-only',
      'simple-edit',
      'bug-fix',
      'multi-file',
      'review',
      'research',
      'long-horizon',
    ]),
    evidenceKind: z.enum(['machine-verifiable', 'human-rubric', 'observational']),
    eligibility: z.enum(['blocked-tier-c', 'calibration-diagnostic', 'offline-calibration']),
    designClass: z.literal('calibration'),
    claimAuthority: z.literal('none'),
    splitRole: z.literal('calibration-public'),
    splitVersion: z.string().min(1),
    splitDigest: Sha256DigestSchema,
    caseFamilyId: SafeEvaluationIdSchema,
    projectFamilyId: SafeEvaluationIdSchema,
    generatorFamilyId: SafeEvaluationIdSchema,
    relationshipGroupId: SafeEvaluationIdSchema,
    prompt: z.string().min(1),
    trial: z
      .object({
        experimentalUnit: z.literal('root-request'),
        clusterKey: z.string().min(1),
        isolation: z.literal('fresh-materialization'),
        attemptsPerArm: z.literal(3),
        evidencePurpose: z.literal('calibration-smoke-only'),
        paired: z.literal(true),
        sameSeedAcrossArms: z.literal(true),
      })
      .strict(),
    fixture: z
      .object({
        source: z.string().min(1),
        revision: z.string().min(1),
        treeDigest: z.string().regex(SHA256_PATTERN),
        reset: z.literal('rematerialize'),
        ownership: z.literal('evaluator'),
        files: z.array(FixtureFileSchema).min(1),
      })
      .strict(),
    modelSliceIds: z.array(z.string().regex(SAFE_ID_PATTERN)).min(1),
    compatibility: z
      .object({
        runtimeProfile: z.string().min(1),
        environmentProfile: z.string().min(1),
        toolSurfaceProfile: z.string().min(1),
        policyProfile: z.string().min(1),
        agentsMode: z.literal('off'),
      })
      .strict(),
    risk: z.enum(['low', 'medium', 'high']),
    allowedTools: z.array(z.string().min(1)),
    expectedArtifacts: z.array(z.string().min(1)),
    verifiers: z.array(HarnessEvaluationVerifierSchema).min(1),
    budgets: z
      .object({
        maxTurns: z.number().int().positive(),
        maxTokens: z.number().int().positive(),
        maxCostUsd: z.number().positive(),
        timeoutMs: z.number().int().positive(),
      })
      .strict(),
    metrics: MetricPolicySchema,
    tags: z.array(z.string().regex(SAFE_ID_PATTERN)).min(1),
    knownUnknowns: z.array(z.string()),
  })
  .strict()
  .superRefine((evaluationCase, context) => {
    const unique = (values: readonly string[], label: string) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must differ.` });
      }
    };
    unique(
      evaluationCase.fixture.files.map((file) => file.path),
      'Fixture file paths',
    );
    unique(
      evaluationCase.verifiers.map((verifier) => verifier.id),
      'Verifier IDs',
    );
    unique(evaluationCase.modelSliceIds, 'Model-slice IDs');
    unique(evaluationCase.allowedTools, 'Allowed tools');
    unique(evaluationCase.expectedArtifacts, 'Expected artifacts');
    unique(evaluationCase.tags, 'Case tags');
  });

export const HarnessEvaluationManifestSchema = z
  .object({
    schemaVersion: z.literal(2),
    corpusVersion: z.string().min(1),
    evaluatorVersion: z.string().min(1),
    scope: z.literal('trusted-built-in-non-adversarial'),
    reportSchemaVersion: z.literal(2),
    designClass: z.literal('calibration'),
    claimAuthority: z.literal('none'),
    splitRole: z.literal('calibration-public'),
    splitVersion: z.string().min(1),
    splitDigest: Sha256DigestSchema,
    corpusDigest: Sha256DigestSchema,
    evaluatorRelease: z
      .object({
        version: z.string().min(1),
        artifactDigest: Sha256DigestSchema,
        provenanceDigest: Sha256DigestSchema,
        status: z.enum(['unpackaged-calibration-source', 'packaged-signed']),
      })
      .strict(),
    confirmatoryStatus: z.literal('not-instantiated'),
    rubricArtifacts: z
      .array(
        z
          .object({
            rubricId: SafeEvaluationIdSchema,
            rubricVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
            file: z.string().min(1),
            digest: Sha256DigestSchema,
            authority: z.enum(['calibration-only', 'confirmatory-eligible', 'observational']),
          })
          .strict(),
      )
      .min(2),
    caseFiles: z.array(z.string().min(1)).min(1),
    arms: z
      .array(
        z
          .object({
            id: z.enum(['A/base', 'B/fixed', 'C/adaptive-shadow', 'D/candidate']),
            availability: z.enum(['current', 'future']),
            description: z.string().min(1),
          })
          .strict(),
      )
      .length(4),
    routingArms: z.array(z.string().min(1)).min(4),
    modelSlices: z
      .array(
        z
          .object({
            id: z.string().regex(SAFE_ID_PATTERN),
            provider: z.string().min(1),
            requestedModel: z.string().min(1),
            resolvedIdentity: z.literal('response-required'),
          })
          .strict(),
      )
      .min(1),
    statistics: z
      .object({
        assignment: z.literal('paired-randomized-order'),
        experimentalUnit: z.literal('root-request'),
        clusterUnit: z.literal('case-project-session'),
        alpha: z.number().positive().max(0.1),
        power: z.number().min(0.7).max(0.99),
        multiplicity: z.literal('holm-primary-family-guardrails-non-inferiority'),
        unknownPolicy: z.literal('retain-in-denominator-and-report-by-arm'),
        tieBreak: z.literal('simpler-workflow'),
        minimumControlRunsForNoiseFloor: z.literal(5),
        minimumMatchedAaBlocksForSizing: z.number().int().min(20),
        minimumHeldOutFamiliesForPromotion: z.number().int().min(20),
        minimumRepetitionsPerFamilyForPromotion: z.number().int().min(5),
        evidenceClass: z.literal('calibration'),
      })
      .strict(),
    trustBoundary: z
      .object({
        projectCommands: z.literal('blocked'),
        adversarialFixtures: z.literal('blocked'),
        network: z.literal('off'),
        credentials: z.literal('forbidden'),
        symlinks: z.literal('forbidden'),
        commandVerifiers: z.literal('blocked'),
        workerExecution: z.enum(['unavailable', 'attested-only']),
        providerBroker: z.enum(['unavailable', 'required']),
      })
      .strict(),
    compatibilityFields: z.array(SafeEvaluationIdSchema).min(8),
  })
  .strict()
  .superRefine((manifest, context) => {
    const unique = (values: readonly string[], label: string) => {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must differ.` });
      }
    };
    unique(
      manifest.rubricArtifacts.map((rubric) => rubric.rubricId),
      'Rubric artifact IDs',
    );
    unique(manifest.caseFiles, 'Case files');
    unique(
      manifest.arms.map((arm) => arm.id),
      'Arm IDs',
    );
    unique(manifest.routingArms, 'Routing arms');
    unique(
      manifest.modelSlices.map((slice) => slice.id),
      'Model-slice IDs',
    );
    unique(manifest.compatibilityFields, 'Compatibility fields');
  });

export type HarnessEvaluationCase = z.infer<typeof HarnessEvaluationCaseSchema>;
export type HarnessEvaluationManifest = z.infer<typeof HarnessEvaluationManifestSchema>;
export type HarnessEvaluationVerifier = z.infer<typeof HarnessEvaluationVerifierSchema>;

export interface HarnessEvaluationCorpus {
  root: string;
  manifest: HarnessEvaluationManifest;
  cases: HarnessEvaluationCase[];
  designClass: 'calibration';
  promotionAuthority: 'none';
}

export interface EvaluationVerifierResult {
  id: string;
  kind: HarnessEvaluationVerifier['kind'];
  required: boolean;
  status: 'passed' | 'failed' | 'unknown';
  detail: string;
}

export interface EvaluationFinalStateResult {
  status: 'success' | 'failure' | 'partial' | 'unknown';
  verifiers: EvaluationVerifierResult[];
}

export interface EvaluationFinalStateContext {
  changedPaths?: readonly string[];
  rubricReviews?: Readonly<Record<string, HumanRubricEvaluationInput>>;
  verificationMode?: 'calibration' | 'confirmatory';
  snapshot?: {
    finalStateDigest: string;
    readOnly: boolean;
    workerStopped: boolean;
    descendantsStopped: boolean;
  };
}

export interface EvaluationComparisonIdentity {
  armId: string;
  corpusVersion: string;
  splitRole?: string;
  splitVersion?: string;
  splitDigest?: string;
  evaluatorVersion: string;
  evaluatorReleaseDigest?: string;
  verifierReleaseDigest?: string;
  workerRegistrationDigest?: string;
  brokerDigest?: string;
  fixtureRevision: string;
  fixtureDigest: string;
  provider: string;
  requestedModel: string;
  resolvedModel: string;
  modelConfigDigest: string;
  runtimeFingerprint: string;
  environmentFingerprint: string;
  toolSurfaceFingerprint: string;
  policyFingerprint: string;
  budgetFingerprint: string;
  pricingVersion: string;
  evaluationDate: string;
  randomSeed: string;
  compatibilityCellDigest?: string;
  treatmentDigest?: string;
}

export interface EvaluationContractComparison {
  eligible: boolean;
  reasons: string[];
}

export interface EvaluationNoiseObservation {
  status: 'success' | 'failure' | 'unknown' | 'setup-failure';
  latencyMs?: number;
}

export interface EvaluationNoiseFloor {
  sampleCount: number;
  sufficient: boolean;
  designClass: 'calibration' | 'confirmatory-sizing';
  promotionEligible: false;
  successRate: number;
  unknownRate: number;
  setupFailureRate: number;
  meanLatencyMs?: number;
  latencyStdDevMs?: number;
  minimumDetectableSuccessRateDelta: number;
  requiredMatchedAaBlocks: number;
}

function assertRelativePath(path: string, label: string): void {
  const segments = path.split(/[\\/]+/);
  if (
    !path ||
    isAbsolute(path) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`${label} must stay within the evaluation corpus.`);
  }
  for (const segment of segments) {
    if (
      segment !== segment.normalize('NFC') ||
      segment.toLowerCase() === '.git' ||
      segment.includes(':') ||
      segment.includes('\0') ||
      segment.endsWith('.') ||
      segment.endsWith(' ') ||
      WINDOWS_RESERVED_NAME.test(segment)
    ) {
      throw new Error(`${label} contains a forbidden portable path segment: ${segment}.`);
    }
  }
}

function resolveWithin(root: string, path: string, label: string): string {
  assertRelativePath(path, label);
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, path);
  const relativePath = relative(absoluteRoot, target);
  if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) {
    throw new Error(`${label} escapes the evaluation corpus.`);
  }
  return target;
}

function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
  );
}

interface ConstrainedPathInspection {
  path: string;
  exists: boolean;
  unsafeReason?: string;
}

async function inspectConstrainedPath(
  root: string,
  relativePath: string,
  label: string,
): Promise<ConstrainedPathInspection> {
  const absoluteRoot = resolve(root);
  const target = resolveWithin(absoluteRoot, relativePath, label);
  const rootMetadata = await lstat(absoluteRoot);
  if (rootMetadata.isSymbolicLink()) {
    return { path: target, exists: true, unsafeReason: 'root-symlink-forbidden' };
  }
  if (!rootMetadata.isDirectory()) {
    return { path: target, exists: true, unsafeReason: 'root-not-directory' };
  }
  const canonicalRoot = await realpath(absoluteRoot);
  const segments = relative(absoluteRoot, target).split(sep).filter(Boolean);
  let current = absoluteRoot;
  for (const [index, segment] of segments.entries()) {
    current = resolve(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { path: target, exists: false };
      }
      throw error;
    }
    if (metadata.isSymbolicLink()) {
      return {
        path: target,
        exists: true,
        unsafeReason:
          index === segments.length - 1 ? 'symlink-forbidden' : 'symlink-ancestor-forbidden',
      };
    }
    const canonicalCurrent = await realpath(current);
    if (!isPathInside(canonicalRoot, canonicalCurrent)) {
      return { path: target, exists: true, unsafeReason: 'canonical-path-escape' };
    }
  }
  return { path: target, exists: true };
}

async function assertConstrainedDirectory(
  root: string,
  relativePath: string,
  label: string,
): Promise<string> {
  const inspection = await inspectConstrainedPath(root, relativePath, label);
  if (!inspection.exists) throw new Error(`${label} does not exist.`);
  if (inspection.unsafeReason) {
    throw new Error(`${label} is unsafe: ${inspection.unsafeReason}.`);
  }
  const metadata = await lstat(inspection.path);
  if (!metadata.isDirectory()) throw new Error(`${label} must be a directory.`);
  return inspection.path;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function readConstrainedJson(root: string, path: string, label: string): Promise<unknown> {
  const inspection = await inspectConstrainedPath(root, path, label);
  if (!inspection.exists) throw new Error(`${label} does not exist.`);
  if (inspection.unsafeReason) throw new Error(`${label} is unsafe: ${inspection.unsafeReason}.`);
  const metadata = await lstat(inspection.path);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file.`);
  return readJson(inspection.path);
}

/** Load the Phase 0 corpus and reject stale versions, duplicates, and unknown fields. */
export async function loadEvaluationCorpus(root: string): Promise<HarnessEvaluationCorpus> {
  const absoluteRoot = resolve(root);
  const manifest = HarnessEvaluationManifestSchema.parse(
    await readConstrainedJson(absoluteRoot, 'manifest.json', 'Manifest path'),
  );
  const cases: HarnessEvaluationCase[] = [];
  const ids = new Set<string>();
  const modelSliceIds = new Set(manifest.modelSlices.map((slice) => slice.id));
  const rubrics = new Map<
    string,
    {
      reference: HarnessEvaluationManifest['rubricArtifacts'][number];
      artifact: z.infer<typeof HumanRubricArtifactSchema>;
    }
  >();
  for (const rubricReference of manifest.rubricArtifacts) {
    assertRelativePath(rubricReference.file, `Rubric path ${rubricReference.rubricId}`);
    const rubric = HumanRubricArtifactSchema.parse(
      await readConstrainedJson(
        absoluteRoot,
        rubricReference.file,
        `Rubric path ${rubricReference.rubricId}`,
      ),
    );
    if (
      rubric.rubricId !== rubricReference.rubricId ||
      rubric.rubricVersion !== rubricReference.rubricVersion ||
      rubric.authority !== rubricReference.authority ||
      rubric.evaluatorReleaseDigest !== manifest.evaluatorRelease.artifactDigest ||
      evaluationDigest(rubric) !== rubricReference.digest
    ) {
      throw new Error(`Rubric ${rubricReference.rubricId} identity does not match its manifest.`);
    }
    if (rubrics.has(rubric.rubricId)) {
      throw new Error(`Duplicate rubric artifact id: ${rubric.rubricId}`);
    }
    rubrics.set(rubric.rubricId, { reference: rubricReference, artifact: rubric });
  }

  for (const caseFile of manifest.caseFiles) {
    const parsed = HarnessEvaluationCaseSchema.parse(
      await readConstrainedJson(absoluteRoot, caseFile, `Case path ${caseFile}`),
    );
    if (parsed.corpusVersion !== manifest.corpusVersion) {
      throw new Error(`Case ${parsed.id} has a stale corpus version.`);
    }
    if (parsed.evaluatorVersion !== manifest.evaluatorVersion) {
      throw new Error(`Case ${parsed.id} has a stale evaluator version.`);
    }
    if (parsed.designClass && parsed.designClass !== 'calibration') {
      throw new Error(`Case ${parsed.id} is not a calibration case.`);
    }
    if (parsed.claimAuthority && parsed.claimAuthority !== 'none') {
      throw new Error(`Case ${parsed.id} declares promotion authority.`);
    }
    if (ids.has(parsed.id)) throw new Error(`Duplicate evaluation case id: ${parsed.id}`);
    ids.add(parsed.id);
    for (const modelSliceId of parsed.modelSliceIds) {
      if (!modelSliceIds.has(modelSliceId)) {
        throw new Error(`Case ${parsed.id} references unknown model slice ${modelSliceId}.`);
      }
    }
    for (const expectedArtifact of parsed.expectedArtifacts) {
      assertRelativePath(expectedArtifact, `Expected artifact ${expectedArtifact}`);
    }
    const fixtureSource = await assertConstrainedDirectory(
      absoluteRoot,
      parsed.fixture.source,
      `Fixture source for ${parsed.id}`,
    );
    const fixtureInspection = await inspectEvaluationFixture(fixtureSource);
    if (fixtureInspection.treeDigest !== parsed.fixture.treeDigest) {
      throw new Error(`Case ${parsed.id} fixture digest does not match its source tree.`);
    }
    if (parsed.fixture.files) {
      const expectedPaths = new Set(parsed.fixture.files.map((file) => file.path));
      if (expectedPaths.size !== parsed.fixture.files.length) {
        throw new Error(`Case ${parsed.id} declares duplicate fixture paths.`);
      }
      for (const file of parsed.fixture.files)
        assertRelativePath(file.path, `Fixture file ${file.path}`);
      if (canonicalJson(parsed.fixture.files) !== canonicalJson(fixtureInspection.files)) {
        throw new Error(`Case ${parsed.id} fixture file manifest does not match its source tree.`);
      }
    }
    for (const verifier of parsed.verifiers) {
      if ('path' in verifier) assertRelativePath(verifier.path, `Verifier path ${verifier.id}`);
      if ('expectedChangedPaths' in verifier) {
        for (const path of [...verifier.expectedChangedPaths, ...verifier.forbiddenChangedPaths]) {
          assertRelativePath(path, `Diff verifier path ${verifier.id}`);
        }
      }
      if (verifier.kind === 'human-rubric') {
        const rubric = rubrics.get(verifier.rubricId);
        if (
          !rubric ||
          rubric.reference.rubricVersion !== verifier.rubricVersion ||
          rubric.reference.digest !== verifier.rubricDigest ||
          rubric.reference.authority !== verifier.authority ||
          !rubric.artifact.eligibleSlice.taskClasses.includes(
            parsed.taskClass as 'review' | 'research',
          ) ||
          !rubric.artifact.eligibleSlice.projectRisks.includes(parsed.risk)
        ) {
          throw new Error(`Verifier ${verifier.id} references an unpinned rubric artifact.`);
        }
      }
    }
    cases.push(parsed);
  }

  if (manifest.designClass && manifest.designClass !== 'calibration') {
    throw new Error('The Phase 0 public corpus cannot declare confirmatory authority.');
  }
  if (manifest.claimAuthority && manifest.claimAuthority !== 'none') {
    throw new Error('The Phase 0 public corpus cannot declare claim authority.');
  }
  const corpusIdentity = cases.map((evaluationCase) => {
    return Object.fromEntries(
      Object.entries(evaluationCase).filter(([key]) => key !== 'splitDigest'),
    );
  });
  if (manifest.corpusDigest && evaluationDigest(corpusIdentity) !== manifest.corpusDigest) {
    throw new Error('Calibration corpus content digest does not match its cases.');
  }
  const splitMembership = cases.map((evaluationCase) => ({
    splitRole: evaluationCase.splitRole,
    caseFamilyId: evaluationCase.caseFamilyId,
    caseId: evaluationCase.id,
    projectFamilyId: evaluationCase.projectFamilyId,
    generatorFamilyId: evaluationCase.generatorFamilyId,
    relationshipGroupId: evaluationCase.relationshipGroupId,
    fixtureRevision: evaluationCase.fixture.revision,
    fixtureDigest: evaluationCase.fixture.treeDigest,
    outcomes: evaluationCase.verifiers.map((verifier) => ({
      id: verifier.id,
      kind: verifier.kind,
      outcomeClass: verifier.outcomeClass ?? evaluationCase.evidenceKind,
      authority: verifier.authority ?? 'legacy-calibration',
      verifierReleaseDigest:
        'verifierReleaseDigest' in verifier ? (verifier.verifierReleaseDigest ?? null) : null,
      rubricDigest: 'rubricDigest' in verifier ? (verifier.rubricDigest ?? null) : null,
    })),
  }));
  const splitDigest = evaluationDigest(splitMembership);
  if (manifest.splitDigest && splitDigest !== manifest.splitDigest) {
    throw new Error('Calibration split digest does not match its ordered membership.');
  }
  if (cases.some((evaluationCase) => evaluationCase.splitDigest !== manifest.splitDigest)) {
    throw new Error('Calibration cases do not pin the manifest split digest.');
  }
  return {
    root: absoluteRoot,
    manifest,
    cases,
    designClass: 'calibration',
    promotionAuthority: 'none',
  };
}

interface FixtureRecord {
  path: string;
  bytes: number;
  digest: string;
}

interface FixtureInspectionState {
  entryCount: number;
  fileCount: number;
  totalBytes: number;
  portablePaths: Set<string>;
}

async function collectFixtureFiles(
  root: string,
  directory: string,
  canonicalRoot: string,
  state: FixtureInspectionState,
  depth = 0,
): Promise<FixtureRecord[]> {
  if (depth > MAX_FIXTURE_DEPTH) {
    throw new Error(`Fixture exceeds the ${MAX_FIXTURE_DEPTH}-directory depth limit.`);
  }
  const files: FixtureRecord[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    state.entryCount += 1;
    if (state.entryCount > MAX_FIXTURE_ENTRIES) {
      throw new Error(`Fixture exceeds the ${MAX_FIXTURE_ENTRIES}-entry limit.`);
    }
    const path = resolve(directory, entry.name);
    const relativePath = relative(root, path).replaceAll('\\', '/');
    assertRelativePath(relativePath, 'Fixture path');
    const portablePath = relativePath.normalize('NFC').toLowerCase();
    if (state.portablePaths.has(portablePath)) {
      throw new Error(`Fixture path collides after case/Unicode normalization: ${relativePath}`);
    }
    state.portablePaths.add(portablePath);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`Fixture symlink is forbidden: ${path}`);
    const canonicalPath = await realpath(path);
    if (!isPathInside(canonicalRoot, canonicalPath)) {
      throw new Error(`Fixture path escapes its root: ${path}`);
    }
    if (metadata.isDirectory()) {
      const nestedFiles = await collectFixtureFiles(root, path, canonicalRoot, state, depth + 1);
      if (nestedFiles.length === 0)
        throw new Error(`Fixture empty directories are forbidden: ${path}`);
      files.push(...nestedFiles);
    } else if (metadata.isFile()) {
      if (metadata.nlink > 1) throw new Error(`Fixture hard links are forbidden: ${path}`);
      if ((metadata.mode & 0o111) !== 0)
        throw new Error(`Fixture executable files are forbidden: ${path}`);
      state.fileCount += 1;
      if (state.fileCount > MAX_FIXTURE_FILES) {
        throw new Error(`Fixture exceeds the ${MAX_FIXTURE_FILES}-file limit.`);
      }
      if (metadata.size > MAX_FIXTURE_BYTES - state.totalBytes) {
        throw new Error(`Fixture exceeds the ${MAX_FIXTURE_BYTES}-byte limit.`);
      }
      const contents = await readFile(path);
      if (contents.byteLength !== metadata.size)
        throw new Error(`Fixture changed while reading: ${path}`);
      state.totalBytes += contents.byteLength;
      files.push({
        path: relativePath,
        bytes: contents.byteLength,
        digest: createHash('sha256').update(contents).digest('hex'),
      });
    } else throw new Error(`Fixture contains unsupported entry: ${path}`);
  }
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/** Hash paths and contents so fixture reset can be verified across materializations. */
export async function inspectEvaluationFixture(root: string): Promise<{
  treeDigest: string;
  files: Array<{ path: string; type: 'regular'; bytes: number; digest: string; modeClass: 'data' }>;
}> {
  const absoluteRoot = resolve(root);
  const rootMetadata = await lstat(absoluteRoot);
  if (rootMetadata.isSymbolicLink()) {
    throw new Error(`Fixture root symlink is forbidden: ${absoluteRoot}`);
  }
  if (!rootMetadata.isDirectory())
    throw new Error(`Fixture root must be a directory: ${absoluteRoot}`);
  const canonicalRoot = await realpath(absoluteRoot);
  const records = await collectFixtureFiles(absoluteRoot, absoluteRoot, canonicalRoot, {
    entryCount: 0,
    fileCount: 0,
    totalBytes: 0,
    portablePaths: new Set(),
  });
  if (records.length === 0) throw new Error(`Fixture must contain at least one regular file.`);
  return {
    treeDigest: evaluationDigest(records),
    files: records.map((file) => ({
      path: file.path,
      type: 'regular',
      bytes: file.bytes,
      digest: `sha256:${file.digest}`,
      modeClass: 'data',
    })),
  };
}

/** Hash paths and contents so fixture reset can be verified across materializations. */
export async function fingerprintEvaluationFixture(root: string): Promise<string> {
  return (await inspectEvaluationFixture(root)).treeDigest;
}

async function copyFixtureTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = resolve(source, entry.name);
    const destinationPath = resolve(destination, entry.name);
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink()) throw new Error(`Fixture symlink is forbidden: ${sourcePath}`);
    if (metadata.isDirectory()) await copyFixtureTree(sourcePath, destinationPath);
    else if (metadata.isFile()) await copyFile(sourcePath, destinationPath);
    else throw new Error(`Fixture contains unsupported entry: ${sourcePath}`);
  }
}

export async function materializeEvaluationFixture(
  corpus: HarnessEvaluationCorpus,
  evaluationCase: HarnessEvaluationCase,
  destination: string,
): Promise<string> {
  const source = resolveWithin(
    corpus.root,
    evaluationCase.fixture.source,
    `Fixture source for ${evaluationCase.id}`,
  );
  await assertConstrainedDirectory(
    corpus.root,
    evaluationCase.fixture.source,
    `Fixture source for ${evaluationCase.id}`,
  );
  const sourceDigest = await fingerprintEvaluationFixture(source);
  if (sourceDigest !== evaluationCase.fixture.treeDigest) {
    throw new Error(
      `Fixture ${evaluationCase.id} digest mismatch: expected ${evaluationCase.fixture.treeDigest}, received ${sourceDigest}.`,
    );
  }
  const absoluteDestination = resolve(destination);
  try {
    const existing = await lstat(absoluteDestination);
    if (!existing.isDirectory() || (await readdir(absoluteDestination)).length > 0) {
      throw new Error(`Fixture destination must be an empty directory: ${absoluteDestination}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await copyFixtureTree(source, absoluteDestination);
  const materializedDigest = await fingerprintEvaluationFixture(destination);
  if (materializedDigest !== sourceDigest) {
    throw new Error(`Fixture ${evaluationCase.id} changed during materialization.`);
  }
  const sourceAfterCopyDigest = await fingerprintEvaluationFixture(source);
  if (sourceAfterCopyDigest !== sourceDigest) {
    throw new Error(`Fixture ${evaluationCase.id} source changed during materialization.`);
  }
  return materializedDigest;
}

async function evaluateVerifier(
  verifier: HarnessEvaluationVerifier,
  workspace: string,
  context: EvaluationFinalStateContext,
): Promise<EvaluationVerifierResult> {
  if (verifier.kind === 'observational') {
    return {
      id: verifier.id,
      kind: verifier.kind,
      required: verifier.required,
      status: 'unknown',
      detail: 'observational-evidence-has-no-decision-authority',
    };
  }
  if (verifier.kind === 'human-rubric') {
    const rubricInput = context.rubricReviews?.[verifier.rubricId];
    const decision: HumanRubricDecision | undefined = rubricInput
      ? evaluateHumanRubric(rubricInput)
      : undefined;
    return {
      id: verifier.id,
      kind: verifier.kind,
      required: verifier.required,
      status: decision?.status ?? 'unknown',
      detail: decision?.reason ?? 'human-review-packet-missing',
    };
  }
  if (verifier.kind === 'diff') {
    if (!context.changedPaths) {
      return {
        id: verifier.id,
        kind: verifier.kind,
        required: verifier.required,
        status: 'unknown',
        detail: 'changed-path-evidence-missing',
      };
    }
    const changed = new Set(context.changedPaths.map((path) => path.replaceAll('\\', '/')));
    const missing = verifier.expectedChangedPaths.filter((path) => !changed.has(path));
    const forbidden = verifier.forbiddenChangedPaths.filter((path) => changed.has(path));
    return {
      id: verifier.id,
      kind: verifier.kind,
      required: verifier.required,
      status: missing.length === 0 && forbidden.length === 0 ? 'passed' : 'failed',
      detail:
        missing.length === 0 && forbidden.length === 0
          ? 'changed-paths-match'
          : `missing:${missing.join(',') || '-'};forbidden:${forbidden.join(',') || '-'}`,
    };
  }

  const inspection = await inspectConstrainedPath(
    workspace,
    verifier.path,
    `Verifier path ${verifier.id}`,
  );
  if (inspection.unsafeReason) {
    return {
      id: verifier.id,
      kind: verifier.kind,
      required: verifier.required,
      status: 'failed',
      detail: inspection.unsafeReason,
    };
  }
  if (!inspection.exists) {
    return {
      id: verifier.id,
      kind: verifier.kind,
      required: verifier.required,
      status: verifier.assertion === 'absent' ? 'passed' : 'failed',
      detail: verifier.assertion === 'absent' ? 'path-absent' : 'path-missing',
    };
  }
  const path = inspection.path;
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) {
    return {
      id: verifier.id,
      kind: verifier.kind,
      required: verifier.required,
      status: 'failed',
      detail: 'symlink-forbidden',
    };
  }
  if (verifier.assertion === 'absent') {
    return {
      id: verifier.id,
      kind: verifier.kind,
      required: verifier.required,
      status: 'failed',
      detail: 'path-present',
    };
  }
  if (!metadata.isFile()) {
    return {
      id: verifier.id,
      kind: verifier.kind,
      required: verifier.required,
      status: 'failed',
      detail: 'path-not-regular-file',
    };
  }
  if (verifier.assertion === 'exists') {
    return {
      id: verifier.id,
      kind: verifier.kind,
      required: verifier.required,
      status: 'passed',
      detail: 'file-present',
    };
  }
  const contents = await readFile(path);
  const passed =
    verifier.assertion === 'sha256'
      ? `sha256:${createHash('sha256').update(contents).digest('hex')}` === verifier.expectedDigest
      : contents.toString('utf8') === verifier.expectedText;
  return {
    id: verifier.id,
    kind: verifier.kind,
    required: verifier.required,
    status: passed ? 'passed' : 'failed',
    detail: passed ? 'content-match' : 'content-mismatch',
  };
}

/** Grade final state without using the tested model's completion claim. */
export async function evaluateCaseFinalState(
  evaluationCase: HarnessEvaluationCase,
  workspace: string,
  context: EvaluationFinalStateContext = {},
): Promise<EvaluationFinalStateResult> {
  if (context.verificationMode === 'confirmatory') {
    const snapshot = context.snapshot;
    const snapshotValid =
      snapshot?.readOnly === true &&
      snapshot.workerStopped === true &&
      snapshot.descendantsStopped === true &&
      SHA256_PATTERN.test(snapshot.finalStateDigest) &&
      snapshot.finalStateDigest === (await fingerprintEvaluationFixture(workspace));
    if (!snapshotValid) {
      return {
        status: 'unknown',
        verifiers: evaluationCase.verifiers.map((verifier) => ({
          id: verifier.id,
          kind: verifier.kind,
          required: verifier.required,
          status: 'unknown',
          detail: 'immutable-post-worker-snapshot-attestation-missing-or-invalid',
        })),
      };
    }
  }
  const verifiers = await Promise.all(
    evaluationCase.verifiers.map((verifier) => evaluateVerifier(verifier, workspace, context)),
  );
  const required = verifiers.filter((verifier) => verifier.required);
  const optional = verifiers.filter((verifier) => !verifier.required);
  let status: EvaluationFinalStateResult['status'];
  if (required.some((verifier) => verifier.status === 'failed')) status = 'failure';
  else if (required.some((verifier) => verifier.status === 'unknown')) status = 'unknown';
  else if (optional.some((verifier) => verifier.status !== 'passed')) status = 'partial';
  else status = 'success';
  return { status, verifiers };
}

export function evaluateContractComparison(
  arms: readonly EvaluationComparisonIdentity[],
): EvaluationContractComparison {
  if (arms.length < 2) return { eligible: false, reasons: ['comparison_arms_missing'] };
  const reasons: string[] = [];
  const armIds = arms.map((arm) => arm.armId.trim());
  if (armIds.some((armId) => armId.length === 0)) reasons.push('comparison_arm_id_missing');
  if (new Set(armIds).size !== armIds.length) reasons.push('comparison_arm_id_duplicate');
  const fields: Array<keyof Omit<EvaluationComparisonIdentity, 'armId'>> = [
    'corpusVersion',
    'evaluatorVersion',
    'fixtureRevision',
    'fixtureDigest',
    'provider',
    'requestedModel',
    'resolvedModel',
    'modelConfigDigest',
    'runtimeFingerprint',
    'environmentFingerprint',
    'toolSurfaceFingerprint',
    'policyFingerprint',
    'budgetFingerprint',
    'pricingVersion',
    'evaluationDate',
    'randomSeed',
  ];
  for (const field of fields) {
    const values = arms.map((arm) => arm[field]);
    if (values.some((value) => !value)) reasons.push(`comparison_${field}_missing`);
    else if (values.some((value) => value !== values[0]))
      reasons.push(`comparison_${field}_mismatch`);
  }
  const releaseFields: Array<keyof Omit<EvaluationComparisonIdentity, 'armId'>> = [
    'splitRole',
    'splitVersion',
    'splitDigest',
    'evaluatorReleaseDigest',
    'verifierReleaseDigest',
    'workerRegistrationDigest',
    'brokerDigest',
    'compatibilityCellDigest',
  ];
  for (const field of releaseFields) {
    const values = arms.map((arm) => arm[field]);
    if (values.some((value) => value !== undefined)) {
      if (values.some((value) => !value)) reasons.push(`comparison_${field}_missing`);
      else if (values.some((value) => value !== values[0])) {
        reasons.push(`comparison_${field}_mismatch`);
      }
    }
  }
  return { eligible: reasons.length === 0, reasons };
}

export function summarizeEvaluationNoiseFloor(
  observations: readonly EvaluationNoiseObservation[],
  options:
    | number
    | {
        designClass?: 'calibration' | 'confirmatory-sizing';
        minimumMatchedAaBlocks?: number;
      } = {},
): EvaluationNoiseFloor {
  const designClass =
    typeof options === 'number' ? 'calibration' : (options.designClass ?? 'calibration');
  const requiredMatchedAaBlocks =
    typeof options === 'number'
      ? options
      : (options.minimumMatchedAaBlocks ?? (designClass === 'confirmatory-sizing' ? 20 : 5));
  if (
    !Number.isInteger(requiredMatchedAaBlocks) ||
    requiredMatchedAaBlocks < (designClass === 'confirmatory-sizing' ? 20 : 1)
  ) {
    throw new Error('Noise-floor matched-block requirement is below the frozen design minimum.');
  }
  const sampleCount = observations.length;
  const count = (status: EvaluationNoiseObservation['status']) =>
    observations.filter((observation) => observation.status === status).length;
  const successRate = sampleCount === 0 ? 0 : count('success') / sampleCount;
  const unknownRate = sampleCount === 0 ? 0 : count('unknown') / sampleCount;
  const setupFailureRate = sampleCount === 0 ? 0 : count('setup-failure') / sampleCount;
  const latencies = observations.flatMap((observation) =>
    observation.latencyMs === undefined ? [] : [observation.latencyMs],
  );
  const meanLatencyMs =
    latencies.length === 0
      ? undefined
      : latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length;
  const latencyStdDevMs =
    latencies.length < 2 || meanLatencyMs === undefined
      ? undefined
      : Math.sqrt(
          latencies.reduce((sum, latency) => sum + (latency - meanLatencyMs) ** 2, 0) /
            (latencies.length - 1),
        );
  const binomialNoise =
    sampleCount === 0 ? 1 : 2 * Math.sqrt((successRate * (1 - successRate)) / sampleCount);
  return {
    sampleCount,
    sufficient: sampleCount >= requiredMatchedAaBlocks,
    designClass,
    promotionEligible: false,
    successRate,
    unknownRate,
    setupFailureRate,
    meanLatencyMs,
    latencyStdDevMs,
    minimumDetectableSuccessRateDelta: Math.max(0.1, binomialNoise),
    requiredMatchedAaBlocks,
  };
}

export async function writeEvaluationReport(path: string, report: unknown): Promise<void> {
  const parsed = Phase0EvaluationReportSchema.parse(report);
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
}
