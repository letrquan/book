import { randomUUID } from 'crypto';
import type { AgentConfig } from '../types/runtime.js';
import type { Message, Usage } from '../types/messages.js';
import type { ToolDefinition, UserQuestionResponse } from '../types/tools.js';
import { runAgentLoop } from '../agent/loop.js';
import { runCompact, usagePressureTokens } from '../agent/compact.js';
import { applyModelDefaults, resolveModelProviderConfig } from '../config.js';
import { runHooks } from '../hooks.js';
import { discoverAgents } from '../subagent-discovery.js';
import { createRegistry } from '../tools/registry-core.js';
import { createCapabilityRegistry, describeCapabilities } from './capabilities.js';
import {
  applyVerifiedCandidate,
  commitAgentWork,
  createAgentWorktree,
  createSyntheticSnapshot,
  checkoutAgentCommit,
  findGitRoot,
  repositoryHash,
} from './git-isolation.js';
import { withBuiltInAgents, type ManagedAgentDef } from './profiles.js';
import { AgentStore } from './store.js';
import type {
  AgentApplyResult,
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

interface ManagerOptions {
  storeRoot?: string;
  worktreeRoot?: string;
  eventSink?: (event: AgentRuntimeEvent) => void;
  hookEventSink?: (event: string, payload: Record<string, unknown>) => void;
  runLoop?: typeof runAgentLoop;
  findGitRoot?: typeof findGitRoot;
  createSnapshot?: typeof createSyntheticSnapshot;
  createWorktree?: typeof createAgentWorktree;
  checkoutWorktree?: typeof checkoutAgentCommit;
  commitWork?: typeof commitAgentWork;
  applyCandidate?: typeof applyVerifiedCandidate;
  runtime?: SessionRuntime;
}

interface PublishEvidenceInput {
  kind: EvidenceKind;
  summary: string;
  confidence?: number;
  references?: EvidenceReference[];
}

const TERMINAL_STATUSES = new Set<AgentStatus>(['completed', 'failed', 'stopped', 'interrupted']);

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

export class AgentManager {
  private readonly config: AgentConfig;
  private readonly parentDefinitions: ToolDefinition[];
  private readonly options: ManagerOptions;
  private store?: AgentStore;
  private repoRoot?: string;
  private initialized?: Promise<void>;
  private readonly agents = new Map<string, AgentRecord>();
  private readonly plans = new Map<string, AgentPlanRecord>();
  private readonly evidence = new Map<string, EvidenceItem>();
  private readonly snapshots = new Map<string, AgentSnapshot>();
  private readonly planSnapshots = new Map<string, string>();
  private readonly snapshotPromises = new Map<string, Promise<AgentSnapshot>>();
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly questionResolvers = new Map<string, (response: UserQuestionResponse) => void>();
  private readonly waiters = new Map<string, Set<(record: AgentRecord) => void>>();
  private active = 0;
  private eventSink?: (event: AgentRuntimeEvent) => void;
  private hookEventSink?: (event: string, payload: Record<string, unknown>) => void;
  private exitHandler?: () => void;

  constructor(
    config: AgentConfig,
    parentDefinitions: ToolDefinition[],
    options: ManagerOptions = {},
  ) {
    this.config = config;
    this.parentDefinitions = parentDefinitions;
    this.options = options;
    this.eventSink = options.eventSink;
    this.hookEventSink = options.hookEventSink;
  }

  setEventSink(
    sink?: (event: AgentRuntimeEvent) => void,
    hookSink?: (event: string, payload: Record<string, unknown>) => void,
  ): void {
    if (sink) this.eventSink = sink;
    if (hookSink) this.hookEventSink = hookSink;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return this.initialized;
    this.initialized = (async () => {
      this.repoRoot = await (this.options.findGitRoot ?? findGitRoot)(this.config.workspace);
      const hash = repositoryHash(this.repoRoot ?? this.config.workspace);
      this.store = new AgentStore(
        hash,
        this.options.storeRoot,
        this.config.settings.agents.persist,
      );
      this.store.cleanup(this.config.settings.agents.retentionDays);
      this.store.markActiveInterrupted();
      for (const record of this.store.listAgents()) this.agents.set(record.id, record);
      for (const plan of this.store.listPlans()) this.plans.set(plan.id, plan);
      for (const item of this.store.listEvidence()) this.evidence.set(item.id, item);
      for (const snapshot of this.store.listSnapshots()) this.snapshots.set(snapshot.id, snapshot);
      for (const record of this.agents.values()) {
        if (record.planId && record.snapshotId)
          this.planSnapshots.set(record.planId, record.snapshotId);
      }
      this.exitHandler = () => {
        for (const record of this.agents.values()) {
          if (!['queued', 'starting', 'running', 'waiting_input'].includes(record.status)) continue;
          record.status = 'interrupted';
          record.stopReason = 'process_exit';
          record.updatedAt = Date.now();
          record.finishedAt = record.updatedAt;
          this.store?.saveAgent(record);
        }
      };
      process.once('exit', this.exitHandler);
    })();
    return this.initialized;
  }

  dispose(): void {
    if (this.exitHandler) process.off('exit', this.exitHandler);
    for (const controller of this.controllers.values()) controller.abort('manager_disposed');
  }

  private emit(event: AgentRuntimeEvent): void {
    this.eventSink?.(clone(event));
  }

  private persist(record: AgentRecord, event: 'update' | 'result' = 'update'): void {
    record.updatedAt = Date.now();
    this.store?.saveAgent(record);
    this.notify(record);
    this.emit({ type: event === 'result' ? 'agent_result' : 'agent_update', agent: clone(record) });
  }

  private notify(record: AgentRecord): void {
    const waiters = this.waiters.get(record.id);
    if (!waiters) return;
    for (const resolve of waiters) resolve(clone(record));
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
  }): Promise<AgentPlanRecord> {
    await this.ensureInitialized();
    const requestedBudget = Number.isFinite(input.agentBudget) ? input.agentBudget : 0;
    const plan: AgentPlanRecord = {
      id: randomUUID(),
      parentSessionId: input.parentSessionId,
      taskShape: input.taskShape,
      issueQuality: input.issueQuality,
      topology: input.topology,
      rationale: input.rationale,
      agentBudget: Math.max(0, Math.min(Math.floor(requestedBudget), 32)),
      createdAt: Date.now(),
    };
    this.plans.set(plan.id, plan);
    this.store?.savePlan(plan);
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
      this.snapshots.set(snapshot.id, snapshot);
      this.planSnapshots.set(planId, snapshot.id);
      this.store?.saveSnapshot(snapshot);
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
    if (!this.repoRoot) {
      throw new Error(
        'Managed agents require a Git workspace. Use --agents off or initialize and commit the repository first.',
      );
    }
    const definition = this.definitions().find((candidate) => candidate.name === request.agent);
    if (!definition) {
      throw new Error(
        `Unknown agent "${request.agent}". Available: ${this.definitions()
          .map((candidate) => candidate.name)
          .join(', ')}`,
      );
    }

    let plan = request.planId ? this.plans.get(request.planId) : undefined;
    if (request.planId && !plan) throw new Error(`Agent plan ${request.planId} was not found.`);
    plan ??= await this.createPlan({
      taskShape: request.prompt.slice(0, 160),
      issueQuality: 'unknown',
      topology: 'single',
      rationale: 'Explicit spawn without a preceding AgentPlan.',
      agentBudget: 1,
      parentSessionId: request.parentSessionId,
    });
    const existingForPlan = Array.from(this.agents.values()).filter(
      (record) => record.planId === plan?.id,
    ).length;
    if (existingForPlan >= plan.agentBudget) {
      throw new Error(`Agent plan ${plan.id} has exhausted its budget of ${plan.agentBudget}.`);
    }
    const now = Date.now();
    const record: AgentRecord = {
      id: randomUUID(),
      name: definition.name,
      role: definition.role,
      description: definition.description,
      parentSessionId: request.parentSessionId ?? plan.parentSessionId,
      planId: plan.id,
      status: 'queued',
      applicationStatus: 'not_applied',
      prompt: request.prompt,
      referencedEvidenceIds: request.evidenceIds ?? [],
      transcript: [],
      pendingMessages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.agents.set(record.id, record);
    this.store?.saveAgent(record);
    this.queue.push(record.id);
    this.emit({ type: 'agent_update', agent: clone(record) });
    queueMicrotask(() => this.pump());
    return clone(record);
  }

  async list(): Promise<AgentRecord[]> {
    await this.ensureInitialized();
    return Array.from(this.agents.values())
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map(clone);
  }

  async get(agentId: string): Promise<AgentRecord | undefined> {
    await this.ensureInitialized();
    const record = this.agents.get(agentId);
    return record ? clone(record) : undefined;
  }

  async send(agentId: string, message: string, evidenceIds: string[] = []): Promise<AgentRecord> {
    await this.ensureInitialized();
    const record = this.agents.get(agentId);
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
      record.status = 'running';
      this.questionResolvers.get(agentId)?.(response);
      this.questionResolvers.delete(agentId);
      this.persist(record);
      return clone(record);
    }

    if (['queued', 'starting', 'running'].includes(record.status)) {
      record.pendingMessages.push(trimmed);
      this.persist(record);
      return clone(record);
    }

    record.prompt = trimmed;
    record.pendingMessages = [];
    record.error = undefined;
    record.stopReason = undefined;
    record.finishedAt = undefined;
    record.status = 'queued';
    this.queue.push(record.id);
    this.persist(record);
    queueMicrotask(() => this.pump());
    return clone(record);
  }

  async wait(agentId: string, timeoutMs = 0): Promise<AgentRecord> {
    await this.ensureInitialized();
    const current = this.agents.get(agentId);
    if (!current) throw new Error(`Agent ${agentId} was not found.`);
    if (TERMINAL_STATUSES.has(current.status)) return clone(current);

    return new Promise((resolvePromise) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = (record: AgentRecord) => {
        if (!TERMINAL_STATUSES.has(record.status)) return;
        if (timer) clearTimeout(timer);
        this.waiters.get(agentId)?.delete(finish);
        resolvePromise(clone(record));
      };
      const listeners = this.waiters.get(agentId) ?? new Set();
      listeners.add(finish);
      this.waiters.set(agentId, listeners);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          listeners.delete(finish);
          if (listeners.size === 0) this.waiters.delete(agentId);
          resolvePromise(clone(this.agents.get(agentId)!));
        }, timeoutMs);
      }
    });
  }

  async stop(agentId: string, reason = 'requested'): Promise<AgentRecord> {
    await this.ensureInitialized();
    const record = this.agents.get(agentId);
    if (!record) throw new Error(`Agent ${agentId} was not found.`);
    if (TERMINAL_STATUSES.has(record.status)) return clone(record);
    record.stopReason = reason;
    record.status = 'stopped';
    record.finishedAt = Date.now();
    this.controllers.get(agentId)?.abort(reason);
    this.questionResolvers.get(agentId)?.({ action: 'cancel', message: reason });
    this.questionResolvers.delete(agentId);
    const queuedIndex = this.queue.indexOf(agentId);
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
    this.persist(record, 'result');
    return clone(record);
  }

  async publishEvidence(agentId: string, input: PublishEvidenceInput): Promise<EvidenceItem> {
    await this.ensureInitialized();
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
    this.evidence.set(item.id, item);
    this.store?.saveEvidence(item);
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
    item.verdict = verdict;
    item.verificationState =
      verdict === 'pass' ? 'verified' : verdict === 'fail' ? 'rejected' : 'inconclusive';
    item.reviewerAgentId = reviewerAgentId;
    item.reviewNotes = notes;
    item.reviewedAt = Date.now();
    item.updatedAt = item.reviewedAt;
    this.store?.saveEvidence(item);
    this.emit({ type: 'evidence_update', evidence: clone(item) });
    return clone(item);
  }

  async apply(agentId: string, evidenceId?: string): Promise<AgentApplyResult> {
    await this.ensureInitialized();
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
      const record = this.agents.get(agentId);
      if (!record || record.status !== 'queued') continue;
      this.active++;
      void this.run(record).finally(() => {
        this.active--;
        this.pump();
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
    snapshot: AgentSnapshot,
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
      `Managed worktree: ${record.worktree}`,
      `Snapshot: ${snapshot.id} (${snapshot.manifest.length} changed paths)`,
      `Capabilities: ${describeCapabilities(definition.allowedTools)}`,
      'Delegation is disabled at this depth. Do not attempt to apply work to the parent workspace.',
      '',
      '## Supplied evidence',
      evidence.length > 0
        ? JSON.stringify(evidence, null, 2)
        : '(no verified or explicitly referenced evidence)',
    ].join('\n');
  }

  private async run(record: AgentRecord): Promise<void> {
    const definition = this.definitions().find((candidate) => candidate.name === record.name);
    if (!definition) {
      record.status = 'failed';
      record.error = 'Agent definition is no longer available.';
      record.finishedAt = Date.now();
      this.persist(record, 'result');
      return;
    }

    const runtime = new SessionRuntime();
    const controller = runtime.trackAbortController(new AbortController());
    this.controllers.set(record.id, controller);
    try {
      record.status = 'starting';
      record.startedAt ??= Date.now();
      this.persist(record);
      const snapshot = record.snapshotId
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
      if (controller.signal.aborted || this.agents.get(record.id)?.status === 'stopped') return;
      record.status = 'running';
      this.persist(record);
      this.emit({
        type: 'agent_start',
        agent: clone(record),
        snapshot: { id: snapshot.id, manifest: clone(snapshot.manifest) },
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
      const registry = createCapabilityRegistry(parent, definition.allowedTools);
      let agentConfig: AgentConfig = {
        ...this.config,
        workspace: record.worktree,
        maxTurns: definition.maxTurns ?? this.config.maxTurns,
        autoCompactEnabled: true,
        memoryContext: undefined,
      };
      if (definition.model) {
        agentConfig = applyModelDefaults(resolveModelProviderConfig(agentConfig, definition.model));
      }
      let loopError: string | undefined;
      const updated = await (this.options.runLoop ?? runAgentLoop)(
        agentConfig,
        registry,
        record.prompt,
        record.transcript,
        {
          onText: () => {},
          onToolCall: () => {},
          onToolResult: () => {},
          onError: (error) => {
            loopError = error;
          },
          onTurnStart: () => {},
          onDone: () => {},
          onPermissionRequired: async () => 'deny',
          onUsage: (usage) => {
            record.usage = accumulateUsage(record.usage, usage);
            this.store?.saveAgent(record);
          },
          onAssistantMessageComplete: () => {
            this.store?.saveAgent(record);
          },
          onUserQuestionRequired: async (request) => {
            record.status = 'waiting_input';
            record.pendingQuestion = request;
            this.persist(record);
            this.emit({ type: 'agent_question', agentId: record.id, request });
            return new Promise<UserQuestionResponse>((resolvePromise) => {
              this.questionResolvers.set(record.id, resolvePromise);
            });
          },
          onCompact: (history, usage) =>
            runCompact(agentConfig, history, {
              trigger: 'auto',
              preContextTokens: usagePressureTokens(usage),
              signal: controller.signal,
            }),
          onAgentEvent: this.eventSink,
        },
        'bypassPermissions',
        {
          signal: controller.signal,
          isNewSession: record.transcript.length === 0,
          manageSessionHooks: false,
          isSubagent: true,
          agentPath: [record.name],
          systemPromptAppend: this.systemPrompt(record, definition, snapshot),
          hideAgents: true,
          agentId: record.id,
          agentRole: record.role,
          parentSessionId: record.parentSessionId,
          runtime,
        },
      );
      record.transcript = updated;
      record.result = lastAssistantText(updated);
      record.error = loopError;

      if (loopError && !loopError.startsWith('Reached max turns')) {
        record.status = 'failed';
        record.finishedAt = Date.now();
        this.persist(record, 'result');
        this.telemetry('failed', record);
        return;
      }
      if (loopError?.startsWith('Reached max turns')) record.stopReason = 'max_turns';

      if (this.agents.get(record.id)?.status !== 'stopped' && !controller.signal.aborted) {
        if (record.role === 'patcher') {
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
            this.store?.saveEvidence(item);
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
          record.status = 'completed';
          record.finishedAt = Date.now();
          this.persist(record, 'result');
          this.telemetry('complete', record);
        }
      }
    } catch (error) {
      if (record.status !== 'stopped') {
        record.status = controller.signal.aborted ? 'stopped' : 'failed';
        record.error = error instanceof Error ? error.message : String(error);
        record.finishedAt = Date.now();
        this.persist(record, 'result');
        this.telemetry('failed', record);
      }
    } finally {
      runtime.dispose('managed_agent_complete');
      this.controllers.delete(record.id);
      this.questionResolvers.delete(record.id);
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
        record.pendingMessages.length > 0 &&
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
      wallTimeMs: record.startedAt ? Date.now() - record.startedAt : undefined,
      totalTokens: record.usage?.totalTokens,
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
    options.runtime.agentManager.setEventSink(options.eventSink, options.hookEventSink);
    return options.runtime.agentManager;
  }
  let manager = managersByConfig.get(config);
  if (!manager) {
    manager = new AgentManager(config, parentDefinitions, options);
    managersByConfig.set(config, manager);
  }
  manager.setEventSink(options.eventSink, options.hookEventSink);
  return manager;
}

const managersByConfig = new WeakMap<AgentConfig, AgentManager>();
