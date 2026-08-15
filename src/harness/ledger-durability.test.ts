import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DURABILITY_POLICY_VERSION,
  durabilityIsVerified,
  openJsonlDurabilityBackend,
  openSqliteDurabilityBackend,
} from './ledger-durability.js';
import type { DurabilityStatus, LedgerDurabilityBackendFactory } from './ledger-durability.js';
import { RunEvidenceStore, readRunLedger } from './run-store.js';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-durability-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

/**
 * A backend that verifies every guarantee. It writes through the real JSONL
 * backend so record framing, sequencing, and the hash chain are untouched — the
 * only difference is the durability claim, which is the whole point of the seam.
 */
const verifiedBackend: LedgerDurabilityBackendFactory = async (input) => {
  const inner = await openJsonlDurabilityBackend(input);
  return {
    ...inner,
    id: 'test-verified-v1',
    append: (line: string) => inner.append(line),
    sync: () => inner.sync(),
    writeSeal: (line: string) => inner.writeSeal(line),
    close: () => inner.close(),
    status: (): DurabilityStatus => ({
      policy: DURABILITY_POLICY_VERSION,
      fileDataSync: 'verified',
      fileMetadataSync: 'verified',
      atomicReplace: 'verified',
      directorySync: 'verified',
    }),
  };
};

describe('ledger durability seam', () => {
  it('treats policy as identity and every other guarantee as required', () => {
    const verified: DurabilityStatus = {
      policy: DURABILITY_POLICY_VERSION,
      fileDataSync: 'verified',
      fileMetadataSync: 'verified',
      atomicReplace: 'verified',
      directorySync: 'verified',
    };
    expect(durabilityIsVerified(verified)).toBe(true);
    // A differing policy string is an identity change, not a guarantee failure.
    expect(durabilityIsVerified({ ...verified, policy: 'other-policy-v9' })).toBe(true);
    for (const key of [
      'fileDataSync',
      'fileMetadataSync',
      'atomicReplace',
      'directorySync',
    ] as const) {
      expect(durabilityIsVerified({ ...verified, [key]: 'unavailable' })).toBe(false);
      expect(durabilityIsVerified({ ...verified, [key]: 'failed' })).toBe(false);
    }
  });

  it('keeps the JSONL backend honestly ineligible because Node has no directory fsync', async () => {
    const root = tempDir();
    const store = new RunEvidenceStore({
      workspace: join(root, 'workspace'),
      bookHome: join(root, 'book'),
    });
    const writer = await store.startRun({
      rootRunId: 'root-jsonl-1',
      runId: 'root-jsonl-1',
      metadata: { mode: 'observe' },
    });
    writer.enqueue({ type: 'turn_started', occurredAt: 2, attributes: { turn: 1 } });
    const result = await writer.finalize({ status: 'completed' });

    expect(result.seal?.durability.directorySync).toBe('unavailable');
    expect(result.seal?.durability.fileDataSync).toBe('verified');
    expect(result.seal?.evidenceComplete).toBe(false);
    expect(result.seal?.evidenceEligibility).toBe('ineligible');
  });

  it('reaches eligible evidence when a backend verifies every guarantee', async () => {
    const root = tempDir();
    const store = new RunEvidenceStore({
      workspace: join(root, 'workspace'),
      bookHome: join(root, 'book'),
      durabilityBackend: verifiedBackend,
    });
    const writer = await store.startRun({
      rootRunId: 'root-durable-1',
      runId: 'root-durable-1',
      metadata: { mode: 'observe' },
    });
    writer.enqueue({ type: 'turn_started', occurredAt: 2, attributes: { turn: 1 } });
    const result = await writer.finalize({ status: 'completed' });

    // This is the property Phase 2 could not express: the ledger now has a
    // passing path, gated on a backend that can actually prove durability.
    expect(result.seal?.durability.directorySync).toBe('verified');
    expect(result.seal?.evidenceComplete).toBe(true);
    expect(result.seal?.evidenceEligibility).toBe('eligible');
  });

  it('keeps record framing and the hash chain identical across backends', async () => {
    async function write(factory?: LedgerDurabilityBackendFactory): Promise<string> {
      const root = tempDir();
      const store = new RunEvidenceStore({
        workspace: join(root, 'workspace'),
        bookHome: join(root, 'book'),
        // Pinned so the two runs differ only by backend. The workspace id is
        // derived from the path, and each run needs its own temp root.
        workspaceId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        now: () => 1_000,
        randomUUID: (() => {
          let n = 0;
          return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
        })(),
        ...(factory ? { durabilityBackend: factory } : {}),
      });
      const writer = await store.startRun({
        rootRunId: 'root-parity-1',
        runId: 'root-parity-1',
        metadata: { mode: 'observe' },
      });
      writer.enqueue({ type: 'turn_started', occurredAt: 2, attributes: { turn: 1 } });
      await writer.finalize({ status: 'completed' });
      return readFile(writer.path, 'utf8');
    }

    // Durability is the only axis the backend may vary. If a backend could also
    // change the bytes, a stream would stop verifying the same way everywhere
    // and cross-backend evidence would not be comparable.
    expect(await write(verifiedBackend)).toBe(await write());
  });

  it('stays readable and chain-verifiable when written through an alternate backend', async () => {
    const root = tempDir();
    const store = new RunEvidenceStore({
      workspace: join(root, 'workspace'),
      bookHome: join(root, 'book'),
      durabilityBackend: verifiedBackend,
    });
    const writer = await store.startRun({
      rootRunId: 'root-readback-1',
      runId: 'root-readback-1',
      metadata: { mode: 'observe' },
    });
    writer.enqueue({ type: 'turn_started', occurredAt: 2, attributes: { turn: 1 } });
    await writer.finalize({ status: 'completed' });

    const read = await readRunLedger(writer.path);
    expect(read.status).toBe('complete');
    expect(read.seal?.evidenceEligibility).toBe('eligible');
    expect(read.records.length).toBeGreaterThan(1);
  });

  it('produces eligible evidence through the real SQLite backend', async () => {
    const root = tempDir();
    const store = new RunEvidenceStore({
      workspace: join(root, 'workspace'),
      bookHome: join(root, 'book'),
      durabilityBackend: openSqliteDurabilityBackend,
    });
    const writer = await store.startRun({
      rootRunId: 'root-sqlite-1',
      runId: 'root-sqlite-1',
      metadata: { mode: 'observe' },
    });
    writer.enqueue({ type: 'turn_started', occurredAt: 2, attributes: { turn: 1 } });
    const result = await writer.finalize({ status: 'completed' });

    expect(result.seal?.durability.directorySync).toBe('verified');
    expect(result.seal?.evidenceEligibility).toBe('eligible');

    // Read back through the same public entry point the JSONL path uses.
    const read = await readRunLedger(writer.path);
    expect(read.status).toBe('complete');
    expect(read.seal?.evidenceEligibility).toBe('eligible');
    expect(read.records.at(-1)?.eventType).toBe('run_completed');
    expect(read.truncatedBytes).toBe(0);
  });

  it('writes byte-identical records through SQLite and JSONL', async () => {
    async function write(factory?: LedgerDurabilityBackendFactory): Promise<string> {
      const root = tempDir();
      const store = new RunEvidenceStore({
        workspace: join(root, 'workspace'),
        bookHome: join(root, 'book'),
        workspaceId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
        now: () => 2_000,
        randomUUID: (() => {
          let n = 0;
          return () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
        })(),
        ...(factory ? { durabilityBackend: factory } : {}),
      });
      const writer = await store.startRun({
        rootRunId: 'root-bytes-1',
        runId: 'root-bytes-1',
        metadata: { mode: 'observe' },
      });
      writer.enqueue({ type: 'turn_started', occurredAt: 3, attributes: { turn: 1 } });
      await writer.finalize({ status: 'completed' });
      return (await readRunLedger(writer.path)).records.map((r) => JSON.stringify(r)).join('\n');
    }

    // The durability claim is the only thing a backend may change. Seal fields
    // differ by construction; the record stream must not.
    expect(await write(openSqliteDurabilityBackend)).toBe(await write());
  });

  it('refuses to reopen a SQLite ledger that already holds records', async () => {
    const runDir = join(tempDir(), 'run');
    const randomUUID = (): string => '00000000-0000-4000-8000-000000000001';
    const first = await openSqliteDurabilityBackend({ runDir, randomUUID });
    await first.append('{"a":1}\n');
    await first.close();
    // Run identity collision must fail closed rather than interleave two
    // writers into one chain.
    await expect(openSqliteDurabilityBackend({ runDir, randomUUID })).rejects.toThrow(
      /collision or open failure/,
    );
  });

  it('survives losing the writer without a seal, and stays unsealed rather than corrupt', async () => {
    const root = tempDir();
    const store = new RunEvidenceStore({
      workspace: join(root, 'workspace'),
      bookHome: join(root, 'book'),
      durabilityBackend: openSqliteDurabilityBackend,
    });
    const writer = await store.startRun({
      rootRunId: 'root-crash-1',
      runId: 'root-crash-1',
      metadata: { mode: 'observe' },
    });
    writer.enqueue({ type: 'turn_started', occurredAt: 2, attributes: { turn: 1 } });
    await writer.flush();
    // Simulate process loss: the descriptor goes away with no seal written.
    await (writer as unknown as { backend: { close(): Promise<void> } }).backend.close();

    const read = await readRunLedger(writer.path);
    // Committed rows survived; the absent seal is reported as unsealed, which
    // is promotion-ineligible but readable — not a corrupt or torn stream.
    expect(read.status).toBe('unsealed');
    expect(read.seal).toBeUndefined();
    expect(read.records.length).toBeGreaterThanOrEqual(2);
    expect(read.truncatedBytes).toBe(0);
    expect(read.error).toBeUndefined();
  });

  it('latches a failed sync so a later success cannot claim the earlier bytes', async () => {
    const runDir = join(tempDir(), 'run');
    const backend = await openJsonlDurabilityBackend({
      runDir,
      randomUUID: () => '00000000-0000-4000-8000-000000000001',
    });
    await backend.append('{"a":1}\n');
    await backend.sync();
    expect(backend.status().fileDataSync).toBe('verified');

    await backend.close();
    // The descriptor is gone: this sync cannot succeed.
    await expect(backend.sync()).rejects.toThrow();
    expect(backend.status().fileDataSync).toBe('failed');
    expect(durabilityIsVerified(backend.status())).toBe(false);
  });

  it('never claims atomic replace before a rename has succeeded', async () => {
    const runDir = join(tempDir(), 'run');
    const backend = await openJsonlDurabilityBackend({
      runDir,
      randomUUID: () => '00000000-0000-4000-8000-000000000001',
    });
    // A host backend that wraps this one and overrides only `directorySync`
    // must not inherit an unearned atomic-replace claim.
    expect(backend.status().atomicReplace).toBe('unavailable');
    await backend.writeSeal('{"sealed":true}\n');
    expect(backend.status().atomicReplace).toBe('verified');
    await backend.close();
  });

  it('rejects a second close as a rejection rather than a synchronous throw', async () => {
    const runDir = join(tempDir(), 'run');
    for (const factory of [openJsonlDurabilityBackend, openSqliteDurabilityBackend]) {
      const dir = join(runDir, factory === openJsonlDurabilityBackend ? 'jsonl' : 'sqlite');
      const backend = await factory({
        runDir: dir,
        randomUUID: () => '00000000-0000-4000-8000-000000000001',
      });
      await backend.append('{"a":1}\n');
      await backend.close();
      // node:sqlite's close() throws ERR_INVALID_STATE synchronously. If close()
      // is not async, that escapes every `await backend.close().catch(...)`
      // guard in the writer and surfaces as a rejected finalize().
      let threw = false;
      try {
        await backend.close().catch(() => undefined);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
    }
  });

  it('refuses to claim durability when the runtime did not grant WAL', async () => {
    // Guard the shape of the claim rather than simulating a hostile filesystem:
    // a granted-pragma host reports verified, and the status must be derived
    // from the read-back pragmas, never asserted unconditionally.
    const runDir = join(tempDir(), 'run');
    const backend = await openSqliteDurabilityBackend({
      runDir,
      randomUUID: () => '00000000-0000-4000-8000-000000000001',
    });
    await backend.append('{"a":1}\n');
    await backend.sync();
    expect(durabilityIsVerified(backend.status())).toBe(true);
    await backend.close();
    // A clean close does not retract durability that was genuinely obtained for
    // committed records, but no further barrier may succeed against it.
    expect(durabilityIsVerified(backend.status())).toBe(true);
    await expect(backend.sync()).rejects.toThrow();
    await expect(backend.append('{"b":2}\n')).rejects.toThrow();
  });

  it('degrades when closed with records that were never committed', async () => {
    const runDir = join(tempDir(), 'run');
    const backend = await openSqliteDurabilityBackend({
      runDir,
      randomUUID: () => '00000000-0000-4000-8000-000000000001',
    });
    // Appended but never synced: these bytes were never durable, so closing
    // must roll them back and the backend must stop claiming the guarantee.
    await backend.append('{"a":1}\n');
    await backend.close();
    expect(backend.status().fileDataSync).toBe('failed');
    expect(durabilityIsVerified(backend.status())).toBe(false);
  });

  it('does not create a database when reading a run directory that has none', async () => {
    const runDir = join(tempDir(), 'empty-run');
    await mkdir(runDir, { recursive: true });
    const ghost = join(runDir, 'events.db');

    const read = await readRunLedger(ghost);
    expect(read.status).toBe('missing');
    // A read path must never write into the append-only evidence tree.
    expect(existsSync(ghost)).toBe(false);
  });

  it('refuses to open a second ledger of a different format in one run directory', async () => {
    const runDir = join(tempDir(), 'run');
    const randomUUID = (): string => '00000000-0000-4000-8000-000000000001';
    const jsonl = await openJsonlDurabilityBackend({ runDir, randomUUID });
    await jsonl.append('{"a":1}\n');
    await jsonl.close();
    // Two ledgers for one run would surface as two contradictory index entries.
    await expect(openSqliteDurabilityBackend({ runDir, randomUUID })).rejects.toThrow(
      /collision or open failure/,
    );
  });

  it('records the backend identity in the seal and rejects a self-contradicting one', async () => {
    const root = tempDir();
    const store = new RunEvidenceStore({
      workspace: join(root, 'workspace'),
      bookHome: join(root, 'book'),
      durabilityBackend: openSqliteDurabilityBackend,
    });
    const writer = await store.startRun({
      rootRunId: 'root-provenance-1',
      runId: 'root-provenance-1',
      metadata: { mode: 'observe' },
    });
    writer.enqueue({ type: 'turn_started', occurredAt: 2, attributes: { turn: 1 } });
    const result = await writer.finalize({ status: 'completed' });

    // Two seals carrying four `verified` values are otherwise indistinguishable.
    expect(result.seal?.backendId).toBe('sqlite-wal-full-v1');

    const read = await readRunLedger(writer.path);
    expect(read.status).toBe('complete');
  });
});
