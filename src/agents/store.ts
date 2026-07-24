import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { AgentPlanRecord, AgentRecord, AgentSnapshot, EvidenceItem } from './types.js';
import { deriveAgentDisplayName } from './naming.js';

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

export interface AgentStoreCleanup {
  agents: AgentRecord[];
  snapshots: AgentSnapshot[];
}

const MANIFEST: StoreManifest = { version: 3 };
const DEFERRED_SAVE_MS = 100;

function encodedName(id: string): string {
  return `${encodeURIComponent(id)}.json`;
}

export class AgentStore {
  readonly directory: string;
  private readonly statePath: string;
  private readonly agentsDirectory: string;
  private readonly agentSummariesDirectory: string;
  private readonly plansDirectory: string;
  private readonly evidenceDirectory: string;
  private readonly snapshotsDirectory: string;
  private enabled: boolean;
  private readonly agents = new Map<string, AgentRecord>();
  private readonly summaryAgentIds = new Set<string>();
  private readonly plans = new Map<string, AgentPlanRecord>();
  private readonly evidence = new Map<string, EvidenceItem>();
  private readonly snapshots = new Map<string, AgentSnapshot>();
  private readonly pendingAgentSaves = new Map<string, NodeJS.Timeout>();

  constructor(repoHash: string, root = join(homedir(), '.book', 'agents'), enabled = true) {
    this.directory = join(root, repoHash);
    this.statePath = join(this.directory, 'state.json');
    this.agentsDirectory = join(this.directory, 'records');
    this.agentSummariesDirectory = join(this.directory, 'summaries');
    this.plansDirectory = join(this.directory, 'plans');
    this.evidenceDirectory = join(this.directory, 'evidence');
    this.snapshotsDirectory = join(this.directory, 'snapshots');
    this.enabled = enabled;
    if (enabled) {
      try {
        this.ensureDirectories();
      } catch {
        this.enabled = false;
      }
    }
    if (this.enabled) this.load();
  }

  private ensureDirectories(): void {
    mkdirSync(this.agentsDirectory, { recursive: true });
    mkdirSync(this.agentSummariesDirectory, { recursive: true });
    mkdirSync(this.plansDirectory, { recursive: true });
    mkdirSync(this.evidenceDirectory, { recursive: true });
    mkdirSync(this.snapshotsDirectory, { recursive: true });
  }

  private quarantine(path: string): void {
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`);
    } catch {
      // Leave unreadable data in place if it cannot be quarantined.
    }
  }

  private readJson<T>(path: string): T | undefined {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
      this.quarantine(path);
      return undefined;
    }
  }

  private writeJson(path: string, value: unknown): void {
    if (!this.enabled) return;
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    renameSync(temp, path);
  }

  private loadDirectory<T extends { id: string }>(
    directory: string,
    target: Map<string, T>,
    migrate?: (value: T) => T,
  ): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const value = this.readJson<T>(join(directory, entry.name));
      if (!value?.id) continue;
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

    this.loadDirectory(this.agentSummariesDirectory, this.agents, (agent) =>
      this.migrateAgent(agent),
    );
    for (const id of this.agents.keys()) this.summaryAgentIds.add(id);
    for (const entry of readdirSync(this.agentsDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const id = decodeURIComponent(entry.name.replace(/\.json$/, ''));
      if (this.agents.has(id)) continue;
      const agent = this.readJson<AgentRecord>(join(this.agentsDirectory, entry.name));
      if (!agent?.id) continue;
      const migrated = this.migrateAgent(agent);
      const summary = this.agentSummary(migrated);
      this.agents.set(summary.id, summary);
      this.summaryAgentIds.add(summary.id);
      this.writeJson(this.agentSummaryPath(summary.id), summary);
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
      this.writeJson(this.statePath, MANIFEST);
    }
  }

  private migrateAgent(record: AgentRecord): AgentRecord {
    const profile = record.profile ?? record.name ?? 'unknown';
    const purpose = record.purpose ?? record.prompt ?? '';
    const terminal = ['completed', 'failed', 'stopped', 'interrupted'].includes(record.status);
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

  private flushAgent(id: string): void {
    const timer = this.pendingAgentSaves.get(id);
    if (timer) clearTimeout(timer);
    this.pendingAgentSaves.delete(id);
    const agent = this.agents.get(id);
    if (agent) {
      this.writeJson(this.agentPath(id), agent);
      this.writeJson(this.agentSummaryPath(id), this.agentSummary(agent));
    }
  }

  private flushAll(): void {
    this.writeJson(this.statePath, MANIFEST);
    for (const agent of this.agents.values()) {
      this.writeJson(this.agentPath(agent.id), agent);
      this.writeJson(this.agentSummaryPath(agent.id), this.agentSummary(agent));
    }
    for (const plan of this.plans.values()) this.writeJson(this.planPath(plan.id), plan);
    for (const item of this.evidence.values()) this.writeJson(this.evidencePath(item.id), item);
    for (const snapshot of this.snapshots.values())
      this.writeJson(this.snapshotPath(snapshot.id), snapshot);
  }

  listAgents(): AgentRecord[] {
    return Array.from(this.agents.values(), (agent) => {
      this.summaryAgentIds.add(agent.id);
      return this.agentSummary(agent);
    });
  }

  loadAgent(id: string): AgentRecord | undefined {
    const value = this.readJson<AgentRecord>(this.agentPath(id));
    if (!value?.id) return undefined;
    const migrated = this.migrateAgent(value);
    this.agents.set(id, migrated);
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

  saveAgent(agent: AgentRecord, options: { defer?: boolean } = {}): void {
    let persisted = structuredClone(agent);
    if (this.summaryAgentIds.has(agent.id)) {
      const detailed = this.readJson<AgentRecord>(this.agentPath(agent.id));
      if (detailed) {
        const migrated = this.migrateAgent(detailed);
        persisted = {
          ...migrated,
          ...persisted,
          transcript: persisted.transcript.length > 0 ? persisted.transcript : migrated.transcript,
        };
      }
    }
    this.agents.set(agent.id, persisted);
    if (!this.enabled) return;
    if (!options.defer) {
      this.flushAgent(agent.id);
      return;
    }
    if (this.pendingAgentSaves.has(agent.id)) return;
    const timer = setTimeout(() => this.flushAgent(agent.id), DEFERRED_SAVE_MS);
    timer.unref?.();
    this.pendingAgentSaves.set(agent.id, timer);
  }

  removeAgent(agentId: string): void {
    const timer = this.pendingAgentSaves.get(agentId);
    if (timer) clearTimeout(timer);
    this.pendingAgentSaves.delete(agentId);
    this.agents.delete(agentId);
    if (this.enabled) {
      rmSync(this.agentPath(agentId), { force: true });
      rmSync(this.agentSummaryPath(agentId), { force: true });
    }
    for (const item of Array.from(this.evidence.values())) {
      if (item.sourceAgentId !== agentId) continue;
      this.evidence.delete(item.id);
      if (this.enabled) rmSync(this.evidencePath(item.id), { force: true });
    }
  }

  removeSnapshot(snapshotId: string): void {
    this.snapshots.delete(snapshotId);
    if (this.enabled) rmSync(this.snapshotPath(snapshotId), { force: true });
  }

  savePlan(plan: AgentPlanRecord): void {
    this.plans.set(plan.id, structuredClone(plan));
    this.writeJson(this.planPath(plan.id), plan);
  }

  saveEvidence(evidence: EvidenceItem): void {
    this.evidence.set(evidence.id, structuredClone(evidence));
    this.writeJson(this.evidencePath(evidence.id), evidence);
  }

  saveSnapshot(snapshot: AgentSnapshot): void {
    this.snapshots.set(snapshot.id, structuredClone(snapshot));
    this.writeJson(this.snapshotPath(snapshot.id), snapshot);
  }

  markActiveInterrupted(): AgentRecord[] {
    const interrupted: AgentRecord[] = [];
    for (const summary of Array.from(this.agents.values())) {
      if (
        !['queued', 'starting', 'running', 'waiting_input', 'waiting_permission'].includes(
          summary.status,
        )
      )
        continue;
      const agent = this.loadAgent(summary.id) ?? summary;
      const lastSeenAt = agent.updatedAt;
      agent.status = 'interrupted';
      agent.stopReason = 'process_exit';
      agent.pendingPermission = undefined;
      agent.updatedAt = Date.now();
      agent.finishedAt = lastSeenAt;
      agent.completionSequence = (agent.completionSequence ?? 0) + 1;
      interrupted.push(structuredClone(agent));
      this.saveAgent(agent);
    }
    return interrupted;
  }

  cleanupDetailed(retentionDays: number): AgentStoreCleanup {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const removedAgents = Array.from(this.agents.values()).filter(
      (agent) => agent.updatedAt < cutoff,
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
      if (this.enabled) rmSync(this.planPath(plan.id), { force: true });
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
    const path = join(this.directory, 'metrics.jsonl');
    writeFileSync(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
  }

  dispose(): void {
    for (const id of Array.from(this.pendingAgentSaves.keys())) this.flushAgent(id);
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
