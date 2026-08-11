import { createHash } from 'node:crypto';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { SafeEvaluationIdSchema, Sha256DigestSchema, evaluationDigest } from './identity.js';

const AbsolutePathSchema = z.string().min(1).refine(isAbsolute, 'Path must be absolute.');
const REQUIRED_RUNNER_OWNED_KEYS = [
  'APPDATA',
  'BOOK_EVALUATION_DATE',
  'BOOK_EVALUATION_FIXTURE_REVISION',
  'BOOK_EVALUATION_RANDOM_SEED',
  'BOOK_EVALUATION_RUN_ID',
  'BOOK_EVALUATION_RUNTIME_REVISION',
  'BOOK_HOME',
  'HOME',
  'LOCALAPPDATA',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
] as const;

export const RegisteredEvaluationWorkerSchema = z
  .object({
    schemaVersion: z.literal(1),
    operationId: SafeEvaluationIdSchema,
    registrationDigest: Sha256DigestSchema,
    evaluatorRelease: z
      .object({
        artifactDigest: Sha256DigestSchema,
        provenanceDigest: Sha256DigestSchema,
        status: z.literal('packaged-signed'),
      })
      .strict(),
    executable: z
      .object({
        absolutePath: AbsolutePathSchema,
        digest: Sha256DigestSchema,
        runtimeVersion: z.string().min(1),
      })
      .strict(),
    entryModule: z
      .object({ absolutePath: AbsolutePathSchema, digest: Sha256DigestSchema })
      .strict(),
    loader: z.object({ absolutePath: AbsolutePathSchema, digest: Sha256DigestSchema }).strict(),
    dependencyLock: z
      .object({ absolutePath: AbsolutePathSchema, digest: Sha256DigestSchema })
      .strict(),
    evaluatorPackage: z
      .object({ absolutePath: AbsolutePathSchema, digest: Sha256DigestSchema })
      .strict(),
    argv: z.array(z.string().min(1).max(4096)).max(64),
    cwd: z.literal('allocated-workspace'),
    stdin: z.literal('closed'),
    environment: z
      .object({
        source: z.literal('empty'),
        nonSecretAllowlist: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).max(16),
        runnerOwnedKeys: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)).min(8),
        fingerprintDigest: Sha256DigestSchema,
      })
      .strict(),
    pathPolicy: z
      .object({
        writableRoots: z.array(z.enum(['workspace', 'book-home', 'runner-temp'])).length(3),
        evaluator: z.literal('read-only'),
        corpus: z.literal('read-only'),
        reports: z.literal('inaccessible'),
        hostHome: z.literal('inaccessible'),
        holdout: z.literal('inaccessible'),
      })
      .strict(),
    toolSurface: z
      .object({
        tools: z.array(z.enum(['Read', 'Glob', 'Grep', 'Write', 'Edit'])).min(1),
        executableTools: z.literal(false),
        digest: Sha256DigestSchema,
      })
      .strict(),
    network: z
      .object({
        worker: z.literal('off'),
        provider: z.enum(['none', 'broker-only']),
        dns: z.literal('off'),
        privateAddresses: z.literal('off'),
      })
      .strict(),
    providerBroker: z
      .object({
        brokerId: SafeEvaluationIdSchema,
        brokerDigest: Sha256DigestSchema,
        providerAdapterDigest: Sha256DigestSchema,
        origin: z.string().url(),
        exactModel: z.string().min(1),
        credentialAudience: z.string().min(1),
        requestLimit: z.number().int().positive(),
      })
      .strict()
      .optional(),
    limits: z
      .object({
        cpuMs: z.number().int().positive(),
        memoryBytes: z.number().int().positive(),
        fileCount: z.number().int().positive(),
        outputBytes: z.number().int().positive(),
        turns: z.number().int().positive(),
        tokens: z.number().int().positive(),
        wallClockMs: z.number().int().positive(),
      })
      .strict(),
    outputPolicy: z
      .object({
        controlSequences: z.literal('sanitize'),
        redaction: z.literal('required'),
        rawProviderPayloads: z.literal('forbidden'),
      })
      .strict(),
    descendants: z.literal('forbidden'),
    isolation: z
      .object({
        backendId: SafeEvaluationIdSchema,
        backendDigest: Sha256DigestSchema,
        filesystemEnforced: z.literal(true),
        networkEnforced: z.literal(true),
        processTreeEnforced: z.literal(true),
      })
      .strict(),
  })
  .strict()
  .superRefine((worker, context) => {
    if (worker.network.provider === 'broker-only' && !worker.providerBroker) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Broker-only provider access requires a pinned broker.',
      });
    }
    if (worker.network.provider === 'none' && worker.providerBroker) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A no-provider worker cannot declare a broker.',
      });
    }
    if (new Set(worker.pathPolicy.writableRoots).size !== 3) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'The three fixed writable-root classes must each appear once.',
      });
    }
    if (new Set(worker.toolSurface.tools).size !== worker.toolSurface.tools.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Worker tools must be unique.' });
    }
    const runnerOwnedKeys = [...worker.environment.runnerOwnedKeys].sort();
    if (runnerOwnedKeys.join('\0') !== [...REQUIRED_RUNNER_OWNED_KEYS].sort().join('\0')) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Runner-owned environment keys must exactly match the frozen deterministic set.',
      });
    }
    if (
      new Set(worker.environment.nonSecretAllowlist).size !==
        worker.environment.nonSecretAllowlist.length ||
      new Set(worker.environment.runnerOwnedKeys).size !== worker.environment.runnerOwnedKeys.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Worker environment-key lists must not contain duplicates.',
      });
    }
    if (
      worker.environment.nonSecretAllowlist.some((key) =>
        worker.environment.runnerOwnedKeys.includes(key),
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Runner-owned keys cannot also be inherited non-secret keys.',
      });
    }
    if (worker.argv.some((argument) => argument.startsWith('@') || argument.includes('\0'))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Response files and NUL-containing argv entries are forbidden.',
      });
    }
  });

export const RegisteredWorkerHostAttestationSchema = z
  .object({
    schemaVersion: z.literal(1),
    predicateType: z.literal('https://book.dev/attestations/registered-worker-host/v1'),
    registrationDigest: Sha256DigestSchema,
    attestationDigest: Sha256DigestSchema,
    signatureEnvelopeDigest: Sha256DigestSchema,
    signerId: SafeEvaluationIdSchema,
    signatureVerifiedByHost: z.literal(true),
    executableIdentityVerified: z.literal(true),
    environmentVerified: z.literal(true),
    toolSurfaceVerified: z.literal(true),
    resourceLimitsVerified: z.literal(true),
    credentialBoundaryVerified: z.literal(true),
    protectedPathsVerified: z.literal(true),
    filesystemEnforcementVerified: z.literal(true),
    networkEnforcementVerified: z.literal(true),
    processTreeEnforcementVerified: z.literal(true),
    providerBrokerVerified: z.boolean(),
    assessedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((attestation, context) => {
    if (Date.parse(attestation.assessedAt) >= Date.parse(attestation.expiresAt)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Host attestation expiry must follow its assessment time.',
      });
    }
  });

export type RegisteredEvaluationWorker = z.infer<typeof RegisteredEvaluationWorkerSchema>;
export type RegisteredWorkerHostAttestation = z.infer<typeof RegisteredWorkerHostAttestationSchema>;

export interface RegisteredWorkerAssessment {
  authority: 'promotion-eligible' | 'calibration-only' | 'blocked';
  reasons: string[];
  registrationDigest?: string;
}

export interface RegisteredWorkerHostVerifier {
  verify(input: {
    worker: RegisteredEvaluationWorker;
    attestation: RegisteredWorkerHostAttestation;
  }): Promise<boolean>;
}

async function inspectPinnedFile(
  path: string,
): Promise<{ digest: string; canonicalPath: string } | undefined> {
  let file;
  try {
    const declaredPath = resolve(path);
    const pathMetadata = await lstat(declaredPath);
    if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile()) return undefined;
    const canonicalPath = await realpath(declaredPath);
    if (relative(declaredPath, canonicalPath) !== '') return undefined;
    file = await open(canonicalPath, 'r');
    const metadata = await file.stat();
    if (!metadata.isFile()) return undefined;
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < metadata.size) {
      const { bytesRead } = await file.read(
        buffer,
        0,
        Math.min(buffer.byteLength, metadata.size - offset),
        offset,
      );
      if (bytesRead === 0) return undefined;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const finalMetadata = await file.stat();
    if (
      finalMetadata.size !== metadata.size ||
      finalMetadata.mtimeMs !== metadata.mtimeMs ||
      finalMetadata.ctimeMs !== metadata.ctimeMs ||
      finalMetadata.dev !== metadata.dev ||
      finalMetadata.ino !== metadata.ino
    ) {
      return undefined;
    }
    return { digest: `sha256:${hash.digest('hex')}`, canonicalPath };
  } catch {
    return undefined;
  } finally {
    await file?.close().catch(() => undefined);
  }
}

function pathIsWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function registrationPayload(
  worker: RegisteredEvaluationWorker,
): Omit<RegisteredEvaluationWorker, 'registrationDigest'> {
  const payload = { ...worker } as Partial<RegisteredEvaluationWorker>;
  delete payload.registrationDigest;
  return payload as Omit<RegisteredEvaluationWorker, 'registrationDigest'>;
}

function attestationPayload(
  attestation: RegisteredWorkerHostAttestation,
): Omit<RegisteredWorkerHostAttestation, 'attestationDigest'> {
  const payload = { ...attestation } as Partial<RegisteredWorkerHostAttestation>;
  delete payload.attestationDigest;
  return payload as Omit<RegisteredWorkerHostAttestation, 'attestationDigest'>;
}

async function candidateRootContainsArtifact(root: string, artifact: string): Promise<boolean> {
  const resolvedRoot = resolve(root);
  let canonicalRoot = resolvedRoot;
  try {
    canonicalRoot = await realpath(resolvedRoot);
  } catch {
    // A not-yet-created root can only be checked lexically.
  }
  return pathIsWithin(canonicalRoot, artifact) || pathIsWithin(resolvedRoot, artifact);
}

/**
 * Assess promotion authority without trusting a manifest's isolation claims. No registered worker
 * is launched unless a separately authenticated host attestation proves every enforcement point.
 */
export async function assessRegisteredEvaluationWorker(
  workerInput: unknown,
  attestationInput: unknown,
  candidateWritableRoots: readonly string[] = [],
  hostVerifier?: RegisteredWorkerHostVerifier,
): Promise<RegisteredWorkerAssessment> {
  if (workerInput === undefined || workerInput === null) {
    return {
      authority: 'calibration-only',
      reasons: ['registered-worker-unavailable'],
    };
  }
  const parsed = RegisteredEvaluationWorkerSchema.safeParse(workerInput);
  if (!parsed.success) return { authority: 'blocked', reasons: ['worker-registration-invalid'] };
  const worker = parsed.data;
  const expectedRegistrationDigest = evaluationDigest(registrationPayload(worker));
  if (expectedRegistrationDigest !== worker.registrationDigest) {
    return {
      authority: 'blocked',
      reasons: ['worker-registration-digest-mismatch'],
      registrationDigest: worker.registrationDigest,
    };
  }
  const protectedPaths = [
    worker.executable.absolutePath,
    worker.entryModule.absolutePath,
    worker.loader.absolutePath,
    worker.dependencyLock.absolutePath,
    worker.evaluatorPackage.absolutePath,
  ];
  const inspectedArtifacts = await Promise.all(
    protectedPaths.map((path) => inspectPinnedFile(path)),
  );
  if (inspectedArtifacts.some((artifact) => artifact === undefined)) {
    return {
      authority: 'blocked',
      reasons: ['worker-artifact-not-canonical-regular-file'],
      registrationDigest: worker.registrationDigest,
    };
  }
  const canonicalArtifacts = inspectedArtifacts.map((artifact) => artifact!.canonicalPath);
  const candidateOverlap = await Promise.all(
    candidateWritableRoots.flatMap((root) =>
      canonicalArtifacts.map((artifact) => candidateRootContainsArtifact(root, artifact)),
    ),
  );
  if (candidateOverlap.some(Boolean)) {
    return {
      authority: 'blocked',
      reasons: ['worker-artifact-inside-candidate-writable-root'],
      registrationDigest: worker.registrationDigest,
    };
  }
  const actualDigests = inspectedArtifacts.map((artifact) => artifact!.digest);
  const declaredDigests = [
    worker.executable.digest,
    worker.entryModule.digest,
    worker.loader.digest,
    worker.dependencyLock.digest,
    worker.evaluatorPackage.digest,
  ];
  if (actualDigests.some((digest, index) => digest !== declaredDigests[index])) {
    return {
      authority: 'blocked',
      reasons: ['worker-artifact-digest-mismatch'],
      registrationDigest: worker.registrationDigest,
    };
  }

  const secretLikeEnvironmentKey = /(?:KEY|TOKEN|SECRET|CREDENTIAL|PASSWORD|AUTH)/;
  if (worker.environment.nonSecretAllowlist.some((key) => secretLikeEnvironmentKey.test(key))) {
    return {
      authority: 'blocked',
      reasons: ['credential-like-worker-environment-key'],
      registrationDigest: worker.registrationDigest,
    };
  }

  const attestation = RegisteredWorkerHostAttestationSchema.safeParse(attestationInput);
  if (!attestation.success) {
    return {
      authority: 'calibration-only',
      reasons: ['host-enforcement-attestation-unavailable'],
      registrationDigest: worker.registrationDigest,
    };
  }
  const proof = attestation.data;
  if (evaluationDigest(attestationPayload(proof)) !== proof.attestationDigest) {
    return {
      authority: 'blocked',
      reasons: ['host-attestation-digest-mismatch'],
      registrationDigest: worker.registrationDigest,
    };
  }
  const providerBrokerVerified = worker.network.provider === 'none' || proof.providerBrokerVerified;
  if (
    proof.registrationDigest !== worker.registrationDigest ||
    !proof.signatureVerifiedByHost ||
    !proof.executableIdentityVerified ||
    !proof.environmentVerified ||
    !proof.toolSurfaceVerified ||
    !proof.resourceLimitsVerified ||
    !proof.credentialBoundaryVerified ||
    !proof.protectedPathsVerified ||
    !proof.filesystemEnforcementVerified ||
    !proof.networkEnforcementVerified ||
    !proof.processTreeEnforcementVerified ||
    !providerBrokerVerified
  ) {
    return {
      authority: 'blocked',
      reasons: ['host-enforcement-attestation-failed'],
      registrationDigest: worker.registrationDigest,
    };
  }
  if (!hostVerifier) {
    return {
      authority: 'calibration-only',
      reasons: ['authenticated-host-attestation-verifier-unavailable'],
      registrationDigest: worker.registrationDigest,
    };
  }
  let authenticated = false;
  try {
    authenticated = await hostVerifier.verify({ worker, attestation: proof });
  } catch {
    authenticated = false;
  }
  if (!authenticated) {
    return {
      authority: 'blocked',
      reasons: ['host-attestation-authentication-failed'],
      registrationDigest: worker.registrationDigest,
    };
  }
  return {
    authority: 'promotion-eligible',
    reasons: [],
    registrationDigest: worker.registrationDigest,
  };
}

/** Current in-repository execution deliberately carries no promotion authority. */
export const CURRENT_PHASE0_WORKER_AVAILABILITY: RegisteredWorkerAssessment = Object.freeze({
  authority: 'calibration-only',
  reasons: [
    'packaged-signed-worker-unavailable',
    'provider-broker-unavailable',
    'host-filesystem-network-process-attestation-unavailable',
  ],
});
