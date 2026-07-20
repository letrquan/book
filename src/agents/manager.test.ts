import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentLoopCallbacks, Message } from '../types.js';
import { defaultConfig } from '../test/fixtures.js';
import { AgentManager } from './manager.js';
import type { AgentSnapshot } from './types.js';

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
    const record = await manager.spawn({ agent: 'explorer', prompt: 'wait' });
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

  it('distinguishes provider failures from bounded max-turn completion', async () => {
    const root = tempRoot();
    const makeManager = (error: string) => {
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
          return history;
        },
      });
    };

    const failedManager = makeManager('provider unavailable');
    const failed = await failedManager.spawn({ agent: 'explorer', prompt: 'fail' });
    expect((await failedManager.wait(failed.id)).status).toBe('failed');
    failedManager.dispose();

    const boundedManager = makeManager('Reached max turns (2). Refine your prompt.');
    const bounded = await boundedManager.spawn({ agent: 'explorer', prompt: 'bounded' });
    const result = await boundedManager.wait(bounded.id);
    expect(result.status).toBe('completed');
    expect(result.stopReason).toBe('max_turns');
    boundedManager.dispose();
  });
});
