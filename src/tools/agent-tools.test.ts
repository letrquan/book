import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { AgentManager } from '../agents/manager.js';
import { AgentStore } from '../agents/store.js';
import type { AtomicJsonWriter } from '../agents/atomic-json.js';
import { SessionRuntime } from '../session/runtime.js';
import { defaultConfig } from '../test/fixtures.js';
import { deriveToolPresentation } from '../tui/tool-presentation.js';
import type { ToolContext } from '../types/tools.js';
import { toolSuccess } from './result.js';
import { agentLifecycleTools, agentStatusPresentation } from './agent-tools.js';
import { taskTool } from './task-tool.js';

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
        new AgentStore(repoHash, requestedRoot, enabled, { writer }),
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
