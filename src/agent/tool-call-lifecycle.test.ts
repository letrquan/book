import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { systemClock } from '../clock.js';
import { runHooks } from '../hooks.js';
import type { Provider } from '../provider/index.js';
import { SessionRuntime } from '../session/runtime.js';
import { defaultConfig } from '../test/fixtures.js';
import { isolateBookHome } from '../test/isolated-book-home.js';
import { createToolSurface } from '../tools/catalog.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { toolFailure, toolSuccess } from '../tools/result.js';
import type { PeerPermissionClass } from '../types/messaging.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type { AgentConfig, PermissionMode } from '../types/runtime.js';
import type {
  PermissionDecision,
  PermissionSubject,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../types/tools.js';
import { ExplorationRoutingTracker } from './exploration-routing.js';
import { runAgentLoop } from './loop.js';
import {
  finalizeToolCall,
  PEER_TURN_AGENT_REFUSAL,
  PEER_TURN_MODE_REFUSAL,
  prepareToolCall,
  type PrepareToolCallOutcome,
  type ToolCallRun,
} from './tool-call-lifecycle.js';

// A hook here is what the gate does with its answer, so no process is needed to give one.
vi.mock('../hooks.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../hooks.js')>();
  return { ...original, runHooks: vi.fn(original.runHooks) };
});

const realHooks = await vi.importActual<typeof import('../hooks.js')>('../hooks.js');

isolateBookHome();

let workspace: string;
let outside: string;
let runtimes: SessionRuntime[] = [];

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'book-gate-')));
  outside = realpathSync(mkdtempSync(join(tmpdir(), 'book-gate-out-')));
  vi.mocked(runHooks).mockReset();
});

afterEach(() => {
  for (const runtime of runtimes) runtime.dispose();
  runtimes = [];
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

interface GateOptions {
  mode?: PermissionMode;
  answer?: PermissionDecision | 'allow' | 'deny' | 'always';
  signal?: AbortSignal;
  peerTurnClass?: PeerPermissionClass;
  allowedTools?: string[];
  configure?: (config: AgentConfig) => void;
  tools?: ToolDefinition[];
}

/** The gate as the loop hands it its run. */
function gate(options: GateOptions = {}) {
  const config = defaultConfig({ workspace });
  options.configure?.(config);
  const registry = createDefaultRegistry();
  for (const tool of options.tools ?? []) registry.register(tool);
  const runtime = new SessionRuntime();
  runtimes.push(runtime);
  const initialMode = options.mode ?? 'default';
  const readOnlyRoots: string[] = [];
  const toolContext: ToolContext = {
    workspaceRoot: workspace,
    env: {},
    readOnlyRoots,
    additionalRoots: [],
    runtime,
    currentMode: initialMode,
  };
  const toolSurface = createToolSurface({
    config,
    context: toolContext,
    definitions: registry.getDefinitions(),
    capabilityRules: options.allowedTools,
  });
  toolContext.toolDiscovery = toolSurface;
  toolSurface.activeDefinitions();

  const host = { mode: initialMode };
  let effectiveMode = initialMode;
  // A stand-in for the loop's `syncHostMode`: here, only when the gate asks matters. The real one,
  // with its peer-turn pin, is tested through `runAgentLoop` at the end of this file.
  const sync = vi.fn(() => {
    toolContext.hostMode = host.mode;
    toolContext.currentMode = host.mode;
    effectiveMode = host.mode;
  });
  const onPermissionRequired = vi.fn(async () => options.answer ?? 'allow');
  const onPersistPermissionRule = vi.fn();
  const callbacks: AgentLoopCallbacks = {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onError: () => {},
    onTurnStart: () => {},
    onDone: () => {},
    onPermissionRequired,
    onPersistPermissionRule,
  };
  const noteUnattendedRefusal = vi.fn();
  const noteChildRefusal = vi.fn();
  const run: ToolCallRun = {
    config,
    registry,
    callbacks,
    signal: options.signal,
    toolContext,
    toolSurface,
    skillRegistry: runtime.skills(workspace, config.settings.skills),
    approveAllRules: [],
    runtime,
    clock: systemClock,
    explorationRouting: new ExplorationRoutingTracker(3),
    readOnlyRoots,
    additionalRoots: [],
    homeGuardPaths: [],
    workspaceRealRoot: workspace,
    workspaceHoldsHome: false,
    mode: {
      current: () => effectiveMode,
      sync,
      set: (next) => {
        effectiveMode = next;
      },
    },
    planState: { handoffRequested: null, planStopRequested: null },
    noteChildRefusal,
    noteUnattendedRefusal,
    peerTurnClass: options.peerTurnClass,
  };
  const prepare = (
    name: string,
    args: Record<string, unknown>,
    request: Partial<{ parallel: boolean; nestedTraceId: string; call: Partial<ToolCall> }> = {},
  ): Promise<PrepareToolCallOutcome> =>
    prepareToolCall(run, {
      index: 0,
      turn: 1,
      call: registry.normalizeCall({ id: 'c1', name, arguments: args, ...request.call }),
      parallel: request.parallel ?? false,
      nestedTraceId: request.nestedTraceId,
    });
  return {
    run,
    host,
    sync,
    prepare,
    onPermissionRequired,
    onPersistPermissionRule,
    noteUnattendedRefusal,
    noteChildRefusal,
  };
}

function refusalOf(outcome: PrepareToolCallOutcome) {
  if (outcome.status !== 'refused')
    throw new Error('expected a refusal, and the call was prepared');
  return outcome.result;
}
const codeOf = (outcome: PrepareToolCallOutcome) => refusalOf(outcome).structuredError?.code;

function entryOf(outcome: PrepareToolCallOutcome) {
  if (outcome.status !== 'prepared') {
    throw new Error(`expected a prepared call, got ${outcome.result.structuredError?.code}`);
  }
  return outcome.entry;
}

const blockedByHook = (message: string) =>
  vi
    .mocked(runHooks)
    .mockResolvedValueOnce([
      { action: 'block', message, entry: { command: 'x', env: {} } },
    ] as unknown as Awaited<ReturnType<typeof runHooks>>);

/** A tool the permission check asks to canonicalize its target. */
function judgedTool(canonicalize: () => Promise<PermissionSubject | undefined>): ToolDefinition {
  return {
    name: 'Judged',
    description: 'A tool with a permission subject',
    parameters: { type: 'object', properties: { to: { type: 'string' } } },
    canonicalizeForPermission: canonicalize,
    execute: async () => toolSuccess('ran'),
  };
}

function writeSkill(name: string, allowedTools: string[] = []): void {
  const directory = join(workspace, '.book', 'skills', name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    [
      '---',
      `name: ${name}`,
      `description: Use the ${name} workflow`,
      ...(allowedTools.length > 0
        ? ['allowed-tools:', ...allowedTools.map((tool) => `- ${tool}`)]
        : []),
      '---',
      `Follow the ${name} procedure.`,
    ].join('\n'),
  );
}

const withRules =
  (rules: { allow?: string[]; deny?: string[]; ask?: string[] }) => (config: AgentConfig) => {
    Object.assign(config.settings.permissions, rules);
  };

describe('prepareToolCall: one case per refusal, in the order the gates run', () => {
  it('1. a run already aborted: cancelled_before_start, before the mode is even read', async () => {
    const controller = new AbortController();
    controller.abort();
    const { prepare, sync } = gate({ signal: controller.signal });

    const refusal = refusalOf(await prepare('Bash', { command: 'ls' }));

    expect(refusal.structuredError?.code).toBe('cancelled_before_start');
    expect(refusal.status).toBe('cancelled');
    expect(refusal.toolCallId).toBe('c1');
    expect(sync).not.toHaveBeenCalled();
    expect(runHooks).not.toHaveBeenCalled();
  });

  it.each(['EnterPlanMode', 'ExitPlanMode'])(
    '2. a peer turn calling %s: peer_turn_mode_change',
    async (name) => {
      const { prepare } = gate({ peerTurnClass: 'bypass' });

      const refusal = refusalOf(await prepare(name, {}));

      expect(refusal.structuredError?.code).toBe('peer_turn_mode_change');
      expect(refusal.structuredError?.message).toContain(PEER_TURN_MODE_REFUSAL);
      expect(refusal.status).toBe('blocked');
    },
  );

  it.each(['AgentSpawn', 'AgentPlan', 'AgentSend'])(
    '2. a prompting-class peer turn calling %s: peer_turn_agents',
    async (name) => {
      const { prepare } = gate({ peerTurnClass: 'prompting' });

      const refusal = refusalOf(await prepare(name, {}));

      expect(refusal.structuredError?.code).toBe('peer_turn_agents');
      expect(refusal.structuredError?.message).toContain(PEER_TURN_AGENT_REFUSAL);
    },
  );

  it('2. a bypass-class peer turn may still start an agent, so that gate is the class', async () => {
    const { prepare } = gate({ peerTurnClass: 'bypass' });

    // Not the peer gate's to refuse: the call goes on to the registry, which reads its arguments.
    expect(codeOf(await prepare('AgentSpawn', {}))).toBe('invalid_arguments');
  });

  it('3. a call that can never run: unknown_tool, invalid_json_arguments, invalid_arguments', async () => {
    const { prepare, onPermissionRequired } = gate();

    expect(codeOf(await prepare('NoSuchTool', {}))).toBe('unknown_tool');
    expect(codeOf(await prepare('Bash', {}, { call: { emptyOnWire: true } }))).toBe(
      'invalid_json_arguments',
    );
    expect(codeOf(await prepare('Bash', {}))).toBe('invalid_arguments');
    expect(onPermissionRequired).not.toHaveBeenCalled();
  });

  it('3. a tool the mode refuses itself is left to the mode, whatever its arguments', async () => {
    const plan = gate({ mode: 'plan' });
    expect(codeOf(await plan.prepare('Write', {}))).toBe('plan_mode_blocked');

    const dontAsk = gate({ mode: 'dontAsk' });
    expect(codeOf(await dontAsk.prepare('AskUserQuestion', {}))).toBe('user_questions_disabled');

    // An unknown tool is no mode's to hide.
    expect(codeOf(await plan.prepare('NoSuchTool', {}))).toBe('unknown_tool');
  });

  it('4. a cancel while the tool canonicalizes its target: cancelled_before_start', async () => {
    const controller = new AbortController();
    const tool = judgedTool(() => {
      controller.abort();
      return new Promise(() => {});
    });
    const { prepare } = gate({ signal: controller.signal, tools: [tool] });

    expect(codeOf(await prepare('Judged', { to: 'x' }))).toBe('cancelled_before_start');
    expect(runHooks).not.toHaveBeenCalled();
  });

  it('4. canonicalization is not asked for a call the mode refuses anyway', async () => {
    const canonicalize = vi.fn(async () => undefined);
    const { prepare } = gate({ mode: 'plan', tools: [judgedTool(canonicalize)] });

    expect(codeOf(await prepare('Judged', { to: 'x' }))).toBe('plan_mode_blocked');
    expect(canonicalize).not.toHaveBeenCalled();
  });

  it('5. a PreToolUse hook that blocks: hook_blocked, with its message', async () => {
    const { prepare } = gate();
    blockedByHook('not on a Friday');

    const refusal = refusalOf(await prepare('Bash', { command: 'ls' }));

    expect(refusal.structuredError?.code).toBe('hook_blocked');
    expect(refusal.structuredError?.message).toContain('not on a Friday');
  });

  it('5. a cancel under the hook: cancelled_before_start; any other failure throws', async () => {
    const controller = new AbortController();
    const cancelled = gate({ signal: controller.signal });
    vi.mocked(runHooks).mockImplementationOnce(async () => {
      controller.abort();
      throw controller.signal.reason;
    });
    expect(codeOf(await cancelled.prepare('Bash', { command: 'ls' }))).toBe(
      'cancelled_before_start',
    );

    const failing = gate();
    vi.mocked(runHooks).mockRejectedValueOnce(new Error('hook runner broke'));
    await expect(failing.prepare('Bash', { command: 'ls' })).rejects.toThrow('hook runner broke');
  });

  it('6. a skill whose execution is denied: skill_execution_denied', async () => {
    writeSkill('alpha');
    const { prepare, run } = gate({
      configure: (config) => {
        config.settings.skills.execution = { alpha: 'deny' };
      },
    });
    const recorded = vi.spyOn(run.skillRegistry, 'recordActivationBlocked');

    expect(codeOf(await prepare('InvokeSkill', { skill: 'alpha' }))).toBe('skill_execution_denied');
    expect(recorded).toHaveBeenCalledWith(
      'alpha',
      'model',
      'skill_execution_denied',
      expect.any(String),
    );
  });

  it('6. a skill whose allowed-tools leave no task tool: skill_tool_intersection_empty', async () => {
    writeSkill('alpha', ['Write']);
    const { prepare, run } = gate({ allowedTools: ['Read', 'InvokeSkill'] });
    const recorded = vi.spyOn(run.skillRegistry, 'recordActivationBlocked');

    expect(codeOf(await prepare('InvokeSkill', { skill: 'alpha' }))).toBe(
      'skill_tool_intersection_empty',
    );
    expect(recorded).toHaveBeenCalledWith(
      'alpha',
      'model',
      'skill_tool_intersection_empty',
      expect.any(String),
    );
  });

  it('7. AskUserQuestion in dontAsk: user_questions_disabled', async () => {
    const { prepare } = gate({ mode: 'dontAsk' });

    expect(codeOf(await prepare('AskUserQuestion', { questions: [] }))).toBe(
      'user_questions_disabled',
    );
  });

  it('8. a deny rule: permission_denied, naming the rule', async () => {
    const { prepare, onPermissionRequired } = gate({
      configure: withRules({ deny: ['Bash(rm *)'] }),
    });

    const refusal = refusalOf(await prepare('Bash', { command: 'rm x' }));

    expect(refusal.structuredError?.code).toBe('permission_denied');
    expect(refusal.content).toContain('Bash(rm *)');
    expect(onPermissionRequired).not.toHaveBeenCalled();
  });

  it('8. a read no root serves: path_outside_workspace, with no prompt', async () => {
    const { prepare, onPermissionRequired, noteChildRefusal } = gate();

    const refusal = refusalOf(await prepare('Read', { filePath: join(outside, 'secret.txt') }));

    expect(refusal.structuredError?.code).toBe('path_outside_workspace');
    expect(noteChildRefusal).toHaveBeenCalledWith('Read', refusal.content);
    expect(onPermissionRequired).not.toHaveBeenCalled();
  });

  it('8. a pattern the matcher cannot read: pattern_unreadable, with no prompt', async () => {
    const { prepare, onPermissionRequired } = gate();

    const pattern = '!('.repeat(2500) + ')'.repeat(2500);
    expect(codeOf(await prepare('Glob', { pattern }))).toBe('pattern_unreadable');
    expect(onPermissionRequired).not.toHaveBeenCalled();
  });

  it('9. a tool this run does not expose: tool_not_active, with no prompt', async () => {
    const { prepare, onPermissionRequired } = gate({ allowedTools: ['Read'] });

    expect(codeOf(await prepare('Bash', { command: 'ls' }))).toBe('tool_not_active');
    expect(onPermissionRequired).not.toHaveBeenCalled();
  });

  it('9. arguments the allowed-tools rules do not cover: arguments_not_allowed', async () => {
    const { prepare, onPermissionRequired } = gate({ allowedTools: ['Bash(git *)'] });

    expect(codeOf(await prepare('Bash', { command: 'ls' }))).toBe('arguments_not_allowed');
    expect(onPermissionRequired).not.toHaveBeenCalled();
  });

  it('9. a tool that could not judge the call: permission_check_failed, with no prompt', async () => {
    const tool = judgedTool(async () => {
      throw new Error('no such session');
    });
    const { prepare, onPermissionRequired } = gate({ tools: [tool] });

    const refusal = refusalOf(await prepare('Judged', { to: 'x' }));

    expect(refusal.structuredError?.code).toBe('permission_check_failed');
    expect(refusal.structuredError?.message).toContain('no such session');
    expect(onPermissionRequired).not.toHaveBeenCalled();
  });

  it("9. a subject's own refusal is the result, under this call's id", async () => {
    const tool = judgedTool(async () => ({
      args: { to: 'x' },
      allow: ['x'],
      restrict: ['x'],
      refusal: toolFailure('SKIPPED: gone', { code: 'session_not_found', status: 'blocked' }),
    }));
    const { prepare, onPermissionRequired } = gate({ tools: [tool] });

    const refusal = refusalOf(await prepare('Judged', { to: 'x' }));

    expect(refusal.structuredError?.code).toBe('session_not_found');
    expect(refusal.toolCallId).toBe('c1');
    expect(onPermissionRequired).not.toHaveBeenCalled();
  });

  it('10. the prompt answered no: permission_denied', async () => {
    const { prepare, onPermissionRequired } = gate({ answer: 'deny' });

    expect(codeOf(await prepare('Bash', { command: 'ls' }))).toBe('permission_denied');
    expect(onPermissionRequired).toHaveBeenCalledOnce();
  });

  it('10. no approver: permission_denied with its remedy, and the operator is told', async () => {
    const { prepare, noteUnattendedRefusal } = gate({
      answer: { result: 'deny', reason: 'no_approver' },
    });

    const refusal = refusalOf(await prepare('Bash', { command: 'ls' }));

    expect(refusal.structuredError?.code).toBe('permission_denied');
    expect(noteUnattendedRefusal).toHaveBeenCalledWith(
      'Bash',
      expect.objectContaining({ kind: 'rule_or_auto', rule: 'Bash(ls)' }),
    );
  });

  it('10. dontAsk refuses what it would have asked about, without asking', async () => {
    const { prepare, onPermissionRequired } = gate({ mode: 'dontAsk' });

    expect(codeOf(await prepare('Bash', { command: 'ls' }))).toBe('permission_denied');
    expect(onPermissionRequired).not.toHaveBeenCalled();
  });

  it('10. "always" saves the rule, and the rule answers the next call', async () => {
    const { prepare, run, onPermissionRequired, onPersistPermissionRule } = gate({
      answer: 'always',
    });

    entryOf(await prepare('Bash', { command: 'ls' }));
    expect(run.approveAllRules).toEqual(['Bash(ls)']);
    expect(onPersistPermissionRule).toHaveBeenCalledWith('Bash(ls)');

    entryOf(await prepare('Bash', { command: 'ls' }));
    expect(onPermissionRequired).toHaveBeenCalledOnce();
  });

  it('10. a persistent background shell always asks, and "always" saves nothing', async () => {
    const { prepare, run, onPermissionRequired } = gate({ answer: 'always' });
    const args = { command: 'ls', run_in_background: true, lifetime: 'persistent' };

    entryOf(await prepare('Bash', args));
    entryOf(await prepare('Bash', args));

    expect(onPermissionRequired).toHaveBeenCalledTimes(2);
    expect(run.approveAllRules).toEqual([]);
  });

  it("10. a peer turn's call on a managed agent asks even in bypass, past any rule", async () => {
    const agentStop: ToolDefinition = {
      name: 'AgentStop',
      description: 'Stop an agent',
      parameters: { type: 'object', properties: {} },
      execute: async () => toolSuccess('stopped'),
    };
    const { prepare, run, onPermissionRequired } = gate({
      mode: 'bypassPermissions',
      peerTurnClass: 'bypass',
      tools: [agentStop],
      answer: 'deny',
    });
    run.approveAllRules.push('AgentStop');

    expect(codeOf(await prepare('AgentStop', {}))).toBe('permission_denied');
    expect(onPermissionRequired).toHaveBeenCalledOnce();
  });

  it('11. a mutating tool in plan mode: plan_mode_blocked, with no prompt', async () => {
    const { prepare, onPermissionRequired } = gate({ mode: 'plan' });

    const refusal = refusalOf(await prepare('Write', { filePath: 'a.txt', content: 'x' }));

    expect(refusal.structuredError?.code).toBe('plan_mode_blocked');
    expect(refusal.structuredError?.message).toContain('ExitPlanMode');
    expect(onPermissionRequired).not.toHaveBeenCalled();
  });

  it("12. the registry's last word: a rejection from prepare is the result", async () => {
    const { prepare, run } = gate({ mode: 'bypassPermissions' });
    const rejected = toolFailure('no', { code: 'prepare_rejected', status: 'blocked' });
    vi.spyOn(run.registry, 'prepare').mockReturnValueOnce({ status: 'rejected', result: rejected });

    expect(refusalOf(await prepare('Bash', { command: 'ls' }))).toBe(rejected);
  });
});

// Two paths leave the request open today, plan mode and a prompt that rejects: #729.
describe('prepareToolCall: skill consent, requested once and closed on each of these paths', () => {
  const invoke = { skill: 'alpha' };

  it('granted when the prompt says yes', async () => {
    writeSkill('alpha');
    const { prepare, run, onPermissionRequired } = gate();
    const requested = vi.spyOn(run.skillRegistry, 'requestConsent');
    const granted = vi.spyOn(run.skillRegistry, 'grantConsent');

    entryOf(await prepare('InvokeSkill', invoke));

    expect(requested).toHaveBeenCalledWith('alpha', 'model');
    expect(onPermissionRequired).toHaveBeenCalledOnce();
    expect(granted).toHaveBeenCalledWith('alpha', 'model');
  });

  it.each([
    [{ result: 'deny' }, 'user_denied'],
    [{ result: 'deny', reason: 'no_approver' }, 'no_approver'],
    [{ result: 'deny', reason: 'dismissed' }, 'dismissed'],
  ] as Array<[PermissionDecision, string]>)(
    'denied at the prompt (%j): %s',
    async (answer, cause) => {
      writeSkill('alpha');
      const { prepare, run } = gate({ answer });
      const denied = vi.spyOn(run.skillRegistry, 'denyConsent');
      const granted = vi.spyOn(run.skillRegistry, 'grantConsent');

      expect(codeOf(await prepare('InvokeSkill', invoke))).toBe('permission_denied');

      expect(denied).toHaveBeenCalledWith('alpha', 'model', cause);
      expect(granted).not.toHaveBeenCalled();
    },
  );

  it('denied by a deny rule', async () => {
    writeSkill('alpha');
    const { prepare, run } = gate({ configure: withRules({ deny: ['InvokeSkill'] }) });
    const denied = vi.spyOn(run.skillRegistry, 'denyConsent');

    expect(codeOf(await prepare('InvokeSkill', invoke))).toBe('permission_denied');
    expect(denied).toHaveBeenCalledWith('alpha', 'model', 'permission_denied');
  });

  it('denied when the tool is not active', async () => {
    writeSkill('alpha');
    const { prepare, run } = gate({ allowedTools: ['Read'] });
    const denied = vi.spyOn(run.skillRegistry, 'denyConsent');

    expect(codeOf(await prepare('InvokeSkill', invoke))).toBe('tool_not_active');
    expect(denied).toHaveBeenCalledWith('alpha', 'model', 'tool_not_active');
  });

  it('denied in dontAsk, which cannot ask for it', async () => {
    writeSkill('alpha');
    const { prepare, run, onPermissionRequired } = gate({ mode: 'dontAsk' });
    const denied = vi.spyOn(run.skillRegistry, 'denyConsent');

    expect(codeOf(await prepare('InvokeSkill', invoke))).toBe('permission_denied');
    expect(denied).toHaveBeenCalledWith('alpha', 'model', 'dont_ask');
    expect(onPermissionRequired).not.toHaveBeenCalled();
  });
});

describe('prepareToolCall: the order of the gates', () => {
  // With the mode unchanged. A mode left during the hook is the exception: #730.
  it('an invalid call never reaches a hook or the prompt, unless the mode refuses the tool itself', async () => {
    const { prepare, onPermissionRequired } = gate();

    await prepare('Bash', {});
    await prepare('NoSuchTool', { command: 'ls' });
    await prepare('Bash', {}, { call: { emptyOnWire: true } });

    expect(runHooks).not.toHaveBeenCalled();
    expect(onPermissionRequired).not.toHaveBeenCalled();
  });

  it('a peer refusal comes before the check for a call that can never run', async () => {
    const { prepare } = gate({ peerTurnClass: 'bypass' });

    // ExitPlanMode requires a plan, so this one would be invalid_arguments if it got that far.
    expect(codeOf(await prepare('ExitPlanMode', {}))).toBe('peer_turn_mode_change');
  });

  it('a hook block never reaches the prompt', async () => {
    const { prepare, onPermissionRequired } = gate();
    blockedByHook('no');

    expect(codeOf(await prepare('Bash', { command: 'ls' }))).toBe('hook_blocked');
    expect(onPermissionRequired).not.toHaveBeenCalled();
  });

  it('a hook speaks before a deny rule, and is asked about the canonical target', async () => {
    const subject = { args: { to: 'canonical' }, allow: ['canonical'], restrict: ['canonical'] };
    const { prepare } = gate({
      tools: [judgedTool(async () => subject)],
      configure: withRules({ deny: ['Judged'] }),
    });
    blockedByHook('no');

    expect(codeOf(await prepare('Judged', { to: 'alias' }))).toBe('hook_blocked');
    expect(vi.mocked(runHooks).mock.calls[0][2]).toMatchObject({
      toolName: 'Judged',
      toolArgs: { to: 'alias' },
      toolTargets: ['canonical'],
    });
  });

  it.each(['auto', 'bypassPermissions'] as const)(
    'a deny rule holds in %s, which asks about nothing',
    async (mode) => {
      const { prepare, onPermissionRequired } = gate({
        mode,
        configure: withRules({ deny: ['Bash(rm *)'] }),
      });

      expect(codeOf(await prepare('Bash', { command: 'rm x' }))).toBe('permission_denied');
      entryOf(await prepare('Bash', { command: 'ls' }));
      expect(onPermissionRequired).not.toHaveBeenCalled();
    },
  );

  it('a deny rule speaks before the refusals of a tool that is not active or could not judge', async () => {
    const inactive = gate({ allowedTools: ['Read'], configure: withRules({ deny: ['Bash'] }) });
    expect(codeOf(await inactive.prepare('Bash', { command: 'ls' }))).toBe('permission_denied');

    const unjudged = gate({
      tools: [
        judgedTool(async () => {
          throw new Error('no such session');
        }),
      ],
      configure: withRules({ deny: ['Judged'] }),
    });
    expect(codeOf(await unjudged.prepare('Judged', { to: 'x' }))).toBe('permission_denied');
  });

  it('tool_not_active speaks before a failed canonicalization', async () => {
    const tool = judgedTool(async () => {
      throw new Error('no such session');
    });
    const { prepare } = gate({ tools: [tool], allowedTools: ['Read'] });

    expect(codeOf(await prepare('Judged', { to: 'x' }))).toBe('tool_not_active');
  });

  it('a widened session rule does not skip an ask rule, and the exact rule does', async () => {
    const { prepare, run, onPermissionRequired } = gate({
      configure: withRules({ ask: ['Bash(git push *)'] }),
      answer: 'deny',
    });
    run.approveAllRules.push('Bash(git *)', 'Bash');

    expect(codeOf(await prepare('Bash', { command: 'git push origin' }))).toBe('permission_denied');
    expect(onPermissionRequired).toHaveBeenCalledOnce();

    run.approveAllRules.push('Bash(git push origin)');
    entryOf(await prepare('Bash', { command: 'git push origin' }));
    expect(onPermissionRequired).toHaveBeenCalledOnce();
  });

  it('a session rule still answers a call no ask rule matched', async () => {
    const { prepare, run, onPermissionRequired } = gate({
      configure: withRules({ ask: ['Bash(git push *)'] }),
    });
    run.approveAllRules.push('Bash(git *)');

    entryOf(await prepare('Bash', { command: 'git status' }));
    expect(onPermissionRequired).not.toHaveBeenCalled();
  });
});

describe('prepareToolCall: the mode', () => {
  it('asks for the host to be read twice per call: first, and again after the hooks', async () => {
    const { prepare, sync } = gate({ mode: 'auto' });
    let syncsBeforeHook = -1;
    vi.mocked(runHooks).mockImplementationOnce(async () => {
      syncsBeforeHook = sync.mock.calls.length;
      return [];
    });

    entryOf(await prepare('Bash', { command: 'ls' }));

    expect(syncsBeforeHook).toBe(1);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('a mode entered during a PreToolUse hook is the one the plan gate sees', async () => {
    const { prepare, host, run, onPermissionRequired } = gate();
    vi.mocked(runHooks).mockImplementationOnce(async () => {
      host.mode = 'plan';
      return [];
    });

    const refusal = refusalOf(await prepare('Write', { filePath: 'a.txt', content: 'x' }));

    expect(refusal.structuredError?.code).toBe('plan_mode_blocked');
    expect(onPermissionRequired).not.toHaveBeenCalled();
    expect(run.mode.current()).toBe('plan');
    expect(run.toolContext.currentMode).toBe('plan');
  });

  // Only the gates that read the mode after the hooks: `modeRefusesItself` keeps the first read (#730).
  it('a mode left during a PreToolUse hook is the one the prompt sees', async () => {
    const { prepare, host, onPermissionRequired } = gate({ mode: 'plan' });
    vi.mocked(runHooks).mockImplementationOnce(async () => {
      host.mode = 'default';
      return [];
    });

    const entry = entryOf(await prepare('Write', { filePath: 'a.txt', content: 'x' }));

    expect(onPermissionRequired).toHaveBeenCalledOnce();
    expect(entry.modeAtPreparation).toBe('default');
  });

  it('a mode changed before the call is the one the first gates see', async () => {
    const { prepare, host, onPermissionRequired } = gate();
    host.mode = 'plan';

    // Invalid arguments, but plan mode refuses the tool itself, so the registry does not speak.
    expect(codeOf(await prepare('Write', {}))).toBe('plan_mode_blocked');
    expect(onPermissionRequired).not.toHaveBeenCalled();
  });
});

describe('prepareToolCall: a prepared call', () => {
  it('a serial call runs on the shared context, and sets its trace and subject there', async () => {
    const subject = { args: { to: 'x' }, allow: ['x'], restrict: ['x'] };
    const { prepare, run } = gate({
      mode: 'bypassPermissions',
      tools: [judgedTool(async () => subject)],
    });

    const entry = entryOf(await prepare('Judged', { to: 'x' }, { nestedTraceId: 'trace-1' }));

    expect(entry.context).toBe(run.toolContext);
    expect(run.toolContext.currentToolTraceId).toBe('trace-1');
    expect(run.toolContext.permissionSubject).toBe(subject);
    expect(entry).toMatchObject({
      index: 0,
      canonName: 'Judged',
      nestedTraceId: 'trace-1',
      parallel: false,
      modeAtPreparation: 'bypassPermissions',
      permissionSubject: subject,
    });
  });

  it("one serial call's subject does not reach the next", async () => {
    const subject = { args: { to: 'x' }, allow: ['x'], restrict: ['x'] };
    const { prepare, run } = gate({
      mode: 'bypassPermissions',
      tools: [judgedTool(async () => subject)],
    });

    entryOf(await prepare('Judged', { to: 'x' }));
    entryOf(await prepare('Bash', { command: 'ls' }));

    expect(run.toolContext.permissionSubject).toBeUndefined();
    expect(run.toolContext.currentToolTraceId).toBe('c1');
  });

  it('a parallel call gets its own copy, and the shared context is left alone', async () => {
    const { prepare, run } = gate();
    run.toolContext.todos = [];
    run.toolContext.tasks = [];
    run.toolContext.agentPath = ['root'];

    const entry = entryOf(await prepare('Glob', { pattern: '*.ts' }, { parallel: true }));

    expect(entry.context).not.toBe(run.toolContext);
    expect(entry.parallel).toBe(true);
    expect(entry.context.currentToolTraceId).toBe('c1');
    expect(entry.context.todos).not.toBe(run.toolContext.todos);
    expect(entry.context.tasks).not.toBe(run.toolContext.tasks);
    expect(entry.context.agentPath).not.toBe(run.toolContext.agentPath);
    expect(run.toolContext.currentToolTraceId).toBeUndefined();
  });
});

describe('finalizeToolCall: a clipped output', () => {
  it('goes into the roots the gate reads, so the next Read of its file is served', async () => {
    const { prepare, run, onPermissionRequired } = gate();
    run.toolOutputRoot = outside;
    const entry = entryOf(await prepare('Glob', { pattern: '*.ts' }, { parallel: true }));

    const result = await finalizeToolCall(run, entry, toolSuccess('x'.repeat(2_000_000)));

    const clipped = result.artifacts?.outputPath;
    expect(clipped).toBeDefined();
    expect(run.toolContext.readOnlyRoots).toContain(clipped);
    expect(run.runtime.clippedOutputPaths.has(clipped!)).toBe(true);
    entryOf(await prepare('Read', { filePath: clipped }));
    expect(onPermissionRequired).not.toHaveBeenCalled();
  });
});

describe("the loop's mode sync, through runAgentLoop", () => {
  /** Runs `act` as the PreToolUse hooks run, the window a user's Shift+Tab can land in. */
  function duringPreToolUse(act: () => void): void {
    vi.mocked(runHooks).mockImplementation(async (...args) => {
      if (args[1] === 'PreToolUse') act();
      return realHooks.runHooks(...args);
    });
  }

  /** One call through the real loop. `Observed` reports the modes its context carried. */
  async function drive(options: {
    mode: PermissionMode;
    call: { name: string; arguments: Record<string, unknown> };
    getMode?: () => PermissionMode;
    peerTurnClass?: PeerPermissionClass;
  }) {
    const seen: Array<Pick<ToolContext, 'currentMode' | 'hostMode'>> = [];
    const registry = createDefaultRegistry();
    registry.register({
      name: 'Observed',
      description: 'Reports the modes its context carries',
      parameters: { type: 'object', properties: {} },
      execute: async (_args, context) => {
        seen.push({ currentMode: context.currentMode, hostMode: context.hostMode });
        return toolSuccess('ran');
      },
    });
    let turn = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        if (turn++ === 0) {
          yield { type: 'tool_call' as const, toolCall: { id: 'c1', ...options.call } };
        } else {
          yield { type: 'text' as const, content: 'done' };
        }
        yield { type: 'done' as const };
      },
    };
    const results: ToolResult[] = [];
    const onPermissionRequired = vi.fn(async () => 'allow' as const);
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
        onPermissionRequired,
        getMode: options.getMode,
      },
      options.mode,
      { provider, peerTurnClass: options.peerTurnClass },
    );
    return { seen, onPermissionRequired, result: results[0] };
  }

  const observed = { name: 'Observed', arguments: {} };

  it('a mode entered during a PreToolUse hook reaches the gates', async () => {
    let hostMode: PermissionMode = 'default';
    duringPreToolUse(() => {
      hostMode = 'plan';
    });

    const { result, seen, onPermissionRequired } = await drive({
      mode: 'default',
      getMode: () => hostMode,
      call: observed,
    });

    expect(result.structuredError?.code).toBe('plan_mode_blocked');
    expect(seen).toEqual([]);
    expect(onPermissionRequired).not.toHaveBeenCalled();
  });

  it('a mode left during a PreToolUse hook reaches the gates and the tool', async () => {
    let hostMode: PermissionMode = 'plan';
    duringPreToolUse(() => {
      hostMode = 'bypassPermissions';
    });

    const { seen, onPermissionRequired } = await drive({
      mode: 'plan',
      getMode: () => hostMode,
      call: observed,
    });

    expect(seen).toEqual([{ currentMode: 'bypassPermissions', hostMode: 'bypassPermissions' }]);
    expect(onPermissionRequired).not.toHaveBeenCalled();
  });

  it('a host with no getMode leaves the mode the run started in', async () => {
    const { seen } = await drive({ mode: 'bypassPermissions', call: observed });

    expect(seen).toEqual([{ currentMode: 'bypassPermissions', hostMode: undefined }]);
  });

  it("a prompting-class peer turn's pin holds when the host goes to bypass, which it reports", async () => {
    let hostMode: PermissionMode = 'default';
    duringPreToolUse(() => {
      hostMode = 'bypassPermissions';
    });

    const { seen, onPermissionRequired } = await drive({
      mode: 'default',
      getMode: () => hostMode,
      peerTurnClass: 'prompting',
      call: observed,
    });

    expect(onPermissionRequired).toHaveBeenCalledOnce();
    expect(seen).toEqual([{ currentMode: 'default', hostMode: 'bypassPermissions' }]);
  });

  it('a bypass-class peer turn takes the host at its word', async () => {
    let hostMode: PermissionMode = 'default';
    duringPreToolUse(() => {
      hostMode = 'bypassPermissions';
    });

    const { seen, onPermissionRequired } = await drive({
      mode: 'default',
      getMode: () => hostMode,
      peerTurnClass: 'bypass',
      call: observed,
    });

    expect(onPermissionRequired).not.toHaveBeenCalled();
    expect(seen).toEqual([{ currentMode: 'bypassPermissions', hostMode: 'bypassPermissions' }]);
  });
});
