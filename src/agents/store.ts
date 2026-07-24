import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import { homedir, hostname as readHostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createDebugLogger } from '../debug-log.js';
import { deriveAgentDisplayName } from './naming.js';
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

function withoutStoreMetadata(record: PersistedAgentRecord): AgentRecord {
  const publicRecord = { ...record };
  delete publicRecord._store;
  return publicRecord;
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
  private heartbeatTimer?: NodeJS.Timeout;
  private persistenceState: 'healthy' | 'degraded_busy' | 'degraded_unavailable' = 'healthy';
  private readonly agents = new Map<string, AgentRecord>();
  private readonly agentOwners = new Map<string, StoreOwnerMetadata | undefined>();
  private readonly summaryAgentIds = new Set<string>();
  private readonly plans = new Map<string, AgentPlanRecord>();
  private readonly evidence = new Map<string, EvidenceItem>();
  private readonly snapshots = new Map<string, AgentSnapshot>();
  private readonly pendingWrites = new Map<string, PendingWrite>();

  constructor(
    repoHash: string,
    root = join(homedir(), '.book', 'agents'),
    enabled = true,
    options: AgentStoreOptions = {},
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
    if (enabled) {
      try {
        this.ensureDirectories();
      } catch {
        this.enabled = false;
      }
    }
    if (this.enabled) {
      this.recoverTemps();
      this.load();
      this.refreshLease();
      this.scheduleHeartbeat();
    }
  }

  private ensureDirectories(): void {
    mkdirSync(this.agentsDirectory, { recursive: true });
    mkdirSync(this.agentSummariesDirectory, { recursive: true });
    mkdirSync(this.plansDirectory, { recursive: true });
    mkdirSync(this.evidenceDirectory, { recursive: true });
    mkdirSync(this.snapshotsDirectory, { recursive: true });
    mkdirSync(this.instancesDirectory, { recursive: true });
  }

  private safeLog(event: string, metadata: Record<string, unknown>): void {
    try {
      log.event(event, metadata);
    } catch {
      // Diagnostics are never allowed to affect persistence.
    }
  }

  private quarantine(path: string): void {
    try {
      renameSync(path, `${path}.corrupt-${this.now()}`);
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

  private targetMatchesId(path: string, value: { id?: string }): boolean {
    const type = targetTypeFor(path);
    if (!['record', 'summary', 'plan', 'evidence', 'snapshot'].includes(type)) return true;
    try {
      return value.id === decodeURIComponent(basename(path).replace(/\.json$/, ''));
    } catch {
      return false;
    }
  }

  private loadDirectory<T extends { id: string }>(
    directory: string,
    target: Map<string, T>,
    migrate?: (value: T) => T,
  ): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(directory, entry.name);
      const value = this.readJson<T>(path);
      if (!value?.id || !this.targetMatchesId(path, value)) {
        if (value) this.quarantine(path);
        continue;
      }
      const resolved = migrate ? migrate(value) : value;
      target.set(resolved.id, resolved);
    }
  }

  private load(): void {
    let legacy: LegacyStoreState | undefined;
    if (existsSync(this.statePath)) {
      const parsed = this.readJson<LegacyStoreState>(this.statePath);
      if (parsed?.version !== 3) legacy = parsed;
    }

    for (const entry of readdirSync(this.agentSummariesDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(this.agentSummariesDirectory, entry.name);
      const persisted = this.readJson<PersistedAgentRecord>(path);
      if (!persisted?.id || !this.targetMatchesId(path, persisted)) {
        if (persisted) this.quarantine(path);
        continue;
      }
      const migrated = this.migrateAgent(withoutStoreMetadata(persisted));
      this.agents.set(migrated.id, migrated);
      this.agentOwners.set(migrated.id, persisted._store);
      this.summaryAgentIds.add(migrated.id);
    }

    for (const entry of readdirSync(this.agentsDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const path = join(this.agentsDirectory, entry.name);
      const persisted = this.readJson<PersistedAgentRecord>(path);
      if (!persisted?.id || !this.targetMatchesId(path, persisted)) {
        if (persisted) this.quarantine(path);
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
    this.loadDirectory(this.plansDirectory, this.plans);
    this.loadDirectory(this.evidenceDirectory, this.evidence);
    this.loadDirectory(this.snapshotsDirectory, this.snapshots);

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
    } else if (!existsSync(this.statePath)) {
      this.queueWrite(this.statePath, MANIFEST, { targetType: 'manifest', immediate: true });
    }
  }

  private migrateAgent(record: AgentRecord): AgentRecord {
    const profile = record.profile ?? record.name ?? 'unknown';
    const purpose = record.purpose ?? record.prompt ?? '';
    const terminal = TERMINAL_STATUSES.has(record.status);
    const hasCompletionSequence = record.completionSequence !== undefined;
    const completionSequence = record.completionSequence ?? (terminal ? 1 : 0);
    return {
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
    };
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
    if (result.status === 'ok' || !result.tempPath) return result;
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
    if (options.immediate) return this.flushPending(target);
    this.schedulePending(pending, options.delayMs ?? DEFERRED_SAVE_MS);
    return okResult(target);
  }

  private flushPending(target: string): AtomicWriteResult {
    const pending = this.pendingWrites.get(target);
    if (!pending || pending.flushing) return okResult(target);
    pending.flushing = true;
    let result: AtomicWriteResult;
    try {
      result = this.writer.write(target, pending.value, pending.tempPath);
    } catch (error) {
      result = {
        status: 'unavailable',
        target,
        operation: 'write',
        errorCode: errorCode(error),
        message: 'Agent state storage failed.',
        attempts: 1,
        elapsedMs: 0,
      };
    }
    pending.flushing = false;
    if (result.status === 'ok') {
      this.pendingWrites.delete(target);
      this.safeLog('retry succeeded', { target: pending.targetType, attempts: result.attempts });
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
    const detailed = this.persistedAgent(persisted, owner);
    const summary = this.persistedAgent(this.agentSummary(persisted), owner);
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
      agent.status = 'interrupted';
      agent.stopReason = 'process_exit';
      agent.pendingPermission = undefined;
      agent.updatedAt = this.now();
      agent.finishedAt = lastSeenAt;
      agent.completionSequence = (agent.completionSequence ?? 0) + 1;
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
    try {
      rmSync(this.leasePath, { force: true });
    } catch {
      // A stale lease is recoverable on the next startup.
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

  private refreshLease(): void {
    if (!this.enabled || this.disposed) return;
    const lease: InstanceLease = { ...this.ownerMetadata(), heartbeatAt: this.now() };
    try {
      const result = this.writer.write(this.leasePath, lease);
      if (result.status !== 'ok') this.safeLog('lease refresh failed', { status: result.status });
    } catch {
      // Heartbeat failures are non-fatal; agent writes carry the same owner metadata.
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
    const lease = this.readJson<InstanceLease>(
      join(this.instancesDirectory, `${instanceId}.json`),
      false,
    );
    if (lease && this.now() - lease.heartbeatAt <= this.leaseFreshMs) return true;
    return ownerHostname === this.hostname && typeof pid === 'number'
      ? this.processAlive(pid)
      : false;
  }

  private isLockOwnerAlive(owner: AtomicLockOwner): boolean {
    return this.isInstanceAlive(owner.instanceId, owner.pid, owner.hostname);
  }

  private parseTemp(path: string): TempCandidate | undefined {
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
    const value = this.readJson<unknown>(path, false);
    if (
      value === undefined ||
      (typeof value === 'object' &&
        value !== null &&
        !this.targetMatchesId(target, value as { id?: string }))
    ) {
      this.quarantine(path);
      return undefined;
    }
    return {
      path,
      target,
      value,
      revision: logicalRevision(value, targetTypeFor(target)),
      mtimeMs: statSync(path).mtimeMs,
      ownerInstanceId: modern?.[3],
    };
  }

  private recoverTemps(): void {
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
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.tmp')) continue;
        const candidate = this.parseTemp(join(directory, entry.name));
        if (!candidate) continue;
        if (candidate.ownerInstanceId && this.isInstanceAlive(candidate.ownerInstanceId)) continue;
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
      const targetValue = existsSync(target) ? this.readJson<unknown>(target, false) : undefined;
      const type = targetTypeFor(target);
      const shouldPromote =
        targetValue === undefined ||
        (type !== 'manifest' &&
          compareRevision(selected.revision, logicalRevision(targetValue, type)) > 0);
      if (shouldPromote) {
        const result = this.writer.write(target, selected.value, selected.path);
        if (result.status === 'ok') this.safeLog('orphan temp recovered', { target: type });
        if (result.status !== 'ok') {
          for (const candidate of candidates.slice(1)) {
            try {
              unlinkSync(candidate.path);
            } catch {
              // Keep the newest valid temp; older candidates are best-effort cleanup.
            }
          }
          continue;
        }
      }
      for (const candidate of candidates) {
        if (shouldPromote && candidate.path === selected.path && !existsSync(candidate.path))
          continue;
        try {
          unlinkSync(candidate.path);
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
