import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluationDigest } from './identity.js';
import {
  RegisteredEvaluationWorkerSchema,
  assessRegisteredEvaluationWorker,
  type RegisteredEvaluationWorker,
  type RegisteredWorkerHostAttestation,
} from './worker.js';

const roots: string[] = [];
const digest = `sha256:${'a'.repeat(64)}`;
const otherDigest = `sha256:${'b'.repeat(64)}`;
const trustedHostVerifier = { verify: async () => true };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fileDigest(path: string): Promise<string> {
  return `sha256:${createHash('sha256')
    .update(await readFile(path))
    .digest('hex')}`;
}

async function workerFixture(): Promise<{
  root: string;
  worker: RegisteredEvaluationWorker;
  attestation: RegisteredWorkerHostAttestation;
}> {
  // The boundary rejects any artifact whose declared path is not already canonical, which is a
  // real anti-symlink defense. CI temp roots are commonly symlinks (Windows 8.3 names such as
  // RUNNER~1, macOS /var -> /private/var), so canonicalize the fixture root here. Otherwise the
  // fixture — not the code under test — trips that check and every assertion below sees
  // 'worker-artifact-not-canonical-regular-file'.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'book-registered-worker-')));
  roots.push(root);
  const executable = join(root, 'runtime.bin');
  const entryModule = join(root, 'worker.mjs');
  const loader = join(root, 'loader.mjs');
  const dependencyLock = join(root, 'package-lock.json');
  const evaluatorPackage = join(root, 'evaluator-package.json');
  await Promise.all([
    writeFile(executable, 'fixed runtime'),
    writeFile(entryModule, 'export const worker = true;'),
    writeFile(loader, 'export const loader = true;'),
    writeFile(dependencyLock, '{}'),
    writeFile(evaluatorPackage, '{"name":"pinned-evaluator"}'),
  ]);
  const payload = {
    schemaVersion: 1 as const,
    operationId: 'phase0-worker-v1',
    evaluatorRelease: {
      artifactDigest: digest,
      provenanceDigest: digest,
      status: 'packaged-signed' as const,
    },
    executable: {
      absolutePath: executable,
      digest: await fileDigest(executable),
      runtimeVersion: 'runtime-v1',
    },
    entryModule: { absolutePath: entryModule, digest: await fileDigest(entryModule) },
    loader: { absolutePath: loader, digest: await fileDigest(loader) },
    dependencyLock: { absolutePath: dependencyLock, digest: await fileDigest(dependencyLock) },
    evaluatorPackage: {
      absolutePath: evaluatorPackage,
      digest: await fileDigest(evaluatorPackage),
    },
    argv: ['--worker', 'phase0'],
    cwd: 'allocated-workspace' as const,
    stdin: 'closed' as const,
    environment: {
      source: 'empty' as const,
      nonSecretAllowlist: ['LANG', 'TZ'],
      runnerOwnedKeys: [
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
      ],
      fingerprintDigest: digest,
    },
    pathPolicy: {
      writableRoots: ['workspace', 'book-home', 'runner-temp'] as const,
      evaluator: 'read-only' as const,
      corpus: 'read-only' as const,
      reports: 'inaccessible' as const,
      hostHome: 'inaccessible' as const,
      holdout: 'inaccessible' as const,
    },
    toolSurface: {
      tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit'] as const,
      executableTools: false as const,
      digest,
    },
    network: {
      worker: 'off' as const,
      provider: 'none' as const,
      dns: 'off' as const,
      privateAddresses: 'off' as const,
    },
    limits: {
      cpuMs: 10_000,
      memoryBytes: 256 * 1024 * 1024,
      fileCount: 1_000,
      outputBytes: 1024 * 1024,
      turns: 20,
      tokens: 20_000,
      wallClockMs: 60_000,
    },
    outputPolicy: {
      controlSequences: 'sanitize' as const,
      redaction: 'required' as const,
      rawProviderPayloads: 'forbidden' as const,
    },
    descendants: 'forbidden' as const,
    isolation: {
      backendId: 'host-isolation-v1',
      backendDigest: digest,
      filesystemEnforced: true as const,
      networkEnforced: true as const,
      processTreeEnforced: true as const,
    },
  };
  const worker = RegisteredEvaluationWorkerSchema.parse({
    ...payload,
    registrationDigest: evaluationDigest(payload),
  });
  const attestationPayload = {
    schemaVersion: 1 as const,
    predicateType: 'https://book.dev/attestations/registered-worker-host/v1' as const,
    registrationDigest: worker.registrationDigest,
    signatureEnvelopeDigest: digest,
    signerId: 'host-verifier-v1',
    signatureVerifiedByHost: true,
    executableIdentityVerified: true,
    environmentVerified: true,
    toolSurfaceVerified: true,
    resourceLimitsVerified: true,
    credentialBoundaryVerified: true,
    protectedPathsVerified: true,
    filesystemEnforcementVerified: true,
    networkEnforcementVerified: true,
    processTreeEnforcementVerified: true,
    providerBrokerVerified: false,
    assessedAt: '2026-08-11T00:00:00Z',
    expiresAt: '2026-09-11T00:00:00Z',
  } as const;
  const attestation: RegisteredWorkerHostAttestation = {
    ...attestationPayload,
    attestationDigest: evaluationDigest(attestationPayload),
  };
  return { root, worker, attestation };
}

describe('registered Phase 0 worker boundary', () => {
  it('classifies the absent in-repository worker/broker as calibration-only', async () => {
    await expect(assessRegisteredEvaluationWorker(undefined, undefined)).resolves.toEqual({
      authority: 'calibration-only',
      reasons: ['registered-worker-unavailable'],
    });
  });

  it('requires a matching host enforcement attestation before granting authority', async () => {
    const { worker, attestation } = await workerFixture();
    await expect(assessRegisteredEvaluationWorker(worker, undefined)).resolves.toMatchObject({
      authority: 'calibration-only',
      reasons: ['host-enforcement-attestation-unavailable'],
    });
    await expect(assessRegisteredEvaluationWorker(worker, attestation)).resolves.toMatchObject({
      authority: 'calibration-only',
      reasons: ['authenticated-host-attestation-verifier-unavailable'],
    });
    await expect(
      assessRegisteredEvaluationWorker(worker, attestation, [], trustedHostVerifier),
    ).resolves.toEqual({
      authority: 'promotion-eligible',
      reasons: [],
      registrationDigest: worker.registrationDigest,
    });
    await expect(
      assessRegisteredEvaluationWorker(worker, attestation, [], { verify: async () => false }),
    ).resolves.toMatchObject({
      authority: 'blocked',
      reasons: ['host-attestation-authentication-failed'],
    });
  });

  it('blocks a digest mismatch and artifacts inside candidate-writable state', async () => {
    const { root, worker, attestation } = await workerFixture();
    await expect(
      assessRegisteredEvaluationWorker({ ...worker, registrationDigest: digest }, attestation),
    ).resolves.toMatchObject({
      authority: 'blocked',
      reasons: ['worker-registration-digest-mismatch'],
    });
    await expect(
      assessRegisteredEvaluationWorker(worker, attestation, [root]),
    ).resolves.toMatchObject({
      authority: 'blocked',
      reasons: ['worker-artifact-inside-candidate-writable-root'],
    });
  });

  it('rejects response-file argv expansion and credential-like environment keys', async () => {
    const { worker, attestation } = await workerFixture();
    await expect(
      assessRegisteredEvaluationWorker({ ...worker, argv: ['@project.args'] }, attestation),
    ).resolves.toMatchObject({ authority: 'blocked', reasons: ['worker-registration-invalid'] });

    const unsafePayload = {
      ...worker,
      environment: { ...worker.environment, nonSecretAllowlist: ['API_TOKEN'] },
    };
    const payload = Object.fromEntries(
      Object.entries(unsafePayload).filter(([key]) => key !== 'registrationDigest'),
    );
    await expect(
      assessRegisteredEvaluationWorker(
        { ...payload, registrationDigest: evaluationDigest(payload) },
        attestation,
      ),
    ).resolves.toMatchObject({
      authority: 'blocked',
      reasons: ['credential-like-worker-environment-key'],
    });
  });

  it('rejects self-asserted attestation digests and symlinked worker artifacts', async () => {
    const { root, worker, attestation } = await workerFixture();
    await expect(
      assessRegisteredEvaluationWorker(
        { ...worker },
        { ...attestation, attestationDigest: otherDigest },
        [],
        trustedHostVerifier,
      ),
    ).resolves.toMatchObject({
      authority: 'blocked',
      reasons: ['host-attestation-digest-mismatch'],
    });

    const linkedExecutable = join(root, 'runtime-link.bin');
    try {
      await symlink(worker.executable.absolutePath, linkedExecutable, 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }
    const linkedPayload = {
      ...worker,
      executable: { ...worker.executable, absolutePath: linkedExecutable },
    };
    const registrationPayload = Object.fromEntries(
      Object.entries(linkedPayload).filter(([key]) => key !== 'registrationDigest'),
    );
    await expect(
      assessRegisteredEvaluationWorker(
        {
          ...registrationPayload,
          registrationDigest: evaluationDigest(registrationPayload),
        },
        attestation,
      ),
    ).resolves.toMatchObject({
      authority: 'blocked',
      reasons: ['worker-artifact-not-canonical-regular-file'],
    });
  });
});
