import { generateKeyPairSync, sign as signBytes, verify as verifyBytes } from 'node:crypto';
import { canonicalJson, sha256Hex } from './canonical-json.js';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import type { KeyObject } from 'node:crypto';
import { join, dirname, relative, resolve } from 'node:path';
import {
  DURABILITY_POLICY_VERSION,
  LEDGER_FILENAMES,
  defaultSealPath,
  durabilityIsVerified,
  openJsonlDurabilityBackend,
  openLedgerSource,
  openSqliteDurabilityBackend,
} from './ledger-durability.js';
import type {
  DurabilityStatus,
  LedgerDurabilityBackend,
  LedgerDurabilityBackendFactory,
} from './ledger-durability.js';
import { resolveBookHome } from '../book-home.js';
import { workspaceIdentity } from '../tools/file-provenance.js';
import type {
  FinalizeRunInput,
  HarnessEvent,
  HarnessEventEnvelope,
  HarnessEventType,
  HarnessObserverFlushResult,
  HarnessPayloadClass,
  HarnessRunIdentity,
  HarnessTerminalStatus,
} from './contracts.js';
import {
  MAX_RECORD_BYTES,
  REDACTION_POLICY_VERSION,
  harnessTextRejectionReason,
  redactHarnessEvent,
  redactIdentity,
  safeHarnessIdentityValue,
  validSpanId,
  validTraceId,
} from './redaction.js';

export const LEDGER_SCHEMA_VERSION = 1 as const;
export const LEDGER_WRITER_VERSION = 'phase-2-v1';
export const GENESIS_HASH = '0'.repeat(64);
export {
  DURABILITY_POLICY_VERSION,
  durabilityIsVerified,
  openJsonlDurabilityBackend,
  openSqliteDurabilityBackend,
};
export type { DurabilityStatus, LedgerDurabilityBackend, LedgerDurabilityBackendFactory };
/** Reserved headroom so an accepted redacted body cannot overflow once enveloped. */
export const ENVELOPE_OVERHEAD_BYTES = 2_048;
export const DEFAULT_QUEUE_SIZE = 512;
export const DEFAULT_QUEUE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_SYNC_BYTES = 64 * 1024;
export const DEFAULT_SYNC_INTERVAL_MS = 50;
export const DEFAULT_FLUSH_TIMEOUT_MS = 2_000;
export const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

export type LedgerStatus = 'complete' | 'unsealed' | 'truncated-tail' | 'corrupt' | 'missing';

export interface RunLedgerMetadata {
  readonly mode: 'observe';
  readonly workflowId?: string;
  readonly workflowVersion?: number;
  readonly workflowSource?: string;
  readonly workflowReasonCode?: string;
  readonly workflowOverrideScope?: string;
  readonly workflowRegistryVersion?: number;
  readonly workflowRegistryDigest?: string;
  readonly workflowDefinitionDigest?: string;
  readonly workflowPolicyRenderVersion?: string;
  readonly workflowClampCount?: number;
  readonly workflowActiveFieldCount?: number;
  readonly workflowRenderedChars?: number;
  readonly workflowRequestedExtraCalls?: number;
  readonly model?: string;
  readonly provider?: string;
  readonly runtimeFingerprint?: string;
  readonly environmentFingerprint?: string;
  readonly toolSurfaceFingerprint?: string;
  readonly contextCapabilitiesVersion?: string;
  readonly capabilityManifestDigest?: string;
  readonly workspaceTrustFingerprint?: string;
  readonly integrationFingerprint?: string;
  readonly settingsFingerprint?: string;
  readonly componentReferences?: Readonly<Record<string, string>>;
}

export interface RunLedgerStartInput extends HarnessRunIdentity {
  readonly metadata: RunLedgerMetadata;
}

export interface LedgerCounters {
  readonly attemptedEventCount: number;
  readonly acceptedEventCount: number;
  readonly exportedEventCount: number;
  readonly droppedEventCount: number;
  readonly droppedEventBytes: number;
  readonly queueHighWaterCount: number;
  readonly queueHighWaterBytes: number;
  readonly storageErrors: readonly string[];
  readonly incomplete: boolean;
}

export interface RunLedgerSeal {
  readonly schemaVersion: 1;
  readonly writerVersion: string;
  readonly workspaceId: string;
  readonly rootRunId: string;
  readonly firstSequence: number;
  readonly lastSequence: number;
  readonly recordCount: number;
  readonly byteLength: number;
  readonly firstRecordHash: string;
  readonly lastRecordHash: string;
  readonly terminalStatus: HarnessTerminalStatus;
  readonly terminalEventId: string;
  readonly occurredAt: number;
  /**
   * Identity of the backend that made the durability claim below. Two seals
   * carrying four `verified` values are otherwise indistinguishable, so an
   * offline verifier needs to know which implementation asserted them.
   */
  readonly backendId: string;
  readonly durability: DurabilityStatus;
  readonly counters: LedgerCounters;
  readonly evidenceComplete: boolean;
  readonly evidenceEligibility: 'eligible' | 'ineligible';
  readonly sealDigest: string;
  readonly attestation: {
    readonly algorithm: 'ed25519';
    readonly publicKey: string;
    readonly signature: string;
    readonly keyScope: 'process';
  };
}

export interface LedgerReadResult {
  readonly path: string;
  readonly sealPath: string;
  readonly records: readonly HarnessEventEnvelope[];
  readonly seal?: RunLedgerSeal;
  readonly status: LedgerStatus;
  readonly validBytes: number;
  readonly invalidBytes: number;
  readonly truncatedBytes: number;
  readonly lastSequence: number;
  readonly lastRecordHash: string;
  readonly error?: string;
}

export interface RunIndexEntry {
  readonly rootRunId: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly sealPath: string;
  readonly status: LedgerStatus;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly terminalStatus?: HarnessTerminalStatus;
  readonly recordCount: number;
  readonly byteLength: number;
  readonly lastRecordHash: string;
  readonly evidenceComplete: boolean;
  readonly pinned: boolean;
}

export interface RunEvidencePin {
  readonly schemaVersion: 1;
  readonly evidencePacketId: string;
  readonly rootRunId: string;
  readonly workspaceId: string;
  readonly purpose: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly sealDigest: string;
}

export interface RunStoreOptions {
  readonly workspace: string;
  readonly bookHome?: string;
  readonly workspaceId?: string;
  readonly now?: () => number;
  readonly randomUUID?: () => string;
  readonly maxRecordBytes?: number;
  readonly maxQueueSize?: number;
  readonly maxQueueBytes?: number;
  readonly syncEveryBytes?: number;
  readonly syncIntervalMs?: number;
  readonly flushTimeoutMs?: number;
  readonly closeTimeoutMs?: number;
  /**
   * Durability backend factory. Defaults to the append-only JSONL writer, whose
   * seals stay `ineligible` because Node exposes no portable directory fsync.
   * A backend that verifies every guarantee makes eligible evidence reachable
   * without changing record framing, sequencing, or the hash chain.
   */
  readonly durabilityBackend?: LedgerDurabilityBackendFactory;
  /** Test/host hook. Errors are latched and never thrown through user callbacks. */
  readonly onStorageError?: (error: Error) => void;
}

export interface RunLedgerWriterOptions extends RunStoreOptions {
  readonly identity: RunLedgerStartInput;
}

export interface RunFinalizeResult extends HarnessObserverFlushResult {
  readonly seal?: RunLedgerSeal;
}

const canonicalize = canonicalJson;
const sha256 = sha256Hex;

export { canonicalJson };

export function hashLedgerRecord(record: Omit<HarnessEventEnvelope, 'recordHash'>): string {
  const body = canonicalize(record);
  return sha256(`book-harness-record-v1\0${record.previousRecordHash}\0${body}`);
}

function safeId(value: string): string {
  if (!safeHarnessIdentityValue(value)) throw new Error('Invalid harness run identity.');
  return value;
}

function validateStartIdentity(identity: RunLedgerStartInput): void {
  for (const value of [
    identity.workspaceId,
    identity.rootRunId,
    identity.runId,
    identity.parentRunId,
    identity.resumedFromRunId,
    identity.sessionId,
  ]) {
    if (value !== undefined && !safeHarnessIdentityValue(value)) {
      throw new Error('Invalid harness run identity.');
    }
  }
  if (!identity.workspaceId || !identity.rootRunId || !identity.runId) {
    throw new Error('Invalid harness run identity.');
  }
  if (identity.runId !== identity.rootRunId && !identity.parentRunId) {
    throw new Error('Invalid harness child identity.');
  }
}

async function boundedWait(
  promise: Promise<unknown>,
  durationMs: number,
): Promise<{ timedOut: boolean }> {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    await promise;
    return { timedOut: false };
  }
  return new Promise<{ timedOut: boolean }>((resolvePromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolvePromise({ timedOut: true });
      }
    }, durationMs);
    promise.then(
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolvePromise({ timedOut: false });
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolvePromise({ timedOut: false });
        }
      },
    );
  });
}

function statusEventType(status: HarnessTerminalStatus): HarnessEventType {
  if (status === 'completed') return 'run_completed';
  if (status === 'failed' || status === 'timed-out') return 'run_failed';
  return 'run_interrupted';
}

function safeMetadataValue(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const normalized = value.normalize('NFC').trim();
  if (harnessTextRejectionReason(normalized)) return undefined;
  return normalized;
}

function metadataProjection(metadata: RunLedgerMetadata): Record<string, unknown> {
  const result: Record<string, unknown> = {
    mode: metadata.mode,
    // A run with no selection keeps the Phase 2 `baseline` label.
    workflowId: safeMetadataValue(metadata.workflowId) ?? 'baseline',
  };
  for (const key of [
    'workflowVersion',
    'workflowSource',
    'workflowReasonCode',
    'workflowOverrideScope',
    'workflowRegistryVersion',
    'workflowRegistryDigest',
    'workflowDefinitionDigest',
    'workflowPolicyRenderVersion',
    'workflowClampCount',
    'workflowActiveFieldCount',
    'workflowRenderedChars',
    'workflowRequestedExtraCalls',
    'model',
    'provider',
    'runtimeFingerprint',
    'environmentFingerprint',
    'toolSurfaceFingerprint',
    'contextCapabilitiesVersion',
    'capabilityManifestDigest',
    'workspaceTrustFingerprint',
    'integrationFingerprint',
    'settingsFingerprint',
  ] as const) {
    const value = safeMetadataValue(metadata[key]);
    if (value !== undefined) result[key] = value;
  }
  if (metadata.componentReferences) {
    result.componentReferences = Object.fromEntries(
      Object.entries(metadata.componentReferences)
        .map(([key, value]) => [key, safeMetadataValue(value)] as const)
        .filter(
          (entry): entry is readonly [string, string | number] =>
            /^[a-z][a-zA-Z0-9_.-]{0,63}$/.test(entry[0]) && typeof entry[1] === 'string',
        )
        .slice(0, 32),
    );
  }
  return result;
}

export class RunLedgerWriter {
  readonly path: string;
  readonly sealPath: string;
  readonly identity: RunLedgerStartInput;
  readonly policy: Readonly<{
    maxQueueSize: number;
    maxQueueBytes: number;
    overflow: 'drop-newest';
    flushTimeoutMs: number;
    closeTimeoutMs: number;
  }>;
  private readonly backend: LedgerDurabilityBackend;
  private readonly options: RunLedgerWriterOptions;
  private readonly now: () => number;
  private readonly randomUUID: () => string;
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private queue: Array<{ event: ReturnType<typeof redactHarnessEvent>; bytes: number }> = [];
  private queueBytes = 0;
  private drainPromise: Promise<void> | null = null;
  private sequence = 0;
  private previousHash = GENESIS_HASH;
  private firstHash = GENESIS_HASH;
  private byteLength = 0;
  private attempted = 0;
  private accepted = 0;
  private exported = 0;
  private dropped = 0;
  private droppedBytes = 0;
  private highWaterCount = 0;
  private highWaterBytes = 0;
  private storageErrors: string[] = [];
  private incomplete = false;
  private state: 'open' | 'closing' | 'closed' | 'failed' = 'open';
  private childHandoffs = 0;
  private terminal?: { status: HarnessTerminalStatus; eventId: string };
  private seal?: RunLedgerSeal;
  private lastSyncAt = 0;
  private unsyncedBytes = 0;
  private lifecyclePromise: Promise<RunFinalizeResult> | null = null;

  private constructor(backend: LedgerDurabilityBackend, options: RunLedgerWriterOptions) {
    this.backend = backend;
    this.path = backend.path;
    this.sealPath = backend.sealPath;
    this.options = options;
    this.identity = options.identity;
    this.now = options.now ?? Date.now;
    this.randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
    const keys = generateKeyPairSync('ed25519');
    this.privateKey = keys.privateKey;
    this.publicKey = keys.publicKey;
    this.policy = Object.freeze({
      maxQueueSize: options.maxQueueSize ?? DEFAULT_QUEUE_SIZE,
      maxQueueBytes: options.maxQueueBytes ?? DEFAULT_QUEUE_BYTES,
      overflow: 'drop-newest' as const,
      flushTimeoutMs: options.flushTimeoutMs ?? DEFAULT_FLUSH_TIMEOUT_MS,
      closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
    });
  }

  static async open(options: RunLedgerWriterOptions): Promise<RunLedgerWriter> {
    validateStartIdentity(options.identity);
    const root = resolve(options.bookHome ?? resolveBookHome());
    const workspaceId = options.identity.workspaceId;
    const yearMonth = new Date(options.now?.() ?? Date.now()).toISOString().slice(0, 7);
    const runDir = join(
      root,
      'projects',
      workspaceId,
      'harness',
      'v1',
      'runs',
      yearMonth,
      safeId(options.identity.rootRunId),
    );
    const openBackend = options.durabilityBackend ?? openJsonlDurabilityBackend;
    const backend = await openBackend({
      runDir,
      randomUUID: options.randomUUID ?? (() => crypto.randomUUID()),
    });
    const writer = new RunLedgerWriter(backend, options);
    try {
      await writer.appendDirect({
        eventType: 'run_started',
        occurredAt: writer.now(),
        payloadClass: 'safe-metadata',
        data: {
          // Scalar identity projection only; the raw start input carries the
          // unprojected metadata object and must not enter the stream directly.
          identity: redactIdentity(options.identity),
          workflow: safeMetadataValue(options.identity.metadata.workflowId) ?? 'baseline',
          metadata: metadataProjection(options.identity.metadata),
          durability: DURABILITY_POLICY_VERSION,
          redactionPolicyVersion: REDACTION_POLICY_VERSION,
        },
      });
      await writer.sync();
      return writer;
    } catch (error) {
      await backend.close().catch(() => undefined);
      throw error;
    }
  }

  enqueue(
    event: HarnessEvent,
  ):
    | 'accepted'
    | 'dropped'
    | 'closed'
    | 'rejected'
    | { readonly status: 'accepted'; readonly sequence?: number }
    | { readonly status: 'dropped'; readonly reason: string; readonly droppedEventCount: number }
    | { readonly status: 'rejected'; readonly reason: string } {
    this.attempted += 1;
    if (this.state !== 'open') return { status: 'rejected', reason: this.state };
    let redacted: ReturnType<typeof redactHarnessEvent>;
    try {
      redacted = redactHarnessEvent(event);
    } catch {
      this.incomplete = true;
      this.dropped += 1;
      return { status: 'rejected', reason: 'invalid-event' };
    }
    const bytes = Buffer.byteLength(canonicalize(redacted), 'utf8') + 1;
    if (bytes + ENVELOPE_OVERHEAD_BYTES > (this.options.maxRecordBytes ?? MAX_RECORD_BYTES)) {
      this.incomplete = true;
      this.dropped += 1;
      this.droppedBytes += bytes;
      return { status: 'dropped', reason: 'record-byte-limit', droppedEventCount: this.dropped };
    }
    if (
      this.queue.length >= this.policy.maxQueueSize ||
      this.queueBytes + bytes > this.policy.maxQueueBytes
    ) {
      this.incomplete = true;
      this.dropped += 1;
      this.droppedBytes += bytes;
      return { status: 'dropped', reason: 'queue-limit', droppedEventCount: this.dropped };
    }
    this.queue.push({ event: redacted, bytes });
    this.accepted += 1;
    this.queueBytes += bytes;
    this.highWaterCount = Math.max(this.highWaterCount, this.queue.length);
    this.highWaterBytes = Math.max(this.highWaterBytes, this.queueBytes);
    this.scheduleDrain();
    return { status: 'accepted' };
  }

  append(event: HarnessEvent): Promise<boolean> {
    const result = this.enqueue(event);
    if (typeof result === 'string') return Promise.resolve(result === 'accepted');
    return Promise.resolve(result.status === 'accepted');
  }

  async flush(): Promise<HarnessObserverFlushResult> {
    if (this.lifecyclePromise) return this.lifecyclePromise;
    if (this.seal) return this.flushResult('closed', !this.incomplete);
    if ((this.state as string) === 'closed')
      return this.flushResult('closed', false, 'closed-without-seal');
    const deadline = Date.now() + this.policy.flushTimeoutMs;
    // Re-await the barrier while new drains are scheduled so "flushed" cannot be
    // claimed with accepted records still queued.
    while (this.drainPromise || (this.queue.length > 0 && this.state === 'open')) {
      if (Date.now() >= deadline) {
        this.incomplete = true;
        return this.flushResult('timed-out', false, 'flush-timeout');
      }
      if (!this.drainPromise) this.scheduleDrain();
      const barrier = this.drainPromise ?? Promise.resolve();
      const waited = await boundedWait(barrier, deadline - Date.now());
      if (waited.timedOut) {
        this.incomplete = true;
        return this.flushResult('timed-out', false, 'flush-timeout');
      }
      // Re-read: finalize/close on another task may have advanced the state
      // across the await, which control-flow narrowing cannot see.
      const state = this.state as 'open' | 'closing' | 'closed' | 'failed';
      if (state === 'failed' || state === 'closed') break;
    }
    if (this.seal) return this.flushResult('closed', !this.incomplete);
    if (this.state === 'closed') return this.flushResult('closed', false, 'closed-without-seal');
    if (this.state === 'failed') return this.flushResult('failed', false, 'storage-error');
    if (this.queue.length > 0) return this.flushResult('partial', false, 'queue-not-drained');
    try {
      await this.sync();
      return this.flushResult('flushed', true);
    } catch (error) {
      this.recordStorageError(error);
      return this.flushResult('failed', false, 'flush-failed');
    }
  }

  async finalize(input: FinalizeRunInput): Promise<RunFinalizeResult> {
    if (this.lifecyclePromise) {
      const result = await this.lifecyclePromise;
      if (result.seal && result.seal.terminalStatus !== input.status) {
        this.incomplete = true;
        return {
          ...this.flushResult('failed', false, 'conflicting-finalization'),
          seal: result.seal,
        };
      }
      return result;
    }
    this.lifecyclePromise = this.finalizeOnce(input);
    try {
      return await this.lifecyclePromise;
    } finally {
      this.lifecyclePromise = null;
    }
  }

  private async finalizeOnce(input: FinalizeRunInput): Promise<RunFinalizeResult> {
    if (this.seal) {
      if (this.seal.terminalStatus !== input.status) {
        this.incomplete = true;
        return {
          ...this.flushResult('failed', false, 'conflicting-finalization'),
          seal: this.seal,
        };
      }
      return { ...this.flushResult('closed', true), seal: this.seal };
    }
    if (this.state === 'failed') return this.flushResult('failed', false, 'storage-error');
    this.state = 'closing';
    // Closing prevents a new drain from being scheduled, but records already
    // accepted before the transition must still be fully written.
    while (this.drainPromise || this.queue.length > 0) {
      if (!this.drainPromise) this.scheduleDrain(true);
      const waited = await boundedWait(
        this.drainPromise ?? Promise.resolve(),
        this.policy.closeTimeoutMs,
      );
      if (waited.timedOut) {
        this.incomplete = true;
        this.state = 'failed';
        await this.backend.close().catch(() => undefined);
        return this.flushResult('timed-out', false, 'close-timeout');
      }
      if ((this.state as string) === 'failed')
        return this.flushResult('failed', false, 'storage-error');
    }
    const terminalEventId = this.randomUUID();
    try {
      const eventType = statusEventType(input.status);
      await this.appendDirect({
        eventType,
        occurredAt: this.now(),
        eventId: terminalEventId,
        payloadClass: 'safe-metadata',
        data: {
          status: input.status,
          reasonCode: safeReason(input.reasonCode),
          observer: this.counterProjection(),
          outcomeCount: input.outcomes?.length ?? 0,
          // Non-zero means linked continuation turns may follow this seal;
          // their evidence is bounded to what this stream captured.
          childHandoffCount: this.childHandoffs,
        },
      });
      this.terminal = { status: input.status, eventId: terminalEventId };
      await this.sync();
      const seal = await this.writeSeal(input.status, terminalEventId);
      this.seal = seal;
      this.state = 'closed';
      await this.backend.close().catch((error: unknown) => this.recordStorageError(error));
      return { ...this.flushResult('closed', !this.incomplete), seal };
    } catch (error) {
      this.recordStorageError(error);
      this.state = 'failed';
      await this.backend.close().catch(() => undefined);
      return this.flushResult('failed', false, 'finalize-failed');
    }
  }

  async close(): Promise<RunFinalizeResult> {
    if (this.lifecyclePromise) return this.lifecyclePromise;
    this.lifecyclePromise = this.closeOnce();
    try {
      return await this.lifecyclePromise;
    } finally {
      this.lifecyclePromise = null;
    }
  }

  private async closeOnce(): Promise<RunFinalizeResult> {
    if (this.seal) return { ...this.flushResult('closed', !this.incomplete), seal: this.seal };
    if (this.state === 'open' || this.state === 'failed') {
      this.state = 'closing';
      while (this.drainPromise || this.queue.length > 0) {
        if (!this.drainPromise) this.scheduleDrain(true);
        const waited = await boundedWait(
          this.drainPromise ?? Promise.resolve(),
          this.policy.closeTimeoutMs,
        );
        if (waited.timedOut) {
          this.incomplete = true;
          this.state = 'failed';
          break;
        }
      }
    }
    if (this.state !== 'closed') {
      await this.backend.close().catch((error: unknown) => this.recordStorageError(error));
      this.state = this.storageErrors.length > 0 ? 'failed' : 'closed';
    }
    return this.flushResult(
      'closed',
      false,
      this.storageErrors.length ? 'not-finalized' : undefined,
    );
  }

  getCounters(): LedgerCounters {
    return this.counterProjection();
  }

  getSeal(): RunLedgerSeal | undefined {
    return this.seal;
  }

  private counterProjection(): LedgerCounters {
    return {
      attemptedEventCount: this.attempted,
      acceptedEventCount: this.accepted,
      exportedEventCount: this.exported,
      droppedEventCount: this.dropped,
      droppedEventBytes: this.droppedBytes,
      queueHighWaterCount: this.highWaterCount,
      queueHighWaterBytes: this.highWaterBytes,
      storageErrors: [...this.storageErrors],
      incomplete: this.incomplete || this.storageErrors.length > 0,
    };
  }

  private flushResult(
    status: NonNullable<HarnessObserverFlushResult['status']>,
    flushed: boolean,
    failureReason?: string,
  ): HarnessObserverFlushResult {
    return {
      flushed,
      status,
      attemptedEventCount: this.attempted,
      acceptedEventCount: this.accepted,
      exportedEventCount: this.exported,
      droppedEventCount: this.dropped,
      incomplete: this.incomplete || this.storageErrors.length > 0,
      storageErrors: [...this.storageErrors],
      flushStatus: flushed ? 'durable' : 'not-durable',
      ...(failureReason ? { failureReason } : {}),
    };
  }

  private scheduleDrain(allowClosing = false): void {
    if (
      this.drainPromise ||
      (this.state !== 'open' && !(allowClosing && this.state === 'closing'))
    ) {
      return;
    }
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = null;
      if (this.queue.length > 0 && this.state === 'open') this.scheduleDrain();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && this.state !== 'failed' && this.state !== 'closed') {
      const item = this.queue.shift();
      if (!item) break;
      this.queueBytes -= item.bytes;
      try {
        await this.appendDirect({
          ...item.event,
          eventType: item.event.eventType,
          payloadClass: item.event.payloadClass,
          data: item.event.data,
        });
        this.exported += 1;
        const now = this.now();
        const interval = this.options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
        const threshold = this.options.syncEveryBytes ?? DEFAULT_SYNC_BYTES;
        if (this.unsyncedBytes >= threshold || now - this.lastSyncAt >= interval) await this.sync();
      } catch (error) {
        if (error instanceof OversizedRecordError) {
          // One oversized record is a visible drop, never a whole-stream failure.
          this.incomplete = true;
          this.dropped += 1;
          this.droppedBytes += item.bytes;
          continue;
        }
        this.recordStorageError(error);
        this.state = 'failed';
        // The in-flight record was accepted and is now lost with the queue.
        this.dropped += this.queue.length + 1;
        this.droppedBytes += item.bytes;
        this.queue = [];
        this.queueBytes = 0;
        break;
      }
    }
  }

  private async appendDirect(input: {
    eventType: HarnessEventType;
    occurredAt: number;
    eventId?: string;
    sourceClass?: import('./contracts.js').HarnessSourceClass;
    payloadClass: HarnessPayloadClass;
    traceId?: string;
    spanId?: string;
    parentSpanId?: string;
    runId?: string;
    parentRunId?: string;
    sessionId?: string;
    data: unknown;
  }): Promise<HarnessEventEnvelope> {
    const base = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      writerVersion: LEDGER_WRITER_VERSION,
      eventId: input.eventId ?? this.randomUUID(),
      workspaceId: this.identity.workspaceId,
      rootRunId: this.identity.rootRunId,
      runId: input.runId ?? this.identity.runId,
      ...((input.parentRunId ?? this.identity.parentRunId)
        ? { parentRunId: input.parentRunId ?? this.identity.parentRunId }
        : {}),
      ...(this.identity.resumedFromRunId
        ? { resumedFromRunId: this.identity.resumedFromRunId }
        : {}),
      ...((input.sessionId ?? this.identity.sessionId)
        ? { sessionId: input.sessionId ?? this.identity.sessionId }
        : {}),
      ...(validTraceId(input.traceId) ? { traceId: input.traceId } : {}),
      ...(validSpanId(input.spanId) ? { spanId: input.spanId } : {}),
      ...(validSpanId(input.parentSpanId) ? { parentSpanId: input.parentSpanId } : {}),
      sequence: ++this.sequence,
      occurredAt: input.occurredAt,
      observedAt: this.now(),
      eventType: input.eventType,
      payloadClass: input.payloadClass,
      ...(input.sourceClass ? { sourceClass: input.sourceClass } : {}),
      redactionPolicyVersion: REDACTION_POLICY_VERSION,
      data: input.data,
      previousRecordHash: this.previousHash,
    } satisfies Omit<HarnessEventEnvelope, 'recordHash'>;
    const recordHash = hashLedgerRecord(base);
    const envelope = { ...base, recordHash } as HarnessEventEnvelope;
    const line = `${canonicalize(envelope)}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    if (bytes > (this.options.maxRecordBytes ?? MAX_RECORD_BYTES)) {
      this.sequence -= 1;
      throw new OversizedRecordError();
    }
    await this.backend.append(line);
    this.previousHash = recordHash;
    if (this.sequence === 1) this.firstHash = recordHash;
    if (input.eventType === 'subagent_handoff_created') this.childHandoffs += 1;
    this.byteLength += bytes;
    this.unsyncedBytes += bytes;
    return envelope;
  }

  private async sync(): Promise<void> {
    await this.backend.sync();
    this.lastSyncAt = this.now();
    this.unsyncedBytes = 0;
  }

  private recordStorageError(error: unknown): void {
    // Persisted evidence may carry only a stable classification — never raw
    // exception text, which can embed file paths or other forbidden content.
    const source = error as { code?: unknown; syscall?: unknown } | undefined;
    const code =
      typeof source?.code === 'string' && /^[A-Z0-9_]{2,32}$/.test(source.code)
        ? source.code
        : undefined;
    const syscall =
      typeof source?.syscall === 'string' && /^[a-z_]{2,32}$/.test(source.syscall)
        ? source.syscall
        : undefined;
    const name =
      error instanceof Error && /^[A-Za-z0-9_]{1,64}$/.test(error.name) ? error.name : undefined;
    const safe = [code ?? name ?? 'unknown-storage-error', syscall].filter(Boolean).join(':');
    if (!this.storageErrors.includes(safe)) this.storageErrors.push(safe);
    this.incomplete = true;
    try {
      this.options.onStorageError?.(new Error(safe));
    } catch {
      // A host diagnostic callback is outside the evidence boundary and must
      // never affect the user run or writer state.
    }
  }

  private async writeSeal(
    status: HarnessTerminalStatus,
    terminalEventId: string,
  ): Promise<RunLedgerSeal> {
    const counters = this.counterProjection();
    const durability = this.backend.status();
    // One derivation, used by both fields: evidence is complete and eligible
    // only when nothing was lost, no storage error was latched, and the backend
    // itself verifies every durability guarantee it claims.
    const durableAndComplete =
      !this.incomplete && this.storageErrors.length === 0 && durabilityIsVerified(durability);
    const unsigned = {
      schemaVersion: 1 as const,
      writerVersion: LEDGER_WRITER_VERSION,
      workspaceId: this.identity.workspaceId,
      rootRunId: this.identity.rootRunId,
      firstSequence: 1,
      lastSequence: this.sequence,
      recordCount: this.sequence,
      byteLength: this.byteLength,
      firstRecordHash: this.firstHash,
      lastRecordHash: this.previousHash,
      terminalStatus: status,
      terminalEventId,
      occurredAt: this.now(),
      backendId: this.backend.id,
      durability,
      counters,
      evidenceComplete: durableAndComplete,
      evidenceEligibility: durableAndComplete ? ('eligible' as const) : ('ineligible' as const),
    };
    const sealDigest = sha256(canonicalize(unsigned));
    const signature = signBytes(
      null,
      Buffer.from(canonicalize(unsigned)),
      this.privateKey,
    ).toString('base64');
    const publicKey = this.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const seal = {
      ...unsigned,
      sealDigest,
      attestation: {
        algorithm: 'ed25519' as const,
        publicKey,
        signature,
        keyScope: 'process' as const,
      },
    } satisfies RunLedgerSeal;
    await this.backend.writeSeal(`${canonicalize(seal)}\n`);
    return seal;
  }
}

class OversizedRecordError extends Error {
  constructor() {
    super('oversized-ledger-record');
    this.name = 'OversizedRecordError';
  }
}

function safeReason(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return value
    .replace(/[\r\n]/g, ' ')
    .slice(0, 128)
    .replace(/[^a-zA-Z0-9_.:-]/g, '_');
}

export interface RunEvidenceStoreOptions extends RunStoreOptions {
  readonly indexLockTimeoutMs?: number;
}

export class RunEvidenceStore {
  readonly workspace: string;
  readonly workspaceId: string;
  readonly root: string;
  readonly harnessRoot: string;
  private readonly options: RunEvidenceStoreOptions;

  constructor(options: RunEvidenceStoreOptions) {
    this.workspace = resolve(options.workspace);
    this.workspaceId = options.workspaceId ?? workspaceIdentity(this.workspace);
    // Must resolve identically to RunLedgerWriter.open, or the authoritative
    // reader cannot find the streams its own writers produced.
    this.root = resolve(options.bookHome ?? resolveBookHome());
    this.harnessRoot = join(this.root, 'projects', this.workspaceId, 'harness', 'v1');
    this.options = { ...options, workspaceId: this.workspaceId };
  }

  async startRun(
    input: Omit<RunLedgerStartInput, 'workspaceId'> & { workspaceId?: string },
  ): Promise<RunLedgerWriter> {
    const rootRunId = input.rootRunId || input.runId;
    const identity: RunLedgerStartInput = {
      ...input,
      workspaceId: input.workspaceId ?? this.workspaceId,
      rootRunId,
      runId: input.runId || rootRunId,
    };
    return RunLedgerWriter.open({ ...this.options, identity });
  }

  async readRun(rootRunId: string): Promise<LedgerReadResult> {
    const events = await findRunFile(this.harnessRoot, rootRunId);
    if (!events) {
      return {
        path: '',
        sealPath: '',
        records: [],
        status: 'missing',
        validBytes: 0,
        invalidBytes: 0,
        truncatedBytes: 0,
        lastSequence: 0,
        lastRecordHash: GENESIS_HASH,
      };
    }
    return readRunLedger(events, defaultSealPath(events));
  }

  async rebuildIndex(): Promise<readonly RunIndexEntry[]> {
    const entries: RunIndexEntry[] = [];
    const now = this.options.now?.() ?? Date.now();
    const pinnedRunIds = new Set(
      (await this.readPins()).filter((pin) => pin.expiresAt > now).map((pin) => pin.rootRunId),
    );
    for (const events of await findEventFiles(this.harnessRoot)) {
      const result = await readRunLedger(events, defaultSealPath(events));
      const header = result.records[0];
      const terminal = result.records[result.records.length - 1];
      entries.push({
        rootRunId: String(header?.rootRunId ?? relative(this.harnessRoot, dirname(events))),
        workspaceId: this.workspaceId,
        path: events,
        sealPath: defaultSealPath(events),
        status: result.status,
        startedAt: header?.occurredAt,
        endedAt: terminal?.occurredAt,
        terminalStatus: result.seal?.terminalStatus,
        recordCount: result.records.length,
        byteLength: result.validBytes,
        lastRecordHash: result.lastRecordHash,
        evidenceComplete: result.seal?.evidenceComplete === true && result.status === 'complete',
        pinned: pinnedRunIds.has(String(header?.rootRunId)),
      });
    }
    entries.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    await mkdir(join(this.harnessRoot, 'index'), { recursive: true, mode: 0o700 });
    const indexPath = join(this.harnessRoot, 'index', 'index.v1.json');
    const temp = `${indexPath}.tmp-${this.options.randomUUID?.() ?? crypto.randomUUID()}`;
    await writeFile(temp, `${canonicalize({ schemaVersion: 1, entries })}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temp, indexPath);
    return entries;
  }

  async listRuns(limit = 50): Promise<readonly RunIndexEntry[]> {
    const indexPath = join(this.harnessRoot, 'index', 'index.v1.json');
    try {
      const parsed = JSON.parse(await readFile(indexPath, 'utf8')) as {
        schemaVersion?: number;
        entries?: RunIndexEntry[];
      };
      if (parsed.schemaVersion === 1 && Array.isArray(parsed.entries))
        return parsed.entries.slice(0, limit);
    } catch {
      // Rebuild below.
    }
    return (await this.rebuildIndex()).slice(0, limit);
  }

  async inspectRun(rootRunId: string): Promise<LedgerReadResult> {
    return this.readRun(rootRunId);
  }

  async storageInfo(): Promise<{ root: string; bytes: number; runCount: number }> {
    let bytes = 0;
    let runCount = 0;
    for (const file of await findEventFiles(this.harnessRoot)) {
      runCount += 1;
      try {
        bytes += (await stat(file)).size;
      } catch {
        /* raced cleanup */
      }
    }
    return { root: this.harnessRoot, bytes, runCount };
  }

  async deleteRun(rootRunId: string): Promise<boolean> {
    const events = await findRunFile(this.harnessRoot, rootRunId);
    if (!events) return false;
    await rm(dirname(events), { recursive: true, force: false });
    return true;
  }

  async cleanupRetention(
    options: { maxAgeMs?: number; now?: number; pinnedRunIds?: readonly string[] } = {},
  ): Promise<readonly string[]> {
    const now = options.now ?? this.options.now?.() ?? Date.now();
    const pinned = new Set(options.pinnedRunIds ?? []);
    // Persisted pins are retention authority on their own; callers need not re-list them.
    for (const pin of await this.readPins()) {
      if (pin.expiresAt > now) pinned.add(pin.rootRunId);
    }
    const removed: string[] = [];
    for (const entry of await this.listRuns(Number.MAX_SAFE_INTEGER)) {
      if (pinned.has(entry.rootRunId) || !entry.startedAt) continue;
      if (now - entry.startedAt < (options.maxAgeMs ?? 30 * 24 * 60 * 60 * 1000)) continue;
      try {
        await rm(dirname(entry.path), { recursive: true, force: false });
        removed.push(entry.rootRunId);
      } catch {
        /* preserve evidence on cleanup races/failures */
      }
    }
    if (removed.length > 0) await this.rebuildIndex();
    return removed;
  }

  private async readPins(): Promise<readonly RunEvidencePin[]> {
    const pins: RunEvidencePin[] = [];
    let entries: Dirent[];
    try {
      entries = await readdir(join(this.harnessRoot, 'pins'), { withFileTypes: true });
    } catch {
      return pins;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.pin.json')) continue;
      try {
        const parsed = JSON.parse(
          await readFile(join(this.harnessRoot, 'pins', entry.name), 'utf8'),
        ) as Partial<RunEvidencePin>;
        if (
          parsed.schemaVersion === 1 &&
          typeof parsed.evidencePacketId === 'string' &&
          typeof parsed.rootRunId === 'string' &&
          typeof parsed.workspaceId === 'string' &&
          parsed.workspaceId === this.workspaceId &&
          typeof parsed.purpose === 'string' &&
          typeof parsed.createdAt === 'number' &&
          Number.isFinite(parsed.createdAt) &&
          typeof parsed.expiresAt === 'number' &&
          Number.isFinite(parsed.expiresAt) &&
          typeof parsed.sealDigest === 'string' &&
          /^[0-9a-f]{64}$/.test(parsed.sealDigest)
        ) {
          pins.push(parsed as RunEvidencePin);
        }
      } catch {
        /* a malformed pin names no run to protect; skip it */
      }
    }
    return pins;
  }

  async createPin(input: {
    evidencePacketId: string;
    rootRunId: string;
    purpose: string;
    expiresAt: number;
  }): Promise<string> {
    if (!/^[A-Za-z0-9._~-]{8,128}$/.test(input.evidencePacketId))
      throw new Error('Invalid evidence packet ID.');
    const run = await this.readRun(input.rootRunId);
    if (!run.seal || run.status !== 'complete')
      throw new Error('Only complete sealed runs may be pinned.');
    if (
      !Number.isFinite(input.expiresAt) ||
      input.expiresAt <= (this.options.now?.() ?? Date.now())
    ) {
      throw new Error('Evidence pin expiry must be in the future.');
    }
    const pin: RunEvidencePin = {
      schemaVersion: 1,
      evidencePacketId: input.evidencePacketId,
      rootRunId: input.rootRunId,
      workspaceId: this.workspaceId,
      purpose: safeReason(input.purpose) ?? 'unspecified',
      createdAt: this.options.now?.() ?? Date.now(),
      expiresAt: input.expiresAt,
      sealDigest: run.seal.sealDigest,
    };
    const pins = join(this.harnessRoot, 'pins');
    await mkdir(pins, { recursive: true, mode: 0o700 });
    const path = join(pins, `${input.evidencePacketId}.pin.json`);
    await writeFile(path, `${canonicalize(pin)}\n`, { mode: 0o600, flag: 'wx' });
    return path;
  }
}

export async function readRunLedger(
  path: string,
  sealPath = defaultSealPath(path),
): Promise<LedgerReadResult> {
  const source = openLedgerSource(path, sealPath);
  let bytes: Buffer;
  try {
    bytes = await source.readRecordBytes();
  } catch (error) {
    return {
      path,
      sealPath,
      records: [],
      status: 'missing',
      validBytes: 0,
      invalidBytes: 0,
      truncatedBytes: 0,
      lastSequence: 0,
      lastRecordHash: GENESIS_HASH,
      error: String(error),
    };
  }
  const records: HarnessEventEnvelope[] = [];
  let offset = 0;
  let validBytes = 0;
  let invalidBytes = 0;
  let truncatedBytes = 0;
  let previous = GENESIS_HASH;
  let expected = 1;
  let error: string | undefined;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0) {
      truncatedBytes = bytes.length - offset;
      break;
    }
    const end = newline + 1;
    const lineBytes = bytes.subarray(offset, newline);
    offset = end;
    if (lineBytes.length === 0) {
      invalidBytes += 1;
      error = 'empty-record';
      break;
    }
    let parsed: HarnessEventEnvelope;
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(lineBytes);
      parsed = JSON.parse(decoded) as HarnessEventEnvelope;
      if (
        parsed.schemaVersion !== 1 ||
        canonicalize(parsed) !== decoded ||
        parsed.sequence !== expected ||
        parsed.previousRecordHash !== previous ||
        typeof parsed.eventId !== 'string' ||
        typeof parsed.workspaceId !== 'string' ||
        typeof parsed.rootRunId !== 'string' ||
        typeof parsed.runId !== 'string' ||
        !Number.isSafeInteger(parsed.occurredAt) ||
        !Number.isSafeInteger(parsed.observedAt)
      )
        throw new Error('sequence-or-schema-mismatch');
      const { recordHash, ...withoutHash } = parsed;
      if (hashLedgerRecord(withoutHash) !== recordHash) throw new Error('record-hash-mismatch');
    } catch (caught) {
      invalidBytes = bytes.length - (offset - lineBytes.length - 1);
      error = caught instanceof Error ? caught.message : 'invalid-record';
      break;
    }
    records.push(parsed);
    validBytes = offset;
    previous = parsed.recordHash;
    expected += 1;
  }
  let seal: RunLedgerSeal | undefined;
  let sealError: string | undefined;
  try {
    const sealText = await source.readSealText();
    try {
      const parsed = JSON.parse(sealText) as RunLedgerSeal;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('invalid-seal-shape');
      }
      const canonicalSeal = canonicalize(parsed);
      if (sealText !== canonicalSeal && sealText !== `${canonicalSeal}\n`) {
        throw new Error('non-canonical-seal');
      }
      seal = parsed;
    } catch (caught) {
      sealError = caught instanceof Error ? caught.message : 'invalid-seal';
    }
  } catch (caught) {
    const code = (caught as { code?: unknown } | undefined)?.code;
    // A missing seal is the normal state for an interrupted/unfinalized run;
    // other filesystem failures make the stream integrity-unknown.
    if (code !== 'ENOENT') sealError = 'seal-read-error';
  }
  let status: LedgerStatus = 'complete';
  if (error) status = 'corrupt';
  else if (sealError) status = 'corrupt';
  else if (truncatedBytes > 0) status = 'truncated-tail';
  else if (!seal) status = 'unsealed';
  else if (
    seal.workspaceId !== records[0]?.workspaceId ||
    seal.rootRunId !== records[0]?.rootRunId ||
    seal.firstSequence !== (records[0]?.sequence ?? 0) ||
    seal.lastSequence !== (records.at(-1)?.sequence ?? 0) ||
    seal.firstRecordHash !== (records[0]?.recordHash ?? GENESIS_HASH) ||
    seal.lastRecordHash !== previous ||
    seal.recordCount !== records.length ||
    seal.byteLength !== validBytes ||
    seal.terminalEventId !== records.at(-1)?.eventId ||
    statusEventType(seal.terminalStatus) !== records.at(-1)?.eventType ||
    // The eligibility fields must not contradict the durability status they
    // were derived from. The reader cannot confirm the guarantee itself — only
    // the writing host can — but completeness implies verified durability, and
    // the two eligibility fields come from one expression, so a seal that
    // disagrees with itself must not be trusted. Note this is an implication,
    // not an equivalence: dropped events make a run incomplete even when its
    // durability was fully verified.
    (seal.evidenceComplete && !durabilityIsVerified(seal.durability)) ||
    seal.evidenceComplete !== (seal.evidenceEligibility === 'eligible') ||
    typeof seal.backendId !== 'string' ||
    !verifySeal(seal)
  )
    status = 'corrupt';
  return {
    path,
    sealPath,
    records,
    seal,
    status,
    validBytes,
    invalidBytes,
    truncatedBytes,
    lastSequence: records.length ? records[records.length - 1]!.sequence : 0,
    lastRecordHash: previous,
    error: error ?? sealError,
  };
}

async function findEventFiles(root: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && (LEDGER_FILENAMES as readonly string[]).includes(entry.name))
        result.push(path);
    }
  }
  await visit(join(root, 'runs'));
  return result;
}

async function findRunFile(root: string, runId: string): Promise<string | undefined> {
  for (const path of await findEventFiles(root)) {
    try {
      const first = (await readRunLedger(path)).records[0];
      if (first?.rootRunId === runId) return path;
    } catch {
      /* ignore malformed paths */
    }
  }
  return undefined;
}

export function verifySeal(seal: RunLedgerSeal): boolean {
  if (!seal || typeof seal !== 'object') return false;
  const { attestation, sealDigest, ...unsignedAndDigest } = seal;
  if (
    seal.schemaVersion !== 1 ||
    !attestation ||
    typeof attestation !== 'object' ||
    attestation.algorithm !== 'ed25519' ||
    attestation.keyScope !== 'process' ||
    typeof attestation.publicKey !== 'string' ||
    typeof attestation.signature !== 'string' ||
    typeof sealDigest !== 'string' ||
    !/^[0-9a-f]{64}$/.test(sealDigest) ||
    typeof seal.firstRecordHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(seal.firstRecordHash) ||
    typeof seal.lastRecordHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(seal.lastRecordHash) ||
    !Number.isSafeInteger(seal.firstSequence) ||
    !Number.isSafeInteger(seal.lastSequence) ||
    seal.firstSequence !== 1 ||
    seal.lastSequence < seal.firstSequence ||
    seal.recordCount !== seal.lastSequence - seal.firstSequence + 1 ||
    !Number.isSafeInteger(seal.recordCount) ||
    !Number.isSafeInteger(seal.byteLength) ||
    seal.byteLength < 0 ||
    !Number.isFinite(seal.occurredAt)
  ) {
    return false;
  }
  try {
    const unsigned = { ...unsignedAndDigest } as Record<string, unknown>;
    const expectedDigest = sha256(canonicalize(unsigned));
    if (expectedDigest !== sealDigest) return false;
    return verifyBytes(
      null,
      Buffer.from(canonicalize(unsigned)),
      {
        key: Buffer.from(attestation.publicKey, 'base64'),
        format: 'der',
        type: 'spki',
      },
      Buffer.from(attestation.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

export const RunStore = RunEvidenceStore;
