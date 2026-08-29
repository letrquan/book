import { randomUUID } from 'crypto';
import type { AgentConfig, PermissionMode } from '../types/runtime.js';
import type { Message, Usage } from '../types/messages.js';
import { createAgentRunContext, type AgentRunContext } from '../types/runs.js';
import {
  classifyRuntimeError,
  createTerminalOutcome,
  type AgentTerminalOutcome,
} from '../types/terminal.js';
import type { ToolCall, ToolDefinition, ToolResult, UserQuestionResponse } from '../types/tools.js';
import { runAgentLoop } from '../agent/loop.js';
import { runCompact, usagePressureTokens } from '../agent/compact.js';
import { applyModelDefaults, resolveModelProviderConfig } from '../config.js';
import { runHooks } from '../hooks.js';
import { discoverAgents } from '../subagent-discovery.js';
import { createRegistry } from '../tools/registry-core.js';
import { createCapabilityRegistry, describeCapabilities } from './capabilities.js';
import { checkWorktreeCapacity } from './resource-governor.js';
import {
  applyVerifiedCandidate,
  commitAgentWork,
  createAgentWorktree,
  defaultWorktreeRoot,
  createSyntheticSnapshot,
  checkoutAgentCommit,
  findGitRoot,
  repositoryHash,
  removeAgentWorktree,
  removeSnapshotRef,
} from './git-isolation.js';
import { withBuiltInAgents, type ManagedAgentDef } from './profiles.js';
import { resolveAgentProfile, usableAgentEffort } from './profile-resolver.js';
import { deriveAgentDisplayName, uniqueAgentDisplayName } from './naming.js';
import { projectAgentCompletion, projectAgentSummary } from './projections.js';
import { beginTerminalGeneration } from './completion-notification.js';
import { projectToolResultForDisplay, redactToolCallForDisplay } from './activity.js';
import { AgentStore, type AgentStoreWriteResult } from './store.js';
import { permissionRuleForToolCall } from '../permissions.js';
import { createRunAmbientSnapshot } from '../session/run-ambient.js';
import type {
  AgentApplyResult,
  AgentActivity,
  AgentCompletionNotification,
  AgentPermissionRequest,
  AgentPlanRecord,
  AgentRecord,
  AgentRuntimeEvent,
  AgentSnapshot,
  AgentSpawnRequest,
  AgentStatus,
  EvidenceItem,
  EvidenceKind,
  EvidenceReference,
  IssueQuality,
  AgentTopology,
} from './types.js';
import { SessionRuntime } from '../session/runtime.js';
import { normalizePermissionMode, resolvePermissionMode } from '../permission-mode.js';

interface ManagerOptions {
  storeRoot?: string;
  worktreeRoot?: string;
  eventSink?: (event: AgentRuntimeEvent) => void;
  hookEventSink?: (event: string, payload: Record<string, unknown>) => void;
  runLoop?: typeof runAgentLoop;
  compactRunner?: typeof runCompact;
  findGitRoot?: typeof findGitRoot;
  createSnapshot?: typeof createSyntheticSnapshot;
  createWorktree?: typeof createAgentWorktree;
  checkoutWorktree?: typeof checkoutAgentCommit;
  commitWork?: typeof commitAgentWork;
  applyCandidate?: typeof applyVerifiedCandidate;
  removeWorktree?: (record: AgentRecord, repoRoot?: string) => Promise<void>;
  removeSnapshot?: typeof removeSnapshotRef;
  runtime?: SessionRuntime;
  permissionMode?: string;
  persistPermissionRule?: (rule: string) => void;
  createStore?: (repoHash: string, root: string | undefined, enabled: boolean) => AgentStore;
  harnessObserver?: import('../harness/contracts.js').HarnessRuntimeObserver;
}

interface SubscribeOptions {
  snapshot?: boolean;
}

interface PublishEvidenceInput {
  kind: EvidenceKind;
  summary: string;
  confidence?: number;
  references?: EvidenceReference[];
}

const TERMINAL_STATUSES = new Set<AgentStatus>(['completed', 'failed', 'stopped', 'interrupted']);
const DURABILITY_WARNING =
  'The latest agent state is still waiting for durable storage; Book will retry in the background.';

export class AgentManagerError extends Error {
  constructor(
    message: string,
    readonly code: 'agent_store_busy' | 'agent_store_unavailable' | 'agent_owned_by_other_process',
    readonly retryable: boolean,
    readonly remediation: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AgentManagerError';
  }
}

function lastAssistantText(history: Message[]): string {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index];
    if (message.role === 'assistant' && message.content) return message.content;
  }
  return '';
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function agentRevision(record: AgentRecord): [number, number, number] {
  return [
    record.completionSequence ?? 0,
    record.updatedAt,
    TERMINAL_STATUSES.has(record.status) ? 1 : 0,
  ];
}

function isNewerAgentRecord(candidate: AgentRecord, current: AgentRecord): boolean {
  const left = agentRevision(candidate);
  const right = agentRevision(current);
  for (let index = 0; index < left.length; index++) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

function accumulateUsage(current: Usage | undefined, next: Usage): Usage {
  return {
    promptTokens: (current?.promptTokens ?? 0) + next.promptTokens,
    completionTokens: (current?.completionTokens ?? 0) + next.completionTokens,
    totalTokens: (current?.totalTokens ?? 0) + next.totalTokens,
    contextTokens: next.contextTokens,
    cacheCreationInputTokens:
      (current?.cacheCreationInputTokens ?? 0) + (next.cacheCreationInputTokens ?? 0),
    cacheReadInputTokens: (current?.cacheReadInputTokens ?? 0) + (next.cacheReadInputTokens ?? 0),
  };
}

function errorKind(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (/413|request too large|context length/i.test(value)) return 'context_overflow';
  if (/stream stall|no data received/i.test(value)) return 'stream_stall';
  if (/timeout|timed out/i.test(value)) return 'timeout';
  if (/abort|cancel|stop/i.test(value)) return 'aborted';
  if (/permission|capability denied/i.test(value)) return 'permission';
  return 'other';
}

export class AgentManager {
  private config: AgentConfig;
  private readonly parentDefinitions: ToolDefinition[];
  private readonly options: ManagerOptions;
  private store?: AgentStore;
  private repoRoot?: string;
  private initialized?: Promise<void>;
  private readonly agents = new Map<string, AgentRecord>();
  private readonly hydratedAgentIds = new Set<string>();
  private readonly plans = new Map<string, AgentPlanRecord>();
  private readonly evidence = new Map<string, EvidenceItem>();
  private readonly snapshots = new Map<string, AgentSnapshot>();
  private readonly planSnapshots = new Map<string, string>();
  private readonly snapshotPromises = new Map<string, Promise<AgentSnapshot>>();
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly questionResolvers = new Map<string, (response: UserQuestionResponse) => void>();
  private readonly permissionResolvers = new Map<
    string,
    (response: 'allow' | 'deny' | 'always') => void
  >();
  private readonly permissionRules = new Map<string, string>();
  private readonly activities = new Map<string, Map<string, AgentActivity>>();
  private readonly waiters = new Map<string, Set<(record: AgentRecord) => void>>();
  private readonly idleWaiters = new Set<() => void>();
  private active = 0;
  private interactivePermissions = false;
  private permissionMode: PermissionMode = 'default';
  private permissionModeOverride?: PermissionMode;
  private readonly subscribers = new Set<(event: AgentRuntimeEvent) => void>();
  private legacyEventSink?: (event: AgentRuntimeEvent) => void;
  private readonly textBuffers = new Map<string, string>();
  private readonly textTimers = new Map<string, NodeJS.Timeout>();
  private hookEventSink?: (event: string, payload: Record<string, unknown>) => void;
  private harnessObserver?: import('../harness/contracts.js').HarnessRuntimeObserver;
  private exitHandler?: () => void;
  private disposed = false;
  private persistenceState: 'healthy' | 'degraded_busy' | 'degraded_unavailable' = 'healthy';

  constructor(
    config: AgentConfig,
    parentDefinitions: ToolDefinition[],
    options: ManagerOptions = {},
  ) {
    this.config = config;
    this.parentDefinitions = parentDefinitions;
    this.options = options;
    this.permissionModeOverride =
      options.permissionMode === undefined
        ? undefined
        : (normalizePermissionMode(options.permissionMode) ?? 'default');
    this.permissionMode = resolvePermissionMode(config.settings, options.permissionMode);
    this.legacyEventSink = options.eventSink;
    this.hookEventSink = options.hookEventSink;
    this.harnessObserver = options.harnessObserver;
  }

  setEventSink(
    sink?: (event: AgentRuntimeEvent) => void,
    hookSink?: (event: string, payload: Record<string, unknown>) => void,
  ): void {
    if (sink) this.legacyEventSink = sink;
    if (hookSink) this.hookEventSink = hookSink;
  }

  setHarnessObserver(observer?: import('../harness/contracts.js').HarnessRuntimeObserver): void {
    this.harnessObserver = observer;
  }

  updateConfig(config: AgentConfig): void {
    this.config = config;
    if (this.permissionModeOverride === undefined) {
      this.permissionMode = resolvePermissionMode(config.settings);
    }
  }

  hasActiveProfile(profile: string): boolean {
    return Array.from(this.agents.values()).some(
      (record) =>
        (record.profile ?? record.name) === profile &&
        !TERMINAL_STATUSES.has(record.status) &&
        this.store?.isOwnedByCurrent(record.id) !== false,
    );
  }

  setInteractivePermissions(enabled: boolean): void {
    this.interactivePermissions = enabled;
    if (enabled) return;
    for (const record of this.agents.values()) {
      let changed = false;
      if (record.pendingPermission) {
        this.permissionResolvers.get(record.pendingPermission.id)?.('deny');
        this.permissionResolvers.delete(record.pendingPermission.id);
        this.permissionRules.delete(record.pendingPermission.id);
        record.pendingPermission = undefined;
        changed = true;
      }
      if (record.pendingQuestion) {
        this.questionResolvers.get(record.id)?.({
          action: 'cancel',
          message:
            'No interactive host is available. Use AgentSend from an interactive host to answer.',
        });
        this.questionResolvers.delete(record.id);
        record.pendingQuestion = undefined;
        record.pendingQuestionCreatedAt = undefined;
        changed = true;
      }
      if (changed && !TERMINAL_STATUSES.has(record.status)) {
        record.status = 'running';
        this.persist(record);
      }
    }
  }

  setPermissionMode(mode: string | undefined): void {
    if (mode === undefined) {
      this.permissionModeOverride = undefined;
      this.permissionMode = resolvePermissionMode(this.config.settings);
      return;
    }
    const normalized = normalizePermissionMode(mode);
    if (normalized === undefined) {
      this.permissionModeOverride = 'default';
      this.permissionMode = resolvePermissionMode(this.config.settings, mode);
      return;
    }
    this.permissionModeOverride = normalized;
    this.permissionMode = resolvePermissionMode(this.config.settings, normalized);
  }

  async resolvePermission(
    agentId: string,
    requestId: string,
    response: 'allow' | 'deny' | 'always',
  ): Promise<AgentRecord> {
    await this.ensureInitialized();
    this.assertMutable(agentId);
    const record = this.agents.get(agentId);
    if (!record) throw new Error(`Agent ${agentId} was not found.`);
    if (record.pendingPermission?.id !== requestId) {
      throw new Error(`Permission request ${requestId} is no longer pending.`);
    }
    if (response === 'always') {
      const rule = this.permissionRules.get(requestId);
      if (rule) this.options.persistPermissionRule?.(rule);
    }
    record.pendingPermission = undefined;
    record.status = 'running';
    this.permissionResolvers.get(requestId)?.(response);
    this.permissionResolvers.delete(requestId);
    this.permissionRules.delete(requestId);
    this.persist(record);
    return clone(record);
  }

  async resolveQuestion(agentId: string, response: UserQuestionResponse): Promise<AgentRecord> {
    await this.ensureInitialized();
    this.assertMutable(agentId);
    const record = this.agents.get(agentId);
    if (!record) throw new Error(`Agent ${agentId} was not found.`);
    if (!record.pendingQuestion) throw new Error(`Agent ${agentId} has no pending question.`);
    record.pendingQuestion = undefined;
    record.pendingQuestionCreatedAt = undefined;
    record.status = 'running';
    this.questionResolvers.get(agentId)?.(response);
    this.questionResolvers.delete(agentId);
    this.persist(record);
    return clone(record);
  }

  recordRoutingTelemetry(event: string, data: Record<string, unknown> = {}): void {
    if (!this.config.settings.agents.telemetry) return;
    this.store?.appendTelemetry({ timestamp: Date.now(), event, ...data });
  }

  subscribe(
    listener: (event: AgentRuntimeEvent) => void,
    options: SubscribeOptions = {},
  ): () => void {
    this.subscribers.add(listener);
    if (options.snapshot) {
      void this.ensureInitialized().then(() => {
        for (const record of this.agents.values()) {
          listener({
            type: 'agent_status',
            agent: projectAgentSummary(record),
            parentSessionId: record.parentSessionId,
          });
        }
      });
    }
    return () => this.subscribers.delete(listener);
  }

  async listPendingCompletions(): Promise<AgentCompletionNotification[]> {
    await this.ensureInitialized();
    return Array.from(this.agents.values())
      .filter(
        (record) =>
          TERMINAL_STATUSES.has(record.status) &&
          (record.completionSequence ?? 0) > (record.completionDeliveredSequence ?? 0),
      )
      .map((record) => this.completionNotification(record));
  }

  async acknowledgeCompletion(deliveryId: string): Promise<void> {
    await this.ensureInitialized();
    const record = Array.from(this.agents.values()).find(
      (candidate) => `${candidate.id}:${candidate.completionSequence ?? 0}` === deliveryId,
    );
    if (!record) return;
    this.assertMutable(record.id);
    const sequence = record.completionSequence ?? 0;
    if ((record.completionDeliveredSequence ?? 0) >= sequence) return;
    record.completionDeliveredSequence = sequence;
    this.store?.saveAgent(record);
  }

  async waitForIdle(): Promise<void> {
    await this.ensureInitialized();
    if (this.active === 0 && this.queue.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      this.repoRoot = await (this.options.findGitRoot ?? findGitRoot)(this.config.workspace);
      const hash = repositoryHash(this.repoRoot ?? this.config.workspace);
      this.store = this.options.createStore
        ? this.options.createStore(
            hash,
            this.options.storeRoot,
            this.config.settings.agents.persist,
          )
        : new AgentStore(hash, this.options.storeRoot, this.config.settings.agents.persist, {
            eventSink: (event) => this.handlePersistenceEvent(event),
          });
      const cleanup = this.store.cleanupDetailed(this.config.settings.agents.retentionDays);
      for (const agent of cleanup.agents) {
        await (this.options.removeWorktree ?? removeAgentWorktree)(agent, this.repoRoot);
      }
      for (const snapshot of cleanup.snapshots) {
        await (this.options.removeSnapshot ?? removeSnapshotRef)(snapshot);
      }
      this.store.recoverAbandonedAgents();
      for (const record of this.store.listAgents()) this.agents.set(record.id, record);
      for (const plan of this.store.listPlans()) this.plans.set(plan.id, plan);
      for (const item of this.store.listEvidence()) this.evidence.set(item.id, item);
      for (const snapshot of this.store.listSnapshots()) this.snapshots.set(snapshot.id, snapshot);
      for (const record of this.agents.values()) {
        record.producedEvidenceIds = Array.from(
          new Set([
            ...(record.producedEvidenceIds ?? []),
            ...Array.from(this.evidence.values())
              .filter((item) => item.sourceAgentId === record.id)
              .map((item) => item.id),
          ]),
        );
      }
      for (const record of this.agents.values()) {
        if (record.planId && record.snapshotId)
          this.planSnapshots.set(record.planId, record.snapshotId);
      }
      // Re-drive what died mid-flight. `ensureInitialized` already hydrates agents,
      // plans, evidence, and snapshots — it just never pushed anything onto the
      // queue, so a restart turned the entire pending backlog into terminal records
      // nothing picked up. `prompt` and `purpose` are on disk and never mutated
      // after spawn, so the re-drive needs no information a restart cannot have.
      if (this.config.settings.agents.resumeInterrupted) {
        for (const record of this.agents.values()) {
          if (!record.resumable) continue;
          // A user stop stays stopped; only process death is resumable, and only
          // for work that had not reached a terminal decision of its own.
          if (record.stopReason !== 'process_exit') continue;
          if (!['queued', 'starting', 'running'].includes(record.resumedFromStatus ?? '')) continue;
          record.resumable = false;
          record.status = 'queued';
          record.stopReason = undefined;
          record.finishedAt = undefined;
          this.persist(record);
          this.queue.push(record.id);
          this.emit({ type: 'agent_update', agent: clone(record) });
        }
        if (this.queue.length > 0) queueMicrotask(() => this.pump());
      }
      this.exitHandler = () => {
        for (const record of this.agents.values()) {
          if (
            !['queued', 'starting', 'running', 'waiting_input', 'waiting_permission'].includes(
              record.status,
            )
          )
            continue;
          if (!this.store?.isOwnedByCurrent(record.id)) continue;
          record.status = 'interrupted';
          record.stopReason = 'process_exit';
          record.pendingPermission = undefined;
          record.updatedAt = Date.now();
          record.finishedAt = record.updatedAt;
          beginTerminalGeneration(record);
          this.store?.saveAgent(record);
        }
      };
      process.once('exit', this.exitHandler);
    })();
    return this.initialized;
  }

  private hydrateAgent(agentId: string): AgentRecord | undefined {
    const current = this.agents.get(agentId);
    if (!current || this.hydratedAgentIds.has(agentId) || !this.store) return current;
    const detailed = this.store.loadAgent(agentId);
    if (!detailed) return current;
    this.agents.set(agentId, detailed);
    this.hydratedAgentIds.add(agentId);
    return detailed;
  }

  private agentListRecord(record: AgentRecord): AgentRecord {
    return this.recordForReturn({ ...record, transcript: [] });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.exitHandler) process.off('exit', this.exitHandler);
    for (const record of this.agents.values()) {
      if (!this.store?.isOwnedByCurrent(record.id) || TERMINAL_STATUSES.has(record.status))
        continue;
      record.status = 'interrupted';
      record.stopReason = 'process_exit';
      record.pendingPermission = undefined;
      record.updatedAt = Date.now();
      record.finishedAt = record.updatedAt;
      beginTerminalGeneration(record);
      this.store.saveAgent(record);
    }
    for (const controller of this.controllers.values()) controller.abort('manager_disposed');
    for (const timer of this.textTimers.values()) clearTimeout(timer);
    this.textTimers.clear();
    this.textBuffers.clear();
    this.permissionRules.clear();
    this.subscribers.clear();
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
    this.store?.dispose();
  }

  private notifyIdle(): void {
    if (this.active !== 0 || this.queue.length !== 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private emit(event: AgentRuntimeEvent): void {
    this.legacyEventSink?.(clone(event));
    for (const listener of this.subscribers) listener(clone(event));
  }

  private recordForReturn(record: AgentRecord): AgentRecord {
    const result = clone(record);
    if (this.store?.hasPendingAgent(record.id)) result.durabilityWarning = DURABILITY_WARNING;
    else delete result.durabilityWarning;
    return result;
  }

  private assertMutable(agentId: string): void {
    if (!this.store?.isOwnedByLiveForeign(agentId)) return;
    throw new AgentManagerError(
      `Agent ${agentId} is owned by another live Book process.`,
      'agent_owned_by_other_process',
      true,
      'Retry from the Book process that owns this agent, or wait for that process to exit.',
      { agentId },
    );
  }

  getPersistenceState(): 'healthy' | 'degraded_busy' | 'degraded_unavailable' {
    return this.persistenceState;
  }

  private handlePersistenceEvent(
    event: Extract<AgentRuntimeEvent, { type: 'agent_persistence' }>,
  ): void {
    this.persistenceState =
      event.state === 'recovered'
        ? 'healthy'
        : event.reason === 'busy'
          ? 'degraded_busy'
          : 'degraded_unavailable';
    this.emit(event);
  }

  private requirePersisted(result: AgentStoreWriteResult, operation: string): void {
    if (result.status === 'ok') {
      if (this.persistenceState !== 'healthy' && this.store?.getPersistenceState() === 'healthy') {
        this.handlePersistenceEvent({
          type: 'agent_persistence',
          state: 'recovered',
          reason: this.persistenceState === 'degraded_busy' ? 'busy' : 'unavailable',
          message: 'Agent state storage has recovered.',
          retrying: false,
          timestamp: Date.now(),
        });
      }
      return;
    }
    if (this.persistenceState === 'healthy') {
      this.handlePersistenceEvent({
        type: 'agent_persistence',
        state: 'degraded',
        reason: result.status === 'busy' ? 'busy' : 'unavailable',
        errorCode: result.status === 'unavailable' ? result.errorCode : undefined,
        message:
          result.status === 'busy'
            ? 'Agent state storage is temporarily busy.'
            : 'Agent state storage is unavailable.',
        retrying: false,
        timestamp: Date.now(),
      });
    }
    if (result.status === 'busy') {
      throw new AgentManagerError(
        `Agent state storage is busy while trying to ${operation}.`,
        'agent_store_busy',
        true,
        'Retry after the other process or filesystem scanner releases the agent store.',
        { operation: result.operation, attempts: result.attempts },
      );
    }
    throw new AgentManagerError(
      `Agent state storage is unavailable while trying to ${operation}.`,
      'agent_store_unavailable',
      false,
      'Free disk space or restore write access, then retry the operation.',
      { operation: result.operation, errorCode: result.errorCode },
    );
  }

  private queueTextDelta(agentId: string, text: string): void {
    this.textBuffers.set(agentId, `${this.textBuffers.get(agentId) ?? ''}${text}`);
    if (this.textTimers.has(agentId)) return;
    this.textTimers.set(
      agentId,
      setTimeout(() => this.flushTextDelta(agentId), 32),
    );
  }

  private flushTextDelta(agentId: string): void {
    const timer = this.textTimers.get(agentId);
    if (timer) clearTimeout(timer);
    this.textTimers.delete(agentId);
    const text = this.textBuffers.get(agentId);
    this.textBuffers.delete(agentId);
    if (text) this.emit({ type: 'agent_text_delta', agentId, text });
  }

  private persist(record: AgentRecord, event: 'update' | 'result' = 'update'): void {
    if (event === 'result') {
      record.currentActivity = undefined;
      beginTerminalGeneration(record);
    }
    record.updatedAt = Date.now();
    this.store?.saveAgent(record, { defer: event !== 'result' });
    const publicRecord = this.recordForReturn(record);
    this.notify(record);
    this.emit({
      type: 'agent_status',
      agent: projectAgentSummary(publicRecord),
      parentSessionId: record.parentSessionId,
      rootRunId: record.rootRunId,
      parentRunId: record.parentRunId,
    });
    if (event === 'result' && record.notifyParentOnCompletion !== false) {
      this.emit({
        type: 'agent_completion',
        notification: this.completionNotification(record),
      });
    }
    this.emit({
      type: event === 'result' ? 'agent_result' : 'agent_update',
      agent: publicRecord,
    });
  }

  private completionNotification(record: AgentRecord): AgentCompletionNotification {
    const sequence = record.completionSequence ?? 0;
    return {
      deliveryId: `${record.id}:${sequence}`,
      sequence,
      completion: projectAgentCompletion(this.recordForReturn(record)),
      parentSessionId: record.parentSessionId,
      rootRunId: record.rootRunId,
      parentRunId: record.parentRunId,
      runId: record.runId,
      outcome: record.runOutcome,
    };
  }

  private notify(record: AgentRecord): void {
    const waiters = this.waiters.get(record.id);
    if (!waiters) return;
    for (const resolve of waiters) resolve(this.recordForReturn(record));
    if (waiters.size === 0) this.waiters.delete(record.id);
  }

  private definitions(): ManagedAgentDef[] {
    return withBuiltInAgents(discoverAgents(this.config.workspace));
  }

  async createPlan(input: {
    taskShape: string;
    issueQuality: IssueQuality;
    topology: AgentTopology;
    rationale: string;
    agentBudget: number;
    parentSessionId?: string;
    rootRunId?: string;
    parentRunId?: string;
  }): Promise<AgentPlanRecord> {
    await this.ensureInitialized();
    const requestedBudget = Number.isFinite(input.agentBudget) ? input.agentBudget : 0;
    const plan: AgentPlanRecord = {
      id: randomUUID(),
      parentSessionId: input.parentSessionId,
      rootRunId: input.rootRunId,
      parentRunId: input.parentRunId,
      taskShape: input.taskShape,
      issueQuality: input.issueQuality,
      topology: input.topology,
      rationale: input.rationale,
      agentBudget: Math.max(0, Math.min(Math.floor(requestedBudget), 32)),
      createdAt: Date.now(),
    };
    if (this.store) this.requirePersisted(this.store.savePlan(plan), 'create the agent plan');
    this.plans.set(plan.id, plan);
    return clone(plan);
  }

  async listPlans(): Promise<AgentPlanRecord[]> {
    await this.ensureInitialized();
    return Array.from(this.plans.values(), clone);
  }

  private async snapshotForPlan(planId: string): Promise<AgentSnapshot> {
    const existingId = this.planSnapshots.get(planId);
    if (existingId) {
      const existing = this.snapshots.get(existingId);
      if (existing) return existing;
    }
    const pending = this.snapshotPromises.get(planId);
    if (pending) return pending;
    const creation = (async () => {
      if (!this.repoRoot) {
        throw new Error(
          'Managed agents require a Git workspace. Use --agents off or initialize and commit the repository first.',
        );
      }
      const snapshot = await (this.options.createSnapshot ?? createSyntheticSnapshot)(
        this.repoRoot,
        this.config.settings.agents.includeUntrackedInSnapshot,
      );
      if (this.store) {
        try {
          this.requirePersisted(this.store.saveSnapshot(snapshot), 'save the agent snapshot');
        } catch (error) {
          await (this.options.removeSnapshot ?? removeSnapshotRef)(snapshot).catch(() => {});
          throw error;
        }
      }
      this.snapshots.set(snapshot.id, snapshot);
      this.planSnapshots.set(planId, snapshot.id);
      return snapshot;
    })();
    this.snapshotPromises.set(planId, creation);
    try {
      return await creation;
    } catch (error) {
      this.snapshotPromises.delete(planId);
      throw error;
    }
  }

  async spawn(request: AgentSpawnRequest): Promise<AgentRecord> {
    await this.ensureInitialized();
    if (this.config.settings.agents.mode === 'off') {
      throw new Error('Managed agents are disabled by --agents off or agents.mode=off.');
    }
    const definition = this.definitions().find((candidate) => candidate.name === request.agent);
    if (!definition) {
      throw new Error(
        `Unknown agent "${request.agent}". Available: ${this.definitions()
          .map((candidate) => candidate.name)
          .join(', ')}`,
      );
    }
    if (definition.unknownTools?.length) {
      throw new Error(
        `Agent ${definition.name} declares unsupported tools: ${definition.unknownTools.join(', ')}. Import or edit the definition before running it.`,
      );
    }
    if (definition.isolation === 'worktree' && !this.repoRoot) {
      throw new Error(
        `${definition.name} requires Git worktree isolation. Initialize and commit the repository, or use the explorer profile for read-only discovery.`,
      );
    }
    const outstanding = Array.from(this.agents.values()).filter(
      (record) =>
        !TERMINAL_STATUSES.has(record.status) && this.store?.isOwnedByCurrent(record.id) !== false,
    ).length;
    if (outstanding >= this.config.settings.agents.maxSpawned) {
      throw new Error(
        `Managed agent spawn cap reached (${this.config.settings.agents.maxSpawned} outstanding). Wait for or stop an existing agent before spawning another.`,
      );
    }
    const resolvedProfile = resolveAgentProfile(definition, this.config, request.model);

    let plan = request.planId ? this.plans.get(request.planId) : undefined;
    const autoCreatedPlan = !request.planId;
    if (request.planId && !plan) throw new Error(`Agent plan ${request.planId} was not found.`);
    plan ??= await this.createPlan({
      taskShape: request.prompt.slice(0, 160),
      issueQuality: 'unknown',
      topology: 'single',
      rationale: 'Explicit spawn without a preceding AgentPlan.',
      agentBudget: 1,
      parentSessionId: request.parentSessionId,
      rootRunId: request.rootRunId,
      parentRunId: request.parentRunId,
    });
    const existingForPlan = Array.from(this.agents.values()).filter(
      (record) => record.planId === plan?.id,
    ).length;
    if (existingForPlan >= plan.agentBudget) {
      throw new Error(`Agent plan ${plan.id} has exhausted its budget of ${plan.agentBudget}.`);
    }
    const previousSnapshotId = this.planSnapshots.get(plan.id);
    const preparedSnapshot =
      definition.isolation === 'worktree' ? await this.snapshotForPlan(plan.id) : undefined;
    const now = Date.now();
    const requestedDisplayName =
      request.description?.trim() || deriveAgentDisplayName(request.prompt, definition.name);
    const displayName = uniqueAgentDisplayName(
      requestedDisplayName,
      Array.from(this.agents.values())
        .filter((agent) => !TERMINAL_STATUSES.has(agent.status))
        .map((agent) => agent.displayName ?? agent.name),
    );
    const runId = randomUUID();
    const record: AgentRecord = {
      id: randomUUID(),
      profile: definition.name,
      displayName,
      profileDescription: definition.description,
      purpose: request.prompt,
      requestedModel: resolvedProfile.requestedModel,
      resolvedModel: resolvedProfile.resolvedModel,
      provider: resolvedProfile.provider,
      effort: resolvedProfile.effort,
      isolation: definition.isolation,
      name: definition.name,
      role: definition.role,
      description: definition.description,
      parentSessionId: request.parentSessionId ?? plan.parentSessionId,
      rootRunId: request.rootRunId ?? plan.rootRunId ?? runId,
      parentRunId: request.parentRunId ?? plan.parentRunId,
      notifyParentOnCompletion: request.notifyParentOnCompletion,
      runId,
      planId: plan.id,
      status: 'queued',
      applicationStatus: 'not_applied',
      prompt: request.prompt,
      referencedEvidenceIds: request.evidenceIds ?? [],
      producedEvidenceIds: [],
      transcript: [],
      pendingMessages: [],
      snapshotId: preparedSnapshot?.id,
      createdAt: now,
      updatedAt: now,
    };
    try {
      if (this.store) {
        this.requirePersisted(
          this.store.saveAgent(record, { required: true }),
          'create the initial agent record',
        );
      }
    } catch (error) {
      if (preparedSnapshot && !previousSnapshotId) {
        this.snapshots.delete(preparedSnapshot.id);
        this.planSnapshots.delete(plan.id);
        this.store?.removeSnapshot(preparedSnapshot.id);
        await (this.options.removeSnapshot ?? removeSnapshotRef)(preparedSnapshot).catch(() => {});
      }
      if (autoCreatedPlan) {
        this.plans.delete(plan.id);
        this.store?.removePlan(plan.id);
      }
      throw error;
    }
    this.agents.set(record.id, record);
    this.hydratedAgentIds.add(record.id);
    this.queue.push(record.id);
    this.emit({ type: 'agent_update', agent: clone(record) });
    queueMicrotask(() => this.pump());
    return clone(record);
  }

  async list(): Promise<AgentRecord[]> {
    await this.ensureInitialized();
    for (const refreshed of this.store?.listAgents() ?? []) {
      const current = this.agents.get(refreshed.id);
      if (
        !current ||
        this.store?.isOwnedByLiveForeign(refreshed.id) ||
        isNewerAgentRecord(refreshed, current)
      ) {
        this.agents.set(refreshed.id, refreshed);
        this.hydratedAgentIds.delete(refreshed.id);
      }
    }
    return Array.from(this.agents.values())
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((record) => this.agentListRecord(record));
  }

  async listProfiles(): Promise<
    Array<{
      name: string;
      description: string;
      role: AgentRecord['role'];
      isolation: NonNullable<AgentRecord['isolation']>;
      resolvedModel: string;
      configuredModel?: string;
      color?: string;
    }>
  > {
    await this.ensureInitialized();
    return this.definitions().map((definition) => {
      const resolved = resolveAgentProfile(definition, this.config);
      return {
        name: definition.name,
        description: definition.description,
        role: definition.role,
        isolation: definition.isolation,
        resolvedModel: resolved.resolvedModel,
        configuredModel: this.config.settings.agents.profiles[definition.name]?.model,
        color: resolved.color,
      };
    });
  }

  async get(agentId: string): Promise<AgentRecord | undefined> {
    await this.ensureInitialized();
    for (const refreshed of this.store?.listAgents() ?? []) {
      if (refreshed.id !== agentId) continue;
      const current = this.agents.get(agentId);
      if (
        !current ||
        this.store?.isOwnedByLiveForeign(agentId) ||
        isNewerAgentRecord(refreshed, current)
      ) {
        this.agents.set(agentId, refreshed);
        this.hydratedAgentIds.delete(agentId);
      }
    }
    const record = this.hydrateAgent(agentId);
    return record ? this.recordForReturn(record) : undefined;
  }

  async dismiss(agentId: string): Promise<void> {
    await this.ensureInitialized();
    this.assertMutable(agentId);
    const record = this.agents.get(agentId);
    if (!record) return;
    if (!TERMINAL_STATUSES.has(record.status)) {
      throw new Error('Only terminal agents can be dismissed.');
    }
    await (this.options.removeWorktree ?? removeAgentWorktree)(record, this.repoRoot);
    this.agents.delete(agentId);
    this.hydratedAgentIds.delete(agentId);
    for (const evidence of Array.from(this.evidence.values())) {
      if (evidence.sourceAgentId === agentId) this.evidence.delete(evidence.id);
    }
    this.store?.removeAgent(agentId);
    if (record.snapshotId) {
      const stillReferenced = Array.from(this.agents.values()).some(
        (candidate) => candidate.snapshotId === record.snapshotId,
      );
      if (!stillReferenced) {
        const snapshot = this.snapshots.get(record.snapshotId);
        if (snapshot) await (this.options.removeSnapshot ?? removeSnapshotRef)(snapshot);
        this.snapshots.delete(record.snapshotId);
        if (record.planId && this.planSnapshots.get(record.planId) === record.snapshotId) {
          this.planSnapshots.delete(record.planId);
        }
        this.store?.removeSnapshot(record.snapshotId);
      }
    }
  }

  async send(
    agentId: string,
    message: string,
    evidenceIds: string[] = [],
    runContext?: Pick<AgentRunContext, 'rootRunId' | 'runId'>,
  ): Promise<AgentRecord> {
    await this.ensureInitialized();
    this.assertMutable(agentId);
    const record = this.hydrateAgent(agentId);
    if (!record) throw new Error(`Agent ${agentId} was not found.`);
    const trimmed = message.trim();
    if (!trimmed) throw new Error('AgentSend message must not be empty.');
    record.referencedEvidenceIds = Array.from(
      new Set([...record.referencedEvidenceIds, ...evidenceIds]),
    );

    if (record.status === 'waiting_input' && record.pendingQuestion) {
      const response: UserQuestionResponse = {
        action: 'answer',
        answers: Object.fromEntries(
          record.pendingQuestion.questions.map((question) => [question.question, trimmed]),
        ),
      };
      record.pendingQuestion = undefined;
      record.pendingQuestionCreatedAt = undefined;
      record.status = 'running';
      this.questionResolvers.get(agentId)?.(response);
      this.questionResolvers.delete(agentId);
      this.persist(record);
      return this.recordForReturn(record);
    }

    if (['queued', 'starting', 'running'].includes(record.status)) {
      record.pendingMessages.push(trimmed);
      this.persist(record);
      return this.recordForReturn(record);
    }

    record.prompt = trimmed;
    record.pendingMessages = [];
    record.error = undefined;
    record.result = undefined;
    record.stopReason = undefined;
    record.finishedAt = undefined;
    if (runContext) {
      record.rootRunId = runContext.rootRunId;
      record.parentRunId = runContext.runId;
    }
    record.status = 'queued';
    this.queue.push(record.id);
    this.persist(record);
    queueMicrotask(() => this.pump());
    return this.recordForReturn(record);
  }

  async wait(agentId: string, timeoutMs = 0): Promise<AgentRecord> {
    await this.ensureInitialized();
    const current = this.hydrateAgent(agentId);
    if (!current) throw new Error(`Agent ${agentId} was not found.`);
    if (TERMINAL_STATUSES.has(current.status)) return this.recordForReturn(current);

    return new Promise((resolvePromise) => {
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const finish = (record: AgentRecord) => {
        if (settled) return;
        if (!TERMINAL_STATUSES.has(record.status)) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.waiters.get(agentId)?.delete(finish);
        resolvePromise(this.recordForReturn(record));
      };
      const listeners = this.waiters.get(agentId) ?? new Set();
      listeners.add(finish);
      this.waiters.set(agentId, listeners);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          listeners.delete(finish);
          if (listeners.size === 0) this.waiters.delete(agentId);
          resolvePromise(this.recordForReturn(this.agents.get(agentId)!));
        }, timeoutMs);
      }
    });
  }

  async stop(agentId: string, reason = 'requested'): Promise<AgentRecord> {
    await this.ensureInitialized();
    this.assertMutable(agentId);
    const record = this.agents.get(agentId);
    if (!record) throw new Error(`Agent ${agentId} was not found.`);
    if (TERMINAL_STATUSES.has(record.status)) return this.recordForReturn(record);
    record.stopReason = reason;
    record.status = 'stopped';
    record.runOutcome = createTerminalOutcome('cancelled', 'user_cancelled', {
      partialOutput: Boolean(record.result),
      message: reason,
    });
    record.finishedAt = Date.now();
    this.controllers.get(agentId)?.abort(reason);
    this.questionResolvers.get(agentId)?.({ action: 'cancel', message: reason });
    this.questionResolvers.delete(agentId);
    record.pendingQuestion = undefined;
    record.pendingQuestionCreatedAt = undefined;
    if (record.pendingPermission) {
      this.permissionResolvers.get(record.pendingPermission.id)?.('deny');
      this.permissionResolvers.delete(record.pendingPermission.id);
      this.permissionRules.delete(record.pendingPermission.id);
      record.pendingPermission = undefined;
    }
    const queuedIndex = this.queue.indexOf(agentId);
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
    this.persist(record, 'result');
    this.notifyIdle();
    return this.recordForReturn(record);
  }

  async publishEvidence(agentId: string, input: PublishEvidenceInput): Promise<EvidenceItem> {
    await this.ensureInitialized();
    this.assertMutable(agentId);
    if (!this.agents.has(agentId)) throw new Error(`Agent ${agentId} was not found.`);
    const now = Date.now();
    const requestedConfidence = Number.isFinite(input.confidence) ? input.confidence! : 0.5;
    const item: EvidenceItem = {
      id: randomUUID(),
      kind: input.kind,
      sourceAgentId: agentId,
      summary: input.summary,
      confidence: Math.max(0, Math.min(1, requestedConfidence)),
      references: input.references ?? [],
      verificationState: 'unverified',
      createdAt: now,
      updatedAt: now,
    };
    if (this.store) this.requirePersisted(this.store.saveEvidence(item), 'publish evidence');
    this.evidence.set(item.id, item);
    const record = this.agents.get(agentId);
    if (record) {
      const previousProducedEvidenceIds = [...(record.producedEvidenceIds ?? [])];
      record.producedEvidenceIds = Array.from(
        new Set([...(record.producedEvidenceIds ?? []), item.id]),
      );
      try {
        if (this.store) {
          this.requirePersisted(
            this.store.saveAgent(record, { required: true }),
            'link published evidence to the agent',
          );
        }
      } catch (error) {
        record.producedEvidenceIds = previousProducedEvidenceIds;
        this.evidence.delete(item.id);
        this.store?.removeEvidence(item.id);
        throw error;
      }
    }
    this.emit({ type: 'evidence_update', evidence: clone(item) });
    return clone(item);
  }

  async listEvidence(options?: {
    requesterAgentId?: string;
    includeUnverified?: boolean;
    ids?: string[];
  }): Promise<EvidenceItem[]> {
    await this.ensureInitialized();
    const requester = options?.requesterAgentId
      ? this.agents.get(options.requesterAgentId)
      : undefined;
    const requestedIds = new Set(options?.ids ?? []);
    return Array.from(this.evidence.values())
      .filter((item) => {
        if (requestedIds.size > 0 && !requestedIds.has(item.id)) return false;
        if (!requester) return true;
        if (item.verificationState === 'verified') return true;
        return (
          requester.role === 'validator' &&
          options?.includeUnverified === true &&
          requestedIds.has(item.id)
        );
      })
      .map(clone);
  }

  async reviewEvidence(
    reviewerAgentId: string,
    evidenceId: string,
    verdict: 'pass' | 'fail' | 'inconclusive',
    notes?: string,
  ): Promise<EvidenceItem> {
    await this.ensureInitialized();
    this.assertMutable(reviewerAgentId);
    const reviewer = this.agents.get(reviewerAgentId);
    if (!reviewer) throw new Error(`Reviewer agent ${reviewerAgentId} was not found.`);
    if (reviewer.role !== 'validator')
      throw new Error('Only validator agents may review evidence.');
    const item = this.evidence.get(evidenceId);
    if (!item) throw new Error(`Evidence ${evidenceId} was not found.`);
    if (item.sourceAgentId === reviewerAgentId)
      throw new Error('Agents cannot verify their own evidence.');
    if (!reviewer.referencedEvidenceIds.includes(evidenceId)) {
      throw new Error('Validator was not explicitly assigned this unverified evidence item.');
    }
    const reviewed = clone(item);
    reviewed.verdict = verdict;
    reviewed.verificationState =
      verdict === 'pass' ? 'verified' : verdict === 'fail' ? 'rejected' : 'inconclusive';
    reviewed.reviewerAgentId = reviewerAgentId;
    reviewed.reviewNotes = notes;
    reviewed.reviewedAt = Date.now();
    reviewed.updatedAt = reviewed.reviewedAt;
    if (this.store) this.requirePersisted(this.store.saveEvidence(reviewed), 'review evidence');
    this.evidence.set(reviewed.id, reviewed);
    this.emit({ type: 'evidence_update', evidence: clone(reviewed) });
    return clone(reviewed);
  }

  async apply(agentId: string, evidenceId?: string): Promise<AgentApplyResult> {
    await this.ensureInitialized();
    this.assertMutable(agentId);
    const record = this.agents.get(agentId);
    if (!record) throw new Error(`Agent ${agentId} was not found.`);
    const evidence = evidenceId
      ? this.evidence.get(evidenceId)
      : Array.from(this.evidence.values())
          .filter((item) => item.sourceAgentId === agentId && item.kind === 'patch_candidate')
          .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (!evidence) throw new Error(`No patch candidate evidence was found for agent ${agentId}.`);
    if (
      evidence.verificationState !== 'verified' ||
      evidence.verdict !== 'pass' ||
      !evidence.reviewerAgentId
    ) {
      throw new Error(
        'Patch candidate is locked until a distinct validator records a pass verdict.',
      );
    }
    if (!record.patchCandidate || !evidence.patchCandidate) {
      throw new Error('Patch candidate metadata is missing.');
    }
    if (evidence.patchCandidate.headCommit !== record.patchCandidate.headCommit) {
      throw new Error("Validator verdict does not match the agent's exact patch commit.");
    }
    const snapshot = record.snapshotId ? this.snapshots.get(record.snapshotId) : undefined;
    if (!snapshot) throw new Error('Agent snapshot is unavailable.');
    const result = await (this.options.applyCandidate ?? applyVerifiedCandidate)(
      snapshot,
      evidence.patchCandidate,
    );
    record.applicationStatus = result.status;
    this.persist(record);
    this.emit({
      type: 'agent_apply',
      agentId,
      evidenceId: evidence.id,
      status: result.status,
      commit: result.commit,
      error: result.error,
    });
    this.telemetry('apply', record, { status: result.status });
    return result;
  }

  private pump(): void {
    while (this.active < this.config.settings.agents.maxConcurrent && this.queue.length > 0) {
      const agentId = this.queue.shift()!;
      const record = this.hydrateAgent(agentId);
      if (!record || record.status !== 'queued') continue;
      this.active++;
      void this.run(record).finally(() => {
        this.active--;
        this.pump();
        this.notifyIdle();
      });
    }
  }

  private evidenceContext(record: AgentRecord): EvidenceItem[] {
    const referenced = new Set(record.referencedEvidenceIds);
    return Array.from(this.evidence.values()).filter(
      (item) =>
        item.verificationState === 'verified' ||
        (record.role === 'validator' && referenced.has(item.id)),
    );
  }

  private systemPrompt(
    record: AgentRecord,
    definition: ManagedAgentDef,
    snapshot?: AgentSnapshot,
  ): string {
    const evidence = this.evidenceContext(record).map((item) => ({
      id: item.id,
      kind: item.kind,
      summary: item.summary,
      confidence: item.confidence,
      references: item.references,
      verificationState: item.verificationState,
      patchCandidate: item.patchCandidate,
    }));
    return [
      '## Managed agent identity',
      definition.body,
      `Agent ID: ${record.id}`,
      `Role: ${record.role}`,
      `Isolation: ${record.isolation ?? definition.isolation}`,
      record.worktree
        ? `Managed worktree: ${record.worktree}`
        : `Workspace: ${this.config.workspace}`,
      snapshot
        ? `Snapshot: ${snapshot.id} (${snapshot.manifest.length} changed paths)`
        : 'Snapshot: not used for workspace-readonly isolation',
      `Capabilities: ${describeCapabilities(definition.allowedTools)}`,
      'Delegation is disabled at this depth. Do not attempt to apply work to the parent workspace.',
      '',
      '## Final response contract',
      'Return a compact handoff, not a transcript or process diary.',
      'Start with the outcome or verdict, then give only the material findings, changes, checks, and blockers.',
      'Use exact file:line, command, or commit references. Never paste raw search output or full file contents.',
      'Keep the response under 200 words unless the assigned task explicitly requires more detail. Omit empty sections.',
      '',
      '## Supplied evidence',
      evidence.length > 0
        ? JSON.stringify(evidence, null, 2)
        : '(no verified or explicitly referenced evidence)',
    ].join('\n');
  }

  private async run(record: AgentRecord): Promise<void> {
    record.status = 'starting';
    record.startedAt ??= Date.now();
    record.runSequence = (record.runSequence ?? 0) + 1;
    record.runId = randomUUID();
    record.rootRunId ??= record.runId;
    record.runStartedAt = Date.now();
    record.runUsage = undefined;
    record.runMetrics = { toolCalls: 0, compactions: 0, retries: 0 };
    record.runOutcome = undefined;
    record.result = undefined;
    record.error = undefined;
    const definition = this.definitions().find(
      (candidate) => candidate.name === (record.profile ?? record.name),
    );
    if (!definition) {
      record.status = 'failed';
      record.error = 'Agent definition is no longer available.';
      record.runOutcome = createTerminalOutcome('failed', 'runtime_error', {
        partialOutput: false,
        message: record.error,
      });
      record.finishedAt = Date.now();
      this.persist(record, 'result');
      return;
    }

    const runtime = new SessionRuntime({
      toolExecutionScheduler: this.options.runtime?.toolExecutionScheduler,
      runAccounting: this.options.runtime?.runAccounting,
      runAmbientSnapshots: this.options.runtime?.runAmbientSnapshots,
      // Children inherit a copy of the parent's file observations so files the
      // parent already Read (or the user @-mentioned) stay editable without a
      // redundant re-Read. Worktree children key by their own workspace, so
      // parent entries are simply inert there.
      fileObservationLedger: new Map(this.options.runtime?.fileObservationLedger ?? []),
    });
    const controller = runtime.trackAbortController(new AbortController());
    this.controllers.set(record.id, controller);
    try {
      this.persist(record);
      let snapshot: AgentSnapshot | undefined;
      const isolation = record.isolation ?? definition.isolation;
      if (isolation === 'worktree') {
        snapshot = record.snapshotId
          ? this.snapshots.get(record.snapshotId)
          : record.planId
            ? await this.snapshotForPlan(record.planId)
            : undefined;
        if (!snapshot) throw new Error('Snapshot is unavailable.');
        record.snapshotId = snapshot.id;
        this.store?.saveAgent(record);
        if (controller.signal.aborted || this.agents.get(record.id)?.status === 'stopped') return;
        const validationHead =
          record.role === 'validator'
            ? record.referencedEvidenceIds
                .map((id) => this.evidence.get(id)?.patchCandidate?.headCommit)
                .find((head): head is string => Boolean(head))
            : undefined;
        // Admission control before the checkout, not after. A worktree shares the
        // filesystem with the workspace, so exhausting the disk here breaks the
        // root agent's own writes; refusing with a named reason is recoverable,
        // discovering it mid-edit is not.
        const capacity = checkWorktreeCapacity({
          worktreeRoot: this.options.worktreeRoot ?? defaultWorktreeRoot(),
          repoHash: snapshot.repoHash,
          maxWorktrees: this.config.settings.agents.maxWorktrees,
          minFreeDiskBytes: this.config.settings.agents.minFreeDiskBytes,
        });
        if (!capacity.ok) {
          // Escalate rather than only failing the child: this is the failure that
          // takes the whole run down, so it is worth waking someone for.
          this.hookEventSink?.('Notification', {
            severity: 'alarm',
            kind: `agent_${capacity.reason}`,
            message: capacity.message,
          });
          throw new Error(capacity.message);
        }
        const worktree = await (this.options.createWorktree ?? createAgentWorktree)(
          snapshot,
          record.id,
          this.options.worktreeRoot,
          validationHead,
        );
        record.worktree = worktree.path;
        record.branch = worktree.branch;
        if (controller.signal.aborted || this.agents.get(record.id)?.status === 'stopped') return;
        if (validationHead) {
          await (this.options.checkoutWorktree ?? checkoutAgentCommit)(
            record.worktree,
            validationHead,
          );
        }
      }
      if (controller.signal.aborted || this.agents.get(record.id)?.status === 'stopped') return;
      record.status = 'running';
      this.persist(record);
      this.emit({
        type: 'agent_start',
        agent: clone(record),
        snapshot: snapshot ? { id: snapshot.id, manifest: clone(snapshot.manifest) } : undefined,
      });
      await runHooks(
        this.config.settings.hooks.SubagentStart,
        'SubagentStart',
        {
          workspace: this.config.workspace,
          event: 'SubagentStart',
          agentId: record.id,
          agentRole: record.role,
          parentSessionId: record.parentSessionId,
          worktree: record.worktree,
          status: record.status,
        },
        { onHookEvent: this.hookEventSink, signal: controller.signal },
      );

      const parent = createRegistry();
      parent.registerAll(this.parentDefinitions);
      const registry = createCapabilityRegistry(parent, definition.allowedTools, {
        isolation,
        profile: definition.name,
      });
      if (
        definition.source !== 'builtin' &&
        definition.allowedTools.length > 0 &&
        registry.getDefinitions().every((tool) => tool.name === 'ToolSearch')
      ) {
        throw new Error(
          `Agent ${definition.name} declares tools, but none are available in this host. Check unsupported names or import the definition with /agents import for diagnostics.`,
        );
      }
      const resolvedProfile = resolveAgentProfile(definition, this.config, record.requestedModel);
      const resolvedEffort = usableAgentEffort(record.effort) ?? resolvedProfile.effort;
      let agentConfig: AgentConfig = {
        ...this.config,
        workspace: record.worktree ?? this.config.workspace,
        maxTurns: resolvedProfile.maxTurns,
        effort: resolvedEffort,
        effortExplicit: resolvedEffort !== undefined || this.config.effortExplicit,
        autoCompactEnabled: true,
        memoryContext: undefined,
      };
      if (record.resolvedModel && record.resolvedModel !== 'unknown') {
        agentConfig = applyModelDefaults(
          resolveModelProviderConfig(agentConfig, record.resolvedModel),
        );
      }
      let loopError: string | undefined;
      let terminalOutcome: AgentTerminalOutcome | undefined;
      const startActivity = (
        kind: AgentActivity['kind'],
        label: string,
        toolName?: string,
        id: string = randomUUID(),
        toolCall?: ToolCall,
      ): AgentActivity => {
        const activity: AgentActivity = {
          id,
          kind,
          label,
          toolName,
          toolCall,
          startedAt: Date.now(),
          status: 'running',
        };
        const byCall = this.activities.get(record.id) ?? new Map<string, AgentActivity>();
        byCall.set(id, activity);
        this.activities.set(record.id, byCall);
        record.currentActivity = activity;
        this.emit({ type: 'agent_activity', agentId: record.id, activity: clone(activity) });
        this.persist(record);
        return activity;
      };
      const finishActivityById = (
        activityId: string,
        failed: boolean,
        result?: ToolResult,
      ): void => {
        const activity = this.activities.get(record.id)?.get(activityId);
        if (!activity) return;
        activity.finishedAt = Date.now();
        activity.status = failed ? 'failed' : 'completed';
        if (result) activity.result = projectToolResultForDisplay(result);
        record.currentActivity = activity;
        this.emit({ type: 'agent_activity', agentId: record.id, activity: clone(activity) });
        this.persist(record);
      };
      const finishActivity = (result: ToolResult): void => {
        finishActivityById(result.toolCallId ?? '', result.status !== 'success', result);
      };
      const finishRunningActivities = (failed: boolean): void => {
        for (const activity of this.activities.get(record.id)?.values() ?? []) {
          if (activity.status !== 'running') continue;
          activity.finishedAt = Date.now();
          activity.status = failed ? 'failed' : 'completed';
          record.currentActivity = activity;
          this.emit({ type: 'agent_activity', agentId: record.id, activity: clone(activity) });
          this.persist(record);
        }
      };
      const runContext = createAgentRunContext({
        sessionId: record.parentSessionId ?? `agent:${record.id}`,
        runId: record.runId,
        rootRunId: record.rootRunId,
        parentRunId: record.parentRunId,
        source: 'internal',
      });
      const systemPromptAppend = this.systemPrompt(record, definition, snapshot);
      runtime.runAccounting.startExecution(runContext);
      runtime.recordRunAmbientSnapshot(
        runContext.runId,
        createRunAmbientSnapshot(agentConfig, registry, {
          permissionMode: this.permissionMode,
          systemPromptAppend,
          hideAgents: true,
          planMode: this.permissionMode === 'plan',
          allowedTools: definition.allowedTools,
        }),
      );
      const recordUsage = (usage: Usage): void => {
        record.usage = accumulateUsage(record.usage, usage);
        record.runUsage = accumulateUsage(record.runUsage, usage);
        this.store?.saveAgent(record, { defer: true });
        this.emit({
          type: 'agent_status',
          agent: projectAgentSummary(record),
          parentSessionId: record.parentSessionId,
        });
      };
      const updated = await (this.options.runLoop ?? runAgentLoop)(
        agentConfig,
        registry,
        record.prompt,
        record.transcript,
        {
          onText: (text) => {
            this.queueTextDelta(record.id, text);
          },
          onToolCall: (call) => {
            record.runMetrics!.toolCalls++;
            startActivity('tool', `Using ${call.name}`, call.name, call.id, clone(call));
          },
          onToolResult: (result) => {
            finishActivity(result);
          },
          onError: (error) => {
            loopError = error;
          },
          onTurnStart: (turn) => {
            startActivity('thinking', `Thinking (turn ${turn})`);
          },
          onDone: () => {},
          onTerminal: (outcome) => {
            terminalOutcome = outcome;
            record.runOutcome = outcome;
          },
          onPermissionRequired: async (toolCall: ToolCall) => {
            if (!this.interactivePermissions) return 'deny';
            const request: AgentPermissionRequest = {
              id: randomUUID(),
              agentId: record.id,
              displayName: record.displayName ?? record.name,
              toolName: toolCall.name,
              toolCall: redactToolCallForDisplay(toolCall),
              createdAt: Date.now(),
            };
            record.status = 'waiting_permission';
            record.pendingPermission = request;
            this.permissionRules.set(request.id, permissionRuleForToolCall(toolCall));
            this.persist(record);
            this.emit({ type: 'agent_permission', agentId: record.id, request: clone(request) });
            return new Promise<'allow' | 'deny' | 'always'>((resolvePromise) => {
              this.permissionResolvers.set(request.id, resolvePromise);
            });
          },
          onUsage: recordUsage,
          onAssistantMessageComplete: (message) => {
            this.flushTextDelta(record.id);
            if (!record.transcript.some((candidate) => candidate.id === message.id)) {
              record.transcript.push(message);
            }
            this.store?.saveAgent(record);
            this.emit({ type: 'agent_message', agentId: record.id, message: clone(message) });
          },
          onUserQuestionRequired: async (request) => {
            if (!this.interactivePermissions) {
              return {
                action: 'cancel',
                message:
                  'No interactive host is available to answer this child question. Use AgentSend from an interactive host.',
              };
            }
            const attributedRequest = {
              ...request,
              source:
                request.source.kind === 'subagent'
                  ? {
                      ...request.source,
                      agentPath: [
                        `${record.displayName ?? record.name} (${record.profile ?? record.name})`,
                      ],
                    }
                  : request.source,
            } satisfies typeof request;
            record.status = 'waiting_input';
            record.pendingQuestion = attributedRequest;
            record.pendingQuestionCreatedAt = Date.now();
            this.persist(record);
            this.emit({
              type: 'agent_question',
              agentId: record.id,
              request: attributedRequest,
            });
            return new Promise<UserQuestionResponse>((resolvePromise) => {
              this.questionResolvers.set(record.id, resolvePromise);
            });
          },
          onCompact: (history, usage) => {
            record.runMetrics!.compactions++;
            const activity = startActivity('compacting', 'Compacting context');
            return (this.options.compactRunner ?? runCompact)(agentConfig, history, {
              trigger: 'auto',
              preContextTokens: usage ? usagePressureTokens(usage) : undefined,
              signal: controller.signal,
              beforeModelCall: (model) =>
                runtime.runAccounting.checkBeforeModelCall(runContext.rootRunId, model),
              onUsage: (compactUsage, metadata) => {
                runtime.runAccounting.record(runContext, compactUsage, metadata);
                recordUsage(compactUsage);
              },
              onUsageMissing: (metadata) => {
                runtime.runAccounting.markUsageUnknown(runContext, metadata, 'compaction_usage');
              },
            }).then(
              (result) => {
                finishActivityById(activity.id, result.status === 'failed');
                return result;
              },
              (error) => {
                finishActivityById(activity.id, true);
                throw error;
              },
            );
          },
          onRetry: () => {
            record.runMetrics!.retries++;
            this.store?.saveAgent(record, { defer: true });
          },
          onAgentEvent: (event) => this.emit(event),
        },
        this.permissionMode,
        {
          signal: controller.signal,
          isNewSession: record.transcript.length === 0,
          manageSessionHooks: false,
          isSubagent: true,
          agentPath: [record.name],
          systemPromptAppend,
          hideAgents: true,
          agentId: record.id,
          agentRole: record.role,
          parentSessionId: record.parentSessionId,
          agentManager: this,
          runContext,
          runtime,
          harnessObserver: this.harnessObserver
            ? { observer: this.harnessObserver.observer, runId: runContext.runId }
            : undefined,
        },
      );
      finishRunningActivities(false);
      this.flushTextDelta(record.id);
      record.transcript = updated;
      record.result = lastAssistantText(updated);
      record.error = loopError;

      if (terminalOutcome && terminalOutcome.status !== 'completed') {
        record.runOutcome = terminalOutcome;
        record.status =
          terminalOutcome.status === 'cancelled'
            ? 'stopped'
            : terminalOutcome.status === 'interrupted'
              ? 'interrupted'
              : 'failed';
        record.stopReason = terminalOutcome.reason;
        record.error = terminalOutcome.message ?? loopError;
        record.finishedAt = Date.now();
        this.persist(record, 'result');
        this.telemetry('failed', record, { terminalReason: terminalOutcome.reason });
        return;
      }

      if (loopError && !loopError.startsWith('Reached max turns')) {
        record.runOutcome = createTerminalOutcome('failed', 'provider_error', {
          partialOutput: Boolean(record.result),
          message: loopError,
        });
        record.status = 'failed';
        record.finishedAt = Date.now();
        this.persist(record, 'result');
        this.telemetry('failed', record);
        return;
      }
      if (loopError?.startsWith('Reached max turns')) record.stopReason = 'max_turns';

      if (this.agents.get(record.id)?.status !== 'stopped' && !controller.signal.aborted) {
        if (record.role === 'patcher' && snapshot) {
          const candidate = await (this.options.commitWork ?? commitAgentWork)(record, snapshot);
          if (controller.signal.aborted || this.agents.get(record.id)?.status === 'stopped') return;
          if (candidate) {
            record.patchCandidate = candidate;
            const now = Date.now();
            const item: EvidenceItem = {
              id: randomUUID(),
              kind: 'patch_candidate',
              sourceAgentId: record.id,
              summary: `Patch candidate ${candidate.headCommit} from ${candidate.baseCommit}`,
              confidence: 1,
              references: [
                { type: 'commit', value: candidate.headCommit },
                { type: 'diff', value: `${candidate.baseCommit}..${candidate.headCommit}` },
              ],
              verificationState: 'unverified',
              patchCandidate: candidate,
              createdAt: now,
              updatedAt: now,
            };
            this.evidence.set(item.id, item);
            record.producedEvidenceIds = Array.from(
              new Set([...(record.producedEvidenceIds ?? []), item.id]),
            );
            this.store?.saveEvidence(item, { required: false });
            this.emit({ type: 'evidence_update', evidence: clone(item) });
          }
        }
        if (controller.signal.aborted || this.agents.get(record.id)?.status === 'stopped') return;
        if (record.pendingMessages.length > 0) {
          record.prompt = record.pendingMessages.shift()!;
          record.status = 'queued';
          record.finishedAt = undefined;
          this.queue.push(record.id);
          this.persist(record);
        } else {
          record.runOutcome ??= createTerminalOutcome('completed', 'normal_completion', {
            partialOutput: false,
          });
          record.status = 'completed';
          record.finishedAt = Date.now();
          this.persist(record, 'result');
          this.telemetry('complete', record);
        }
      }
    } catch (error) {
      if (this.disposed) return;
      if (record.status !== 'stopped') {
        this.flushTextDelta(record.id);
        record.status = controller.signal.aborted ? 'stopped' : 'failed';
        record.error = error instanceof Error ? error.message : String(error);
        record.runOutcome = controller.signal.aborted
          ? createTerminalOutcome('cancelled', 'caller_cancelled', {
              partialOutput: Boolean(record.result),
              message: record.error,
            })
          : classifyRuntimeError(error, Boolean(record.result));
        record.finishedAt = Date.now();
        this.persist(record, 'result');
        this.telemetry('failed', record);
      }
    } finally {
      runtime.dispose('managed_agent_complete');
      this.flushTextDelta(record.id);
      this.controllers.delete(record.id);
      this.questionResolvers.delete(record.id);
      if (record.pendingPermission) {
        this.permissionResolvers.get(record.pendingPermission.id)?.('deny');
        this.permissionResolvers.delete(record.pendingPermission.id);
        this.permissionRules.delete(record.pendingPermission.id);
        record.pendingPermission = undefined;
      }
      this.activities.delete(record.id);
      await runHooks(
        this.config.settings.hooks.SubagentStop,
        'SubagentStop',
        {
          workspace: this.config.workspace,
          event: 'SubagentStop',
          agentId: record.id,
          agentRole: record.role,
          parentSessionId: record.parentSessionId,
          worktree: record.worktree,
          status: record.status,
          stopReason: record.stopReason ?? record.error,
        },
        { onHookEvent: this.hookEventSink },
      ).catch(() => {});

      if (
        !this.disposed &&
        // Defensive: a resumed record comes off disk and may predate this field.
        (record.pendingMessages?.length ?? 0) > 0 &&
        record.status !== 'stopped' &&
        record.status !== 'queued'
      ) {
        record.prompt = record.pendingMessages.shift()!;
        record.status = 'queued';
        record.finishedAt = undefined;
        this.queue.push(record.id);
        this.persist(record);
      }
    }
  }

  private telemetry(event: string, record: AgentRecord, extra: Record<string, unknown> = {}): void {
    if (!this.config.settings.agents.telemetry) return;
    const plan = record.planId ? this.plans.get(record.planId) : undefined;
    this.store?.appendTelemetry({
      timestamp: Date.now(),
      event,
      agentId: record.id,
      role: record.role,
      status: record.status,
      route: plan?.topology,
      issueQuality: plan?.issueQuality,
      runSequence: record.runSequence,
      completionSequence: record.completionSequence,
      wallTimeMs: record.runStartedAt ? Date.now() - record.runStartedAt : undefined,
      totalTokens: record.runUsage?.totalTokens,
      cumulativeTokens: record.usage?.totalTokens,
      promptTokens: record.runUsage?.promptTokens,
      completionTokens: record.runUsage?.completionTokens,
      contextTokens: record.runUsage?.contextTokens,
      toolCalls: record.runMetrics?.toolCalls,
      compactions: record.runMetrics?.compactions,
      retries: record.runMetrics?.retries,
      resultCharacters: record.result?.length ?? 0,
      errorKind: errorKind(record.error),
      applicationStatus: record.applicationStatus,
      ...extra,
    });
  }
}

export function getOrCreateAgentManager(
  config: AgentConfig,
  parentDefinitions: ToolDefinition[],
  options: ManagerOptions = {},
): AgentManager {
  if (options.runtime) {
    options.runtime.agentManager ??= new AgentManager(config, parentDefinitions, options);
    options.runtime.agentManager.updateConfig(config);
    options.runtime.agentManager.setPermissionMode(options.permissionMode);
    options.runtime.agentManager.setEventSink(options.eventSink, options.hookEventSink);
    options.runtime.agentManager.setHarnessObserver(options.harnessObserver);
    return options.runtime.agentManager;
  }
  let manager = managersByConfig.get(config);
  if (!manager) {
    manager = new AgentManager(config, parentDefinitions, options);
    managersByConfig.set(config, manager);
  }
  manager.setEventSink(options.eventSink, options.hookEventSink);
  manager.updateConfig(config);
  manager.setPermissionMode(options.permissionMode);
  manager.setHarnessObserver(options.harnessObserver);
  return manager;
}

const managersByConfig = new WeakMap<AgentConfig, AgentManager>();
