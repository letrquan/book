import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type { AgentConfig } from '../types/runtime.js';
import type { Message } from '../types/messages.js';
import { defaultConfig, toolResult } from '../test/fixtures.js';
import { AgentManager } from './manager.js';
import { AgentStore } from './store.js';
import type { AtomicJsonWriter } from './atomic-json.js';
import { repositoryHash } from './git-isolation.js';
import type { AgentRuntimeEvent, AgentSnapshot } from './types.js';
import { createAgentRunContext } from '../types/runs.js';
import { SessionRuntime } from '../session/runtime.js';

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'book-manager-test-'));
  tempRoots.push(root);
  return root;
}

function snapshot(root: string): AgentSnapshot {
  return {
    id: 'snapshot',
    repoRoot: root,
    repoHash: 'repo',
    baseHead: 'base-head',
    commit: 'snapshot-commit',
    tree: 'tree',
    ref: 'refs/book/test',
    fingerprint: 'base-head:tree',
    dirty: false,
    includeUntracked: true,
    manifest: [],
    createdAt: Date.now(),
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

describe('AgentManager lifecycle', () => {
  it('rolls back an unstarted agent and returns a typed retryable error when initial persistence is busy', async () => {
    const root = tempRoot();
    const storeRoot = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = true;
    const runLoop = vi.fn();
    const removeSnapshot = vi.fn(async () => {});
    const writer = {
      write: vi.fn((target: string) =>
        target.includes(`${join('records', '')}`)
          ? {
              status: 'busy' as const,
              target,
              operation: 'rename' as const,
              attempts: 4,
              elapsedMs: 500,
            }
          : { status: 'ok' as const, target, attempts: 1, elapsedMs: 0 },
      ),
    } as unknown as AtomicJsonWriter;
    const manager = new AgentManager(config, [], {
      storeRoot,
      findGitRoot: async () => root,
      createSnapshot: async () => snapshot(root),
      removeSnapshot,
      runLoop,
      createStore: (repoHash, requestedRoot, enabled) =>
        new AgentStore(repoHash, requestedRoot, enabled, { writer }),
    });

    await expect(manager.spawn({ agent: 'patcher', prompt: 'inspect' })).rejects.toMatchObject({
      code: 'agent_store_busy',
      retryable: true,
    });
    expect(await manager.list()).toEqual([]);
    expect(await manager.listPlans()).toEqual([]);
    expect(manager.getPersistenceState()).toBe('degraded_busy');
    expect(runLoop).not.toHaveBeenCalled();
    expect(removeSnapshot).toHaveBeenCalledWith(expect.objectContaining({ id: 'snapshot' }));
    manager.dispose();
  });

  it('allows reading but rejects mutation of an agent owned by another live process', async () => {
    const root = tempRoot();
    const storeRoot = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = true;
    const owner = new AgentStore(repositoryHash(root), storeRoot, true);
    owner.saveAgent(
      {
        id: 'foreign-agent',
        name: 'explorer',
        role: 'explorer',
        description: 'Explore',
        status: 'running',
        applicationStatus: 'not_applied',
        prompt: 'inspect',
        referencedEvidenceIds: [],
        transcript: [],
        pendingMessages: [],
        createdAt: 1,
        updatedAt: 1,
      },
      { required: true },
    );
    const manager = new AgentManager(config, [], {
      storeRoot,
      findGitRoot: async () => undefined,
    });

    expect(await manager.get('foreign-agent')).toMatchObject({ status: 'running' });
    await expect(manager.send('foreign-agent', 'continue')).rejects.toMatchObject({
      code: 'agent_owned_by_other_process',
    });
    manager.dispose();
    owner.dispose();
  });

  it('refreshes a cached foreign agent after its owner exits with a terminal update', async () => {
    const root = tempRoot();
    const storeRoot = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = true;
    let now = 1;
    const owner = new AgentStore(repositoryHash(root), storeRoot, true, {
      instanceId: '11111111-1111-4111-8111-111111111111',
      pid: 111,
      hostname: 'test-host',
      now: () => now,
    });
    const foreign = {
      id: 'foreign-terminal-agent',
      name: 'explorer',
      role: 'explorer' as const,
      description: 'Explore',
      status: 'running' as const,
      applicationStatus: 'not_applied' as const,
      prompt: 'inspect',
      referencedEvidenceIds: [],
      transcript: [],
      pendingMessages: [],
      createdAt: 1,
      updatedAt: 1,
    };
    owner.saveAgent(foreign, { required: true });
    const manager = new AgentManager(config, [], {
      storeRoot,
      findGitRoot: async () => undefined,
      createStore: (repoHash, requestedRoot, enabled) =>
        new AgentStore(repoHash, requestedRoot, enabled, {
          instanceId: '22222222-2222-4222-8222-222222222222',
          pid: 222,
          hostname: 'test-host',
          now: () => now,
          processAlive: () => false,
        }),
    });

    expect(await manager.get(foreign.id)).toMatchObject({ status: 'running' });
    now = 2;
    owner.saveAgent(
      {
        ...foreign,
        status: 'completed',
        result: 'done',
        completionSequence: 1,
        updatedAt: now,
      },
      { required: true },
    );
    owner.dispose();
    now = 100_000;

    expect(await manager.list()).toEqual([
      expect.objectContaining({ id: foreign.id, status: 'completed', result: 'done' }),
    ]);
    expect(await manager.get(foreign.id)).toMatchObject({ status: 'completed', result: 'done' });
    manager.dispose();
  });

  it('delivers a useful terminal result with a durability warning while retry is pending', async () => {
    const root = tempRoot();
    const storeRoot = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = true;
    let recordWrites = 0;
    const writer = {
      write: vi.fn((target: string) => {
        if (target.includes(`${join('records', '')}`) && ++recordWrites > 1) {
          return {
            status: 'busy' as const,
            target,
            operation: 'rename' as const,
            attempts: 4,
            elapsedMs: 500,
          };
        }
        return { status: 'ok' as const, target, attempts: 1, elapsedMs: 0 };
      }),
    } as unknown as AtomicJsonWriter;
    const manager = new AgentManager(config, [], {
      storeRoot,
      findGitRoot: async () => undefined,
      createStore: (repoHash, requestedRoot, enabled) =>
        new AgentStore(repoHash, requestedRoot, enabled, { writer }),
      runLoop: async (_config, _registry, _prompt, history) => [
        ...history,
        {
          id: 'result',
          role: 'assistant',
          content: 'Completed in memory',
          includeInContext: true,
          timestamp: 1,
        },
      ],
    });

    const spawned = await manager.spawn({ agent: 'explorer', prompt: 'inspect' });
    const completed = await manager.wait(spawned.id, 1_000);

    expect(completed).toMatchObject({
      status: 'completed',
      result: 'Completed in memory',
    });
    expect(completed.durabilityWarning).toContain('waiting for durable storage');
    manager.dispose();
  });

  it('dismisses terminal agents with their evidence, worktree, and unshared snapshot', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    const removeWorktree = vi.fn(async () => {});
    const removeSnapshot = vi.fn(async () => {});
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      worktreeRoot: tempRoot(),
      findGitRoot: async () => root,
      createSnapshot: async () => snapshot(root),
      createWorktree: async (_snapshot, agentId) => ({
        path: join(root, agentId),
        branch: `branch-${agentId}`,
      }),
      commitWork: async () => undefined,
      removeWorktree,
      removeSnapshot,
      runLoop: async (_config, _registry, _prompt, history) => history,
    });
    const record = await manager.spawn({ agent: 'patcher', prompt: 'patch' });
    await manager.wait(record.id, 1000);
    const evidence = await manager.publishEvidence(record.id, {
      kind: 'finding',
      summary: 'temporary finding',
    });

    await manager.dismiss(record.id);

    expect(await manager.get(record.id)).toBeUndefined();
    expect((await manager.listEvidence()).find((item) => item.id === evidence.id)).toBeUndefined();
    expect(removeWorktree).toHaveBeenCalledOnce();
    expect(removeSnapshot).toHaveBeenCalledWith(expect.objectContaining({ id: 'snapshot' }));
    manager.dispose();
  });

  it('caps outstanding spawned agents without limiting completed history', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    config.settings.agents.maxConcurrent = 1;
    config.settings.agents.maxSpawned = 2;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      findGitRoot: async () => undefined,
      runLoop: async (_config, _registry, prompt, history) => {
        if (prompt !== 'third') await gate;
        return history;
      },
    });

    const first = await manager.spawn({ agent: 'explorer', prompt: 'first' });
    await manager.spawn({ agent: 'explorer', prompt: 'second' });
    await expect(manager.spawn({ agent: 'explorer', prompt: 'blocked' })).rejects.toThrow(
      'spawn cap reached',
    );

    release();
    await manager.wait(first.id, 1000);
    await manager.waitForIdle();
    await expect(manager.spawn({ agent: 'explorer', prompt: 'third' })).resolves.toMatchObject({
      status: 'queued',
    });
    await manager.waitForIdle();
    manager.dispose();
  });

  it('tracks resumed execution generations separately from cumulative usage', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    let messageIndex = 0;
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      findGitRoot: async () => undefined,
      runLoop: async (_config, _registry, prompt, history, callbacks) => {
        callbacks.onUsage?.({ promptTokens: 2, completionTokens: 3, totalTokens: 5 });
        return [
          ...history,
          {
            id: `assistant-${messageIndex++}`,
            role: 'assistant',
            content: `Finished ${prompt}`,
            includeInContext: true,
            timestamp: Date.now(),
          },
        ];
      },
    });

    const spawned = await manager.spawn({ agent: 'explorer', prompt: 'first' });
    const first = await manager.wait(spawned.id, 1000);
    const identityStartedAt = first.startedAt;
    const firstRunId = first.runId;
    const rootRunId = first.rootRunId;
    expect(first).toMatchObject({
      runSequence: 1,
      runUsage: { totalTokens: 5 },
      usage: { totalTokens: 5 },
    });

    await manager.send(spawned.id, 'second', [], {
      runId: 'current-parent-run',
      rootRunId: 'current-root-run',
    });
    const second = await manager.wait(spawned.id, 1000);
    expect(second.startedAt).toBe(identityStartedAt);
    expect(second.runId).not.toBe(firstRunId);
    expect(rootRunId).not.toBe('current-root-run');
    expect(second.rootRunId).toBe('current-root-run');
    expect(second.parentRunId).toBe('current-parent-run');
    expect(second).toMatchObject({
      runSequence: 2,
      runUsage: { totalTokens: 5 },
      usage: { totalTokens: 10 },
      result: 'Finished second',
    });
    manager.dispose();
  });

  it('attributes managed-child compaction usage to the shared root accounting', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root, model: 'gpt-5' });
    config.settings.agents.persist = false;
    const runtime = new SessionRuntime();
    const parentContext = createAgentRunContext({
      sessionId: 'parent-session',
      runId: 'parent-run',
      source: 'headless',
      startedAt: 1,
    });
    runtime.runAccounting.startRoot(parentContext, 1);
    const budgetChecks: unknown[] = [];
    const compactRunner = vi.fn(async (_config, _history, options) => {
      budgetChecks.push(options.beforeModelCall?.('gpt-5'));
      options.onUsage?.(
        { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
        {
          provider: 'openai-compatible',
          requestedModel: 'gpt-5',
          responseModel: 'gpt-5',
          responseId: 'child-compact-response',
        },
      );
      return { status: 'skipped' as const, reason: 'too-short' as const };
    });
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      findGitRoot: async () => undefined,
      runtime,
      compactRunner,
      runLoop: async (_config, _registry, prompt, history, callbacks) => {
        await callbacks.onCompact?.(history, null);
        return [
          ...history,
          {
            id: 'assistant-child-compact',
            role: 'assistant',
            content: `Finished ${prompt}`,
            includeInContext: true,
            timestamp: Date.now(),
          },
        ];
      },
    });

    const spawned = await manager.spawn({
      agent: 'explorer',
      prompt: 'inspect',
      rootRunId: parentContext.rootRunId,
      parentRunId: parentContext.runId,
    });
    const finished = await manager.wait(spawned.id, 1000);

    expect(budgetChecks).toEqual([{ allowed: true, status: 'within' }]);
    expect(finished).toMatchObject({
      runUsage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
      usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
      runMetrics: { compactions: 1 },
    });
    expect(runtime.runAccounting.snapshotRun(finished.runId!)).toMatchObject({
      directUsage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
      modelIdentities: [{ responseId: 'child-compact-response', status: 'verified' }],
      missingSources: ['failed_provider_attempt_usage'],
    });
    expect(runtime.snapshotRunAmbient(finished.runId!)).toMatchObject({
      schemaVersion: 1,
      model: { requestedModel: 'gpt-5' },
      settings: { agentsMode: 'adaptive' },
      policies: { permissionMode: 'default' },
      completeness: 'partial',
    });
    manager.dispose();
  });

  it('marks shared root accounting unknown when managed-child compaction omits usage', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root, model: 'gpt-5' });
    config.settings.agents.persist = false;
    const runtime = new SessionRuntime();
    const parentContext = createAgentRunContext({
      sessionId: 'parent-session',
      runId: 'parent-run',
      source: 'headless',
      startedAt: 1,
    });
    runtime.runAccounting.startRoot(parentContext, 1);
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      findGitRoot: async () => undefined,
      runtime,
      compactRunner: async (_config, _history, options) => {
        options.onUsageMissing?.({
          provider: 'openai-compatible',
          requestedModel: 'gpt-5',
          responseModel: 'gpt-5',
          responseId: 'child-compact-without-usage',
        });
        return { status: 'skipped' as const, reason: 'too-short' as const };
      },
      runLoop: async (_config, _registry, prompt, history, callbacks) => {
        await callbacks.onCompact?.(history, null);
        return [
          ...history,
          {
            id: 'assistant-child-compact-without-usage',
            role: 'assistant',
            content: `Finished ${prompt}`,
            includeInContext: true,
            timestamp: Date.now(),
          },
        ];
      },
    });

    const spawned = await manager.spawn({
      agent: 'explorer',
      prompt: 'inspect',
      rootRunId: parentContext.rootRunId,
      parentRunId: parentContext.runId,
    });
    const finished = await manager.wait(spawned.id, 1000);

    expect(runtime.runAccounting.snapshotRun(finished.runId!)).toMatchObject({
      costUsd: null,
      costStatus: 'unknown',
      budgetStatus: 'unknown',
      missingSources: ['failed_provider_attempt_usage', 'compaction_usage'],
    });
    expect(
      runtime.runAccounting.checkBeforeModelCall(parentContext.rootRunId, 'gpt-5'),
    ).toMatchObject({ allowed: false, status: 'unknown' });
    manager.dispose();
  });

  it('passes an exhausted root budget to managed-child compaction before its model call', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root, model: 'gpt-5' });
    config.settings.agents.persist = false;
    const runtime = new SessionRuntime();
    const parentContext = createAgentRunContext({
      sessionId: 'parent-session',
      runId: 'parent-run',
      source: 'headless',
      startedAt: 1,
    });
    runtime.runAccounting.startRoot(parentContext, 0);
    const budgetChecks: unknown[] = [];
    const compactRunner = vi.fn(async (_config, _history, options) => {
      const budget = options.beforeModelCall?.('gpt-5');
      budgetChecks.push(budget);
      return {
        status: 'failed' as const,
        reason: 'budget-overflow' as const,
        error: budget?.message ?? 'budget blocked',
      };
    });
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      findGitRoot: async () => undefined,
      runtime,
      compactRunner,
      runLoop: async (_config, _registry, prompt, history, callbacks) => {
        await callbacks.onCompact?.(history, null);
        return [
          ...history,
          {
            id: 'assistant-child-budget',
            role: 'assistant',
            content: `Finished ${prompt}`,
            includeInContext: true,
            timestamp: Date.now(),
          },
        ];
      },
    });

    const spawned = await manager.spawn({
      agent: 'explorer',
      prompt: 'inspect',
      rootRunId: parentContext.rootRunId,
      parentRunId: parentContext.runId,
    });
    const finished = await manager.wait(spawned.id, 1000);

    expect(budgetChecks).toEqual([expect.objectContaining({ allowed: false, status: 'exceeded' })]);
    expect(finished.runUsage).toBeUndefined();
    expect(compactRunner).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it('runs three workers concurrently and completes queued records independently', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    config.settings.agents.maxConcurrent = 3;
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const runLoop = vi.fn(
      async (
        _config: unknown,
        _registry: unknown,
        prompt: string,
        history: Message[],
        callbacks: AgentLoopCallbacks,
      ) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        callbacks.onDone();
        return [
          ...history,
          {
            id: `u-${prompt}`,
            role: 'user',
            content: prompt,
            includeInContext: true,
            timestamp: 1,
          },
          {
            id: `a-${prompt}`,
            role: 'assistant',
            content: prompt,
            includeInContext: true,
            timestamp: 2,
          },
        ] as Message[];
      },
    );
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      worktreeRoot: tempRoot(),
      findGitRoot: async () => root,
      createSnapshot: async () => snapshot(root),
      createWorktree: async (_snapshot, agentId) => ({ path: root, branch: `branch-${agentId}` }),
      commitWork: async () => undefined,
      runLoop,
    });
    const plan = await manager.createPlan({
      taskShape: 'three independent questions',
      issueQuality: 'clear',
      topology: 'parallel_research',
      rationale: 'independent',
      agentBudget: 3,
    });
    const records = await Promise.all(
      ['one', 'two', 'three'].map((prompt) =>
        manager.spawn({ agent: 'explorer', prompt, planId: plan.id }),
      ),
    );
    expect(records.map((record) => record.status)).toEqual(['queued', 'queued', 'queued']);

    for (let attempt = 0; attempt < 50 && releases.length < 3; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(releases).toHaveLength(3);
    expect(maxActive).toBe(3);
    const waits = records.map((record) => manager.wait(record.id));
    releases.splice(0).forEach((release) => release());
    const completed = await Promise.all(waits);
    expect(completed.map((record) => record.status)).toEqual([
      'completed',
      'completed',
      'completed',
    ]);
    manager.dispose();
  });

  it('locks patch application until a distinct validator passes the exact candidate', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    const applyCandidate = vi.fn(async () => ({ status: 'applied' as const, commit: 'head' }));
    const checkoutWorktree = vi.fn(async () => {});
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      worktreeRoot: tempRoot(),
      findGitRoot: async () => root,
      createSnapshot: async () => snapshot(root),
      createWorktree: async (_snapshot, agentId) => ({ path: root, branch: `branch-${agentId}` }),
      checkoutWorktree,
      commitWork: async (record) =>
        record.role === 'patcher'
          ? {
              baseCommit: 'snapshot-commit',
              headCommit: 'head',
              branch: record.branch!,
              agentId: record.id,
            }
          : undefined,
      applyCandidate,
      runLoop: async (_config, _registry, prompt, history, callbacks) => {
        callbacks.onDone();
        return [
          ...history,
          {
            id: `u-${prompt}`,
            role: 'user',
            content: prompt,
            includeInContext: true,
            timestamp: 1,
          },
          {
            id: `a-${prompt}`,
            role: 'assistant',
            content: 'done',
            includeInContext: true,
            timestamp: 2,
          },
        ];
      },
    });
    const plan = await manager.createPlan({
      taskShape: 'patch and validate',
      issueQuality: 'clear',
      topology: 'patch_validate',
      rationale: 'independent validation',
      agentBudget: 2,
    });
    const patcher = await manager.spawn({ agent: 'patcher', prompt: 'patch', planId: plan.id });
    await manager.wait(patcher.id, 1000);
    const candidate = (await manager.listEvidence()).find(
      (item) => item.kind === 'patch_candidate',
    )!;
    expect((await manager.get(patcher.id))?.producedEvidenceIds).toContain(candidate.id);
    expect((await manager.listPendingCompletions())[0]?.completion.evidenceIds).toContain(
      candidate.id,
    );
    const validator = await manager.spawn({
      agent: 'validator',
      prompt: 'validate',
      planId: plan.id,
      evidenceIds: [candidate.id],
    });
    await manager.wait(validator.id, 1000);
    expect(checkoutWorktree).toHaveBeenCalledWith(root, 'head');

    await expect(manager.apply(patcher.id, candidate.id)).rejects.toThrow('locked');
    await expect(manager.reviewEvidence(patcher.id, candidate.id, 'pass')).rejects.toThrow(
      'validator',
    );
    await manager.reviewEvidence(validator.id, candidate.id, 'pass');
    await expect(manager.apply(patcher.id, candidate.id)).resolves.toEqual({
      status: 'applied',
      commit: 'head',
    });
    expect(applyCandidate).toHaveBeenCalledOnce();
    manager.dispose();
  });

  it('does not resurrect an agent stopped during worktree provisioning', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    let releaseWorktree!: () => void;
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      worktreeRoot: tempRoot(),
      findGitRoot: async () => root,
      createSnapshot: async () => snapshot(root),
      createWorktree: async (_snapshot, agentId) => {
        await new Promise<void>((resolve) => {
          releaseWorktree = resolve;
        });
        return { path: root, branch: `branch-${agentId}` };
      },
      runLoop: async () => {
        throw new Error('stopped agents must not enter the model loop');
      },
    });
    const record = await manager.spawn({ agent: 'patcher', prompt: 'wait' });
    for (let attempt = 0; attempt < 50 && !releaseWorktree; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await manager.stop(record.id);
    releaseWorktree();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await manager.get(record.id))?.status).toBe('stopped');
    manager.dispose();
  });

  it('routes a waiting question through AgentSend and resumes the same worker', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    let answer = '';
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      worktreeRoot: tempRoot(),
      findGitRoot: async () => root,
      createSnapshot: async () => snapshot(root),
      createWorktree: async (_snapshot, agentId) => ({ path: root, branch: `branch-${agentId}` }),
      runLoop: async (_config, _registry, prompt, history, callbacks) => {
        const response = await callbacks.onUserQuestionRequired!(
          {
            id: 'question',
            source: { kind: 'subagent', agentPath: ['explorer'] },
            questions: [
              {
                question: 'Which mode?',
                header: 'Mode',
                options: [{ label: 'Deep', description: 'More checks' }],
                multiSelect: false,
              },
            ],
          },
          {},
        );
        answer = String(response.action === 'answer' ? response.answers['Which mode?'] : '');
        callbacks.onDone();
        return [
          ...history,
          { id: 'u', role: 'user', content: prompt, includeInContext: true, timestamp: 1 },
          { id: 'a', role: 'assistant', content: answer, includeInContext: true, timestamp: 2 },
        ];
      },
    });
    manager.setInteractivePermissions(true);
    const record = await manager.spawn({ agent: 'explorer', prompt: 'ask' });
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await manager.get(record.id))?.status === 'waiting_input') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await manager.send(record.id, 'Deep');
    const completed = await manager.wait(record.id);
    expect(completed.status).toBe('completed');
    expect(answer).toBe('Deep');
    manager.dispose();
  });

  it('distinguishes provider failures and honors max-turn terminal outcomes', async () => {
    const root = tempRoot();
    const makeManager = (error: string, terminalReason?: 'max_turns') => {
      const config = defaultConfig({ workspace: root });
      config.settings.agents.persist = false;
      return new AgentManager(config, [], {
        storeRoot: tempRoot(),
        worktreeRoot: tempRoot(),
        findGitRoot: async () => root,
        createSnapshot: async () => snapshot(root),
        createWorktree: async (_snapshot, agentId) => ({ path: root, branch: `branch-${agentId}` }),
        runLoop: async (_config, _registry, _prompt, history, callbacks) => {
          callbacks.onError(error);
          if (terminalReason) {
            callbacks.onTerminal?.({
              status: 'failed',
              reason: terminalReason,
              message: error,
              partialOutput: true,
            });
          }
          return history;
        },
      });
    };

    const failedManager = makeManager('provider unavailable');
    const failed = await failedManager.spawn({ agent: 'explorer', prompt: 'fail' });
    expect((await failedManager.wait(failed.id)).status).toBe('failed');
    failedManager.dispose();

    const boundedManager = makeManager('Reached max turns (2). Refine your prompt.', 'max_turns');
    const bounded = await boundedManager.spawn({ agent: 'explorer', prompt: 'bounded' });
    const result = await boundedManager.wait(bounded.id);
    expect(result.status).toBe('failed');
    expect(result.stopReason).toBe('max_turns');
    boundedManager.dispose();
  });

  it('runs explorer without Git, snapshots, or worktrees', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    const createSnapshot = vi.fn(async () => snapshot(root));
    const createWorktree = vi.fn(async () => ({ path: root, branch: 'unused' }));
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      findGitRoot: async () => undefined,
      createSnapshot,
      createWorktree,
      runLoop: async (_config, _registry, prompt, history, callbacks) => {
        callbacks.onDone();
        return [
          ...history,
          { id: 'u', role: 'user', content: prompt, includeInContext: true, timestamp: 1 },
          { id: 'a', role: 'assistant', content: 'found', includeInContext: true, timestamp: 2 },
        ];
      },
    });

    const explorer = await manager.spawn({ agent: 'explorer', prompt: 'find symbol' });
    expect((await manager.wait(explorer.id)).status).toBe('completed');
    expect(createSnapshot).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
    await expect(manager.spawn({ agent: 'patcher', prompt: 'edit symbol' })).rejects.toThrow(
      'Git worktree isolation',
    );
    manager.dispose();
  });

  it('supports multiple independent event subscribers', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      findGitRoot: async () => undefined,
      runLoop: async (_config, _registry, _prompt, history) => history,
    });
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = manager.subscribe(first);
    manager.subscribe(second);
    await manager.spawn({ agent: 'explorer', prompt: 'inspect' });
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();
    unsubscribe();
    await manager.spawn({ agent: 'explorer', prompt: 'inspect again' });
    expect(second.mock.calls.length).toBeGreaterThan(first.mock.calls.length);
    manager.dispose();
  });

  it('resolves permission requests for only the requesting child', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    config.settings.agents.maxConcurrent = 2;
    const decisions = new Map<string, string>();
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      findGitRoot: async () => undefined,
      runLoop: async (_config, _registry, prompt, history, callbacks) => {
        const decision = await callbacks.onPermissionRequired({
          id: `call-${prompt}`,
          name: 'Read',
          arguments: { file_path: `${prompt}.txt` },
        });
        decisions.set(prompt, decision);
        return history;
      },
    });
    manager.setInteractivePermissions(true);
    const [first, second] = await Promise.all([
      manager.spawn({ agent: 'explorer', prompt: 'first' }),
      manager.spawn({ agent: 'explorer', prompt: 'second' }),
    ]);

    for (let attempt = 0; attempt < 50; attempt++) {
      const records = await Promise.all([manager.get(first.id), manager.get(second.id)]);
      if (records.every((record) => record?.pendingPermission)) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const firstPending = (await manager.get(first.id))?.pendingPermission;
    const secondPending = (await manager.get(second.id))?.pendingPermission;
    expect(firstPending).toBeDefined();
    expect(secondPending).toBeDefined();

    await manager.resolvePermission(first.id, firstPending!.id, 'allow');
    expect((await manager.wait(first.id, 1000)).status).toBe('completed');
    expect(decisions.get('first')).toBe('allow');
    expect((await manager.get(second.id))?.status).toBe('waiting_permission');
    expect(decisions.has('second')).toBe(false);

    await manager.resolvePermission(second.id, secondPending!.id, 'deny');
    expect((await manager.wait(second.id, 1000)).status).toBe('completed');
    expect(decisions.get('second')).toBe('deny');
    manager.dispose();
  });

  it('persists a child Always allow rule using the tool primary argument', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    const persistPermissionRule = vi.fn();
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      findGitRoot: async () => undefined,
      persistPermissionRule,
      runLoop: async (_config, _registry, _prompt, history, callbacks) => {
        const call = { id: 'read-call', name: 'Read', arguments: { filePath: 'src/a.ts' } };
        await callbacks.onPermissionRequired(call);
        return history;
      },
    });
    manager.setInteractivePermissions(true);
    const record = await manager.spawn({ agent: 'explorer', prompt: 'inspect' });
    await vi.waitFor(async () =>
      expect((await manager.get(record.id))?.pendingPermission).toBeDefined(),
    );
    const request = (await manager.get(record.id))!.pendingPermission!;
    await manager.resolvePermission(record.id, request.id, 'always');
    expect(persistPermissionRule).toHaveBeenCalledWith('Read(src/a.ts)');
    await manager.stop(record.id);
    manager.dispose();
  });

  it('denies noninteractive child permissions without waiting for a host', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    const decision = vi.fn();
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      findGitRoot: async () => undefined,
      runLoop: async (_config, _registry, _prompt, history, callbacks) => {
        decision(
          await callbacks.onPermissionRequired({
            id: 'call',
            name: 'Read',
            arguments: { file_path: 'README.md' },
          }),
        );
        return history;
      },
    });

    const record = await manager.spawn({ agent: 'explorer', prompt: 'inspect' });
    expect((await manager.wait(record.id, 1000)).status).toBe('completed');
    expect(decision).toHaveBeenCalledWith('deny');
    expect((await manager.get(record.id))?.pendingPermission).toBeUndefined();
    manager.dispose();
  });

  it('cancels noninteractive child questions with recovery guidance', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    let responseMessage = '';
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      findGitRoot: async () => undefined,
      runLoop: async (_config, _registry, _prompt, history, callbacks) => {
        const response = await callbacks.onUserQuestionRequired!(
          {
            id: 'question',
            source: { kind: 'subagent', agentPath: ['explorer'] },
            questions: [
              {
                question: 'Continue?',
                header: 'Continue',
                options: [{ label: 'Yes', description: 'Continue' }],
                multiSelect: false,
              },
            ],
          },
          {},
        );
        responseMessage = response.action === 'cancel' ? (response.message ?? '') : '';
        return history;
      },
    });

    const record = await manager.spawn({ agent: 'explorer', prompt: 'ask' });
    expect((await manager.wait(record.id, 1000)).status).toBe('completed');
    expect(responseMessage).toContain('AgentSend');
    manager.dispose();
  });

  it('coalesces ordered text deltas and persists complete child messages', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    const message: Message = {
      id: 'assistant-complete',
      role: 'assistant',
      content: 'hello',
      includeInContext: true,
      timestamp: 2,
    };
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      findGitRoot: async () => undefined,
      runLoop: async (_config, _registry, _prompt, history, callbacks) => {
        callbacks.onToolCall({ id: 'read-call', name: 'Read', arguments: { file_path: 'a.ts' } });
        callbacks.onToolResult(toolResult('read-call', 'ok'));
        callbacks.onText('hel');
        callbacks.onText('lo');
        callbacks.onAssistantMessageComplete?.(message);
        return [...history, message];
      },
    });
    const events: string[] = [];
    let completionEvent: Extract<AgentRuntimeEvent, { type: 'agent_completion' }> | undefined;
    const deltas: string[] = [];
    const activityStatuses: string[] = [];
    let liveToolCall: Extract<
      AgentRuntimeEvent,
      { type: 'agent_activity' }
    >['activity']['toolCall'];
    let liveToolResult: Extract<
      AgentRuntimeEvent,
      { type: 'agent_activity' }
    >['activity']['result'];
    manager.subscribe((event) => {
      events.push(event.type);
      if (event.type === 'agent_completion') completionEvent = event;
      if (event.type === 'agent_text_delta') deltas.push(event.text);
      if (event.type === 'agent_activity') {
        activityStatuses.push(event.activity.status);
        liveToolCall ??= event.activity.toolCall;
        liveToolResult ??= event.activity.result;
      }
    });

    const record = await manager.spawn({ agent: 'explorer', prompt: 'inspect' });
    const completed = await manager.wait(record.id, 1000);
    expect(deltas).toEqual(['hello']);
    expect(events.indexOf('agent_text_delta')).toBeLessThan(events.indexOf('agent_message'));
    expect(events.indexOf('agent_message')).toBeLessThan(events.lastIndexOf('agent_result'));
    expect(events.indexOf('agent_completion')).toBeLessThan(events.lastIndexOf('agent_result'));
    expect(completionEvent?.notification.parentSessionId).toBeUndefined();
    expect(completionEvent?.notification.completion).not.toHaveProperty('transcript');
    expect(completionEvent?.notification.completion).not.toHaveProperty('prompt');
    expect(completionEvent?.notification.completion).not.toHaveProperty('worktree');
    expect(completionEvent?.notification.completion).not.toHaveProperty('pendingMessages');
    const pending = await manager.listPendingCompletions();
    expect(pending).toHaveLength(1);
    await manager.acknowledgeCompletion(pending[0].deliveryId);
    expect(await manager.listPendingCompletions()).toEqual([]);
    expect(activityStatuses).toEqual(['running', 'completed']);
    expect(liveToolCall).toEqual({
      id: 'read-call',
      name: 'Read',
      arguments: { file_path: 'a.ts' },
    });
    expect(liveToolResult?.content).toBe('ok');
    expect(liveToolResult).not.toHaveProperty('data');
    expect(completed.transcript).toContainEqual(message);
    expect((await manager.get(record.id))?.transcript).toContainEqual(message);
    manager.dispose();
  });

  it('projects evidence published by the completed child instead of supplied evidence', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      findGitRoot: async () => undefined,
      runLoop: async (_config, _registry, _prompt, history) => {
        await gate;
        return history;
      },
    });
    const record = await manager.spawn({
      agent: 'explorer',
      prompt: 'inspect',
      evidenceIds: ['supplied-evidence'],
    });
    await vi.waitFor(async () => expect((await manager.get(record.id))?.status).toBe('running'));
    const published = await manager.publishEvidence(record.id, {
      kind: 'finding',
      summary: 'Found it',
    });
    let idle = false;
    const idlePromise = manager.waitForIdle().then(() => {
      idle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(idle).toBe(false);
    release();
    await idlePromise;
    expect((await manager.get(record.id))?.status).toBe('completed');

    const [notification] = await manager.listPendingCompletions();
    expect(notification.completion.evidenceIds).toEqual([published.id]);
    expect(notification.completion.evidenceIds).not.toContain('supplied-evidence');
    manager.dispose();
  });

  it('applies profile model changes only to newly spawned runs', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    config.settings.agents.profiles.explorer = { model: 'gateway/first' };
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      findGitRoot: async () => undefined,
      runLoop: async (_config, _registry, _prompt, history) => history,
    });
    const first = await manager.spawn({ agent: 'explorer', prompt: 'first' });
    config.settings.agents.profiles.explorer = { model: 'gateway/second' };
    manager.updateConfig(config);
    const second = await manager.spawn({ agent: 'explorer', prompt: 'second' });

    expect((await manager.get(first.id))?.resolvedModel).toBe('gateway/first');
    expect(second.resolvedModel).toBe('gateway/second');
    manager.dispose();
  });

  it('applies the resolved profile effort to the child model loop', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root, effort: 'high', effortExplicit: false });
    config.settings.agents.persist = false;
    config.settings.agents.maxConcurrent = 1;
    config.settings.agents.profiles.explorer = { effort: 'low' };
    let childConfig: AgentConfig | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      findGitRoot: async () => undefined,
      runLoop: async (nextConfig, _registry, prompt, history) => {
        if (prompt === 'blocker') await gate;
        else childConfig = nextConfig;
        return history;
      },
    });

    const blocker = await manager.spawn({ agent: 'explorer', prompt: 'blocker' });
    await vi.waitFor(async () => expect((await manager.get(blocker.id))?.status).toBe('running'));
    const record = await manager.spawn({ agent: 'explorer', prompt: 'inspect' });
    expect(record.effort).toBe('low');
    config.settings.agents.profiles.explorer = { effort: 'high' };
    manager.updateConfig(config);
    release();
    await manager.wait(blocker.id, 1000);
    await manager.wait(record.id, 1000);

    expect(childConfig!.effort).toBe('low');
    expect(childConfig!.effortExplicit).toBe(true);
    manager.dispose();
  });

  it('refreshes and normalizes its permission mode when config or host mode changes', async () => {
    const root = tempRoot();
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    config.settings.defaultMode = 'plan';
    const modes: string[] = [];
    const manager = new AgentManager(config, [], {
      storeRoot: tempRoot(),
      findGitRoot: async () => undefined,
      runLoop: async (_config, _registry, _prompt, history, _callbacks, mode) => {
        modes.push(mode ?? 'default');
        return history;
      },
    });

    const first = await manager.spawn({ agent: 'explorer', prompt: 'first' });
    await manager.wait(first.id, 1000);

    config.settings.defaultMode = 'acceptEdits';
    manager.updateConfig(config);
    const second = await manager.spawn({ agent: 'explorer', prompt: 'second' });
    await manager.wait(second.id, 1000);

    manager.setPermissionMode('acceptEdits');
    const third = await manager.spawn({ agent: 'explorer', prompt: 'third' });
    await manager.wait(third.id, 1000);

    manager.setPermissionMode('invalid-mode');
    const fourth = await manager.spawn({ agent: 'explorer', prompt: 'fourth' });
    await manager.wait(fourth.id, 1000);

    expect(modes).toEqual(['plan', 'accept-edits', 'accept-edits', 'default']);
    manager.dispose();
  });
});
