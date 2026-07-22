import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { AgentPlanRecord, AgentRecord, AgentSnapshot, EvidenceItem } from './types.js';
import { deriveAgentDisplayName } from './naming.js';

interface StoreState {
  version: 2;
  plans: AgentPlanRecord[];
  agents: AgentRecord[];
  evidence: EvidenceItem[];
  snapshots: AgentSnapshot[];
}

const EMPTY_STATE: StoreState = {
  version: 2,
  plans: [],
  agents: [],
  evidence: [],
  snapshots: [],
};

export class AgentStore {
  readonly directory: string;
  private readonly statePath: string;
  private enabled: boolean;
  private state: StoreState;

  constructor(repoHash: string, root = join(homedir(), '.book', 'agents'), enabled = true) {
    this.directory = join(root, repoHash);
    this.statePath = join(this.directory, 'state.json');
    this.enabled = enabled;
    if (enabled) {
      try {
        mkdirSync(this.directory, { recursive: true });
      } catch {
        this.enabled = false;
      }
    }
    this.state = this.enabled ? this.load() : structuredClone(EMPTY_STATE);
  }

  private load(): StoreState {
    if (!existsSync(this.statePath)) return structuredClone(EMPTY_STATE);
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<StoreState> & {
        version?: number;
      };
      const agents = (parsed.agents ?? []).map((agent) => this.migrateAgent(agent));
      return {
        version: 2,
        plans: parsed.plans ?? [],
        agents,
        evidence: parsed.evidence ?? [],
        snapshots: parsed.snapshots ?? [],
      };
    } catch {
      return structuredClone(EMPTY_STATE);
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

  private flush(): void {
    if (!this.enabled) return;
    mkdirSync(this.directory, { recursive: true });
    const temp = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    renameSync(temp, this.statePath);
  }

  listAgents(): AgentRecord[] {
    return structuredClone(this.state.agents);
  }

  listPlans(): AgentPlanRecord[] {
    return structuredClone(this.state.plans);
  }

  listEvidence(): EvidenceItem[] {
    return structuredClone(this.state.evidence);
  }

  listSnapshots(): AgentSnapshot[] {
    return structuredClone(this.state.snapshots);
  }

  saveAgent(agent: AgentRecord): void {
    const index = this.state.agents.findIndex((candidate) => candidate.id === agent.id);
    if (index === -1) this.state.agents.push(structuredClone(agent));
    else this.state.agents[index] = structuredClone(agent);
    this.flush();
  }

  removeAgent(agentId: string): void {
    this.state.agents = this.state.agents.filter((agent) => agent.id !== agentId);
    this.state.evidence = this.state.evidence.filter(
      (evidence) => evidence.sourceAgentId !== agentId,
    );
    this.flush();
  }

  savePlan(plan: AgentPlanRecord): void {
    const index = this.state.plans.findIndex((candidate) => candidate.id === plan.id);
    if (index === -1) this.state.plans.push(structuredClone(plan));
    else this.state.plans[index] = structuredClone(plan);
    this.flush();
  }

  saveEvidence(evidence: EvidenceItem): void {
    const index = this.state.evidence.findIndex((candidate) => candidate.id === evidence.id);
    if (index === -1) this.state.evidence.push(structuredClone(evidence));
    else this.state.evidence[index] = structuredClone(evidence);
    this.flush();
  }

  saveSnapshot(snapshot: AgentSnapshot): void {
    const index = this.state.snapshots.findIndex((candidate) => candidate.id === snapshot.id);
    if (index === -1) this.state.snapshots.push(structuredClone(snapshot));
    else this.state.snapshots[index] = structuredClone(snapshot);
    this.flush();
  }

  markActiveInterrupted(): AgentRecord[] {
    const interrupted: AgentRecord[] = [];
    for (const agent of this.state.agents) {
      if (
        !['queued', 'starting', 'running', 'waiting_input', 'waiting_permission'].includes(
          agent.status,
        )
      )
        continue;
      agent.status = 'interrupted';
      agent.stopReason = 'process_exit';
      // A recovered process has no live resolver, so do not expose stale
      // permission UI that cannot be answered by an active child loop.
      agent.pendingPermission = undefined;
      agent.updatedAt = Date.now();
      agent.finishedAt = agent.updatedAt;
      agent.completionSequence = (agent.completionSequence ?? 0) + 1;
      interrupted.push(structuredClone(agent));
    }
    if (interrupted.length > 0) this.flush();
    return interrupted;
  }

  cleanup(retentionDays: number): number {
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const staleIds = new Set(
      this.state.agents.filter((agent) => agent.updatedAt < cutoff).map((agent) => agent.id),
    );
    if (staleIds.size === 0) return 0;
    this.state.agents = this.state.agents.filter((agent) => !staleIds.has(agent.id));
    this.state.evidence = this.state.evidence.filter(
      (evidence) => !staleIds.has(evidence.sourceAgentId),
    );
    const activePlanIds = new Set(
      this.state.agents.map((agent) => agent.planId).filter((id): id is string => Boolean(id)),
    );
    const activeSnapshotIds = new Set(
      this.state.agents.map((agent) => agent.snapshotId).filter((id): id is string => Boolean(id)),
    );
    this.state.plans = this.state.plans.filter(
      (plan) => activePlanIds.has(plan.id) || plan.createdAt >= cutoff,
    );
    this.state.snapshots = this.state.snapshots.filter(
      (snapshot) => activeSnapshotIds.has(snapshot.id) || snapshot.createdAt >= cutoff,
    );
    this.flush();
    return staleIds.size;
  }

  appendTelemetry(event: Record<string, unknown>): void {
    if (!this.enabled) return;
    const path = join(this.directory, 'metrics.jsonl');
    writeFileSync(path, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flag: 'a' });
  }
}

export function cleanupAgentStoreRoot(root: string, olderThanMs: number, now = Date.now()): number {
  if (!existsSync(root)) return 0;
  let removed = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const statePath = join(root, entry.name, 'state.json');
    if (!existsSync(statePath)) continue;
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as StoreState;
      const newest = Math.max(0, ...state.agents.map((agent) => agent.updatedAt));
      if (newest > 0 && now - newest <= olderThanMs) continue;
      rmSync(join(root, entry.name), { recursive: true, force: true });
      removed++;
    } catch {
      // Corrupt state is left in place for manual recovery.
    }
  }
  return removed;
}
