import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../test/fixtures.js';
import { toolSuccess } from '../tools/result.js';
import type { ToolDefinition } from '../types/tools.js';
import { repositoryHash } from './git-isolation.js';
import { AgentManager, AgentManagerError } from './manager.js';
import { AgentStore } from './store.js';
import type { AgentRecord } from './types.js';

const UNCONTENDED = { writerOptions: { sleep: () => {} } } as const;
const EXPLORER_TOOLS = ['Read', 'Glob', 'Grep'];

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'book-tool-ceiling-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tool(name: string): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    execute: async () => toolSuccess('ok'),
  };
}

/**
 * A record as a restart finds it on disk, and the tools each run the manager re-drives from it
 * holds.
 */
async function restart(seeded: Record<string, unknown>) {
  const root = tempRoot();
  const bookHome = tempRoot();
  vi.stubEnv('BOOK_HOME', bookHome);
  const config = defaultConfig({ workspace: root });
  config.settings.agents.persist = true;
  const store = await AgentStore.open(repositoryHash(root), bookHome, true, UNCONTENDED);
  store.saveAgent({
    id: 'explorer-1',
    name: 'explorer',
    profile: 'explorer',
    role: 'explorer',
    description: '',
    prompt: 'survey',
    purpose: 'survey',
    parentSessionId: 'parent-1',
    status: 'interrupted',
    stopReason: 'process_exit',
    resumable: true,
    resumedFromStatus: 'running',
    applicationStatus: 'not_applied',
    referencedEvidenceIds: [],
    transcript: [],
    pendingMessages: [],
    isolation: 'workspace-readonly',
    runSequence: 1,
    completionSequence: 1,
    completionDeliveredSequence: 1,
    createdAt: 1,
    updatedAt: Date.now(),
    ...seeded,
  } as unknown as Parameters<AgentStore['saveAgent']>[0]);
  store.dispose();

  const runs: string[][] = [];
  const createWorktree = vi.fn();
  const manager = new AgentManager(config, EXPLORER_TOOLS.map(tool), {
    storeRoot: bookHome,
    findGitRoot: async () => undefined,
    createWorktree,
    runLoop: async (_config, registry, _prompt, history) => {
      runs.push(registry.getDefinitions().map((definition) => definition.name));
      return history;
    },
  });
  await manager.list();
  const settled = await manager.wait('explorer-1', 10_000);
  return { manager, runs, settled, createWorktree };
}

describe('a tool ceiling on the agent record (#696)', () => {
  it('holds a re-driven agent to the ceiling on its record', async () => {
    const { manager, runs, settled } = await restart({ toolCeiling: [['Read', 'Task']] });
    try {
      expect(runs).toEqual([['Read']]);
      expect(settled.toolCeiling).toEqual([['Read', 'Task']]);
    } finally {
      manager.dispose();
    }
  });

  it('reads a record from before the field as no ceiling', async () => {
    const { manager, runs, settled } = await restart({});
    try {
      expect(runs).toEqual([EXPLORER_TOOLS]);
      expect(settled).not.toHaveProperty('toolCeiling');
    } finally {
      manager.dispose();
    }
  });

  it.each([
    ['null', null],
    ['a string', 'Read'],
    ['an unreadable rule', [[42]]],
    ['a flat list', ['Read']],
  ])('fails a record whose ceiling is %s rather than running it unnarrowed', async (_name, bad) => {
    const { manager, runs, settled } = await restart({ toolCeiling: bad });
    try {
      expect(runs).toEqual([]);
      expect(settled.status).toBe('failed');
      expect(settled.error).toContain('Unreadable tool ceiling');
    } finally {
      manager.dispose();
    }
  });

  it('fails an unreadable ceiling before any worktree is made', async () => {
    const { manager, runs, settled, createWorktree } = await restart({
      name: 'patcher',
      profile: 'patcher',
      role: 'patcher',
      isolation: 'worktree',
      toolCeiling: 'Read',
    });
    try {
      expect(runs).toEqual([]);
      expect(settled.status).toBe('failed');
      expect(createWorktree).not.toHaveBeenCalled();
    } finally {
      manager.dispose();
    }
  });

  it('fails a later run that the ceiling leaves with nothing, naming the ceiling', async () => {
    const { manager, runs, settled } = await restart({ toolCeiling: [['WebFetch']] });
    try {
      expect(runs).toEqual([]);
      expect(settled.status).toBe('failed');
      expect(settled.error).toContain('would have no tool left');
    } finally {
      manager.dispose();
    }
  });

  describe('at the spawn', () => {
    function manager(tools = EXPLORER_TOOLS) {
      const root = tempRoot();
      const config = defaultConfig({ workspace: root });
      config.settings.agents.persist = false;
      const runs: string[][] = [];
      const createSnapshot = vi.fn();
      const agents = new AgentManager(config, tools.map(tool), {
        storeRoot: tempRoot(),
        findGitRoot: async () => root,
        createSnapshot,
        runLoop: async (_config, registry, _prompt, history) => {
          runs.push(registry.getDefinitions().map((definition) => definition.name));
          return history;
        },
      });
      return { agents, runs, createSnapshot, workspace: root };
    }

    it('records the ceiling apart from what the caller holds, and returns a copy', async () => {
      const { agents, runs } = manager();
      const ceiling = [['Read', 'Task']];
      try {
        const spawned = await agents.spawn({
          agent: 'explorer',
          prompt: 'look',
          toolCeiling: ceiling,
        });
        // A skill's later change to the caller's list reaches nothing already spawned.
        ceiling[0].push('Glob');
        spawned.toolCeiling?.[0].push('Glob');
        const settled = await agents.wait(spawned.id, 10_000);
        expect(settled.toolCeiling).toEqual([['Read', 'Task']]);
        expect(runs).toEqual([['Read']]);
      } finally {
        agents.dispose();
      }
    });

    it('writes no field for an empty ceiling', async () => {
      const { agents, runs } = manager();
      try {
        const spawned = await agents.spawn({ agent: 'explorer', prompt: 'look', toolCeiling: [] });
        expect(spawned).not.toHaveProperty('toolCeiling');
        await agents.wait(spawned.id, 10_000);
        expect(runs).toEqual([EXPLORER_TOOLS]);
      } finally {
        agents.dispose();
      }
    });

    /** A project agent named `custom`, with these lines of frontmatter. */
    function customAgent(workspace: string, frontmatter: string[]): void {
      const directory = join(workspace, '.book', 'agents');
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, 'custom.md'),
        [
          '---',
          'name: custom',
          'description: custom',
          'isolation: workspace-readonly',
          ...frontmatter,
          '---',
          'Work.',
        ].join('\n'),
      );
    }

    it('does not blame the ceiling for a role with no tools of its own', async () => {
      const { agents, runs, workspace } = manager();
      customAgent(workspace, []);
      try {
        const spawned = await agents.spawn({
          agent: 'custom',
          prompt: 'think',
          toolCeiling: [['Read', 'Task']],
        });
        await agents.wait(spawned.id, 10_000);
        expect(runs).toEqual([[]]);
      } finally {
        agents.dispose();
      }
    });

    it('refuses a role the ceiling leaves only the skill tools', async () => {
      const { agents, runs, workspace } = manager([
        ...EXPLORER_TOOLS,
        'InvokeSkill',
        'ReadSkillResource',
      ]);
      customAgent(workspace, ['tools: "*"']);
      try {
        await expect(
          agents.spawn({
            agent: 'custom',
            prompt: 'look',
            toolCeiling: [['Task', 'InvokeSkill', 'ReadSkillResource']],
          }),
        ).rejects.toMatchObject({ code: 'child_tool_surface_empty' });
        expect(runs).toEqual([]);
      } finally {
        agents.dispose();
      }
    });

    it('refuses a role with no tool left, typed, and takes no snapshot', async () => {
      const { agents, createSnapshot } = manager(['Read', 'Write', 'ToolSearch']);
      try {
        const refused = await agents
          .spawn({ agent: 'patcher', prompt: 'patch', toolCeiling: [['WebFetch', 'Task']] })
          .catch((error: unknown) => error);

        expect(refused).toBeInstanceOf(AgentManagerError);
        expect(refused).toMatchObject({
          code: 'child_tool_surface_empty',
          retryable: false,
          details: { agent: 'patcher', toolCeiling: [['WebFetch', 'Task']] },
        });
        expect((refused as AgentManagerError).remediation).toContain('allowed-tools');
        expect(createSnapshot).not.toHaveBeenCalled();
        expect(await agents.list()).toEqual<AgentRecord[]>([]);
        expect(await agents.listPlans()).toEqual([]);
      } finally {
        agents.dispose();
      }
    });
  });
});
