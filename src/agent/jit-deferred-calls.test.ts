import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLoop } from './loop.js';
import { canonicalToolName } from '../tools/aliases.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { toolSuccess } from '../tools/result.js';
import type { Provider } from '../provider/index.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type { PermissionMode } from '../types/runtime.js';
import type { ToolCall, ToolDefinition, ToolResult } from '../types/tools.js';
import { defaultConfig } from '../test/fixtures.js';
import { isolateBookHome } from '../test/isolated-book-home.js';

// Just-in-time execution of deferred tools (#619), through the whole agent loop: a direct call to
// an authorized deferred tool must get exactly the outcome `select:` followed by the same call
// gets, in every permission mode and under every restriction, and the only difference allowed is
// the budget exception, asserted on its own.

isolateBookHome();

const MODES: PermissionMode[] = [
  'default',
  'auto',
  'plan',
  'accept-edits',
  'dontAsk',
  'bypassPermissions',
];

const MCP_TOOL: ToolDefinition = {
  name: 'mcp__demo__lookup',
  description: 'Look a record up in the demo server.',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  execute: async () => toolSuccess('never'),
};

/** A deferred tool its runtime never offers, like a server that is not running. */
const OFFLINE_TOOL: ToolDefinition = {
  name: 'OfflineProbe',
  description: 'Probe a service that is not running.',
  parameters: { type: 'object', properties: {} },
  catalog: { available: () => false },
  execute: async () => toolSuccess('never'),
};

/** One call per deferred tool kind: read-only, network, mutating, git mutation, MCP, root-only. */
const CALLS: Record<string, ToolCall> = {
  GitLog: { id: 'x', name: 'GitLog', arguments: {} },
  WebFetch: { id: 'x', name: 'WebFetch', arguments: { url: 'https://example.com/page' } },
  NotebookEdit: {
    id: 'x',
    name: 'NotebookEdit',
    arguments: { notebook_path: 'a.ipynb', new_source: 'x' },
  },
  GitCommit: { id: 'x', name: 'GitCommit', arguments: { message: 'm' } },
  mcp__demo__lookup: { id: 'x', name: 'mcp__demo__lookup', arguments: { q: 'x' } },
  AgentSpawn: {
    id: 'x',
    name: 'AgentSpawn',
    arguments: { agent: 'explorer', description: 'look', prompt: 'look around' },
  },
  OfflineProbe: { id: 'x', name: 'OfflineProbe', arguments: {} },
};

const STUBBED = [
  'GitLog',
  'GitStatus',
  'WebFetch',
  'NotebookEdit',
  'GitCommit',
  'AgentSpawn',
  'BashOutput',
  'Write',
];

/** The default tools with every tool the cases call stubbed, so nothing reaches git or the net. */
function stubbedRegistry(ran: string[]) {
  const registry = createDefaultRegistry();
  for (const definition of [
    ...STUBBED.map((name) => registry.getTool(name)!),
    MCP_TOOL,
    OFFLINE_TOOL,
  ]) {
    registry.register({
      ...definition,
      execute: async () => {
        ran.push(definition.name);
        return toolSuccess(`ran ${definition.name}`);
      },
    });
  }
  // A background Bash: records a finished shell, as a real one would, without a process.
  registry.register({
    ...registry.getTool('Bash')!,
    execute: async (_args, context) => {
      ran.push('Bash');
      context.backgroundShells?.shells.set('shell-1', {
        id: 'shell-1',
        command: 'sleep 1',
        effectiveCommand: 'sleep 1',
        workdir: context.workspaceRoot,
        status: 'exited',
        output: '',
        readOffset: 0,
        truncatedBytes: 0,
        startedAt: 0,
        exitCode: 0,
      });
      return toolSuccess('started shell-1');
    },
  });
  return registry;
}

type Arm = 'direct' | 'select-next-turn' | 'select-same-response';

interface Case {
  mode: PermissionMode;
  call: ToolCall;
  allowedTools?: string[];
  isSubagent?: boolean;
  typedText?: string;
  /** Calls the same response makes before the case's own (EnterPlanMode, InvokeSkill). */
  prelude?: ToolCall[];
  configure?: (config: ReturnType<typeof defaultConfig>) => void;
}

interface Outcome {
  /** Permission prompts for the case's own call. */
  asked: number;
  status?: string;
  code?: string;
  ran: boolean;
  /** Whether the request after the call declares the tool. */
  declaredNext: boolean;
}

let workspace = '';

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-jit-'));
  const skill = join(workspace, '.book', 'skills', 'jit');
  mkdirSync(skill, { recursive: true });
  writeFileSync(
    join(skill, 'SKILL.md'),
    [
      '---',
      'name: jit',
      'description: Use the jit workflow',
      'allowed-tools:',
      '- Read',
      '- GitLog',
      '- WebFetch',
      '---',
      'Follow the jit procedure.',
    ].join('\n'),
  );
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

async function run(
  testCase: Case,
  arm: Arm,
  observe?: (result: ToolResult) => void,
): Promise<Outcome> {
  const target = { ...testCase.call, id: 'target' };
  const name = canonicalToolName(target.name);
  const select: ToolCall = {
    id: 'select',
    name: 'ToolSearch',
    arguments: { query: `select:${name}` },
  };
  const prelude = testCase.prelude ?? [];
  const turns: ToolCall[][] =
    arm === 'direct'
      ? [[...prelude, target]]
      : arm === 'select-same-response'
        ? [[...prelude, select, target]]
        : [[...prelude, select], [target]];
  const callTurn = turns.length - 1;
  const requests: string[][] = [];
  let turn = 0;
  const provider = {
    id: 'scripted',
    stream: async function* (_config: unknown, _messages: unknown, tools: Array<{ name: string }>) {
      requests.push(tools.map((tool) => tool.name));
      const calls = turns[turn++];
      if (calls) for (const toolCall of calls) yield { type: 'tool_call', toolCall };
      else yield { type: 'text', content: 'done' };
      yield { type: 'done' };
    },
  } as unknown as Provider;
  const ran: string[] = [];
  let asked = 0;
  let result: ToolResult | undefined;
  const callbacks: AgentLoopCallbacks = {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: (toolResult) => {
      if (toolResult.toolCallId === 'target') result = toolResult;
      observe?.(toolResult);
    },
    onError: () => {},
    onTurnStart: () => {},
    onDone: () => {},
    onPermissionRequired: async (call) => {
      if (call.id === 'target') asked++;
      return 'allow';
    },
    onPlanApprovalRequired: async () => 'approve',
  };
  const config = defaultConfig({ workspace, maxTurns: turns.length + 1 });
  testCase.configure?.(config);
  await runAgentLoop(config, stubbedRegistry(ran), 'go', [], callbacks, testCase.mode, {
    provider,
    isNewSession: false,
    allowedTools: testCase.allowedTools,
    isSubagent: testCase.isSubagent,
    typedText: testCase.typedText,
  });
  return {
    asked,
    status: result?.status,
    code: result?.structuredError?.code,
    ran: ran.includes(name),
    declaredNext: requests[callTurn + 1]?.includes(name) ?? false,
  };
}

const label = (testCase: Case, source: string) =>
  `${source} | ${testCase.mode} | ${testCase.call.name}${
    testCase.call.name === 'WebFetch' ? ` ${String(testCase.call.arguments.url)}` : ''
  }`;

/** Restriction sources, each as the loop option a host passes for it. */
const SOURCES: Array<{ source: string; extend: (testCase: Case) => Case }> = [
  { source: 'none', extend: (testCase) => testCase },
  // A Task subagent and a managed agent run as the child role.
  { source: 'agent role (child)', extend: (testCase) => ({ ...testCase, isSubagent: true }) },
  // The SDK's and a managed agent's allowedTools.
  {
    source: 'allowedTools',
    extend: (testCase) => ({
      ...testCase,
      allowedTools: ['Read', 'GitLog', 'mcp__demo__lookup', 'WebFetch(https://example.com/*)'],
    }),
  },
  // A command's allowed-tools reach the loop as the same option, from both hosts.
  {
    source: "command's allowed-tools",
    extend: (testCase) => ({ ...testCase, allowedTools: ['NotebookEdit', 'GitCommit'] }),
  },
  {
    source: "skill's allowed-tools",
    extend: (testCase) => ({ ...testCase, typedText: '$jit go' }),
  },
];

const ALL_TOOLS = Object.keys(CALLS);

function matrix(): Array<[string, Case]> {
  const cases: Array<[string, Case]> = [];
  for (const { source, extend } of SOURCES) {
    // Every mode against the unrestricted surface; the two ends of the permission range under
    // each restriction, where the restriction rather than the mode decides.
    const modes = source === 'none' ? MODES : (['default', 'bypassPermissions'] as const);
    for (const mode of modes) {
      for (const tool of ALL_TOOLS) {
        const testCase = extend({ mode, call: CALLS[tool] });
        cases.push([label(testCase, source), testCase]);
      }
    }
  }
  // An argument-scoped rule: the same tool, a URL the rule does not cover.
  for (const mode of MODES) {
    const testCase: Case = {
      mode,
      call: { id: 'x', name: 'WebFetch', arguments: { url: 'https://other.test/' } },
      allowedTools: ['Read', 'WebFetch(https://example.com/*)'],
    };
    cases.push([label(testCase, 'argument-scoped rule'), testCase]);
  }
  return cases;
}

describe('a direct call against select: then the same call (#619)', () => {
  it.each(matrix())('%s', async (_name, testCase) => {
    const direct = await run(testCase, 'direct');
    const nextTurn = await run(testCase, 'select-next-turn');
    const sameResponse = await run(testCase, 'select-same-response');

    expect(direct).toEqual(nextTurn);
    expect(direct).toEqual(sameResponse);
  });

  it.each([
    [
      'EnterPlanMode, then NotebookEdit',
      {
        mode: 'default',
        prelude: [{ id: 'plan', name: 'EnterPlanMode', arguments: {} }],
        call: CALLS.NotebookEdit,
      },
    ],
    [
      // A core tool that became available after the request was built (review of #637).
      'a background Bash, then BashOutput',
      {
        mode: 'default',
        prelude: [
          {
            id: 'bash',
            name: 'Bash',
            arguments: { command: 'sleep 1', run_in_background: true },
          },
        ],
        call: { id: 'x', name: 'BashOutput', arguments: { shell_id: 'shell-1' } },
      },
    ],
    [
      'a background Bash, then BashOutput, under bypassPermissions',
      {
        mode: 'bypassPermissions',
        prelude: [
          {
            id: 'bash',
            name: 'Bash',
            arguments: { command: 'sleep 1', run_in_background: true },
          },
        ],
        call: { id: 'x', name: 'BashOutput', arguments: { shell_id: 'shell-1' } },
      },
    ],
    [
      'an approved ExitPlanMode, then Write',
      {
        mode: 'plan',
        prelude: [{ id: 'exit', name: 'ExitPlanMode', arguments: { plan: 'Write the file.' } }],
        call: { id: 'x', name: 'Write', arguments: { file_path: 'out.txt', content: 'x' } },
      },
    ],
    [
      'InvokeSkill with allowed-tools, then WebFetch',
      {
        mode: 'bypassPermissions',
        prelude: [{ id: 'skill', name: 'InvokeSkill', arguments: { skill: 'jit' } }],
        call: CALLS.WebFetch,
      },
    ],
    [
      'InvokeSkill with allowed-tools, then NotebookEdit',
      {
        mode: 'bypassPermissions',
        prelude: [{ id: 'skill', name: 'InvokeSkill', arguments: { skill: 'jit' } }],
        call: CALLS.NotebookEdit,
      },
    ],
  ] as Array<[string, Case]>)('in the same response: %s', async (_name, testCase) => {
    // A mode or a skill restriction that changes earlier in the response decides the call the
    // same way for both: the mode is read live, and a skill's frame applies from the next turn.
    const direct = await run(testCase, 'direct');
    expect(direct).toEqual(await run(testCase, 'select-same-response'));
  });
});

describe('what a direct call gets (#619)', () => {
  it('runs an authorized read-only tool with no ToolSearch, and declares it next request', async () => {
    expect(await run({ mode: 'default', call: CALLS.GitLog }, 'direct')).toEqual({
      asked: 0,
      status: 'success',
      code: undefined,
      ran: true,
      declaredNext: true,
    });
  });

  it('runs AgentSpawn when the model names it without searching (§3)', async () => {
    const outcome = await run({ mode: 'bypassPermissions', call: CALLS.AgentSpawn }, 'direct');
    expect(outcome).toMatchObject({ status: 'success', ran: true, declaredNext: true });
  });

  it('runs a core tool that became available earlier in the response', async () => {
    const bashOutput = await run(
      {
        mode: 'bypassPermissions',
        prelude: [
          {
            id: 'bash',
            name: 'Bash',
            arguments: { command: 'sleep 1', run_in_background: true },
          },
        ],
        call: { id: 'x', name: 'BashOutput', arguments: { shell_id: 'shell-1' } },
      },
      'direct',
    );
    const write = await run(
      {
        mode: 'plan',
        prelude: [{ id: 'exit', name: 'ExitPlanMode', arguments: { plan: 'Write the file.' } }],
        call: { id: 'x', name: 'Write', arguments: { file_path: 'out.txt', content: 'x' } },
      },
      'direct',
    );

    expect(bashOutput).toMatchObject({ status: 'success', ran: true });
    expect(write).toMatchObject({ status: 'success', ran: true });
  });

  it('still asks for a mutating tool in default mode', async () => {
    const outcome = await run({ mode: 'default', call: CALLS.NotebookEdit }, 'direct');
    expect(outcome).toMatchObject({ asked: 1, status: 'success', ran: true });
  });

  it.each([['NotebookEdit'], ['GitCommit']])(
    'keeps plan mode refusing %s, with the mode named',
    async (tool) => {
      const outcome = await run({ mode: 'plan', call: CALLS[tool] }, 'direct');
      expect(outcome).toEqual({
        asked: 0,
        status: 'blocked',
        code: 'plan_mode_blocked',
        ran: false,
        declaredNext: false,
      });
    },
  );

  it('refuses a tool outside allowedTools as not active, and declares nothing', async () => {
    const outcome = await run(
      { mode: 'bypassPermissions', call: CALLS.NotebookEdit, allowedTools: ['Read'] },
      'direct',
    );
    expect(outcome).toEqual({
      asked: 0,
      status: 'blocked',
      code: 'tool_not_active',
      ran: false,
      declaredNext: false,
    });
  });

  it('refuses a URL the argument-scoped rule does not cover, after loading the tool', async () => {
    const outcome = await run(
      {
        mode: 'bypassPermissions',
        call: { id: 'x', name: 'WebFetch', arguments: { url: 'https://other.test/' } },
        allowedTools: ['Read', 'WebFetch(https://example.com/*)'],
      },
      'direct',
    );
    expect(outcome).toMatchObject({
      code: 'arguments_not_allowed',
      ran: false,
      declaredNext: true,
    });
  });

  it('refuses a root-only tool in a child run', async () => {
    const outcome = await run(
      { mode: 'bypassPermissions', call: CALLS.AgentSpawn, isSubagent: true },
      'direct',
    );
    expect(outcome).toMatchObject({ code: 'tool_not_active', ran: false });
  });

  it("refuses a tool outside a typed skill's allowed-tools", async () => {
    const outcome = await run(
      { mode: 'bypassPermissions', call: CALLS.NotebookEdit, typedText: '$jit go' },
      'direct',
    );
    expect(outcome).toMatchObject({ code: 'tool_not_active', ran: false });
  });

  it('refuses a deferred tool its runtime does not offer', async () => {
    const outcome = await run({ mode: 'bypassPermissions', call: CALLS.OfflineProbe }, 'direct');
    expect(outcome).toMatchObject({ code: 'tool_not_active', ran: false });
  });

  it('refuses dontAsk mode a tool it would have to ask about', async () => {
    const outcome = await run({ mode: 'dontAsk', call: CALLS.NotebookEdit }, 'direct');
    expect(outcome).toMatchObject({ asked: 0, status: 'blocked', ran: false });
  });

  it('runs a tool whose schema alone exceeds the budget, without declaring it next request', async () => {
    // The one allowed difference: `select:` cannot load the tool, while the direct call runs
    // and says it was not loaded. The call after the failed `select:` is itself a direct call,
    // so it runs the same way.
    const testCase: Case = {
      mode: 'bypassPermissions',
      call: CALLS.GitLog,
      configure: (config) => {
        config.settings.toolDiscovery.schemaTokenBudget = 1;
      },
    };
    let content = '';
    const direct = await run(testCase, 'direct', (result) => {
      if (result.toolCallId === 'target') content = result.content;
    });
    let selectCode: string | undefined;
    const selected = await run(testCase, 'select-next-turn', (result) => {
      if (result.toolCallId === 'select') selectCode = result.structuredError?.code;
    });

    expect(direct).toEqual({
      asked: 0,
      status: 'success',
      code: undefined,
      ran: true,
      declaredNext: false,
    });
    expect(content).toContain('GitLog ran without being loaded');
    expect(selectCode).toBe('tool_discovery_budget_exceeded');
    expect(selected).toEqual(direct);
  });
});

describe('a rule or hook on ToolSearch itself gates discovery again (#619, decision c)', () => {
  const gated = (configure: Case['configure']): Case['configure'] => configure;
  it.each([
    [
      'deny: ["ToolSearch"]',
      gated((config) => {
        config.settings.permissions.deny = ['ToolSearch'];
      }),
    ],
    [
      'ask: ["ToolSearch"]',
      gated((config) => {
        config.settings.permissions.ask = ['ToolSearch'];
      }),
    ],
    [
      'a PreToolUse hook on ToolSearch',
      gated((config) => {
        config.settings.hooks.PreToolUse = [{ command: 'exit 0', matcher: 'ToolSearch', env: {} }];
      }),
    ],
  ])('%s: a direct call is refused toward ToolSearch, as before #619', async (_name, configure) => {
    for (const mode of ['default', 'bypassPermissions'] as const) {
      for (const tool of ['GitLog', 'WebFetch', 'mcp__demo__lookup']) {
        let remediation: string | undefined;
        const outcome = await run({ mode, call: CALLS[tool], configure }, 'direct', (result) => {
          if (result.toolCallId === 'target') remediation = result.structuredError?.remediation;
        });
        expect(outcome, `${mode} ${tool}`).toEqual({
          asked: 0,
          status: 'blocked',
          code: 'tool_not_active',
          ran: false,
          declaredNext: false,
        });
        expect(remediation).toBe(
          'Call ToolSearch to discover it or use an authorized active tool.',
        );
      }
    }
  });

  it('a hook with no matcher keeps direct calls, and sees the direct call', async () => {
    const hooked: string[] = [];
    const config = defaultConfig({ workspace, maxTurns: 2 });
    config.settings.hooks.PreToolUse = [{ command: 'exit 0', env: {} }];
    let turn = 0;
    const ran: string[] = [];
    let status: string | undefined;
    await runAgentLoop(
      config,
      stubbedRegistry(ran),
      'go',
      [],
      {
        onText: () => {},
        onToolCall: () => {},
        onToolResult: (result) => (status = result.status),
        onError: () => {},
        onTurnStart: () => {},
        onDone: () => {},
        onPermissionRequired: async () => 'allow',
        onHookEvent: (event, payload) => {
          if (event === 'PreToolUse') hooked.push(String(payload.toolName));
        },
      },
      'default',
      {
        provider: {
          id: 'scripted',
          stream: async function* () {
            if (turn++ === 0)
              yield { type: 'tool_call', toolCall: { id: 'log-1', name: 'GitLog', arguments: {} } };
            else yield { type: 'text', content: 'done' };
            yield { type: 'done' };
          },
        } as unknown as Provider,
        isNewSession: false,
      },
    );

    expect(status).toBe('success');
    expect(ran).toEqual(['GitLog']);
    expect(hooked).toEqual(['GitLog']);
  });
});

describe('just-in-time calls in the loop (#619)', () => {
  it('admits two parallel-safe deferred tools in one execution wave', async () => {
    const ran: string[] = [];
    const results: ToolResult[] = [];
    const requests: string[][] = [];
    let turn = 0;
    const provider = {
      id: 'scripted',
      stream: async function* (_c: unknown, _m: unknown, tools: Array<{ name: string }>) {
        requests.push(tools.map((tool) => tool.name));
        if (turn++ === 0) {
          for (const toolCall of [
            { id: 'log-1', name: 'GitLog', arguments: {} },
            { id: 'status-1', name: 'GitStatus', arguments: {} },
            { id: 'log-2', name: 'GitLog', arguments: {} },
          ])
            yield { type: 'tool_call', toolCall };
        } else yield { type: 'text', content: 'done' };
        yield { type: 'done' };
      },
    } as unknown as Provider;
    const registry = stubbedRegistry(ran);
    expect(registry.getTool('GitLog')?.policy?.concurrency).toBe('parallel');

    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2 }),
      registry,
      'go',
      [],
      {
        onText: () => {},
        onToolCall: () => {},
        onToolResult: (result) => results.push(result),
        onError: () => {},
        onTurnStart: () => {},
        onDone: () => {},
        onPermissionRequired: async () => 'allow',
      },
      'default',
      { provider, isNewSession: false },
    );

    expect(requests[0]).not.toContain('GitLog');
    expect(results.map((result) => result.status)).toEqual(['success', 'success', 'success']);
    expect(ran.sort()).toEqual(['GitLog', 'GitLog', 'GitStatus']);
    expect(requests[1]).toEqual(expect.arrayContaining(['GitLog', 'GitStatus']));
  });

  it('runs PreToolUse hooks on a just-in-time call, and lets them block it', async () => {
    const ran: string[] = [];
    const hookEvents: string[] = [];
    let result: ToolResult | undefined;
    const requests: string[][] = [];
    let turn = 0;
    const provider = {
      id: 'scripted',
      stream: async function* (_c: unknown, _m: unknown, tools: Array<{ name: string }>) {
        requests.push(tools.map((tool) => tool.name));
        if (turn++ === 0)
          yield { type: 'tool_call', toolCall: { id: 'log-1', name: 'GitLog', arguments: {} } };
        else yield { type: 'text', content: 'done' };
        yield { type: 'done' };
      },
    } as unknown as Provider;
    const config = defaultConfig({ workspace, maxTurns: 2 });
    config.settings.hooks.PreToolUse = [{ command: 'exit 2', matcher: 'GitLog', env: {} }];

    await runAgentLoop(
      config,
      stubbedRegistry(ran),
      'go',
      [],
      {
        onText: () => {},
        onToolCall: () => {},
        onToolResult: (toolResult) => (result = toolResult),
        onError: () => {},
        onTurnStart: () => {},
        onDone: () => {},
        onPermissionRequired: async () => 'allow',
        onHookEvent: (event, payload) => {
          if (event === 'PreToolUse') hookEvents.push(String(payload.toolName));
        },
      },
      'bypassPermissions',
      { provider, isNewSession: false },
    );

    expect(hookEvents).toEqual(['GitLog']);
    expect(result?.structuredError?.code).toBe('hook_blocked');
    expect(ran).toEqual([]);
    // Admission comes before the hooks, as a `select:` would have: the blocked call still
    // loaded the tool for the next request.
    expect(requests[1]).toContain('GitLog');
  });
});
