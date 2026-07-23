import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { AgentManager } from '../agents/manager.js';
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

describe('managed-agent synchronous delivery', () => {
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
      runtime,
    };

    try {
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
});
