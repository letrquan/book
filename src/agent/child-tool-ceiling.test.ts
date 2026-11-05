import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentManager } from '../agents/manager.js';
import type { AgentRecord, AgentSnapshot } from '../agents/types.js';
import { SessionRuntime } from '../session/runtime.js';
import { defaultConfig } from '../test/fixtures.js';
import { isolateBookHome } from '../test/isolated-book-home.js';
import { createDefaultRegistry } from '../tools/registry.js';
import type { Provider } from '../provider/index.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type { ToolCall, ToolResult } from '../types/tools.js';
import { runAgentLoop } from './loop.js';

// A skill's or command's allowed-tools carry into the children the parent starts under them (#696),
// through the whole agent loop: the parent's rule sets are frozen at the spawn, and the child's
// registry and its calls are held to them.

isolateBookHome();

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeSkill(workspace: string, name: string, allowedTools: string[]): void {
  const directory = join(workspace, '.book', 'skills', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: Use the ${name} workflow`,
      'allowed-tools:',
      ...allowedTools.map((tool) => `- ${tool}`),
      '---',
      `Follow the ${name} procedure.`,
    ].join('\n'),
  );
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

function callbacks(overrides: Partial<AgentLoopCallbacks> = {}): AgentLoopCallbacks {
  return {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onError: () => {},
    onTurnStart: () => {},
    onDone: () => {},
    onPermissionRequired: async () => 'allow' as const,
    ...overrides,
  };
}

/** A provider that answers each request with the next list of calls, then ends the run. */
function scripted(turns: ToolCall[][]): Provider {
  let turn = 0;
  return {
    id: 'scripted',
    stream: async function* () {
      const calls = turns[turn++];
      if (calls) for (const toolCall of calls) yield { type: 'tool_call', toolCall };
      else yield { type: 'text', content: 'done' };
      yield { type: 'done' };
    },
  };
}

interface ChildRun {
  /** The tools the child's registry holds. */
  tools: string[];
  /** The child's tool results, by call id. */
  results: Map<string, ToolResult>;
  /** The worktree the child ran in. */
  workspace: string;
  /** The system prompt the manager wrote for the child. */
  systemPromptAppend?: string;
}

const WRITE: ToolCall = {
  id: 'child-write',
  name: 'Write',
  arguments: { file_path: 'written-by-child.txt', content: 'from the child\n' },
};

/**
 * The real parent loop and the real child loop, with a real manager. Only the git isolation is
 * stubbed: each child gets an empty directory for its worktree.
 */
function harness(childCalls: ToolCall[] = [WRITE]) {
  const workspace = tempRoot('book-child-ceiling-');
  const worktrees = tempRoot('book-child-ceiling-worktrees-');
  const config = defaultConfig({ workspace, maxTurns: 4 });
  config.settings.agents.persist = false;
  config.settings.skills.overrides.probe = 'auto';
  const registry = createDefaultRegistry();
  const childRuns: ChildRun[] = [];
  const runtime = new SessionRuntime();
  const manager = new AgentManager(config, registry.getDefinitions(), {
    storeRoot: tempRoot('book-child-ceiling-store-'),
    worktreeRoot: worktrees,
    findGitRoot: async () => workspace,
    createSnapshot: async () => snapshot(workspace),
    createWorktree: async (_snapshot, agentId) => {
      const path = join(worktrees, agentId);
      mkdirSync(path, { recursive: true });
      return { path, branch: `branch-${agentId}` };
    },
    commitWork: async () => undefined,
    removeWorktree: async () => {},
    removeSnapshot: async () => {},
    runLoop: (childConfig, childRegistry, prompt, history, childCallbacks, mode, options) => {
      const run: ChildRun = {
        tools: childRegistry.getDefinitions().map((definition) => definition.name),
        results: new Map(),
        workspace: childConfig.workspace,
        systemPromptAppend: options?.systemPromptAppend,
      };
      childRuns.push(run);
      return runAgentLoop(
        childConfig,
        childRegistry,
        prompt,
        history,
        {
          ...childCallbacks,
          onToolResult: (result) => {
            run.results.set(result.toolCallId ?? '', result);
            childCallbacks.onToolResult(result);
          },
        },
        mode,
        { ...options, provider: scripted([childCalls]) },
      );
    },
  });
  runtime.agentManager = manager;

  const parent = async (
    turns: ToolCall[][],
    options: { allowedTools?: string[]; typedText?: string } = {},
  ): Promise<Map<string, ToolResult>> => {
    const results = new Map<string, ToolResult>();
    await runAgentLoop(
      config,
      registry,
      'do the work',
      [],
      callbacks({ onToolResult: (result) => results.set(result.toolCallId ?? '', result) }),
      'bypassPermissions',
      { provider: scripted(turns), isNewSession: false, runtime, ...options },
    );
    return results;
  };
  return { workspace, childRuns, manager, parent, dispose: () => manager.dispose() };
}

const TASK: ToolCall = {
  id: 'task',
  name: 'Task',
  arguments: { agent: 'patcher', prompt: 'write the file' },
};
const SPAWN: ToolCall = {
  id: 'spawn',
  name: 'AgentSpawn',
  arguments: { agent: 'patcher', description: 'write the file', prompt: 'write the file' },
};
const INVOKE: ToolCall = { id: 'skill', name: 'InvokeSkill', arguments: { skill: 'probe' } };

/** The tools a `patcher` holds with nothing narrowing it. */
const PATCHER_WRITES = ['Write', 'Edit', 'MultiEdit', 'ApplyPatch', 'NotebookEdit', 'Check'];

function expectNarrowed(run: ChildRun | undefined): void {
  expect(run?.tools).toContain('Read');
  for (const tool of PATCHER_WRITES) expect(run?.tools).not.toContain(tool);
  // Refused, and nothing written where the child runs.
  expect(run?.results.get(WRITE.id)?.status).not.toBe('success');
  expect(existsSync(join(run!.workspace, 'written-by-child.txt'))).toBe(false);
}

function expectWhole(run: ChildRun | undefined): void {
  for (const tool of PATCHER_WRITES) expect(run?.tools).toContain(tool);
  expect(run?.results.get(WRITE.id)?.status).toBe('success');
  expect(existsSync(join(run!.workspace, 'written-by-child.txt'))).toBe(true);
}

async function settled(manager: AgentManager, id: string): Promise<AgentRecord> {
  const record = await manager.wait(id, 10_000);
  expect(record.status).toBe('completed');
  return record;
}

/** The agent id in a successful `AgentSpawn` result. */
function spawnedId(result: ToolResult | undefined): string {
  expect(result?.status).toBe('success');
  const data = result?.data as { agentId?: string } | undefined;
  expect(data?.agentId).toBeTruthy();
  return data!.agentId!;
}

describe("a child under its parent's allowed-tools (#696)", () => {
  it("holds a Task child to a skill's allowed-tools, and a new spawn after the run has the role's tools", async () => {
    const run = harness();
    try {
      writeSkill(run.workspace, 'probe', ['Read', 'Task']);

      // The same response: the skill applies from the call after InvokeSkill (#657).
      const results = await run.parent([[INVOKE, TASK]]);

      expect(results.get(INVOKE.id)?.structuredError).toBeUndefined();
      expect(results.get(TASK.id)?.status).toBe('success');
      expectNarrowed(run.childRuns[0]);

      // The frame ended with its run: the next Task is the role's own.
      const next = await run.parent([[TASK]]);
      expect(next.get(TASK.id)?.status).toBe('success');
      expectWhole(run.childRuns[1]);
    } finally {
      run.dispose();
    }
  });

  it("holds a Task child to a skill the user typed, and an AgentSpawn child to a skill's list", async () => {
    const run = harness();
    try {
      writeSkill(run.workspace, 'probe', ['Read', 'Task', 'AgentSpawn']);

      const typed = await run.parent([[TASK]], { typedText: '$probe go' });
      expect(typed.get(TASK.id)?.status).toBe('success');
      expectNarrowed(run.childRuns[0]);

      const spawned = await run.parent([[INVOKE, SPAWN]]);
      await settled(run.manager, spawnedId(spawned.get(SPAWN.id)));
      expectNarrowed(run.childRuns[1]);
    } finally {
      run.dispose();
    }
  });

  it.each([
    ['Task', TASK],
    ['AgentSpawn', SPAWN],
  ] as const)(
    "holds a %s child to a command's allowed-tools, and only under it",
    async (name, call) => {
      const run = harness();
      try {
        const wait = async (results: Map<string, ToolResult>): Promise<void> => {
          if (name === 'AgentSpawn') await settled(run.manager, spawnedId(results.get(call.id)));
          else expect(results.get(call.id)?.status).toBe('success');
        };

        await wait(await run.parent([[call]], { allowedTools: ['Read', name] }));
        expectNarrowed(run.childRuns[0]);

        await wait(await run.parent([[call]]));
        expectWhole(run.childRuns[1]);
      } finally {
        run.dispose();
      }
    },
  );

  it('keeps the narrow set for an agent that outlives the frame, on every later run', async () => {
    const run = harness();
    try {
      writeSkill(run.workspace, 'probe', ['Read', 'AgentSpawn', 'AgentSend']);

      const spawned = await run.parent([[INVOKE, SPAWN]]);
      const id = spawnedId(spawned.get(SPAWN.id));
      await settled(run.manager, id);
      expectNarrowed(run.childRuns[0]);

      // No frame now: this turn lists nothing, and the same agent gets a follow-up.
      await run.parent([
        [{ id: 'send', name: 'AgentSend', arguments: { agentId: id, message: 'once more' } }],
      ]);
      await vi.waitFor(() => expect(run.childRuns).toHaveLength(2));
      await settled(run.manager, id);
      expectNarrowed(run.childRuns[1]);
    } finally {
      run.dispose();
    }
  });

  it('keeps the pattern of a rule, and tells the child what holds it', async () => {
    const run = harness();
    try {
      await run.parent([[SPAWN]], { allowedTools: ['Read(src/*)', 'AgentSpawn'] });
      const [record] = await run.manager.list();
      expect(record.toolCeiling).toEqual([['Read(src/*)', 'AgentSpawn']]);
      await settled(run.manager, record.id);
      expect(run.childRuns[0].systemPromptAppend).toContain('Read(src/*), AgentSpawn');
    } finally {
      run.dispose();
    }
  });

  it.each([
    ['Task', TASK],
    ['AgentSpawn', SPAWN],
  ] as const)(
    'refuses a %s whose role would have no tool left, before any side effect',
    async (name, call) => {
      const run = harness();
      try {
        // `patcher` has neither, so the list leaves it nothing to run.
        const results = await run.parent([[call]], { allowedTools: ['WebFetch', name] });

        const refusal = results.get(call.id);
        expect(refusal?.status).not.toBe('success');
        expect(refusal?.structuredError?.code).toBe('child_tool_surface_empty');
        expect(refusal?.structuredError?.message).toContain('patcher');
        expect(await run.manager.list()).toEqual([]);
        expect(await run.manager.listPlans()).toEqual([]);
        expect(run.childRuns).toEqual([]);
      } finally {
        run.dispose();
      }
    },
  );

  it('gives a spawn with no allowed-tools in force no ceiling at all', async () => {
    const run = harness();
    try {
      await run.parent([[SPAWN]]);
      const [record] = await run.manager.list();
      expect(record).not.toHaveProperty('toolCeiling');
      await settled(run.manager, record.id);
      expectWhole(run.childRuns[0]);
    } finally {
      run.dispose();
    }
  });

  it('gives a child nothing to spawn with, under a ceiling that lists the delegation tools', async () => {
    const nested: ToolCall = {
      id: 'nested',
      name: 'Task',
      arguments: { agent: 'patcher', prompt: 'recurse' },
    };
    const run = harness([nested]);
    try {
      await run.parent([[TASK]], { allowedTools: ['Read', 'Task', 'AgentSpawn'] });
      expect(run.childRuns).toHaveLength(1);
      expect(run.childRuns[0].tools).not.toContain('Task');
      expect(run.childRuns[0].tools).not.toContain('AgentSpawn');
      expect(run.childRuns[0].results.get(nested.id)?.structuredError?.code).toBe('unknown_tool');
    } finally {
      run.dispose();
    }
  });

  it('runs a child with the tools the ceiling leaves, and they work', async () => {
    const read: ToolCall = { id: 'read', name: 'Read', arguments: { file_path: 'note.txt' } };
    const run = harness([read]);
    try {
      await run.parent([[TASK]], { allowedTools: ['Read', 'Task'] });
      // The worktree is empty, so the call reaches the tool and fails on the missing file.
      const result = run.childRuns[0].results.get(read.id);
      expect(result?.structuredError?.code).not.toBe('unknown_tool');
      expect(result?.structuredError?.code).not.toBe('capability_denied');
    } finally {
      run.dispose();
    }
  });
});
