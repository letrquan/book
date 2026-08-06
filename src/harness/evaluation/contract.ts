import { createHash } from 'node:crypto';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SAFE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const strictStringRecord = z.record(z.string(), z.string());

const TrustedCommandSchema = z
  .object({
    argv: z.array(z.string().min(1)).min(1),
    cwd: z.string().min(1),
    envAllowlist: z.array(z.string().min(1)),
    network: z.enum(['off', 'restricted', 'required']),
  })
  .strict();

const FileVerifierSchema = z
  .object({
    id: z.string().regex(SAFE_ID_PATTERN),
    kind: z.literal('file'),
    required: z.boolean(),
    path: z.string().min(1),
    assertion: z.enum(['exists', 'absent', 'sha256', 'utf8-equals']),
    expectedDigest: z.string().regex(SHA256_PATTERN).optional(),
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
  });

const DiffVerifierSchema = z
  .object({
    id: z.string().regex(SAFE_ID_PATTERN),
    kind: z.literal('diff'),
    required: z.boolean(),
    expectedChangedPaths: z.array(z.string().min(1)),
    forbiddenChangedPaths: z.array(z.string().min(1)),
  })
  .strict();

const CommandVerifierSchema = z
  .object({
    id: z.string().regex(SAFE_ID_PATTERN),
    kind: z.literal('command'),
    required: z.boolean(),
    command: TrustedCommandSchema,
    timeoutMs: z.number().int().positive(),
    expectedExitCodes: z.array(z.number().int()).min(1),
  })
  .strict();

const HumanRubricVerifierSchema = z
  .object({
    id: z.string().regex(SAFE_ID_PATTERN),
    kind: z.literal('human-rubric'),
    required: z.boolean(),
    rubricId: z.string().regex(SAFE_ID_PATTERN),
  })
  .strict();

export const HarnessEvaluationVerifierSchema = z.union([
  FileVerifierSchema,
  DiffVerifierSchema,
  CommandVerifierSchema,
  HumanRubricVerifierSchema,
]);

const MetricPolicySchema = z
  .object({
    primary: z.string().min(1),
    guardrails: z.array(z.string().min(1)).min(1),
    minimumAttemptsPerArm: z.number().int().min(2),
    minimumDetectableEffect: z.string().min(1),
    maximumCostIncreaseRatio: z.number().min(0),
    maximumLatencyIncreaseRatio: z.number().min(0),
    nonInferiorityMargins: strictStringRecord,
  })
  .strict();

export const HarnessEvaluationCaseSchema = z
  .object({
    schemaVersion: z.literal(1),
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
    eligibility: z.enum(['provider-trial', 'offline-only', 'blocked-tier-c']),
    prompt: z.string().min(1),
    trial: z
      .object({
        experimentalUnit: z.literal('root-request'),
        clusterKey: z.string().min(1),
        isolation: z.literal('fresh-materialization'),
        attemptsPerArm: z.number().int().min(2),
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
  .strict();

export const HarnessEvaluationManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    corpusVersion: z.string().min(1),
    evaluatorVersion: z.string().min(1),
    scope: z.literal('trusted-built-in-non-adversarial'),
    reportSchemaVersion: z.literal(1),
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
        minimumControlRunsForNoiseFloor: z.number().int().min(3),
      })
      .strict(),
    trustBoundary: z
      .object({
        projectCommands: z.literal('blocked'),
        adversarialFixtures: z.literal('blocked'),
        network: z.literal('off'),
        credentials: z.literal('forbidden'),
        symlinks: z.literal('forbidden'),
      })
      .strict(),
    compatibilityFields: z.array(z.string().regex(SAFE_ID_PATTERN)).min(8),
  })
  .strict();

export type HarnessEvaluationCase = z.infer<typeof HarnessEvaluationCaseSchema>;
export type HarnessEvaluationManifest = z.infer<typeof HarnessEvaluationManifestSchema>;
export type HarnessEvaluationVerifier = z.infer<typeof HarnessEvaluationVerifierSchema>;

export interface HarnessEvaluationCorpus {
  root: string;
  manifest: HarnessEvaluationManifest;
  cases: HarnessEvaluationCase[];
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
  rubricReviews?: Readonly<Record<string, readonly HumanRubricReview[]>>;
}

export interface HumanRubricReview {
  reviewerId: string;
  score: number;
  independent: boolean;
}

export interface HumanRubricDecision {
  status: 'passed' | 'failed' | 'unknown';
  detail: string;
  scores: number[];
}

export interface EvaluationComparisonIdentity {
  armId: string;
  corpusVersion: string;
  evaluatorVersion: string;
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
  successRate: number;
  unknownRate: number;
  setupFailureRate: number;
  meanLatencyMs?: number;
  latencyStdDevMs?: number;
  minimumDetectableSuccessRateDelta: number;
}

function assertRelativePath(path: string, label: string): void {
  if (isAbsolute(path) || path.split(/[\\/]+/).includes('..')) {
    throw new Error(`${label} must stay within the evaluation corpus.`);
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

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function evaluationDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
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
    if (ids.has(parsed.id)) throw new Error(`Duplicate evaluation case id: ${parsed.id}`);
    ids.add(parsed.id);
    for (const modelSliceId of parsed.modelSliceIds) {
      if (!modelSliceIds.has(modelSliceId)) {
        throw new Error(`Case ${parsed.id} references unknown model slice ${modelSliceId}.`);
      }
    }
    await assertConstrainedDirectory(
      absoluteRoot,
      parsed.fixture.source,
      `Fixture source for ${parsed.id}`,
    );
    for (const verifier of parsed.verifiers) {
      if ('path' in verifier) assertRelativePath(verifier.path, `Verifier path ${verifier.id}`);
    }
    cases.push(parsed);
  }

  return { root: absoluteRoot, manifest, cases };
}

async function collectFixtureFiles(
  root: string,
  directory: string,
  canonicalRoot: string,
): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error(`Fixture symlink is forbidden: ${path}`);
    const canonicalPath = await realpath(path);
    if (!isPathInside(canonicalRoot, canonicalPath)) {
      throw new Error(`Fixture path escapes its root: ${path}`);
    }
    if (metadata.isDirectory()) {
      files.push(...(await collectFixtureFiles(root, path, canonicalRoot)));
    } else if (metadata.isFile()) files.push(relative(root, path).replaceAll('\\', '/'));
    else throw new Error(`Fixture contains unsupported entry: ${path}`);
  }
  return files.sort();
}

/** Hash paths and contents so fixture reset can be verified across materializations. */
export async function fingerprintEvaluationFixture(root: string): Promise<string> {
  const absoluteRoot = resolve(root);
  const rootMetadata = await lstat(absoluteRoot);
  if (rootMetadata.isSymbolicLink()) {
    throw new Error(`Fixture root symlink is forbidden: ${absoluteRoot}`);
  }
  if (!rootMetadata.isDirectory())
    throw new Error(`Fixture root must be a directory: ${absoluteRoot}`);
  const canonicalRoot = await realpath(absoluteRoot);
  const records = [];
  for (const path of await collectFixtureFiles(absoluteRoot, absoluteRoot, canonicalRoot)) {
    const contents = await readFile(resolveWithin(absoluteRoot, path, 'Fixture file'));
    records.push({
      path,
      bytes: contents.byteLength,
      digest: createHash('sha256').update(contents).digest('hex'),
    });
  }
  return evaluationDigest(records);
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
  return materializedDigest;
}

export function evaluateHumanRubric(
  reviews: readonly HumanRubricReview[] | undefined,
  options: { minimumReviewers?: number; passingScore?: number; maximumSpread?: number } = {},
): HumanRubricDecision {
  const minimumReviewers = options.minimumReviewers ?? 2;
  const passingScore = options.passingScore ?? 3;
  const maximumSpread = options.maximumSpread ?? 1;
  const scores = reviews?.map((review) => review.score) ?? [];
  if (!reviews || reviews.length < minimumReviewers) {
    return { status: 'unknown', detail: 'insufficient-independent-reviews', scores };
  }
  if (reviews.some((review) => !review.independent)) {
    return {
      status: 'unknown',
      detail: 'reviewer-independence-not-established',
      scores,
    };
  }
  const reviewerIds = reviews.map((review) => review.reviewerId.trim());
  if (reviewerIds.some((reviewerId) => reviewerId.length === 0)) {
    return { status: 'unknown', detail: 'reviewer-identity-missing', scores };
  }
  if (new Set(reviewerIds).size !== reviewerIds.length) {
    return { status: 'unknown', detail: 'duplicate-reviewer-identity', scores };
  }
  const spread = Math.max(...scores) - Math.min(...scores);
  if (spread > maximumSpread) return { status: 'unknown', detail: 'review-disagreement', scores };
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  return {
    status: mean >= passingScore ? 'passed' : 'failed',
    detail: `mean-score:${mean.toFixed(2)}`,
    scores,
  };
}

async function evaluateVerifier(
  verifier: HarnessEvaluationVerifier,
  workspace: string,
  context: EvaluationFinalStateContext,
): Promise<EvaluationVerifierResult> {
  if (verifier.kind === 'human-rubric') {
    const decision = evaluateHumanRubric(context.rubricReviews?.[verifier.rubricId]);
    return { ...decision, id: verifier.id, kind: verifier.kind, required: verifier.required };
  }
  if (verifier.kind === 'command') {
    return {
      id: verifier.id,
      kind: verifier.kind,
      required: verifier.required,
      status: 'unknown',
      detail: 'command-verifier-requires-a-separately-approved-trusted-runner',
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
  return { eligible: reasons.length === 0, reasons };
}

export function summarizeEvaluationNoiseFloor(
  observations: readonly EvaluationNoiseObservation[],
  minimumRuns = 5,
): EvaluationNoiseFloor {
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
    sufficient: sampleCount >= minimumRuns,
    successRate,
    unknownRate,
    setupFailureRate,
    meanLatencyMs,
    latencyStdDevMs,
    minimumDetectableSuccessRateDelta: Math.max(0.1, binomialNoise),
  };
}

export async function writeEvaluationReport(path: string, report: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
