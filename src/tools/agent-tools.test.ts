import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentManager } from '../agents/manager.js';
import { AgentStore } from '../agents/store.js';
import type { AtomicJsonWriter } from '../agents/atomic-json.js';
import { SessionRuntime } from '../session/runtime.js';
import { defaultConfig } from '../test/fixtures.js';
import { deriveToolPresentation } from '../tui/tool-presentation.js';
import type { ToolContext } from '../types/tools.js';
import { toolSuccess } from './result.js';
import { agentLifecycleTools, agentStatusPresentation } from './agent-tools.js';
import { createRegistry } from './registry-core.js';
import { taskTool } from './task-tool.js';
import { MAX_TOOL_TIMEOUT_MS } from './timeouts.js';

describe('managed-agent tool presentation', () => {
  it('uses semantic lifecycle text instead of serialized object prefixes', () => {
    const presentation = agentStatusPresentation(
      {
        agentId: 'agent-1',
        displayName: 'Atlas',
        profile: 'explorer',
        status: 'completed',
        resolvedModel: 'test/model',
        isolation: 'workspace-readonly',
        summary: 'Found the missing delivery bridge',
        createdAt: 1,
        updatedAt: 2,
      },
      'Spawned',
    );

    expect(presentation.summary).toBe('Spawned Atlas');
    expect(presentation.summary).not.toContain('{');
    expect(presentation.metadata).toEqual(['completed']);

    const row = deriveToolPresentation(
      'AgentSpawn',
      { agent: 'explorer' },
      toolSuccess('{\n  "agentId": "agent-1"\n}', {
        presentation: {
          kind: 'agent',
          summary: presentation.summary,
          metadata: presentation.metadata,
        },
      }),
    );
    expect(row.summary).toBe('Spawned Atlas');
    expect(row.summary).not.toContain('{');
  });
});

describe('AgentWait against the registry backstop (#423)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function waitHarness(env: Record<string, string> = {}) {
    const running = {
      id: 'agent-1',
      name: 'explorer',
      status: 'running',
      transcript: [],
      createdAt: 0,
      updatedAt: 0,
    };
    const waits: number[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const manager = {
      updateConfig: () => undefined,
      setPermissionMode: () => undefined,
      setEventSink: () => undefined,
      dispose: () => undefined,
      // As the real manager does, 0 arms no timer: only the agent finishing ends that wait.
      wait: (_id: string, timeoutMs: number, signal?: AbortSignal) =>
        new Promise((resolve) => {
          waits.push(timeoutMs);
          signals.push(signal);
          if (timeoutMs > 0) setTimeout(() => resolve(running), timeoutMs);
        }),
    };
    const runtime = new SessionRuntime();
    runtime.agentManager = manager as unknown as AgentManager;
    const registry = createRegistry();
    registry.registerAll(agentLifecycleTools);
    const context: ToolContext = {
      workspaceRoot: '.',
      env,
      agentConfig: defaultConfig(),
      availableTools: [],
      currentMode: 'bypassPermissions',
      runtime,
    };
    const wait = (args: Record<string, unknown>, signal?: AbortSignal) =>
      registry.execute(
        { id: 'wait-1', name: 'AgentWait', arguments: args },
        signal ? { ...context, signal } : context,
      );
    return { wait, waits, signals, runtime };
  }

  it('answers a wait longer than the default tool deadline with the agent status', async () => {
    vi.useFakeTimers();
    const { wait, waits, runtime } = waitHarness();
    try {
      const pending = wait({ agentId: 'agent-1', timeoutMs: 240_000 });
      await vi.advanceTimersByTimeAsync(240_000);
      const result = await pending;

      expect(result.status).toBe('success');
      expect(result.content).toContain('"status": "running"');
      expect(waits).toEqual([240_000]);
    } finally {
      runtime.dispose();
    }
  });

  it('bounds an open-ended wait by the ceiling, so the backstop never answers it', async () => {
    vi.useFakeTimers();
    const { wait, waits, runtime } = waitHarness({ BOOK_TOOL_TIMEOUT_MS: '60000' });
    try {
      const pending = wait({ agentId: 'agent-1' });
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;

      expect(result.status).toBe('success');
      expect(result.content).toContain('"status": "running"');
      expect(waits).toEqual([60_000]);
    } finally {
      runtime.dispose();
    }
  });

  it('passes the turn signal to the manager so a cancelled wait can clear its timer', async () => {
    const { wait, signals, runtime } = waitHarness({ BOOK_TOOL_TIMEOUT_MS: '60000' });
    try {
      const controller = new AbortController();
      const pending = wait({ agentId: 'agent-1', timeoutMs: 1_000 }, controller.signal);

      // The registry hands the tool a signal derived from the turn's, so it is the abort that
      // has to arrive, not the identity.
      await vi.waitFor(() => expect(signals).toHaveLength(1));
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[0]?.aborted).toBe(false);
      controller.abort();
      expect(signals[0]?.aborted).toBe(true);
      await pending;
    } finally {
      runtime.dispose();
    }
  });

  it('refuses a wait past the limit in force rather than shortening it silently', async () => {
    const { wait, waits, runtime } = waitHarness({ BOOK_TOOL_TIMEOUT_MS: '60000' });
    try {
      const result = await wait({ agentId: 'agent-1', timeoutMs: 90_000 });

      expect(result.status).toBe('error');
      expect(result.structuredError?.message).toContain('exceeds the 60000ms limit');
      expect(waits).toEqual([]);
    } finally {
      runtime.dispose();
    }
  });

  it('publishes the maximum the schema validates against', () => {
    const tool = agentLifecycleTools.find((candidate) => candidate.name === 'AgentWait')!;
    expect(tool.timeoutMs).toBe(MAX_TOOL_TIMEOUT_MS);
    expect(tool.parameters).toMatchObject({
      properties: { timeoutMs: { maximum: MAX_TOOL_TIMEOUT_MS } },
    });
  });
});

describe('AgentApply carries the turn signal to the manager (#491)', () => {
  it('hands the manager a signal that the turn aborting aborts', async () => {
    const calls: {
      agentId: string;
      evidenceId?: string;
      signal?: AbortSignal;
      startedBy?: string;
    }[] = [];
    let finish!: () => void;
    const applying = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const manager = {
      updateConfig: () => undefined,
      setPermissionMode: () => undefined,
      setEventSink: () => undefined,
      dispose: () => undefined,
      apply: async (
        agentId: string,
        evidenceId?: string,
        options?: { signal?: AbortSignal; startedBy?: string },
      ) => {
        calls.push({ agentId, evidenceId, signal: options?.signal, startedBy: options?.startedBy });
        await applying;
        return { status: 'applied' as const, commit: 'head' };
      },
    };
    const runtime = new SessionRuntime();
    runtime.agentManager = manager as unknown as AgentManager;
    const registry = createRegistry();
    registry.registerAll(agentLifecycleTools);
    const controller = new AbortController();
    const context: ToolContext = {
      workspaceRoot: '.',
      env: {},
      agentConfig: defaultConfig(),
      availableTools: [],
      currentMode: 'bypassPermissions',
      runtime,
      signal: controller.signal,
    };
    try {
      const pending = registry.execute(
        { id: 'apply-1', name: 'AgentApply', arguments: { agentId: 'agent-1', evidenceId: 'e-1' } },
        context,
      );

      await vi.waitFor(() => expect(calls).toHaveLength(1));
      // Started by the model, so the model's own AgentStop may stop it (#527).
      expect(calls[0]).toMatchObject({ agentId: 'agent-1', evidenceId: 'e-1', startedBy: 'model' });
      // The registry derives the tool's signal from the turn's, so it is the abort that has to
      // arrive, not the identity.
      expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(calls[0]?.signal?.aborted).toBe(false);
      controller.abort();
      expect(calls[0]?.signal?.aborted).toBe(true);
      finish();
      await pending;
    } finally {
      finish();
      runtime.dispose();
    }
  });
});

describe('managed-agent manager reuse', () => {
  it('refreshes a cached root manager before using it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'book-agent-tools-refresh-'));
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    const manager = new AgentManager(config, [], {
      storeRoot: root,
      findGitRoot: async () => undefined,
    });
    const runtime = new SessionRuntime();
    runtime.agentManager = manager;
    const nextConfig = defaultConfig({ workspace: root });
    const onAgentEvent = vi.fn();
    const onHookEvent = vi.fn();
    const updateConfig = vi.spyOn(manager, 'updateConfig');
    const setPermissionMode = vi.spyOn(manager, 'setPermissionMode');
    const setEventSink = vi.spyOn(manager, 'setEventSink');

    try {
      const listTool = agentLifecycleTools.find((tool) => tool.name === 'AgentList')!;
      await expect(
        listTool.execute(
          {},
          {
            workspaceRoot: root,
            env: {},
            agentConfig: nextConfig,
            availableTools: [],
            currentMode: 'plan',
            onAgentEvent,
            onHookEvent,
            runtime,
          },
        ),
      ).resolves.toMatchObject({ status: 'success' });

      expect(updateConfig).toHaveBeenCalledWith(nextConfig);
      expect(setPermissionMode).toHaveBeenCalledWith('plan');
      expect(setEventSink).toHaveBeenCalledWith(onAgentEvent, onHookEvent);
    } finally {
      manager.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('managed-agent synchronous delivery', () => {
  it('returns a retryable tool failure instead of throwing when AgentSpawn cannot persist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'book-agent-tools-'));
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = true;
    const writer = {
      // Opening the store and the lease heartbeat write asynchronously, and succeed here.
      writeAsync: async (target: string) => ({
        status: 'ok' as const,
        target,
        attempts: 1,
        elapsedMs: 0,
      }),
      write: (target: string) =>
        target.includes(`${join('records', '')}`)
          ? {
              status: 'busy' as const,
              target,
              operation: 'rename' as const,
              attempts: 4,
              elapsedMs: 500,
            }
          : { status: 'ok' as const, target, attempts: 1, elapsedMs: 0 },
    } as unknown as AtomicJsonWriter;
    const manager = new AgentManager(config, [], {
      storeRoot: root,
      findGitRoot: async () => undefined,
      createStore: (repoHash, requestedRoot, enabled) =>
        AgentStore.open(repoHash, requestedRoot, enabled, { writer }),
    });
    const runtime = new SessionRuntime();
    runtime.agentManager = manager;
    const context: ToolContext = {
      workspaceRoot: root,
      env: {},
      agentConfig: config,
      availableTools: [],
      currentMode: 'bypassPermissions',
      parentSessionId: 'session-root',
      runContext: {
        runId: 'run-root',
        rootRunId: 'run-root',
        sessionId: 'session-root',
        source: 'internal',
        startedAt: 1,
      },
      runtime,
    };

    try {
      const spawnTool = agentLifecycleTools.find((tool) => tool.name === 'AgentSpawn')!;
      const result = await spawnTool.execute(
        { agent: 'explorer', description: 'Inspect', prompt: 'inspect' },
        context,
      );

      expect(result).toMatchObject({
        status: 'error',
        structuredError: {
          code: 'agent_store_busy',
          retryable: true,
        },
      });
      expect(await manager.list()).toEqual([]);
    } finally {
      manager.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('acknowledges terminal results consumed by AgentWait and Task', async () => {
    const root = mkdtempSync(join(tmpdir(), 'book-agent-tools-'));
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    const manager = new AgentManager(config, [], {
      storeRoot: root,
      findGitRoot: async () => undefined,
      runLoop: async (_config, _registry, prompt, history) => [
        ...history,
        {
          id: `assistant-${prompt}`,
          role: 'assistant',
          content: `Finished ${prompt}`,
          includeInContext: true,
          timestamp: 1,
        },
      ],
    });
    const runtime = new SessionRuntime();
    runtime.agentManager = manager;
    const context: ToolContext = {
      workspaceRoot: root,
      env: {},
      agentConfig: config,
      availableTools: [],
      currentMode: 'bypassPermissions',
      parentSessionId: 'session-root',
      runContext: {
        runId: 'run-root',
        rootRunId: 'run-root',
        sessionId: 'session-root',
        source: 'internal',
        startedAt: 1,
      },
      runtime,
    };

    try {
      const spawnTool = agentLifecycleTools.find((tool) => tool.name === 'AgentSpawn')!;
      await expect(
        spawnTool.execute({ agent: 'explorer', prompt: 'attributed' }, context),
      ).resolves.toMatchObject({ status: 'success' });
      const attributed = (await manager.list()).find((record) => record.prompt === 'attributed');
      expect(attributed).toMatchObject({
        parentSessionId: 'session-root',
        rootRunId: 'run-root',
        parentRunId: 'run-root',
      });
      if (attributed) {
        await manager.wait(attributed.id, 1000);
        await manager.acknowledgeCompletion(
          `${attributed.id}:${attributed.completionSequence ?? 0}`,
        );
        const sendTool = agentLifecycleTools.find((tool) => tool.name === 'AgentSend')!;
        await expect(
          sendTool.execute(
            { agentId: attributed.id, message: 'continue under the new request' },
            {
              ...context,
              runContext: {
                runId: 'later-parent-run',
                rootRunId: 'later-root-run',
                sessionId: 'session-root',
                source: 'internal',
                startedAt: 2,
              },
            },
          ),
        ).resolves.toMatchObject({ status: 'success' });
        const resumed = await manager.wait(attributed.id, 1000);
        expect(resumed).toMatchObject({
          rootRunId: 'later-root-run',
          parentRunId: 'later-parent-run',
        });
        await manager.acknowledgeCompletion(`${resumed.id}:${resumed.completionSequence ?? 0}`);
      }

      const spawned = await manager.spawn({ agent: 'explorer', prompt: 'waited' });
      const waitTool = agentLifecycleTools.find((tool) => tool.name === 'AgentWait')!;
      await expect(waitTool.execute({ agentId: spawned.id }, context)).resolves.toMatchObject({
        status: 'success',
      });
      expect(await manager.listPendingCompletions()).toEqual([]);

      await expect(
        taskTool[0]!.execute({ agent: 'explorer', prompt: 'legacy task' }, context),
      ).resolves.toMatchObject({ status: 'success' });
      expect(await manager.listPendingCompletions()).toEqual([]);
    } finally {
      manager.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads oversized terminal results through bounded AgentRead chunks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'book-agent-read-'));
    const config = defaultConfig({ workspace: root });
    config.settings.agents.persist = false;
    const result = 'x'.repeat(60_000);
    const manager = new AgentManager(config, [], {
      storeRoot: root,
      findGitRoot: async () => undefined,
      runLoop: async (_config, _registry, _prompt, history) => [
        ...history,
        {
          id: 'assistant-large',
          role: 'assistant',
          content: result,
          includeInContext: true,
          timestamp: 1,
        },
      ],
    });
    const runtime = new SessionRuntime();
    runtime.agentManager = manager;
    const context: ToolContext = {
      workspaceRoot: root,
      env: {},
      agentConfig: config,
      availableTools: [],
      currentMode: 'bypassPermissions',
      runtime,
    };

    try {
      const spawned = await manager.spawn({ agent: 'explorer', prompt: 'large' });
      await manager.wait(spawned.id, 1000);
      const readTool = agentLifecycleTools.find((tool) => tool.name === 'AgentRead')!;
      const first = await readTool.execute({ agentId: spawned.id, limit: 40_000 }, context);
      expect(first.status).toBe('success');
      expect(first.data).toMatchObject({
        offset: 0,
        nextOffset: 40_000,
        totalCharacters: 60_000,
        truncated: true,
      });
      const second = await readTool.execute(
        { agentId: spawned.id, offset: 40_000, limit: 40_000 },
        context,
      );
      expect(second.data).toMatchObject({
        offset: 40_000,
        totalCharacters: 60_000,
        truncated: false,
      });
    } finally {
      manager.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
