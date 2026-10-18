import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { hostname as readHostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createDebugLogger } from '../debug-log.js';
import { resolveBookHome } from '../book-home.js';
import { pathExists } from '../fs-utils.js';
import { deriveAgentDisplayName } from './naming.js';
import { beginTerminalGeneration } from './completion-notification.js';
import { inSpawnerRun, migrateSpawnerClaim } from './spawner-claim.js';
import {
  AtomicJsonWriter,
  type AtomicJsonWriterOptions,
  type AtomicLockOwner,
  type AtomicWriteResult,
} from './atomic-json.js';
import type { AgentPlanRecord, AgentRecord, AgentSnapshot, EvidenceItem } from './types.js';

interface LegacyStoreState {
  version?: number;
  plans?: AgentPlanRecord[];
  agents?: AgentRecord[];
  evidence?: EvidenceItem[];
  snapshots?: AgentSnapshot[];
}

interface StoreManifest {
  version: 3;
}

interface StoreOwnerMetadata {
  schemaVersion: 1;
  instanceId: string;
  pid: number;
  hostname: string;
  processStartedAt: number;
}

interface PersistedAgentRecord extends AgentRecord {
  _store?: StoreOwnerMetadata;
  /**
   * The record-level pair a build from before per-run claims reads. Written from the claim for
   * as long as the claim covers the run the record is on; see {@link legacyDeliveryFlags}.
   */
  notifyParentOnCompletion?: boolean;
  resumeAfterRestart?: boolean;
}

interface InstanceLease extends StoreOwnerMetadata {
  heartbeatAt: number;
}

interface PendingWrite {
  target: string;
  value: unknown;
  targetType: string;
  agentId?: string;
  revision: LogicalRevision;
  tempPath?: string;
  retryIndex: number;
  permanent: boolean;
  timer?: NodeJS.Timeout;
  flushing: boolean;
}

interface LogicalRevision {
  primary: number;
  secondary: number;
  terminal: boolean;
}

interface TempCandidate {
  path: string;
  target: string;
  value: unknown;
  revision: LogicalRevision;
  mtimeMs: number;
  ownerInstanceId?: string;
}

export interface AgentStoreCleanup {
  agents: AgentRecord[];
  snapshots: AgentSnapshot[];
}

export interface AgentStorePersistenceEvent {
  type: 'agent_persistence';
  state: 'degraded' | 'recovered';
  reason: 'busy' | 'unavailable';
  errorCode?: string;
  message: string;
  agentId?: string;
  retrying: boolean;
  timestamp: number;
}

export interface AgentStoreOptions {
  instanceId?: string;
  pid?: number;
  hostname?: string;
  now?: () => number;
  processStartedAt?: number;
  heartbeatMs?: number;
  leaseFreshMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  processAlive?: (pid: number) => boolean;
  eventSink?: (event: AgentStorePersistenceEvent) => void;
  writer?: AtomicJsonWriter;
  writerOptions?: Omit<AtomicJsonWriterOptions, 'instanceId' | 'hostname'>;
}

export type AgentStoreWriteResult = AtomicWriteResult;

const log = createDebugLogger('agent-store');
const MANIFEST: StoreManifest = { version: 3 };
const DEFERRED_SAVE_MS = 100;
const HEARTBEAT_MS = 5_000;
const LEASE_FRESH_MS = 15_000;
const HEALTH_PROBE_MS = 60_000;
const RETRY_DELAYS_MS = [500, 1_000, 2_000, 5_000, 10_000];
const ACTIVE_STATUSES = new Set([
  'queued',
  'starting',
  'running',
  'waiting_input',
  'waiting_permission',
]);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted']);

function encodedName(id: string): string {
  return `${encodeURIComponent(id)}.json`;
}

function okResult(target: string): AtomicWriteResult {
  return { status: 'ok', target, attempts: 0, elapsedMs: 0 };
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

/** What a writer that threw instead of returning a result is reported as. */
function writeFailure(
  target: string,
  error: unknown,
): Extract<AtomicWriteResult, { status: 'unavailable' }> {
  return {
    status: 'unavailable',
    target,
    operation: 'write',
    errorCode: errorCode(error),
    message: 'Agent state storage failed.',
    attempts: 1,
    elapsedMs: 0,
  };
}

function withoutStoreMetadata(record: PersistedAgentRecord): AgentRecord {
  const publicRecord = { ...record };
  delete publicRecord._store;
  return publicRecord;
}

/**
 * The record-level delivery pair a build from before per-run claims reads, taken from the claim
 * for as long as the claim covers the run the record is on. An older Book shares this store: with
 * neither flag written, it treats a claimed `/review` agent as an ordinary one, re-narrates the
 * review, and re-runs its tasks. Past the claim the flags are absent, which is what that build
 * wants too. Written to the file only; the record in memory is the claim.
 */
function legacyDeliveryFlags(
  record: Pick<AgentRecord, 'runSequence' | 'spawnerClaim'>,
): Pick<PersistedAgentRecord, 'notifyParentOnCompletion' | 'resumeAfterRestart'> {
  const claim = inSpawnerRun(record) ? record.spawnerClaim : undefined;
  return {
    ...(claim?.notifyParent === false ? { notifyParentOnCompletion: false } : {}),
    ...(claim?.resumeAfterRestart === false ? { resumeAfterRestart: false } : {}),
  };
}

function compareRevision(left: LogicalRevision, right: LogicalRevision): number {
  if (left.primary !== right.primary) return left.primary - right.primary;
  if (left.secondary !== right.secondary) return left.secondary - right.secondary;
  return Number(left.terminal) - Number(right.terminal);
}

function logicalRevision(value: unknown, targetType: string): LogicalRevision {
  const record = value as Partial<AgentRecord & AgentPlanRecord & AgentSnapshot & EvidenceItem>;
  if (targetType === 'record' || targetType === 'summary') {
    return {
      primary: record.completionSequence ?? 0,
      secondary: record.updatedAt ?? record.createdAt ?? 0,
      terminal: TERMINAL_STATUSES.has(record.status ?? ''),
    };
  }
  if (targetType === 'manifest') return { primary: 0, secondary: 0, terminal: false };
  if (targetType === 'plan' || targetType === 'snapshot') {
    return { primary: record.createdAt ?? 0, secondary: 0, terminal: false };
  }
  return {
    primary: record.updatedAt ?? record.createdAt ?? 0,
    secondary: 0,
    terminal: false,
  };
}

function targetTypeFor(path: string): string {
  const parent = basename(dirname(path));
  if (basename(path) === 'state.json') return 'manifest';
  if (parent === 'records') return 'record';
  if (parent === 'summaries') return 'summary';
  if (parent === 'plans') return 'plan';
  if (parent === 'evidence') return 'evidence';
  if (parent === 'snapshots') return 'snapshot';
  if (parent === 'instances') return 'instance';
  return 'unknown';
}

export class AgentStore {
  readonly directory: string;
  readonly instanceId: string;
  private readonly statePath: string;
  private readonly agentsDirectory: string;
  private readonly agentSummariesDirectory: string;
  private readonly plansDirectory: string;
  private readonly evidenceDirectory: string;
  private readonly snapshotsDirectory: string;
  private readonly instancesDirectory: string;
  private readonly leasePath: string;
  private readonly pid: number;
  private readonly hostname: string;
  private readonly processStartedAt: number;
  private readonly heartbeatMs: number;
  private readonly leaseFreshMs: number;
  private readonly now: () => number;
  private readonly schedule: typeof setTimeout;
  private readonly cancel: typeof clearTimeout;
  private readonly processAlive: (pid: number) => boolean;
  private readonly eventSink?: (event: AgentStorePersistenceEvent) => void;
  private readonly writer: AtomicJsonWriter;
  private enabled: boolean;
  private disposed = false;
  /**
   * Set while {@link open} loads the store. The writes `load` finds it needs are queued rather than
   * made, and `open` flushes them on the thread pool once loading is done.
   */
  private opening = false;
  private heartbeatTimer?: NodeJS.Timeout;
  /**
   * The heartbeat write in flight, if any. See {@link refreshLease}: a tick that arrives while one
   * is running is skipped, and a dispose that arrives while one is running removes the lease after
   * it rather than before.
   */
  private leaseWrite?: Promise<void>;
  private persistenceState: 'healthy' | 'degraded_busy' | 'degraded_unavailable' = 'healthy';
  private readonly agents = new Map<string, AgentRecord>();
  private readonly agentOwners = new Map<string, StoreOwnerMetadata | undefined>();
  private readonly summaryAgentIds = new Set<string>();
  private readonly plans = new Map<string, AgentPlanRecord>();
  private readonly evidence = new Map<string, EvidenceItem>();
  private readonly snapshots = new Map<string, AgentSnapshot>();
  private readonly pendingWrites = new Map<string, PendingWrite>();

  /**
   * A store that has not touched the disk yet, and is not usable until it has: {@link open} is the
   * way to get one.
   */
  private constructor(
    repoHash: string,
    root: string,
    enabled: boolean,
    options: AgentStoreOptions,
  ) {
    this.directory = join(root, repoHash);
    this.statePath = join(this.directory, 'state.json');
    this.agentsDirectory = join(this.directory, 'records');
    this.agentSummariesDirectory = join(this.directory, 'summaries');
    this.plansDirectory = join(this.directory, 'plans');
    this.evidenceDirectory = join(this.directory, 'evidence');
    this.snapshotsDirectory = join(this.directory, 'snapshots');
    this.instancesDirectory = join(this.directory, 'instances');
    this.instanceId = options.instanceId ?? randomUUID();
    this.leasePath = join(this.instancesDirectory, `${this.instanceId}.json`);
    this.pid = options.pid ?? process.pid;
    this.hostname = options.hostname ?? readHostname();
    this.now = options.now ?? Date.now;
    this.processStartedAt =
      options.processStartedAt ?? this.now() - Math.floor(process.uptime() * 1000);
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
    this.leaseFreshMs = options.leaseFreshMs ?? LEASE_FRESH_MS;
    this.schedule = options.setTimeout ?? setTimeout;
    this.cancel = options.clearTimeout ?? clearTimeout;
    this.processAlive = options.processAlive ?? ((pid) => this.defaultProcessAlive(pid));
    this.eventSink = options.eventSink;
    this.enabled = enabled;
    this.writer =
      options.writer ??
      new AtomicJsonWriter({
        ...options.writerOptions,
        instanceId: this.instanceId,
        pid: this.pid,
        hostname: this.hostname,
        now: this.now,
        isLockOwnerAlive: (owner) => this.isLockOwnerAlive(owner),
        onStaleLock: (target) =>
          this.safeLog('stale lock reclaimed', { target: targetTypeFor(target) }),
      });
  }

  /**
   * Open the store for `repoHash` under `root`: create its directories, take this instance's lease
   * and start the heartbeat, then recover the temp files a crashed write left behind, load what is
   * persisted, and make the writes loading found it needed.
   *
   * All of that is on the thread pool. It is the first thing the TUI does after its first frame, and
   * done synchronously on a slow disk its `open`s and `fsync`s held the event loop for hundreds of
   * milliseconds: keys typed in that window arrived in one read and were taken for a paste (#516).
   *
   * The lease comes before the first read, because on the thread pool the reads no longer run in
   * one piece: a disposed manager's {@link recordLateApplication} can land between them. It
   * writes only when no other instance holds a live lease, so with the lease already on disk it
   * stands down; taken after loading, it found none, wrote a record this store had already read,
   * and this store's next save of that stale copy undid it.
   *
   * The promise resolves only once the lease is on disk, so no caller ever holds a store without one
   * (#357). A store whose directories cannot be created, or whose contents cannot be read, is not an
   * error: it resolves disabled, and runs in memory only.
   */
  static async open(
    repoHash: string,
    root = join(resolveBookHome(), 'agents'),
    enabled = true,
    options: AgentStoreOptions = {},
  ): Promise<AgentStore> {
    const store = new AgentStore(repoHash, root, enabled, options);
    await store.initialize();
    return store;
  }

  private async initialize(): Promise<void> {
    if (!this.enabled) return;
    try {
      await this.ensureDirectories();
    } catch {
      this.enabled = false;
      return;
    }
    await this.takeLease();
    // Armed now rather than once loading is done: a slow disk can take longer to load than the
    // lease stays fresh, and the lease is what keeps a late write away while it does.
    this.scheduleHeartbeat();
    this.opening = true;
    try {
      await this.recoverTemps();
      await this.load();
    } catch (error) {
      // A file that vanishes or cannot be read is skipped where it is read; what lands here is a
      // directory that could not be listed. The store is then one that cannot be read, so it runs
      // in memory like one whose directories could not be created, rather than leaving its caller
      // with an `open()` that rejected and a manager that can never initialize.
      this.disableAfterFailedLoad(error);
      return;
    } finally {
      this.opening = false;
    }
    for (const target of Array.from(this.pendingWrites.keys())) {
      await this.flushPendingAsync(target);
    }
  }

  /**
   * Turn an opening store whose contents could not be read into a disabled one: nothing of what it
   * read is kept, nothing it queued is written, and the lease it took is removed with its heartbeat,
   * since a disabled store writes nothing that a lease would speak for.
   */
  private disableAfterFailedLoad(error: unknown): void {
    this.safeLog('store load failed', { code: errorCode(error) });
    this.enabled = false;
    if (this.heartbeatTimer) this.cancel(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.pendingWrites.clear();
    this.agents.clear();
    this.agentOwners.clear();
    this.summaryAgentIds.clear();
    this.plans.clear();
    this.evidence.clear();
    this.snapshots.clear();
    this.removeLease();
    // As in `dispose()`: a heartbeat still running would put the lease back with its rename.
    const inFlight = this.leaseWrite;
    if (inFlight) {
      void inFlight.then(
        () => this.removeLease(),
        () => this.removeLease(),
      );
    }
  }

  private async ensureDirectories(): Promise<void> {
    for (const directory of [
      this.agentsDirectory,
      this.agentSummariesDirectory,
      this.plansDirectory,
      this.evidenceDirectory,
      this.snapshotsDirectory,
      this.instancesDirectory,
    ]) {
      await mkdir(directory, { recursive: true });
    }
  }

  private safeLog(event: string, metadata: Record<string, unknown>): void {
    try {
      log.event(event, metadata);
    } catch {
      // Diagnostics are never allowed to affect persistence.
    }
  }

  private quarantinePath(path: string): string {
    return `${path}.corrupt-${this.now()}`;
  }

  private quarantine(path: string): void {
    try {
      renameSync(path, this.quarantinePath(path));
    } catch {
      // Leave unreadable data in place if it cannot be quarantined.
    }
  }

  /** {@link quarantine}, on the thread pool, for what {@link open} reads. */
  private async quarantineAsync(path: string): Promise<void> {
    try {
      await rename(path, this.quarantinePath(path));
    } catch {
      // Leave unreadable data in place if it cannot be quarantined.
    }
  }

  private readJson<T>(path: string, quarantine = true): T | undefined {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
      if (quarantine) this.quarantine(path);
      return undefined;
    }
  }

  /** {@link readJson}, on the thread pool, for what {@link open} reads. */
  private async readJsonAsync<T>(path: string, quarantine = true): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T;
    } catch {
      if (quarantine) await this.quarantineAsync(path);
      return undefined;
    }
  }

  private targetMatchesId(path: string, value: { id?: string }): boolean {
    const type = targetTypeFor(path);
    if (!['record', 'summary', 'plan', 'evidence', 'snapshot'].includes(type)) return true;
    try {
      return value.id === decodeURIComponent(basename(path).replace(/\.json$/, ''));
    } catch {
      return false;
    }
  }

  private async loadDirectory<T extends { id: string }>(
    directory: string,
    target: Map<string, T>,
    migrate?: (value: T) => T,
  ): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(directory, entry.name);
      const value = await this.readJsonAsync<T>(path);
      if (!value?.id || !this.targetMatchesId(path, value)) {
        if (value) await this.quarantineAsync(path);
        continue;
      }
      const resolved = migrate ? migrate(value) : value;
      target.set(resolved.id, resolved);
    }
  }

  /**
   * Read what is persisted into memory. Runs only inside {@link open}, so the writes it finds it
   * needs are queued, and `open` makes them once it is done.
   */
  private async load(): Promise<void> {
    let legacy: LegacyStoreState | undefined;
    // Whether the manifest is still on disk once read: one that could not be parsed was quarantined.
    let manifestPresent = false;
    if (await pathExists(this.statePath)) {
      const parsed = await this.readJsonAsync<LegacyStoreState>(this.statePath);
      manifestPresent = parsed !== undefined;
      if (parsed?.version !== 3) legacy = parsed;
    }

    for (const entry of await readdir(this.agentSummariesDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(this.agentSummariesDirectory, entry.name);
      const persisted = await this.readJsonAsync<PersistedAgentRecord>(path);
      if (!persisted?.id || !this.targetMatchesId(path, persisted)) {
        if (persisted) await this.quarantineAsync(path);
        continue;
      }
      const migrated = this.migrateAgent(withoutStoreMetadata(persisted));
      this.agents.set(migrated.id, migrated);
      this.agentOwners.set(migrated.id, persisted._store);
      this.summaryAgentIds.add(migrated.id);
    }

    for (const entry of await readdir(this.agentsDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(this.agentsDirectory, entry.name);
      const persisted = await this.readJsonAsync<PersistedAgentRecord>(path);
      if (!persisted?.id || !this.targetMatchesId(path, persisted)) {
        if (persisted) await this.quarantineAsync(path);
        continue;
      }
      const detailed = this.migrateAgent(withoutStoreMetadata(persisted));
      const summary = this.agents.get(detailed.id);
      if (
        !summary ||
        compareRevision(logicalRevision(detailed, 'record'), logicalRevision(summary, 'summary')) >=
          0
      ) {
        this.agents.set(detailed.id, this.agentSummary(detailed));
        this.agentOwners.set(detailed.id, persisted._store);
        this.summaryAgentIds.add(detailed.id);
        this.queueWrite(
          this.agentSummaryPath(detailed.id),
          this.persistedAgent(this.agentSummary(detailed), persisted._store),
          {
            targetType: 'summary',
            agentId: detailed.id,
            immediate: true,
          },
        );
      }
    }
    await this.loadDirectory(this.plansDirectory, this.plans);
    await this.loadDirectory(this.evidenceDirectory, this.evidence);
    await this.loadDirectory(this.snapshotsDirectory, this.snapshots);

    if (legacy) {
      for (const agent of legacy.agents ?? []) {
        const migrated = this.migrateAgent(agent);
        if (!this.agents.has(migrated.id)) this.agents.set(migrated.id, migrated);
      }
      for (const plan of legacy.plans ?? [])
        if (!this.plans.has(plan.id)) this.plans.set(plan.id, plan);
      for (const item of legacy.evidence ?? [])
        if (!this.evidence.has(item.id)) this.evidence.set(item.id, item);
      for (const snapshot of legacy.snapshots ?? [])
        if (!this.snapshots.has(snapshot.id)) this.snapshots.set(snapshot.id, snapshot);
      this.flushAll();
    } else if (!manifestPresent) {
      this.queueWrite(this.statePath, MANIFEST, { targetType: 'manifest', immediate: true });
    }
  }

  private migrateAgent(record: AgentRecord): AgentRecord {
    const profile = record.profile ?? record.name ?? 'unknown';
    const purpose = record.purpose ?? record.prompt ?? '';
    const terminal = TERMINAL_STATUSES.has(record.status);
    const hasCompletionSequence = record.completionSequence !== undefined;
    const completionSequence = record.completionSequence ?? (terminal ? 1 : 0);
    return migrateSpawnerClaim({
      ...record,
      profile,
      displayName: record.displayName ?? deriveAgentDisplayName(purpose, record.name ?? profile),
      profileDescription: record.profileDescription ?? record.description ?? profile,
      purpose,
      resolvedModel: record.resolvedModel ?? 'unknown',
      isolation: record.isolation ?? 'worktree',
      name: record.name ?? profile,
      description: record.description ?? record.profileDescription ?? profile,
      producedEvidenceIds: record.producedEvidenceIds ?? [],
      finishedAt: terminal ? (record.finishedAt ?? record.updatedAt) : record.finishedAt,
      completionSequence,
      completionDeliveredSequence:
        record.completionDeliveredSequence ?? (hasCompletionSequence ? 0 : completionSequence),
    });
  }

  private agentPath(id: string): string {
    return join(this.agentsDirectory, encodedName(id));
  }

  private agentSummaryPath(id: string): string {
    return join(this.agentSummariesDirectory, encodedName(id));
  }

  private agentSummary(agent: AgentRecord): AgentRecord {
    return structuredClone({ ...agent, transcript: [] });
  }

  private planPath(id: string): string {
    return join(this.plansDirectory, encodedName(id));
  }

  private evidencePath(id: string): string {
    return join(this.evidenceDirectory, encodedName(id));
  }

  private snapshotPath(id: string): string {
    return join(this.snapshotsDirectory, encodedName(id));
  }

  private ownerMetadata(): StoreOwnerMetadata {
    return {
      schemaVersion: 1,
      instanceId: this.instanceId,
      pid: this.pid,
      hostname: this.hostname,
      processStartedAt: this.processStartedAt,
    };
  }

  private persistedAgent(agent: AgentRecord, owner = this.ownerMetadata()): PersistedAgentRecord {
    return { ...structuredClone(agent), _store: owner };
  }

  private discardFailedRequiredWrite(result: AtomicWriteResult): AtomicWriteResult {
    // A `cancelled` write is not here: it removed its own temp file on the way out, because its
    // caller asked for it not to land, and there is no half-written file to clean up.
    if (result.status === 'ok' || result.status === 'cancelled' || !result.tempPath) return result;
    try {
      unlinkSync(result.tempPath);
    } catch {
      // Recovery validates revisions and ownership if a rollback temp cannot be removed.
    }
    return result;
  }

  private cancelPendingWrite(target: string): void {
    const pending = this.pendingWrites.get(target);
    if (pending?.timer) this.cancel(pending.timer);
    if (pending?.tempPath) {
      try {
        unlinkSync(pending.tempPath);
      } catch {
        // Recovery will validate ownership if a cancelled temp cannot be removed.
      }
    }
    this.pendingWrites.delete(target);
  }

  private queueWrite(
    target: string,
    value: unknown,
    options: { targetType: string; agentId?: string; immediate?: boolean; delayMs?: number },
  ): AtomicWriteResult {
    if (!this.enabled) return okResult(target);
    const revision = logicalRevision(value, options.targetType);
    const current = this.pendingWrites.get(target);
    if (current && compareRevision(revision, current.revision) < 0) return okResult(target);
    if (current?.timer) this.cancel(current.timer);
    if (current?.tempPath) {
      try {
        unlinkSync(current.tempPath);
      } catch {
        // Recovery will discard the superseded complete temp if it cannot be removed now.
      }
    }
    const pending: PendingWrite = {
      target,
      value: structuredClone(value),
      targetType: options.targetType,
      agentId: options.agentId,
      revision,
      tempPath: undefined,
      retryIndex: current?.retryIndex ?? 0,
      permanent: false,
      flushing: current?.flushing ?? false,
    };
    this.pendingWrites.set(target, pending);
    // Opening flushes everything queued while it loads, on the thread pool; see `initialize`.
    if (this.opening) return okResult(target);
    if (options.immediate) return this.flushPending(target);
    this.schedulePending(pending, options.delayMs ?? DEFERRED_SAVE_MS);
    return okResult(target);
  }

  private flushPending(target: string): AtomicWriteResult {
    const pending = this.beginFlush(target);
    if (!pending) return okResult(target);
    let result: Exclude<AtomicWriteResult, { status: 'cancelled' }>;
    try {
      result = this.writer.write(target, pending.value, pending.tempPath);
    } catch (error) {
      result = writeFailure(target, error);
    }
    return this.finishFlush(pending, result);
  }

  /** {@link flushPending} on the thread pool: the writes {@link open} makes. */
  private async flushPendingAsync(target: string): Promise<AtomicWriteResult> {
    const pending = this.beginFlush(target);
    if (!pending) return okResult(target);
    let result: Exclude<AtomicWriteResult, { status: 'cancelled' }>;
    try {
      result = await this.writer.writeAsync(target, pending.value, {
        preparedTemp: pending.tempPath,
      });
    } catch (error) {
      result = writeFailure(target, error);
    }
    return this.finishFlush(pending, result);
  }

  private beginFlush(target: string): PendingWrite | undefined {
    const pending = this.pendingWrites.get(target);
    if (!pending || pending.flushing) return undefined;
    pending.flushing = true;
    return pending;
  }

  /** What both flushes do with the result: settle the pending write, or schedule its retry. */
  private finishFlush(
    pending: PendingWrite,
    result: Exclude<AtomicWriteResult, { status: 'cancelled' }>,
  ): AtomicWriteResult {
    const target = pending.target;
    pending.flushing = false;
    if (result.status === 'ok') {
      this.pendingWrites.delete(target);
      if (pending.retryIndex > 0 || result.attempts > 1) {
        this.safeLog('retry succeeded', {
          target: pending.targetType,
          attempts: result.attempts,
          scheduledRetries: pending.retryIndex,
        });
      }
      this.maybeRecover();
      return result;
    }

    pending.tempPath = result.tempPath;
    pending.permanent = result.status === 'unavailable';
    pending.retryIndex++;
    this.enterDegraded(result, pending);
    const delay = pending.permanent
      ? HEALTH_PROBE_MS
      : (RETRY_DELAYS_MS[Math.min(pending.retryIndex - 1, RETRY_DELAYS_MS.length - 1)] ?? 10_000);
    this.schedulePending(pending, delay);
    this.safeLog('retry scheduled', {
      code: result.status === 'unavailable' ? result.errorCode : 'busy',
      operation: result.operation,
      attempts: result.attempts,
      waitedMs: result.elapsedMs,
      target: pending.targetType,
    });
    return result;
  }

  private schedulePending(pending: PendingWrite, delay: number): void {
    if (this.disposed || pending.timer) return;
    pending.timer = this.schedule(() => {
      pending.timer = undefined;
      try {
        this.flushPending(pending.target);
      } catch {
        // Timer callbacks are a hard non-throw boundary.
      }
    }, delay);
    pending.timer.unref?.();
  }

  private enterDegraded(
    result: Exclude<AtomicWriteResult, { status: 'ok' }>,
    pending: PendingWrite,
  ): void {
    const next = result.status === 'busy' ? 'degraded_busy' : 'degraded_unavailable';
    if (this.persistenceState !== 'healthy') return;
    this.persistenceState = next;
    const reason = result.status === 'busy' ? 'busy' : 'unavailable';
    this.safeLog('persistence degraded', { reason, target: pending.targetType });
    try {
      this.eventSink?.({
        type: 'agent_persistence',
        state: 'degraded',
        reason,
        errorCode: result.status === 'unavailable' ? result.errorCode : undefined,
        message:
          reason === 'busy'
            ? 'Agent state storage is temporarily busy. Running work continues in memory while Book retries.'
            : 'Agent state storage is unavailable. Running work continues in memory.',
        agentId: pending.agentId,
        retrying: true,
        timestamp: this.now(),
      });
    } catch {
      // Host event sinks are non-fatal.
    }
  }

  private maybeRecover(): void {
    if (this.persistenceState === 'healthy' || this.pendingWrites.size > 0) return;
    const previous = this.persistenceState;
    this.persistenceState = 'healthy';
    this.safeLog('persistence recovered', {});
    try {
      this.eventSink?.({
        type: 'agent_persistence',
        state: 'recovered',
        reason: previous === 'degraded_busy' ? 'busy' : 'unavailable',
        message: 'Agent state storage has recovered.',
        retrying: false,
        timestamp: this.now(),
      });
    } catch {
      // Host event sinks are non-fatal.
    }
  }

  private flushAll(): void {
    this.queueWrite(this.statePath, MANIFEST, { targetType: 'manifest', immediate: true });
    for (const agent of this.agents.values()) this.saveAgent(agent, { defer: false });
    for (const plan of this.plans.values())
      this.queueWrite(this.planPath(plan.id), plan, { targetType: 'plan', immediate: true });
    for (const item of this.evidence.values())
      this.queueWrite(this.evidencePath(item.id), item, {
        targetType: 'evidence',
        immediate: true,
      });
    for (const snapshot of this.snapshots.values())
      this.queueWrite(this.snapshotPath(snapshot.id), snapshot, {
        targetType: 'snapshot',
        immediate: true,
      });
  }

  listAgents(): AgentRecord[] {
    this.refreshForeignSummaries();
    return Array.from(this.agents.values(), (agent) => {
      this.summaryAgentIds.add(agent.id);
      return this.agentSummary(agent);
    });
  }

  loadAgent(id: string): AgentRecord | undefined {
    const path = this.agentPath(id);
    const persisted = this.readJson<PersistedAgentRecord>(path);
    if (!persisted?.id || !this.targetMatchesId(path, persisted)) return undefined;
    const migrated = this.migrateAgent(withoutStoreMetadata(persisted));
    const current = this.agents.get(id);
    if (
      current &&
      compareRevision(logicalRevision(current, 'summary'), logicalRevision(migrated, 'record')) > 0
    ) {
      return structuredClone(current);
    }
    this.agents.set(id, migrated);
    this.agentOwners.set(id, persisted._store);
    this.summaryAgentIds.delete(id);
    return structuredClone(migrated);
  }

  listPlans(): AgentPlanRecord[] {
    return structuredClone(Array.from(this.plans.values()));
  }

  listEvidence(): EvidenceItem[] {
    return structuredClone(Array.from(this.evidence.values()));
  }

  listSnapshots(): AgentSnapshot[] {
    return structuredClone(Array.from(this.snapshots.values()));
  }

  saveAgent(
    agent: AgentRecord,
    options: { defer?: boolean; required?: boolean } = {},
  ): AtomicWriteResult {
    // A disposed store has flushed what it had pending and removed its lease: a record saved now
    // would be a write by an owner that is gone. Refused here, and only here, because `dispose()`
    // itself runs `flushPending`, which is not a save. The cache is left alone for the same reason.
    // The one fact that can still need writing then is {@link recordLateApplication}'s.
    if (this.disposed) {
      return { status: 'cancelled', target: this.agentPath(agent.id), attempts: 0, elapsedMs: 0 };
    }
    let persisted = structuredClone(agent);
    if (this.summaryAgentIds.has(agent.id)) {
      const detailed = this.readJson<PersistedAgentRecord>(this.agentPath(agent.id), false);
      if (detailed) {
        const migrated = this.migrateAgent(withoutStoreMetadata(detailed));
        persisted = {
          ...migrated,
          ...persisted,
          transcript: persisted.transcript.length > 0 ? persisted.transcript : migrated.transcript,
        };
      }
    }
    const owner = this.ownerMetadata();
    const legacy = legacyDeliveryFlags(agent);
    const detailed: PersistedAgentRecord = { ...this.persistedAgent(persisted, owner), ...legacy };
    const summary: PersistedAgentRecord = {
      ...this.persistedAgent(this.agentSummary(persisted), owner),
      ...legacy,
    };
    if (options.required) {
      this.cancelPendingWrite(this.agentPath(agent.id));
      this.cancelPendingWrite(this.agentSummaryPath(agent.id));
      const result = this.enabled
        ? this.writer.write(this.agentPath(agent.id), detailed)
        : okResult(this.agentPath(agent.id));
      if (result.status !== 'ok') return this.discardFailedRequiredWrite(result);
      this.agents.set(agent.id, persisted);
      this.agentOwners.set(agent.id, owner);
      this.summaryAgentIds.delete(agent.id);
      this.queueWrite(this.agentSummaryPath(agent.id), summary, {
        targetType: 'summary',
        agentId: agent.id,
        immediate: true,
      });
      return result;
    }

    this.agents.set(agent.id, persisted);
    this.agentOwners.set(agent.id, owner);
    this.summaryAgentIds.delete(agent.id);
    const immediate = options.defer !== true;
    const result = this.queueWrite(this.agentPath(agent.id), detailed, {
      targetType: 'record',
      agentId: agent.id,
      immediate,
    });
    this.queueWrite(this.agentSummaryPath(agent.id), summary, {
      targetType: 'summary',
      agentId: agent.id,
      immediate,
    });
    return result;
  }

  /**
   * Record on disk how an apply that outlived its manager ended: the one fact that can only be
   * known after this store was disposed. A pick that finished after `dispose()` is on the
   * operator's branch, and nothing else records that.
   *
   * The session's next manager may have opened this store's directory by then and written the
   * same record (#518), so this is a field-level update rather than a save of the disposed
   * manager's copy: the record is re-read from disk and only its `applicationStatus` changes, with
   * the owner and `updatedAt` stamped as every write stamps them. Written to disk only, since the
   * disposed store's cache has no reader left.
   *
   * Nothing is written, and the record is left as it is, when another instance holds a live lease
   * here (the record is its to write now), when the record on disk is newer than `seenUpdatedAt`,
   * the `updatedAt` of the copy the disposed manager last had (someone wrote it since), or when
   * the record is not on disk.
   *
   * That is decided twice: once before the write, and again immediately before each rename, which
   * is the step that changes the file. Between the two are a lock, a temp file and its fsync, and a
   * save by the next manager or another process can land in that window (its writer reclaims the
   * lock of a store that is gone); the copy read before it would otherwise be renamed over it.
   */
  async recordLateApplication(
    agentId: string,
    status: AgentRecord['applicationStatus'],
    seenUpdatedAt: number,
  ): Promise<'recorded' | 'skipped' | 'failed'> {
    if (!this.enabled) return 'skipped';
    const path = this.agentPath(agentId);
    try {
      if (await this.anotherInstanceIsLive()) {
        this.safeLog('late application skipped', { reason: 'live_instance' });
        return 'skipped';
      }
      const persisted = await this.readJsonAsync<PersistedAgentRecord>(path, false);
      if (!persisted?.id || !this.targetMatchesId(path, persisted)) {
        this.safeLog('late application skipped', { reason: 'missing' });
        return 'skipped';
      }
      if ((persisted.updatedAt ?? 0) > seenUpdatedAt) {
        this.safeLog('late application skipped', { reason: 'newer_on_disk' });
        return 'skipped';
      }
      const detailed: PersistedAgentRecord = {
        ...persisted,
        applicationStatus: status,
        updatedAt: this.now(),
        _store: this.ownerMetadata(),
      };
      // Why the write was withdrawn at its rename, for the log line.
      let withdrawn: string | undefined;
      const unlessConflict = (newestAllowed: number) => () => {
        withdrawn = this.lateWriteConflict(path, newestAllowed);
        return withdrawn === undefined;
      };
      const record = await this.writer.writeAsync(path, detailed, {
        canCommit: unlessConflict(seenUpdatedAt),
      });
      const notRecorded = this.lateWriteSetback('record', record, withdrawn);
      if (notRecorded) return notRecorded;
      // By now the record on disk is the one just written, unless something has replaced it.
      const summary = await this.writer.writeAsync(
        this.agentSummaryPath(agentId),
        { ...detailed, transcript: [] },
        { canCommit: unlessConflict(detailed.updatedAt) },
      );
      return this.lateWriteSetback('summary', summary, withdrawn) ?? 'recorded';
    } catch (error) {
      this.safeLog('late application failed', { code: errorCode(error) });
      return 'failed';
    }
  }

  /**
   * What one write of {@link recordLateApplication} not landing makes of it, logged without any of
   * the record's content; `undefined` when the write landed.
   */
  private lateWriteSetback(
    target: 'record' | 'summary',
    result: AtomicWriteResult,
    withdrawn: string | undefined,
  ): 'skipped' | 'failed' | undefined {
    if (result.status === 'ok') return undefined;
    if (result.status === 'cancelled') {
      this.safeLog('late application skipped', { reason: withdrawn, target });
      return 'skipped';
    }
    this.safeLog('late application failed', {
      target,
      status: result.status,
      operation: result.operation,
      code: result.status === 'unavailable' ? result.errorCode : undefined,
    });
    // A temp left behind would be promoted by the next open, past every check made here.
    this.discardFailedRequiredWrite(result);
    return 'failed';
  }

  /**
   * Why a late write to the record at `path` must not land now, or `undefined` if it may: the skip
   * rule of {@link recordLateApplication}, with `newestAllowed` the `updatedAt` the record on disk
   * may have. Synchronous, because it is asked as the `canCommit` of a write, and an answer that
   * waited for the thread pool would be one the rename no longer immediately follows. It is a
   * directory listing and a few small reads, once per late apply.
   */
  private lateWriteConflict(path: string, newestAllowed: number): string | undefined {
    try {
      const leases = readdirSync(this.instancesDirectory, { withFileTypes: true });
      for (const entry of leases) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const lease = this.readJson<InstanceLease>(
          join(this.instancesDirectory, entry.name),
          false,
        );
        if (this.isLiveForeignLease(lease)) return 'live_instance';
      }
    } catch {
      // A lease directory that cannot be listed is not one that can be said to be free.
      return 'unreadable';
    }
    const persisted = this.readJson<PersistedAgentRecord>(path, false);
    if (!persisted?.id || !this.targetMatchesId(path, persisted)) return 'missing';
    if ((persisted.updatedAt ?? 0) > newestAllowed) return 'newer_on_disk';
    return undefined;
  }

  /** Whether an instance other than this one holds a live lease in `instances/`. */
  private async anotherInstanceIsLive(): Promise<boolean> {
    for (const entry of await readdir(this.instancesDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const lease = await this.readJsonAsync<InstanceLease>(
        join(this.instancesDirectory, entry.name),
        false,
      );
      if (this.isLiveForeignLease(lease)) return true;
    }
    return false;
  }

  /** Whether `lease`, as read from `instances/`, is another instance's, and live. */
  private isLiveForeignLease(lease: InstanceLease | undefined): boolean {
    if (!lease?.instanceId || lease.instanceId === this.instanceId) return false;
    return this.aliveByLease(lease, lease.pid, lease.hostname);
  }

  removeAgent(agentId: string): void {
    for (const target of [this.agentPath(agentId), this.agentSummaryPath(agentId)]) {
      this.cancelPendingWrite(target);
      try {
        rmSync(target, { force: true });
      } catch {
        // Cleanup is best effort and must not crash the manager.
      }
    }
    this.agents.delete(agentId);
    this.agentOwners.delete(agentId);
    this.summaryAgentIds.delete(agentId);
    for (const item of Array.from(this.evidence.values())) {
      if (item.sourceAgentId !== agentId) continue;
      this.removeEvidence(item.id);
    }
    this.maybeRecover();
  }

  removePlan(planId: string): void {
    this.plans.delete(planId);
    this.cancelPendingWrite(this.planPath(planId));
    try {
      rmSync(this.planPath(planId), { force: true });
    } catch {
      // Best effort rollback.
    }
  }

  removeEvidence(evidenceId: string): void {
    this.evidence.delete(evidenceId);
    this.cancelPendingWrite(this.evidencePath(evidenceId));
    try {
      rmSync(this.evidencePath(evidenceId), { force: true });
    } catch {
      // Best effort rollback.
    }
  }

  removeSnapshot(snapshotId: string): void {
    this.snapshots.delete(snapshotId);
    this.cancelPendingWrite(this.snapshotPath(snapshotId));
    try {
      rmSync(this.snapshotPath(snapshotId), { force: true });
    } catch {
      // Best effort cleanup.
    }
  }

  savePlan(plan: AgentPlanRecord): AtomicWriteResult {
    this.cancelPendingWrite(this.planPath(plan.id));
    const result = this.enabled
      ? this.writer.write(this.planPath(plan.id), plan)
      : okResult(this.planPath(plan.id));
    if (result.status === 'ok') this.plans.set(plan.id, structuredClone(plan));
    return this.discardFailedRequiredWrite(result);
  }

  saveEvidence(
    evidence: EvidenceItem,
    options: { required?: boolean } = { required: true },
  ): AtomicWriteResult {
    if (options.required === false) {
      this.evidence.set(evidence.id, structuredClone(evidence));
      return this.queueWrite(this.evidencePath(evidence.id), evidence, {
        targetType: 'evidence',
        agentId: evidence.sourceAgentId,
        immediate: true,
      });
    }
    this.cancelPendingWrite(this.evidencePath(evidence.id));
    const result = this.enabled
      ? this.writer.write(this.evidencePath(evidence.id), evidence)
      : okResult(this.evidencePath(evidence.id));
    if (result.status === 'ok') this.evidence.set(evidence.id, structuredClone(evidence));
    return this.discardFailedRequiredWrite(result);
  }

  saveSnapshot(snapshot: AgentSnapshot): AtomicWriteResult {
    this.cancelPendingWrite(this.snapshotPath(snapshot.id));
    const result = this.enabled
      ? this.writer.write(this.snapshotPath(snapshot.id), snapshot)
      : okResult(this.snapshotPath(snapshot.id));
    if (result.status === 'ok') this.snapshots.set(snapshot.id, structuredClone(snapshot));
    return this.discardFailedRequiredWrite(result);
  }

  recoverAbandonedAgents(): AgentRecord[] {
    const interrupted: AgentRecord[] = [];
    for (const summary of Array.from(this.agents.values())) {
      if (!ACTIVE_STATUSES.has(summary.status)) continue;
      const owner = this.agentOwners.get(summary.id);
      if (owner && this.isInstanceAlive(owner.instanceId, owner.pid, owner.hostname)) {
        if (owner.instanceId !== this.instanceId)
          this.safeLog('live foreign owner detected', { agentId: summary.id });
        continue;
      }
      const agent = this.loadAgent(summary.id) ?? summary;
      const lastSeenAt = agent.updatedAt;
      // Record that this died mid-flight rather than being stopped. Without the
      // distinction a restart cannot tell an abandoned agent from a deliberately
      // stopped one, so the whole pending backlog became terminal records that
      // nothing ever re-drove.
      agent.resumedFromStatus = agent.status;
      agent.resumable = true;
      agent.status = 'interrupted';
      agent.stopReason = 'process_exit';
      agent.pendingPermission = undefined;
      agent.updatedAt = this.now();
      agent.finishedAt = lastSeenAt;
      // A `/review` killed mid-run (SIGKILL, or a crash that skips the exit
      // handler) is recovered here. Its reviewers must not come back as
      // undelivered completions: the next `--continue` would spend a model turn
      // re-narrating a review that never produced a report.
      beginTerminalGeneration(agent);
      interrupted.push(structuredClone(agent));
      this.saveAgent(agent);
    }
    return interrupted;
  }

  markActiveInterrupted(): AgentRecord[] {
    return this.recoverAbandonedAgents();
  }

  isOwnedByCurrent(agentId: string): boolean {
    return this.agentOwners.get(agentId)?.instanceId === this.instanceId;
  }

  /**
   * The instance that wrote the newest copy of the record this store knows, as
   * {@link isOwnedByLiveForeign} reads it.
   */
  ownerInstanceId(agentId: string): string | undefined {
    return this.agentOwners.get(agentId)?.instanceId;
  }

  isOwnedByLiveForeign(agentId: string): boolean {
    const owner = this.agentOwners.get(agentId);
    return Boolean(
      owner &&
      owner.instanceId !== this.instanceId &&
      this.isInstanceAlive(owner.instanceId, owner.pid, owner.hostname),
    );
  }

  hasPendingAgent(agentId: string): boolean {
    return Array.from(this.pendingWrites.values()).some((pending) => pending.agentId === agentId);
  }

  getPersistenceState(): 'healthy' | 'degraded_busy' | 'degraded_unavailable' {
    return this.persistenceState;
  }

  cleanupDetailed(retentionDays: number): AgentStoreCleanup {
    const cutoff = this.now() - retentionDays * 24 * 60 * 60 * 1000;
    const removedAgents = Array.from(this.agents.values()).filter(
      (agent) =>
        TERMINAL_STATUSES.has(agent.status) &&
        agent.updatedAt < cutoff &&
        !this.isOwnedByLiveForeign(agent.id),
    );
    for (const agent of removedAgents) this.removeAgent(agent.id);

    const activePlanIds = new Set(
      Array.from(this.agents.values())
        .map((agent) => agent.planId)
        .filter((id): id is string => Boolean(id)),
    );
    for (const plan of Array.from(this.plans.values())) {
      if (activePlanIds.has(plan.id) || plan.createdAt >= cutoff) continue;
      this.plans.delete(plan.id);
      try {
        rmSync(this.planPath(plan.id), { force: true });
      } catch {
        // Best effort retention cleanup.
      }
    }

    const activeSnapshotIds = new Set(
      Array.from(this.agents.values())
        .map((agent) => agent.snapshotId)
        .filter((id): id is string => Boolean(id)),
    );
    const removedSnapshots: AgentSnapshot[] = [];
    for (const snapshot of Array.from(this.snapshots.values())) {
      if (activeSnapshotIds.has(snapshot.id) || snapshot.createdAt >= cutoff) continue;
      removedSnapshots.push(structuredClone(snapshot));
      this.removeSnapshot(snapshot.id);
    }
    return { agents: structuredClone(removedAgents), snapshots: removedSnapshots };
  }

  cleanup(retentionDays: number): number {
    return this.cleanupDetailed(retentionDays).agents.length;
  }

  appendTelemetry(event: Record<string, unknown>): void {
    if (!this.enabled) return;
    try {
      const path = join(this.directory, 'metrics.jsonl');
      writeFileSync(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
    } catch {
      // Telemetry is optional and non-fatal.
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.heartbeatTimer) this.cancel(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    for (const pending of this.pendingWrites.values()) {
      if (pending.timer) this.cancel(pending.timer);
      pending.timer = undefined;
    }
    for (const target of Array.from(this.pendingWrites.keys())) {
      try {
        this.flushPending(target);
      } catch {
        this.safeLog('shutdown flush failed', { target: targetTypeFor(target) });
      }
    }
    // The lease goes now, synchronously and best effort, whatever else is in flight (#357).
    //
    // Waiting for a heartbeat write that is still running is what this used to do, and both halves
    // of that were wrong. A process that exits between `dispose()` returning and that write settling
    // leaves the lease on disk, and another instance reads it as a live owner until it goes stale —
    // minutes, for a Book that is not coming back. And a write that never settles, on a disk that
    // has stopped answering, blocked the removal for good, which is the one case where the lease
    // most needs to be gone. Neither depends on the write: the unlink below is this store's own
    // file, and a write in flight is a *re-creation* of it, not part of it.
    this.removeLease();
    // The write still in flight gets the file back, because its final step is a rename. So the
    // rename is refused once the store is disposed — `refreshLease` asks before it lands — and the
    // unlink is repeated after the write settles, which covers a rename that had already passed that
    // check when `dispose()` ran. Two steps, because either one alone leaves a window: the check
    // alone for the write that had got that far, the unlink alone for the lease an operator can read
    // in the meantime.
    const inFlight = this.leaseWrite;
    if (inFlight) {
      void inFlight.then(
        () => this.removeLease(),
        () => this.removeLease(),
      );
    }
  }

  private refreshForeignSummaries(): void {
    if (!this.enabled || !existsSync(this.agentSummariesDirectory)) return;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(this.agentSummariesDirectory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(this.agentSummariesDirectory, entry.name);
      const persisted = this.readJson<PersistedAgentRecord>(path, false);
      if (!persisted?.id || !this.targetMatchesId(path, persisted)) continue;
      if (persisted._store?.instanceId === this.instanceId) continue;
      const id = persisted.id;
      const next = this.migrateAgent(withoutStoreMetadata(persisted));
      const current = this.agents.get(id);
      if (
        !current ||
        compareRevision(logicalRevision(next, 'summary'), logicalRevision(current, 'summary')) >= 0
      ) {
        this.agents.set(id, next);
        this.agentOwners.set(id, persisted._store);
        this.summaryAgentIds.add(id);
      }
    }
  }

  /**
   * Take the lease for this instance, before this store reads anything and before anything else
   * reads it.
   *
   * {@link open} waits for this write before it resolves, and that order is the guarantee: a store
   * that has just been opened is asked whether its own instance is alive, and answered from this
   * file. A store handed out before its lease landed would have a window with no lease at all, which
   * is what a manager reading a just-created store saw when its first agent looked abandoned (#357).
   * The write itself is on the thread pool like the heartbeat's, because on a slow disk its lock,
   * fsyncs and rename are what held the TUI's event loop after its first frame (#516): the caller
   * waits for it, the event loop does not.
   *
   * A failure is not fatal here either, for the reason it is not fatal on the heartbeat: what is
   * written is this instance's own ownership record, and every other write carries the same metadata.
   */
  private async takeLease(): Promise<void> {
    try {
      const result = await this.writer.writeAsync(this.leasePath, this.leaseDocument());
      if (result.status !== 'ok') this.safeLog('lease write failed', { status: result.status });
    } catch {
      // A store without a lease is one other instances have to treat as dead; the next heartbeat
      // writes one.
    }
  }

  /**
   * Refresh the lease this instance holds, on the thread pool rather than here.
   *
   * The heartbeat runs on a timer for as long as the process lives and nobody is waiting for it,
   * but the write was synchronous: a lock file, an fsync, a temp file, a second fsync and a rename,
   * every one of them a disk round trip, all of it on whichever thread scheduled the timer — for the
   * TUI, the event loop the keystrokes and the model stream are on. On a busy disk that is hundreds
   * of milliseconds every five seconds, and it lands on the user rather than on the heartbeat
   * (#357). {@link takeLease} is on the thread pool too, but awaited: see there.
   *
   * Two properties come with moving it off the thread and are the reason this is not simply a
   * fire-and-forget:
   *
   * - **A tick that arrives during a write is skipped, not queued.** A queued write is a write
   *   whose content was already stale when it started, and on a disk slower than the heartbeat it
   *   is a queue that grows: each tick adds an `fsync` the next tick would have made stale.
   *   A skipped heartbeat costs nothing, because the lease is still fresh — {@link LEASE_FRESH_MS}
   *   is three heartbeats, so one missed tick is not a stale lease.
   * - **The lease is never put back by a write that outlives `dispose()`.** Dispose deletes the
   *   lease file so no other instance reads a live lease for a process that is gone, and the final
   *   step of a write is a rename — so a heartbeat still running when the store was disposed would
   *   recreate the file it was meant to outlive. The `canCommit` below is that write being asked
   *   whether its own store is still the one that wants the result, at the last moment before the
   *   rename that would put the file back, and `dispose()` unlinks again once the write settles for
   *   the rename that had already passed that check.
   */
  private refreshLease(): void {
    if (!this.enabled || this.disposed) return;
    // A write still running owns the lease file's contents; a second one would only rewrite it.
    if (this.leaseWrite) return;
    const write = this.writer
      .writeAsync(this.leasePath, this.leaseDocument(), {
        // A store that opened disabled has removed its lease too; see `disableAfterFailedLoad`.
        canCommit: () => this.enabled && !this.disposed,
      })
      .then((result) => {
        // A write withdrawn by `dispose()` is the expected outcome of a heartbeat that was already
        // running, not a failure worth a log line about it.
        if (result.status !== 'ok' && result.status !== 'cancelled') {
          this.safeLog('lease refresh failed', { status: result.status });
        }
      })
      .catch(() => {
        // Heartbeat failures are non-fatal; agent writes carry the same owner metadata.
      })
      .finally(() => {
        if (this.leaseWrite === write) this.leaseWrite = undefined;
      });
    this.leaseWrite = write;
  }

  private leaseDocument(): InstanceLease {
    return { ...this.ownerMetadata(), heartbeatAt: this.now() };
  }

  private removeLease(): void {
    try {
      rmSync(this.leasePath, { force: true });
    } catch {
      // A stale lease is recoverable on the next startup.
    }
  }

  private scheduleHeartbeat(): void {
    if (this.disposed) return;
    this.heartbeatTimer = this.schedule(() => {
      try {
        this.refreshLease();
      } finally {
        this.scheduleHeartbeat();
      }
    }, this.heartbeatMs);
    this.heartbeatTimer.unref?.();
  }

  private defaultProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return errorCode(error) === 'EPERM';
    }
  }

  private isInstanceAlive(instanceId: string, pid?: number, ownerHostname?: string): boolean {
    if (instanceId === this.instanceId) return true;
    const lease = this.readJson<InstanceLease>(this.instanceLeasePath(instanceId), false);
    return this.aliveByLease(lease, pid, ownerHostname);
  }

  /** {@link isInstanceAlive}, reading the lease on the thread pool, for {@link open}. */
  private async isInstanceAliveAsync(instanceId: string): Promise<boolean> {
    if (instanceId === this.instanceId) return true;
    const lease = await this.readJsonAsync<InstanceLease>(
      this.instanceLeasePath(instanceId),
      false,
    );
    return this.aliveByLease(lease);
  }

  private instanceLeasePath(instanceId: string): string {
    return join(this.instancesDirectory, `${instanceId}.json`);
  }

  /**
   * Whether an instance other than this one is alive, given its lease as read and the owner a
   * record names. Every caller has already answered for this store's own instance.
   *
   * A fresh lease is alive. Without one, an owner on this host is alive while its process is (a
   * Book from before leases, or one whose heartbeat is late), except when that process is this one
   * (#544). Every live store takes its lease before anything else and keeps it fresh until
   * `dispose()` removes it, so an instance of this process without one is taken for a disposed
   * sibling: the manager a `/clear`, `/resume` or `/rewind` replaced. Its records are the next
   * manager's to write and recover, and its locks are left over. No registry of disposed instances
   * is needed for that, and an earlier process whose pid this one now has reads as gone too, which
   * it is. The cost is a live sibling whose lease is missing or late: its first lease write failed,
   * or its heartbeat stalled past {@link LEASE_FRESH_MS}. It reads as gone until its next
   * heartbeat lands. Two live stores on one repository in one process come only from an SDK host
   * running sessions side by side; the TUI and print mode dispose a runtime before replacing it.
   */
  private aliveByLease(
    lease: InstanceLease | undefined,
    pid?: number,
    ownerHostname?: string,
  ): boolean {
    if (lease && this.now() - lease.heartbeatAt <= this.leaseFreshMs) return true;
    if (ownerHostname !== this.hostname || typeof pid !== 'number') return false;
    return pid !== this.pid && this.processAlive(pid);
  }

  private isLockOwnerAlive(owner: AtomicLockOwner): boolean {
    return this.isInstanceAlive(owner.instanceId, owner.pid, owner.hostname);
  }

  private async parseTemp(path: string): Promise<TempCandidate | undefined> {
    const name = basename(path);
    const modern = /^(.*\.json)\.(\d+)\.([0-9a-f-]{36})\.([0-9a-f-]{36})\.tmp$/i.exec(name);
    const legacy = /^(.*\.json)\.(\d+)\.(\d+)\.tmp$/i.exec(name);
    const targetName = modern?.[1] ?? legacy?.[1];
    if (!targetName) return undefined;
    const target = resolve(dirname(path), targetName);
    const root = `${resolve(this.directory)}${process.platform === 'win32' ? '\\' : '/'}`;
    const normalizedTarget = resolve(target);
    const inStore =
      normalizedTarget === resolve(this.statePath) ||
      `${normalizedTarget}${process.platform === 'win32' ? '\\' : '/'}`.startsWith(root) ||
      normalizedTarget.startsWith(root);
    if (!inStore) return undefined;
    // This store's own temps are its writes in flight: the lease it took before recovering, and the
    // heartbeats that keep it. One read half-written would be quarantined from under its writer.
    if (modern?.[3] === this.instanceId) return undefined;
    // A temp that has vanished since it was listed reads as `undefined` here, and its quarantine
    // finds nothing to move.
    const value = await this.readJsonAsync<unknown>(path, false);
    if (
      value === undefined ||
      (typeof value === 'object' &&
        value !== null &&
        !this.targetMatchesId(target, value as { id?: string }))
    ) {
      await this.quarantineAsync(path);
      return undefined;
    }
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      // Renamed away since it was read, as every live Book's heartbeat does with its own temp in
      // `instances/` every few seconds, or no longer readable: not one this open can recover, and
      // a later one retries whatever is still there.
      return undefined;
    }
    return {
      path,
      target,
      value,
      revision: logicalRevision(value, targetTypeFor(target)),
      mtimeMs,
      ownerInstanceId: modern?.[3],
    };
  }

  /** Promote or discard the temp files crashed writes left behind. Runs only inside {@link open}. */
  private async recoverTemps(): Promise<void> {
    const directories = [
      this.directory,
      this.agentsDirectory,
      this.agentSummariesDirectory,
      this.plansDirectory,
      this.evidenceDirectory,
      this.snapshotsDirectory,
      this.instancesDirectory,
    ];
    const groups = new Map<string, TempCandidate[]>();
    for (const directory of directories) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue;
        const candidate = await this.parseTemp(join(directory, entry.name));
        if (!candidate) continue;
        if (
          candidate.ownerInstanceId &&
          (await this.isInstanceAliveAsync(candidate.ownerInstanceId))
        )
          continue;
        const values = groups.get(candidate.target) ?? [];
        values.push(candidate);
        groups.set(candidate.target, values);
      }
    }

    for (const [target, candidates] of groups) {
      candidates.sort(
        (left, right) =>
          compareRevision(right.revision, left.revision) || right.mtimeMs - left.mtimeMs,
      );
      const selected = candidates[0]!;
      // A missing target reads as `undefined`, like an unreadable one.
      const targetValue = await this.readJsonAsync<unknown>(target, false);
      const type = targetTypeFor(target);
      const shouldPromote =
        targetValue === undefined ||
        (type !== 'manifest' &&
          compareRevision(selected.revision, logicalRevision(targetValue, type)) > 0);
      if (shouldPromote) {
        const result = await this.writer.writeAsync(target, selected.value, {
          preparedTemp: selected.path,
        });
        if (result.status === 'ok') this.safeLog('orphan temp recovered', { target: type });
        if (result.status !== 'ok') {
          for (const candidate of candidates.slice(1)) {
            try {
              await unlink(candidate.path);
            } catch {
              // Keep the newest valid temp; older candidates are best-effort cleanup.
            }
          }
          continue;
        }
      }
      for (const candidate of candidates) {
        if (
          shouldPromote &&
          candidate.path === selected.path &&
          !(await pathExists(candidate.path))
        )
          continue;
        try {
          await unlink(candidate.path);
        } catch {
          // A later startup can retry cleanup.
        }
      }
    }
  }
}

export function cleanupAgentStoreRoot(root: string, olderThanMs: number, now = Date.now()): number {
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);
    const recordsDirectory = join(directory, 'records');
    let newest = 0;
    if (existsSync(recordsDirectory)) {
      for (const record of readdirSync(recordsDirectory, { withFileTypes: true })) {
        if (!record.isFile() || !record.name.endsWith('.json')) continue;
        try {
          const agent = JSON.parse(readFileSync(join(recordsDirectory, record.name), 'utf8')) as
            AgentRecord | undefined;
          newest = Math.max(newest, agent?.updatedAt ?? 0);
        } catch {
          newest = Math.max(newest, statSync(join(recordsDirectory, record.name)).mtimeMs);
        }
      }
    } else {
      const statePath = join(directory, 'state.json');
      if (!existsSync(statePath)) continue;
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as LegacyStoreState;
        newest = Math.max(0, ...(state.agents ?? []).map((agent) => agent.updatedAt));
      } catch {
        continue;
      }
    }
    if (newest > 0 && now - newest <= olderThanMs) continue;
    rmSync(directory, { recursive: true, force: true });
    removed++;
  }
  return removed;
}
