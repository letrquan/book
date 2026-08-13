import { describe, expect, it } from 'vitest';
import { appendFile, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunEvidenceStore, canonicalJson, readRunLedger, verifySeal } from './run-store.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'book-harness-ledger-'));
  const store = new RunEvidenceStore({
    workspace: join(root, 'workspace'),
    bookHome: join(root, 'book'),
  });
  return { root, store };
}

describe('append-only run evidence ledger', () => {
  it('writes ordered envelopes, hash chains, a seal, and a rebuildable index', async () => {
    const { store } = await fixture();
    const writer = await store.startRun({
      rootRunId: 'root-identity-1',
      runId: 'root-identity-1',
      sessionId: 'session-1',
      metadata: { mode: 'observe', model: 'model-v1' },
    });
    expect(
      writer.enqueue({ type: 'turn_started', occurredAt: 2, attributes: { turn: 1 } }),
    ).toMatchObject({ status: 'accepted' });
    expect(
      writer.enqueue({
        type: 'tool_finished',
        occurredAt: 3,
        attributes: { status: 'success' as never },
      }),
    ).toMatchObject({ status: 'accepted' });
    const final = await writer.finalize({ status: 'completed' });
    // Node exposes file fsync and atomic rename but no portable directory fsync;
    // the seal must therefore fail closed for promotion eligibility.
    expect(final.seal?.evidenceComplete).toBe(false);
    expect(final.seal?.evidenceEligibility).toBe('ineligible');
    expect(final.seal && verifySeal(final.seal)).toBe(true);
    const run = await store.readRun('root-identity-1');
    expect(run.status).toBe('complete');
    expect(run.records.map((record) => record.sequence)).toEqual([1, 2, 3, 4]);
    expect(
      run.records.every(
        (record, index) =>
          index === 0 || record.previousRecordHash === run.records[index - 1]!.recordHash,
      ),
    ).toBe(true);
    const index = await store.rebuildIndex();
    expect(index[0]).toMatchObject({ rootRunId: 'root-identity-1', evidenceComplete: false });
  });

  it('recovers a truncated tail as an inspectable but incomplete prefix', async () => {
    const { store } = await fixture();
    const writer = await store.startRun({
      rootRunId: 'root-tail-1',
      runId: 'root-tail-1',
      metadata: { mode: 'observe' },
    });
    await writer.flush();
    const path = writer.path;
    await writer.close();
    await appendFile(path, '{"schemaVersion":1');
    const result = await readRunLedger(path);
    expect(result.status).toBe('truncated-tail');
    expect(result.records.length).toBe(1);
    expect(result.truncatedBytes).toBeGreaterThan(0);
  });

  it('fails closed on queue overflow and never stores forbidden input text', async () => {
    const { root } = await fixture();
    const store = new RunEvidenceStore({
      workspace: join(root, 'workspace'),
      bookHome: join(root, 'book'),
      maxQueueSize: 0,
    });
    const writer = await store.startRun({
      rootRunId: 'root-private-1',
      runId: 'root-private-1',
      metadata: { mode: 'observe' },
    });
    const first = writer.enqueue({
      type: 'tool_started',
      occurredAt: 1,
      summary: 'api_key=do-not-store' as never,
    });
    const second = writer.enqueue({
      type: 'tool_started',
      occurredAt: 2,
      summary: 'also-private' as never,
    });
    expect(first).toMatchObject({ status: 'dropped' });
    expect(second).toMatchObject({ status: 'dropped' });
    const final = await writer.finalize({ status: 'completed' });
    expect(final.incomplete).toBe(true);
    const text = await readFile(writer.path, 'utf8');
    expect(text).not.toContain('do-not-store');
    expect(text).not.toContain('api_key');
    expect(final.seal?.evidenceEligibility).toBe('ineligible');
  });

  it('canonicalizes object keys deterministically', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  it('projects header identity and metadata without persisting raw metadata objects', async () => {
    const { store } = await fixture();
    const writer = await store.startRun({
      rootRunId: 'root-header-1',
      runId: 'root-header-1',
      sessionId: 'session-header',
      metadata: {
        mode: 'observe',
        model: 'model-v1',
        componentReferences: {
          promptLayers: 'prompt-v1',
          unsafeUrl: 'https://example.test/private',
          unsafeQuery: 'key=value',
          unsafePath: 'C:\\private\\file.txt',
          unsafeCommand: 'git status',
          unsafeSecret: 'api_key=super-secret-value',
          'Unsafe Key!': 'dropped',
        },
      },
    });
    await writer.finalize({ status: 'completed' });
    const run = await store.readRun('root-header-1');
    const header = run.records[0]!.data as {
      identity: Record<string, unknown>;
      metadata: { componentReferences?: Record<string, string>; model?: string };
    };
    expect(header.identity.metadata).toBeUndefined();
    expect(header.identity.rootRunId).toBe('root-header-1');
    expect(header.identity.sessionId).toBe('session-header');
    expect(header.metadata.model).toBe('model-v1');
    expect(header.metadata.componentReferences).toEqual({ promptLayers: 'prompt-v1' });
  });

  it('persists callback-derived token and provider facts without payload text', async () => {
    const { store } = await fixture();
    const writer = await store.startRun({
      rootRunId: 'root-usage-1',
      runId: 'root-usage-1',
      metadata: { mode: 'observe' },
    });
    writer.enqueue({
      type: 'model_usage',
      occurredAt: 2,
      attributes: {
        provider: 'provider-a' as never,
        requestedModel: 'model-a' as never,
        inputTokens: 4,
        outputTokens: 5,
        totalTokens: 9,
      },
    });
    await writer.finalize({ status: 'completed' });
    const run = await store.readRun('root-usage-1');
    const usage = run.records.find((record) => record.eventType === 'model_usage');
    expect(usage?.data).toMatchObject({
      attributes: {
        provider: 'provider-a',
        requestedModel: 'model-a',
        inputTokens: 4,
        outputTokens: 5,
      },
    });
    expect(JSON.stringify(run.records)).not.toContain('prompt text');
  });

  it('keeps duplicate finalization idempotent and flags conflicting terminal statuses', async () => {
    const { store } = await fixture();
    const writer = await store.startRun({
      rootRunId: 'root-dup-final-1',
      runId: 'root-dup-final-1',
      metadata: { mode: 'observe' },
    });
    const first = await writer.finalize({ status: 'completed' });
    const repeat = await writer.finalize({ status: 'completed' });
    expect(first.seal?.terminalStatus).toBe('completed');
    expect(repeat.seal?.sealDigest).toBe(first.seal?.sealDigest);
    expect(repeat.incomplete).toBeFalsy();

    const conflicting = await writer.finalize({ status: 'failed' });
    expect(conflicting.failureReason).toBe('conflicting-finalization');
    expect(conflicting.incomplete).toBe(true);
    // The sealed stream itself is unchanged by the conflicting caller.
    const run = await store.readRun('root-dup-final-1');
    expect(run.seal?.terminalStatus).toBe('completed');
  });

  it('latches disk write failures as visible storage errors instead of throwing', async () => {
    const { root } = await fixture();
    const errors: string[] = [];
    const store = new RunEvidenceStore({
      workspace: join(root, 'workspace'),
      bookHome: join(root, 'book'),
      onStorageError: (error) => errors.push(error.message),
    });
    const writer = await store.startRun({
      rootRunId: 'root-disk-1',
      runId: 'root-disk-1',
      metadata: { mode: 'observe' },
    });
    // Simulate an unrecoverable device failure under the open descriptor.
    await (writer as unknown as { fd: { close(): Promise<void> } }).fd.close();
    expect(() =>
      writer.enqueue({ type: 'turn_started', occurredAt: 2, attributes: { turn: 1 } }),
    ).not.toThrow();
    const flushed = await writer.flush();
    expect(flushed.flushed).toBe(false);
    expect(flushed.incomplete).toBe(true);
    expect(errors.length).toBeGreaterThan(0);
    const final = await writer.finalize({ status: 'completed' });
    expect(final.status).toBe('failed');
    expect(final.seal).toBeUndefined();
    // Storage errors persist as stable classifications, never raw exception text.
    for (const recorded of [...errors, ...(final.storageErrors ?? [])]) {
      expect(recorded).toMatch(/^[A-Za-z0-9_:-]+$/);
    }
  });

  it('detects mid-stream tampering while keeping the valid prefix readable', async () => {
    const { store } = await fixture();
    const writer = await store.startRun({
      rootRunId: 'root-tamper-1',
      runId: 'root-tamper-1',
      metadata: { mode: 'observe' },
    });
    writer.enqueue({ type: 'turn_started', occurredAt: 2, attributes: { turn: 1 } });
    writer.enqueue({ type: 'turn_started', occurredAt: 3, attributes: { turn: 2 } });
    await writer.finalize({ status: 'completed' });
    const original = await readFile(writer.path, 'utf8');
    const lines = original.split('\n');
    lines[1] = lines[1]!.replace('"turn":1', '"turn":9');
    await writeFile(writer.path, lines.join('\n'), 'utf8');
    const result = await readRunLedger(writer.path);
    expect(result.status).toBe('corrupt');
    expect(result.records.length).toBe(1);
    expect(result.error).toBe('record-hash-mismatch');
  });

  it('rejects a tampered seal and marks the mismatched stream corrupt', async () => {
    const { store } = await fixture();
    const writer = await store.startRun({
      rootRunId: 'root-seal-tamper-1',
      runId: 'root-seal-tamper-1',
      metadata: { mode: 'observe' },
    });
    const final = await writer.finalize({ status: 'completed' });
    expect(final.seal && verifySeal(final.seal)).toBe(true);
    const forged = { ...final.seal!, recordCount: final.seal!.recordCount + 1 };
    expect(verifySeal(forged)).toBe(false);
    await writeFile(writer.sealPath, `${canonicalJson(forged)}\n`, 'utf8');
    const run = await store.readRun('root-seal-tamper-1');
    expect(run.status).toBe('corrupt');
  });

  it('treats malformed seal attestations as corrupt instead of throwing', async () => {
    const { store } = await fixture();
    const writer = await store.startRun({
      rootRunId: 'root-malformed-seal-1',
      runId: 'root-malformed-seal-1',
      metadata: { mode: 'observe' },
    });
    const final = await writer.finalize({ status: 'completed' });
    const malformed = { ...final.seal!, attestation: undefined };
    expect(verifySeal(malformed as never)).toBe(false);
    await writeFile(writer.sealPath, `${canonicalJson(malformed)}\n`, 'utf8');
    await expect(store.readRun('root-malformed-seal-1')).resolves.toMatchObject({
      status: 'corrupt',
    });
  });

  it('contains throwing storage-error callbacks', async () => {
    const { root } = await fixture();
    const store = new RunEvidenceStore({
      workspace: join(root, 'workspace'),
      bookHome: join(root, 'book'),
      onStorageError: () => {
        throw new Error('host callback failed');
      },
    });
    const writer = await store.startRun({
      rootRunId: 'root-storage-callback-1',
      runId: 'root-storage-callback-1',
      metadata: { mode: 'observe' },
    });
    await (writer as unknown as { fd: { close(): Promise<void> } }).fd.close();
    writer.enqueue({ type: 'turn_started', occurredAt: 2, attributes: { turn: 1 } });
    await expect(writer.flush()).resolves.toMatchObject({ status: 'failed', incomplete: true });
  });

  it('rejects unsafe ledger identities before creating the stream', async () => {
    const { store } = await fixture();
    await expect(
      store.startRun({
        rootRunId: 'root-safe-identity-1',
        runId: 'root-safe-identity-1',
        sessionId: 'api_key=super-secret-value',
        metadata: { mode: 'observe' },
      }),
    ).rejects.toThrow(/Invalid harness run identity/);
  });

  it('applies retention without deleting pinned verification evidence', async () => {
    const { root } = await fixture();
    let clock = 1_000;
    const store = new RunEvidenceStore({
      workspace: join(root, 'workspace'),
      bookHome: join(root, 'book'),
      now: () => clock,
    });
    const pinned = await store.startRun({
      rootRunId: 'root-pinned-1',
      runId: 'root-pinned-1',
      metadata: { mode: 'observe' },
    });
    await pinned.finalize({ status: 'completed' });
    clock = 2_000;
    const expired = await store.startRun({
      rootRunId: 'root-expired-1',
      runId: 'root-expired-1',
      metadata: { mode: 'observe' },
    });
    await expired.finalize({ status: 'completed' });
    clock = 100_000_000;
    const fresh = await store.startRun({
      rootRunId: 'root-fresh-1',
      runId: 'root-fresh-1',
      metadata: { mode: 'observe' },
    });
    await fresh.finalize({ status: 'completed' });

    await store.createPin({
      evidencePacketId: 'phase-2-packet-1',
      rootRunId: 'root-pinned-1',
      purpose: 'verification',
      expiresAt: 200_000_000,
    });
    const removed = await store.cleanupRetention({
      maxAgeMs: 10_000,
      now: clock,
      pinnedRunIds: ['root-pinned-1'],
    });
    expect(removed).toEqual(['root-expired-1']);
    expect((await store.readRun('root-pinned-1')).status).toBe('complete');
    expect((await store.readRun('root-fresh-1')).status).toBe('complete');
    expect((await store.readRun('root-expired-1')).status).toBe('missing');
  });

  it('refuses to pin an unsealed run', async () => {
    const { store } = await fixture();
    const writer = await store.startRun({
      rootRunId: 'root-unsealed-pin-1',
      runId: 'root-unsealed-pin-1',
      metadata: { mode: 'observe' },
    });
    await writer.flush();
    await expect(
      store.createPin({
        evidencePacketId: 'phase-2-packet-2',
        rootRunId: 'root-unsealed-pin-1',
        purpose: 'verification',
        expiresAt: 10,
      }),
    ).rejects.toThrow(/complete sealed/);
    await writer.close();
  });

  it('serializes concurrent finalization and emits one terminal record', async () => {
    const { store } = await fixture();
    const writer = await store.startRun({
      rootRunId: 'root-concurrent-finalize-1',
      runId: 'root-concurrent-finalize-1',
      metadata: { mode: 'observe' },
    });
    const [first, second] = await Promise.all([
      writer.finalize({ status: 'completed' }),
      writer.finalize({ status: 'completed' }),
    ]);
    expect(first.seal?.sealDigest).toBe(second.seal?.sealDigest);
    const run = await store.readRun('root-concurrent-finalize-1');
    expect(run.records.filter((record) => record.eventType === 'run_completed')).toHaveLength(1);
  });
});
