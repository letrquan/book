/**
 * The life of one tool call inside a run: `prepareToolCall` decides whether it runs (hooks, deny
 * rules, modes, prompts, skill consent), `executeToolCall` runs it, and `finalizeToolCall` settles
 * what it reported. Nothing here closes over the loop: what lasts the run comes in as
 * `ToolCallRun`, what belongs to the call as `ToolCallRequest`.
 *
 * The order of the gates in `prepareToolCall` is the contract, and `tool-call-lifecycle.test.ts`
 * pins it. A gate moved up or down changes who is asked what: a hook that judges a call the registry
 * would refuse, or a prompt raised for a call a deny rule already answers.
 */
import { createHash } from 'node:crypto';
import type { Clock } from '../clock.js';
import { onAbort as listenForAbort } from '../async.js';
import { createDebugLogger } from '../debug-log.js';
import { runHooks } from '../hooks.js';
import {
  ALWAYS_ALLOWED_TOOLS,
  evaluatePermissionDetail,
  missingRuleReason,
  permissionReasonOf,
  permissionResultOf,
  permissionRuleForToolCall,
  permissionRuleMatchesCall,
  permissionRuleOf,
  WORKSPACE_READ_JUDGING_MODES,
  WORKSPACE_READ_REFUSAL_MODES,
  WORKSPACE_READ_TOOLS,
} from '../permissions.js';
import { redactToolResultSecrets } from '../provider-secrets.js';
import type { SessionRuntime } from '../session/runtime.js';
import type { SkillRegistry } from '../skill-registry.js';
import { canonicalToolName } from '../tools/aliases.js';
import {
  formatUserQuestionAnswers,
  validateUserQuestionResponse,
} from '../tools/ask-user-question.js';
import { PLAN_PERMISSION_REQUIRED_TOOLS, READ_ONLY_PLAN_TOOLS } from '../tools/plan-mode.js';
import type { PreparedToolCall, ToolRegistry } from '../tools/registry.js';
import {
  boundToolResultOutput,
  enrichToolResultPresentation,
  replaceToolResult,
  toolFailure,
  toolResultErrorMessage,
  toolResultSucceeded,
} from '../tools/result.js';
import { isFileMutatingTool } from '../tools/tool-capabilities.js';
import type { PeerAwarenessHandle, PeerPermissionClass } from '../types/messaging.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type { AgentConfig, PermissionMode } from '../types/runtime.js';
import type {
  PermissionSubject,
  ToolCall,
  ToolContext,
  ToolDiscoveryContext,
  ToolResult,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../types/tools.js';
import {
  permissionDeniedError,
  type PermissionDenialCause,
  type UnattendedRemedy,
} from './actionable-errors.js';
import type { ExplorationRoutingTracker } from './exploration-routing.js';
import { invalidPatternRefusal, outsideWorkspaceRefusal } from './refusal-remedies.js';

const log = createDebugLogger('agent');
export const SKILL_INFRASTRUCTURE_TOOLS = new Set([
  'InvokeSkill',
  'ReadSkillResource',
  'ToolSearch',
]);

/**
 * Check whether a tool call should be evaluated against permission rules,
 * based solely on the current mode. When false, the tool runs without
 * any permission gate (e.g. auto / bypassPermissions).
 */
export function needsPermissionCheck(mode: string): boolean {
  if (mode === 'auto' || mode === 'bypassPermissions') return false;
  return true; // all other modes (default, accept-edits, plan, dontAsk) check rules
}

/** Why a peer turn's EnterPlanMode or ExitPlanMode is refused (#620). */
export const PEER_TURN_MODE_REFUSAL =
  "a turn from another session cannot change this session's mode; ask your user";

/** The managed-agent tools that start or steer an agent, which a prompting-class peer turn may not call. */
const PEER_TURN_AGENT_TOOLS: ReadonlySet<string> = new Set([
  'AgentSpawn',
  'AgentPlan',
  'AgentSend',
]);

/**
 * The managed-agent tools that act on an existing agent — most likely the user's — which a peer
 * turn's call asks for in every mode (#620). A prompting-class turn's AgentSend is refused first.
 */
const PEER_TURN_ASK_TOOLS: ReadonlySet<string> = new Set(['AgentStop', 'AgentApply', 'AgentSend']);

/** Why a prompting-class peer turn's AgentSpawn, AgentPlan or AgentSend is refused (#620). */
export const PEER_TURN_AGENT_REFUSAL =
  "a turn from another session cannot start or steer managed agents, which run at this session's own mode; ask your user";

export function requiresToolPermission(mode: string, persistentBackgroundShell: boolean): boolean {
  return needsPermissionCheck(mode) || (persistentBackgroundShell && mode !== 'bypassPermissions');
}

/**
 * The run's permission mode, which stays in `runAgentLoop`. Every read goes through `current()`,
 * because a mode read earlier may be out of date by the next gate. `sync()` reads the host's mode
 * again, and `prepareToolCall` calls it at exactly two points: syncing more or less often changes
 * which mode a gate sees.
 */
export interface ToolCallMode {
  current(): PermissionMode;
  sync(): void;
  set(mode: PermissionMode): void;
}

/** What `finalizeToolCall` asks of the run, which ends it once the wave has settled. */
export interface ToolCallPlanState {
  /** Set when the user approves a plan with fresh context; ends the turn so the host can reseed. */
  handoffRequested: { plan: string; mode: PermissionMode } | null;
  /**
   * Set when the host cannot approve a plan at all (no approver in a
   * non-interactive host). The plan is the deliverable, so the run ends here
   * instead of burning the remaining turns on ExitPlanMode retries.
   */
  planStopRequested: { plan: string; message: string } | null;
}

/** What lasts the run. `approveAllRules` is the loop's own array, and grows here. */
export interface ToolCallRun {
  config: AgentConfig;
  registry: ToolRegistry;
  callbacks: AgentLoopCallbacks;
  signal?: AbortSignal;
  toolContext: ToolContext;
  toolSurface: ToolDiscoveryContext;
  skillRegistry: SkillRegistry;
  approveAllRules: string[];
  runtime: SessionRuntime;
  clock: Clock;
  explorationRouting: ExplorationRoutingTracker;
  /**
   * The array behind `toolContext.readOnlyRoots`, which is typed read-only there. It must be that
   * same array: `finalizeToolCall` adds a clipped output's file here, and the gate and the file
   * tools read `toolContext.readOnlyRoots`, so a copy would have the next Read of that file refused.
   */
  readOnlyRoots: string[];
  additionalRoots: string[];
  homeGuardPaths: string[];
  workspaceRealRoot: string;
  workspaceHoldsHome: boolean;
  mode: ToolCallMode;
  planState: ToolCallPlanState;
  noteChildRefusal: (toolName: string, message: string) => void;
  noteUnattendedRefusal: (toolName: string, remedy: UnattendedRemedy) => void;
  peerTurnClass?: PeerPermissionClass;
  isSubagent?: boolean;
  peerAwareness?: PeerAwarenessHandle;
  toolOutputRoot?: string;
}

/** What belongs to the one call. */
export interface ToolCallRequest {
  index: number;
  turn: number;
  call: ToolCall;
  parallel: boolean;
  nestedTraceId?: string;
}

export type PreparedLoopCall = {
  index: number;
  call: ToolCall;
  canonName: string;
  nestedTraceId?: string;
  prepared: PreparedToolCall;
  context: ToolContext;
  /** What the permission check judged the call by, when its tool canonicalized it (#653). */
  permissionSubject?: PermissionSubject;
  parallel: boolean;
  modeAtPreparation: PermissionMode;
  previousModeAtPreparation: PermissionMode | undefined;
  pendingPlanApprovalAtPreparation: ToolContext['pendingPlanApproval'];
  pendingUserQuestionAtPreparation: ToolContext['pendingUserQuestion'];
};

/** A refusal is the call's result, which the loop stores; a prepared call goes on to run. */
export type PrepareToolCallOutcome =
  { status: 'refused'; result: ToolResult } | { status: 'prepared'; entry: PreparedLoopCall };

/** A call that never started, settled the way any abort settles one. */
export function cancelledBeforeStart(call: ToolCall): ToolResult {
  return toolFailure('CANCELLED: Agent execution was interrupted', {
    toolCallId: call.id,
    code: 'cancelled_before_start',
    status: 'cancelled',
  });
}

export async function prepareToolCall(
  run: ToolCallRun,
  request: ToolCallRequest,
): Promise<PrepareToolCallOutcome> {
  const {
    config,
    registry,
    callbacks,
    signal,
    toolContext,
    toolSurface,
    skillRegistry,
    approveAllRules,
    additionalRoots,
    homeGuardPaths,
    workspaceRealRoot,
    workspaceHoldsHome,
    mode,
    noteChildRefusal,
    noteUnattendedRefusal,
    peerTurnClass,
  } = run;
  const { index, turn, call, parallel, nestedTraceId } = request;
  if (signal?.aborted) {
    return { status: 'refused', result: cancelledBeforeStart(call) };
  }

  // A call that can never run however it is approved — an unknown tool, arguments that
  // never parsed, or arguments that fail the tool's schema — is refused before PreToolUse
  // hooks and the permission check see it, so a hook never judges it and the user is never
  // asked to approve one (an 'Always' on a Bash call with no command would save a bare
  // `Bash` rule). A tool that is merely not active, or active but refused on its
  // arguments, is refused just before the permission prompt instead, once the
  // mode-specific refusals below have named their mode.
  mode.sync();
  const registeredTool = registry.getTool(call.name);
  const canonName = canonicalToolName(registeredTool?.name ?? call.name);
  // Plan mode hides its mutating tools and dontAsk its question tool, and each refuses them
  // below with a message that names the mode. "Not active; call ToolSearch" would send the
  // model after a tool no search can activate, so those calls are left to the mode — but
  // only a registered tool is the mode's to hide; an unknown one is `unknown_tool`, not a
  // plan refusal.
  // A turn another session's message started, or one carrying its work on, never changes
  // this session's permission mode (#620): entering or leaving plan mode is the user's.
  if (
    peerTurnClass !== undefined &&
    (canonName === 'EnterPlanMode' || canonName === 'ExitPlanMode')
  ) {
    return {
      status: 'refused',
      result: toolFailure(`SKIPPED: ${PEER_TURN_MODE_REFUSAL}`, {
        toolCallId: call.id,
        code: 'peer_turn_mode_change',
        status: 'blocked',
      }),
    };
  }
  // Nor does a prompting-class one start or steer a managed agent: an agent outlives the
  // turn and runs at the session's own mode, which the pin does not reach (#620).
  if (peerTurnClass === 'prompting' && PEER_TURN_AGENT_TOOLS.has(canonName)) {
    return {
      status: 'refused',
      result: toolFailure(`SKIPPED: ${PEER_TURN_AGENT_REFUSAL}`, {
        toolCallId: call.id,
        code: 'peer_turn_agents',
        status: 'blocked',
      }),
    };
  }
  const modeRefusesItself =
    registeredTool !== undefined &&
    ((mode.current() === 'plan' && !READ_ONLY_PLAN_TOOLS.has(canonName)) ||
      (mode.current() === 'dontAsk' && canonName === 'AskUserQuestion'));
  const unrunnable = modeRefusesItself ? undefined : registry.rejectBeforeGates(call, toolContext);
  if (unrunnable) {
    return { status: 'refused', result: unrunnable };
  }

  // A tool whose primary argument can spell one target several ways is judged by the target
  // the call reaches, not by how it was typed (#653): `SessionSend` by the session its `to`
  // resolves to now. Hook matchers and deny and ask rules match every spelling of it, allow
  // rules and session approvals the spellings that name it alone, and the prompt and "Always
  // allow" see the canonical one. The tool is handed the subject back when the call runs, so
  // it acts on the target that was judged, or on nothing. Not asked for a call the mode
  // refuses anyway, and a failure is reported only once the tool's own refusals have spoken.
  let permissionSubject: PermissionSubject | undefined;
  let permissionSubjectFailure: string | undefined;
  if (registeredTool?.canonicalizeForPermission && !modeRefusesItself) {
    const tool = registeredTool;
    const cancelled = Symbol('cancelled');
    try {
      const judged = await new Promise<PermissionSubject | undefined | typeof cancelled>(
        (resolve, reject) => {
          const stopListening = listenForAbort(signal, () => resolve(cancelled));
          Promise.resolve()
            .then(() => tool.canonicalizeForPermission?.(call.arguments, toolContext))
            .then(resolve, reject)
            .finally(stopListening);
        },
      );
      if (judged === cancelled) {
        return { status: 'refused', result: cancelledBeforeStart(call) };
      }
      permissionSubject = judged;
    } catch (error) {
      permissionSubjectFailure = error instanceof Error ? error.message : String(error);
    }
  }
  const judgedCall: ToolCall = permissionSubject
    ? { ...call, arguments: permissionSubject.args }
    : call;

  let preHookResults: Awaited<ReturnType<typeof runHooks>>;
  try {
    preHookResults = await runHooks(
      config.settings.hooks.PreToolUse,
      'PreToolUse',
      {
        workspace: config.workspace,
        event: 'PreToolUse',
        toolName: canonName,
        toolArgs: call.arguments,
        shell: toolContext.shell ?? config.shell,
        ...(permissionSubject ? { toolTargets: permissionSubject.restrict } : {}),
      },
      { onHookEvent: callbacks.onHookEvent, signal },
    );
  } catch (error) {
    // A cancel under the hook rejects with the abort reason (#698); the call never started.
    if (!signal?.aborted) throw error;
    return { status: 'refused', result: cancelledBeforeStart(call) };
  }
  const blocked = preHookResults.find((result) => result.action === 'block');
  if (blocked) {
    return {
      status: 'refused',
      result: toolFailure(
        `SKIPPED: Blocked by hook${blocked.message ? `: ${blocked.message}` : ''}`,
        { toolCallId: call.id, code: 'hook_blocked', status: 'blocked' },
      ),
    };
  }

  mode.sync();
  const planReadOnly = mode.current() === 'plan' && READ_ONLY_PLAN_TOOLS.has(canonName);
  const planAutoApproved = planReadOnly && !PLAN_PERMISSION_REQUIRED_TOOLS.has(canonName);
  const isUserQuestion = canonName === 'AskUserQuestion';
  const managedLifecycle = canonName.startsWith('Agent') && canonName !== 'AgentApply';
  const invokedSkillName =
    canonName === 'InvokeSkill' && typeof call.arguments.skill === 'string'
      ? call.arguments.skill
      : undefined;
  const skillActivationReason = invokedSkillName
    ? skillRegistry.isExplicitlyRequested(invokedSkillName)
      ? 'user'
      : 'model'
    : undefined;
  const skillActivationPolicy = invokedSkillName
    ? skillRegistry.activationPolicy(invokedSkillName, skillActivationReason)
    : undefined;
  if (skillActivationPolicy === 'deny') {
    const message = `Skill activation is denied: ${invokedSkillName}`;
    skillRegistry.recordActivationBlocked(
      invokedSkillName!,
      skillRegistry.isExplicitlyRequested(invokedSkillName!) ? 'user' : 'model',
      'skill_execution_denied',
      message,
    );
    return {
      status: 'refused',
      result: toolFailure(`SKIPPED: ${message}`, {
        toolCallId: call.id,
        code: 'skill_execution_denied',
        status: 'blocked',
      }),
    };
  }
  const invokedSkill = invokedSkillName ? skillRegistry.get(invokedSkillName) : undefined;
  if (
    invokedSkillName &&
    invokedSkill?.allowedTools?.length &&
    !skillRegistry.isActive(invokedSkillName, turn)
  ) {
    const restriction = [
      ...new Set([...invokedSkill.allowedTools, 'InvokeSkill', 'ReadSkillResource']),
    ];
    const effectiveTools = toolSurface
      .previewRestriction(restriction)
      .map((definition) => canonicalToolName(definition.name))
      .filter((name) => !SKILL_INFRASTRUCTURE_TOOLS.has(name));
    if (effectiveTools.length === 0) {
      const message = `Skill "${invokedSkillName}" conflicts with the active tool ceiling; no task tools would remain.`;
      skillRegistry.recordActivationBlocked(
        invokedSkillName,
        skillActivationReason ?? 'model',
        'skill_tool_intersection_empty',
        message,
      );
      return {
        status: 'refused',
        result: toolFailure(`SKIPPED: ${message}`, {
          toolCallId: call.id,
          code: 'skill_tool_intersection_empty',
          status: 'blocked',
          remediation: 'Finish the active skill or choose skills with compatible allowed-tools.',
        }),
      };
    }
  }
  const forceSkillPermission = Boolean(
    invokedSkillName &&
    skillActivationPolicy === 'ask' &&
    !skillRegistry.isActive(invokedSkillName, turn),
  );
  if (forceSkillPermission && invokedSkillName && skillActivationReason) {
    skillRegistry.requestConsent(invokedSkillName, skillActivationReason);
  }
  const persistentBackgroundShell =
    canonName === 'Bash' &&
    call.arguments.run_in_background === true &&
    call.arguments.lifetime === 'persistent';
  const autoSafeTool =
    canonName === 'EnterPlanMode' ||
    canonName === 'ToolSearch' ||
    planAutoApproved ||
    isUserQuestion ||
    managedLifecycle;

  if (isUserQuestion && mode.current() === 'dontAsk') {
    return {
      status: 'refused',
      result: toolFailure('SKIPPED: User questions are disabled in dontAsk mode', {
        toolCallId: call.id,
        code: 'user_questions_disabled',
        status: 'blocked',
      }),
    };
  }

  // A `permissions.deny` rule is the one decision no mode may relax, so it
  // is evaluated before anything else and for every tool.
  //
  // This check used to be scoped to `isFileMutatingTool`, which left every
  // other tool unprotected in the two modes that skip the permission block
  // below (`auto` and `bypassPermissions`): `deny: ["Bash(rm *)"]` — the
  // example in the README — matched nothing under `--permission-mode auto`,
  // while `deny: ["Write(.env)"]` in the same list held. Modes decide
  // whether the user is *asked*; they do not decide whether a rule the user
  // already wrote applies.
  const judgeReads = WORKSPACE_READ_JUDGING_MODES.has(mode.current());
  // The session shell, read the way the Bash tool reads it (`sessionShell` in
  // `tools/shell.ts`): the same (platform, shell) pair goes to every gate below, so what
  // the permission check and the capability check call compound agree (#512).
  const scanShell = toolContext.shell ?? config.shell;
  const verdict = evaluatePermissionDetail(canonName, judgedCall.arguments, config.settings, {
    platform: process.platform,
    shell: scanShell,
    ...(permissionSubject ? { subject: permissionSubject } : {}),
    workspace: {
      root: toolContext.workspaceRoot,
      realRoot: workspaceRealRoot,
      readOnlyRoots: toolContext.readOnlyRoots,
      memorySearchRoot: toolContext.memorySearchRoot,
      additionalRoots,
      memoryWrite: toolContext.memoryWrite,
      // A home directory, or anything containing one, keeps the prompt even where it was
      // honored: that is the whole of what `additionalDirectories` widens, and a home holds
      // SSH and provider keys and Book's own trust store.
      homeGuards: homeGuardPaths,
      judgeReads,
      autoAllowReads: judgeReads && !workspaceHoldsHome,
      // Wider than `judgeReads`: `dontAsk` prompts for nothing, so a target no root serves
      // is refused there anyway, and refusing it as the target it is gives the model the
      // directory that would serve it instead of a permission no rule can grant.
      refuseUnreachableReads: WORKSPACE_READ_REFUSAL_MODES.has(mode.current()),
    },
  });
  if (verdict.decision === 'deny') {
    // Consent was requested a few lines up; close it out, or the registry
    // keeps an activation request that never resolves. The later
    // permission-block deny does the same.
    if (forceSkillPermission && invokedSkillName && skillActivationReason) {
      skillRegistry.denyConsent(invokedSkillName, skillActivationReason, 'permission_denied');
    }
    return {
      status: 'refused',
      result: toolFailure('SKIPPED: Permission denied', {
        toolCallId: call.id,
        code: 'permission_denied',
        status: 'blocked',
        content: permissionDeniedError(canonName, { kind: 'rule', rule: verdict.matchedRule }),
      }),
    };
  }

  // A Read, Glob or Grep the tool itself refuses (outside the workspace and every honored
  // root) is not a permission question: no rule and no
  // mode make the file tools serve it, so no prompt is raised and no "Always allow" rule is
  // written for a call that could never work. The model gets a blocked result naming the
  // remedy instead (#305 item 3).
  if (verdict.decision === 'refuse') {
    if (forceSkillPermission && invokedSkillName && skillActivationReason) {
      skillRegistry.denyConsent(invokedSkillName, skillActivationReason, 'permission_denied');
    }
    log.debug('refused a read the tool cannot serve', { tool: canonName });
    // Two refusals, two messages: an unservable path is fixed by adding its directory, and a
    // pattern the matcher cannot read is fixed by writing another pattern — naming a
    // directory for the second would be a dead end.
    const refusal =
      verdict.unreadablePattern !== undefined
        ? invalidPatternRefusal(canonName, call, verdict.unreadablePattern, {
            toolCallId: call.id,
          })
        : outsideWorkspaceRefusal(canonName, call, {
            toolCallId: call.id,
            additionalRoots,
          });
    noteChildRefusal(canonName, refusal.content);
    return { status: 'refused', result: refusal };
  }

  // A tool this turn does not expose, or an active tool whose arguments this run's
  // allowed-tools rules do not cover, can never run, so the user is not asked to approve it
  // (an 'Always' would save a rule for it). Plan mode hides its mutating tools too, and its
  // own refusal below names the mode, which "call ToolSearch" would not.
  if (!modeRefusesItself) {
    const inactive = registry.rejectBeforePrompt(call, toolContext);
    if (inactive) {
      if (forceSkillPermission && invokedSkillName && skillActivationReason) {
        skillRegistry.denyConsent(invokedSkillName, skillActivationReason, 'tool_not_active');
      }
      return { status: 'refused', result: inactive };
    }
  }

  // A call its tool could not judge, or judged as one that can never run (a `SessionSend` to
  // no live session), is refused here: once the deny rules and the tool's own refusals have
  // spoken, and before any prompt, so nothing is approved or saved for it (#653).
  const unjudgeable =
    permissionSubjectFailure !== undefined
      ? toolFailure(
          `SKIPPED: ${canonName} could not be checked for permission: ${permissionSubjectFailure}`,
          { toolCallId: call.id, code: 'permission_check_failed', status: 'error' },
        )
      : permissionSubject?.refusal && { ...permissionSubject.refusal, toolCallId: call.id };
  if (unjudgeable) {
    if (forceSkillPermission && invokedSkillName && skillActivationReason) {
      skillRegistry.denyConsent(invokedSkillName, skillActivationReason, 'permission_denied');
    }
    return { status: 'refused', result: unjudgeable };
  }

  // A compound Bash command under a Bash deny or ask rule asks in every mode but
  // `bypassPermissions`, `auto` included, exactly as a persistent background shell does; so
  // does any call, of any tool, that an `ask` rule the user wrote matched (#527). Both are
  // OR-ed into the same condition, not into `persistentBackgroundShell` itself: that one
  // also turns off the approve-all check below, and a session rule must still admit what it
  // covers. Where nothing can answer the prompt the call is refused, and the remedy names
  // the ask rule.
  const compoundUnderPolicy = verdict.compoundUnderPolicy === true;
  const askRuleMatched = verdict.decision === 'ask' && verdict.source === 'ask';
  const toolPermissionRequired = requiresToolPermission(
    mode.current(),
    persistentBackgroundShell || compoundUnderPolicy || askRuleMatched,
  );
  const userRuleAsked = toolPermissionRequired && askRuleMatched;
  // A guarded read is not auto-safe in plan mode (decision C, PR #334 finding 5). The
  // verdict is `ask` for exactly the targets that keep asking in `default` — a local
  // settings file, a home the serving root holds, a search scope that reaches one — and
  // `planAutoApproved` bypassed the prompt for every read-only tool, so those ran in a plan
  // with no prompt at all. Keyed on the verdict, not on the tool, so an unguarded workspace
  // read still runs unprompted, which is what plan mode is for.
  //
  // Restricted to the tools that read the filesystem. `READ_ONLY_PLAN_TOOLS` also holds the
  // plan-control and session tools, whose verdict is `ask` for an unrelated reason: a
  // prompt for `ExitPlanMode` with no approver is "stop with the plan", which the loop
  // already implements, and treating it as a guarded read turned one turn into five.
  const guardedReadInPlan =
    planAutoApproved && WORKSPACE_READ_TOOLS.has(canonName) && verdict.decision === 'ask';

  // The rule that remembers exactly this call, if it has one: for a canonicalized call, the
  // rule for its canonical spelling.
  const ownRule = permissionRuleForToolCall(judgedCall);
  // A session approve-all rule is an allow rule. For a call an `ask` rule matched, which
  // outranks every allow rule, and for a compound command under a Bash policy, which no glob
  // can read, only the call's own exact rule vouches for it: a widened rung (`Bash(git *)`,
  // `Write(secrets/*)`) or a bare tool rule must not skip the prompt (review of #531).
  const exactSessionRuleOnly = compoundUnderPolicy || askRuleMatched;
  // A peer turn's call that stops, steers or applies a managed agent asks in every mode,
  // bypass included, past any rule: the agent is the user's, not the peer's (#620).
  const peerMustAsk = peerTurnClass !== undefined && PEER_TURN_ASK_TOOLS.has(canonName);
  if (
    (forceSkillPermission || toolPermissionRequired || peerMustAsk) &&
    (persistentBackgroundShell ||
      peerMustAsk ||
      !approveAllRules.some(
        (rule) =>
          (!exactSessionRuleOnly || rule === ownRule) &&
          permissionRuleMatchesCall(
            rule,
            judgedCall,
            process.platform,
            scanShell,
            permissionSubject,
          ),
      )) &&
    (!autoSafeTool || userRuleAsked || guardedReadInPlan || peerMustAsk) &&
    (mode.current() !== 'plan' || planReadOnly)
  ) {
    const autoApproved = mode.current() === 'accept-edits' && isFileMutatingTool(canonName);
    if (!autoApproved || userRuleAsked) {
      let permission: 'allow' | 'deny' | 'always' | undefined;
      let chosenRule: string | undefined;
      let noApprover = false;
      let dismissed = false;
      // A tool on the always-allowed list is never prompted for in any
      // mode, so `dontAsk` — which refuses what it cannot ask about —
      // has nothing to refuse. A `deny` rule already returned above, and
      // an `ask` rule still lands on the deny below rather than a prompt.
      // A write into the memory directory is allowed the same way (`source: 'memory'`).
      const autoAllowed = ALWAYS_ALLOWED_TOOLS.has(canonName) || verdict.source === 'memory';
      if (
        !userRuleAsked &&
        !peerMustAsk &&
        (forceSkillPermission || mode.current() !== 'dontAsk' || autoAllowed) &&
        !persistentBackgroundShell
      ) {
        if (verdict.decision === 'allow') permission = 'allow';
      }
      if (permission === undefined && mode.current() !== 'dontAsk') {
        // The prompt names the target as the rules judged it, and its "Always allow" saves
        // the rule for that spelling.
        const decision = await callbacks.onPermissionRequired(judgedCall);
        permission = permissionResultOf(decision);
        chosenRule = permissionRuleOf(decision);
        const reason = permissionReasonOf(decision);
        noApprover = reason === 'no_approver';
        dismissed = reason === 'dismissed';
      }
      permission ??= 'deny';

      if (permission === 'deny') {
        log.debug('permission denied', { tool: canonName });
        if (forceSkillPermission && invokedSkillName && skillActivationReason) {
          skillRegistry.denyConsent(
            invokedSkillName,
            skillActivationReason,
            mode.current() === 'dontAsk'
              ? 'dont_ask'
              : noApprover
                ? 'no_approver'
                : dismissed
                  ? 'dismissed'
                  : 'user_denied',
          );
        }
        const askRule = verdict.source === 'ask' ? verdict.matchedRule : undefined;
        // The rule the operator is told to add. A bare tool name allows every call of the
        // tool, so it is named only for a call with no argument to scope a rule to. A call
        // that has one but no rule of its own (a Bash command that spans lines or holds `*`,
        // #521; an argument holding `*` or `?`) gets no rule, and the remedy says why.
        const noRule = missingRuleReason(judgedCall);
        const remedyRule = ownRule ?? (canonName === 'Bash' || noRule ? undefined : canonName);
        // What would actually let this call through if nobody could approve it. An
        // outside target comes first: no rule or mode makes the tool serve it.
        const remedy: UnattendedRemedy = persistentBackgroundShell
          ? { kind: 'bypass_only' }
          : verdict.outsideWorkspace
            ? { kind: 'outside_workspace' }
            : compoundUnderPolicy
              ? {
                  kind: 'compound_under_policy',
                  rule: remedyRule,
                  askRule,
                }
              : askRule
                ? { kind: 'ask_rule', rule: askRule }
                : forceSkillPermission
                  ? { kind: 'allow_rule_only', rule: remedyRule, noRule }
                  : { kind: 'rule_or_auto', rule: remedyRule, noRule };
        const cause: PermissionDenialCause =
          mode.current() === 'dontAsk'
            ? { kind: 'dont_ask', askRule }
            : noApprover
              ? { kind: 'no_approver', remedy }
              : dismissed
                ? { kind: 'dismissed' }
                : { kind: 'user' };
        if (cause.kind === 'no_approver') noteUnattendedRefusal(canonName, remedy);
        return {
          status: 'refused',
          result: toolFailure('SKIPPED: Permission denied', {
            toolCallId: call.id,
            code: 'permission_denied',
            status: 'blocked',
            content: permissionDeniedError(canonName, cause),
          }),
        };
      }
      if (permission === 'always' && !persistentBackgroundShell) {
        log.debug('permission always', { tool: canonName });
        // No rule, no write: a call with no primary argument has nothing to scope
        // one to, and a bare `Bash` rule allows every shell command afterwards; a Bash
        // command holding `*` has no rule either (#521). The answer still stands for this
        // one call.
        const rule = chosenRule ?? ownRule;
        if (!rule) {
          log.debug('permission always with no rule to save', { tool: canonName });
        } else {
          approveAllRules.push(rule);
          if (callbacks.onPersistPermissionRule) {
            callbacks.onPersistPermissionRule(rule);
          }
        }
      }
    }
  }

  if (mode.current() === 'plan' && !READ_ONLY_PLAN_TOOLS.has(canonName)) {
    log.debug('plan mode blocked mutating tool', { tool: canonName });
    return {
      status: 'refused',
      result: toolFailure(
        `SKIPPED: Tool "${canonName}" is not allowed in plan mode. Call ExitPlanMode with your plan and wait for approval before making changes.`,
        { toolCallId: call.id, code: 'plan_mode_blocked', status: 'blocked' },
      ),
    };
  }

  if (forceSkillPermission && invokedSkillName && skillActivationReason) {
    skillRegistry.grantConsent(invokedSkillName, skillActivationReason);
  }

  const preparedResult = registry.prepare(call, toolContext);
  if (preparedResult.status === 'rejected') {
    return { status: 'refused', result: preparedResult.result };
  }
  const prepared = preparedResult.prepared;

  const context = parallel
    ? {
        ...toolContext,
        currentToolTraceId: nestedTraceId ?? prepared.call.id,
        permissionSubject,
        todos: toolContext.todos ? [...toolContext.todos] : undefined,
        tasks: toolContext.tasks ? [...toolContext.tasks] : undefined,
        agentPath: toolContext.agentPath ? [...toolContext.agentPath] : undefined,
      }
    : toolContext;
  if (!parallel) {
    context.currentToolTraceId = nestedTraceId ?? prepared.call.id;
    // Every serial call sets it, so one call's subject never reaches the next call.
    context.permissionSubject = permissionSubject;
  }

  return {
    status: 'prepared',
    entry: {
      index,
      call: prepared.call,
      canonName,
      nestedTraceId,
      prepared,
      context,
      ...(permissionSubject ? { permissionSubject } : {}),
      parallel,
      modeAtPreparation: mode.current(),
      previousModeAtPreparation: context.previousMode,
      pendingPlanApprovalAtPreparation: context.pendingPlanApproval,
      pendingUserQuestionAtPreparation: context.pendingUserQuestion,
    },
  };
}

export async function executeToolCall(
  run: ToolCallRun,
  entry: PreparedLoopCall,
): Promise<ToolResult> {
  const { config, registry, runtime, clock, signal } = run;
  const toolStartMs = clock.monotonicNowMs();
  log.debug('tool start', {
    name: entry.canonName,
    id: entry.call.id,
    args: Object.keys(entry.call.arguments),
    parallel: entry.parallel,
  });
  try {
    const execute = () =>
      registry.executePrepared(entry.prepared, entry.context, config.retry.toolRetries);
    const result = entry.parallel
      ? await runtime.toolExecutionScheduler.run(execute, signal)
      : await execute();
    result.toolCallId = entry.call.id;
    result.metrics = { ...result.metrics, durationMs: clock.monotonicNowMs() - toolStartMs };
    return result;
  } catch (error) {
    return toolFailure(error instanceof Error ? error.message : String(error), {
      toolCallId: entry.call.id,
      code: signal?.aborted ? 'cancelled' : 'tool_exception',
      status: signal?.aborted ? 'cancelled' : 'error',
    });
  }
}

export async function finalizeToolCall(
  run: ToolCallRun,
  entry: PreparedLoopCall,
  initialResult: ToolResult,
): Promise<ToolResult> {
  const {
    config,
    callbacks,
    signal,
    toolContext,
    runtime,
    explorationRouting,
    readOnlyRoots,
    mode,
    planState,
    isSubagent,
    peerAwareness,
    toolOutputRoot,
  } = run;
  const { call, canonName, context, nestedTraceId } = entry;
  let result = initialResult;
  const durationMs = result.metrics?.durationMs ?? 0;

  if (
    entry.parallel &&
    (context.currentMode !== entry.modeAtPreparation ||
      context.previousMode !== entry.previousModeAtPreparation ||
      context.pendingPlanApproval !== entry.pendingPlanApprovalAtPreparation ||
      context.pendingUserQuestion !== entry.pendingUserQuestionAtPreparation)
  ) {
    result = toolFailure(`Parallel-safe tool ${canonName} mutated serial agent state`, {
      toolCallId: call.id,
      code: 'parallel_state_mutation',
      remediation: `Mark ${canonName} serial until its state mutation is removed.`,
    });
  }

  log.info('tool done', {
    model: config.model,
    canonicalTool: canonName,
    success: toolResultSucceeded(result),
    status: result.status,
    errorCode: result.structuredError?.code,
    retryCount: Math.max(0, (result.metrics?.retryAttempt ?? 1) - 1),
    hunkCount:
      canonName === 'ApplyPatch' && typeof call.arguments.patch === 'string'
        ? (call.arguments.patch.match(/^@@/gm) ?? []).length
        : undefined,
    changedFileCount:
      result.artifacts?.fileMutations?.length ?? (result.artifacts?.fileMutation ? 1 : 0),
    patchFingerprint:
      canonName === 'ApplyPatch' && typeof call.arguments.patch === 'string'
        ? createHash('sha256').update(call.arguments.patch).digest('hex').slice(0, 16)
        : undefined,
    durationMs,
    outputLen: result.content.length,
    parallel: entry.parallel,
  });

  if (toolResultSucceeded(result)) {
    if (result.artifacts?.fileMutation || result.artifacts?.fileMutations || canonName === 'Bash') {
      runtime.agentContextCache.invalidateWorkspace(config.workspace);
    } else if (canonName.startsWith('Git')) {
      runtime.agentContextCache.invalidateGit(config.workspace);
    }
    // Every mutation tool reports its files here, so this is the one place an edit is
    // recorded for peers (#620 4b): paths from the result, never from the model's text.
    const mutations =
      result.artifacts?.fileMutations ??
      (result.artifacts?.fileMutation ? [result.artifacts.fileMutation] : []);
    const edited = mutations.filter((mutation) => !mutation.memory);
    if (edited.length > 0) {
      peerAwareness?.recordEdits(
        config.workspace,
        edited.map((mutation) => mutation.filePath),
      );
    }
  }

  // Read from the shared context, not the call's own: a serial call runs on it and a call in a
  // parallel wave on a copy, so a call in a parallel wave doesn't write the mode back; only a
  // serial call can.
  const modeAfterTool = toolContext.currentMode ?? mode.current();
  if (modeAfterTool !== mode.current()) {
    mode.set(modeAfterTool);
    callbacks.onModeChange?.(mode.current());
  }

  if (toolResultSucceeded(result) && context.pendingPlanApproval) {
    const approval = callbacks.onPlanApprovalRequired
      ? await callbacks.onPlanApprovalRequired(context.pendingPlanApproval.plan)
      : context.previousMode === 'bypassPermissions'
        ? 'approve'
        : 'reject';

    if (approval === 'approve' || approval === 'approve-fresh') {
      const restoredMode = context.previousMode ?? 'default';
      const approvedPlan = context.pendingPlanApproval.plan;
      context.currentMode = restoredMode;
      context.previousMode = undefined;
      context.pendingPlanApproval = undefined;
      if (approval === 'approve-fresh') {
        planState.handoffRequested = { plan: approvedPlan, mode: restoredMode };
        callbacks.onPlanHandoff?.(planState.handoffRequested);
        result = replaceToolResult(result, {
          content: `${result.content}\n\nPlan approved. Handing off to a fresh context to implement (mode: ${restoredMode}).`,
        });
      } else {
        result = replaceToolResult(result, {
          content: `${result.content}\n\nPlan approved. Exited plan mode; mode restored to ${restoredMode}.`,
        });
      }
    } else if (typeof approval === 'object' && approval.decision === 'stop') {
      // No approver exists, so retrying ExitPlanMode can never succeed.
      // Stay in plan mode (nothing may mutate) and end the run after this
      // wave with the plan itself as the result.
      const submittedPlan = context.pendingPlanApproval.plan;
      context.currentMode = 'plan';
      context.pendingPlanApproval = undefined;
      planState.planStopRequested = { plan: submittedPlan, message: approval.message };
      result = replaceToolResult(result, {
        status: 'blocked',
        content: '',
        error: {
          code: 'plan_approval_unavailable',
          message: `STOPPED: ${approval.message}`,
          retryable: false,
          remediation: 'Do not call ExitPlanMode again: this run ends with the plan as its result.',
          details: { reason: approval.reason },
        },
      });
    } else {
      context.currentMode = 'plan';
      context.pendingPlanApproval = undefined;
      const message =
        approval === 'reject'
          ? 'SKIPPED: Plan was not approved. Revise the plan and call ExitPlanMode again.'
          : `SKIPPED: The user requested changes to the plan.\n\nFeedback: ${approval.feedback}\n\nRevise the plan using this feedback and call ExitPlanMode again.`;
      result = replaceToolResult(result, {
        status: 'blocked',
        content: '',
        error: {
          code: 'plan_not_approved',
          message,
          retryable: false,
          remediation: 'Revise the plan and call ExitPlanMode again.',
        },
      });
    }

    const modeAfterApproval = context.currentMode ?? mode.current();
    if (modeAfterApproval !== mode.current()) {
      mode.set(modeAfterApproval);
      callbacks.onModeChange?.(mode.current());
    }
  }

  if (toolResultSucceeded(result) && context.pendingUserQuestion) {
    const agentPath = context.agentPath ?? [];
    const request: UserQuestionRequest = {
      id: crypto.randomUUID(),
      questions: context.pendingUserQuestion.questions,
      source:
        agentPath.length > 0
          ? { kind: 'subagent', agentPath: [...agentPath], traceId: nestedTraceId }
          : { kind: 'root', traceId: nestedTraceId },
    };

    let response: UserQuestionResponse;
    try {
      if (!callbacks.onUserQuestionRequired) {
        response = { action: 'decline', message: 'User input is unavailable in this host.' };
      } else if (signal?.aborted) {
        response = { action: 'cancel', message: 'Agent execution was interrupted.' };
      } else {
        response = await new Promise<UserQuestionResponse>((resolve, reject) => {
          let settled = false;
          const finish = (value: UserQuestionResponse) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
          };
          const onAbort = () =>
            finish({ action: 'cancel', message: 'Agent execution was interrupted.' });
          const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', onAbort);
            reject(error);
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          callbacks.onUserQuestionRequired!(request, { signal }).then(finish, fail);
        });
      }
    } catch (error) {
      response = {
        action: 'cancel',
        message: `User question handler failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      context.pendingUserQuestion = undefined;
    }

    const validationError = validateUserQuestionResponse(request, response);
    if (validationError) {
      result = replaceToolResult(result, {
        status: 'error',
        content: '',
        error: {
          code: 'invalid_user_question_response',
          message: `Invalid user question response: ${validationError}`,
          retryable: false,
        },
      });
    } else if (response.action === 'answer') {
      result = replaceToolResult(result, {
        content: formatUserQuestionAnswers(request, response),
      });
    } else {
      const message = `SKIPPED: User ${response.action === 'decline' ? 'declined' : 'cancelled'} the question${response.message ? `: ${response.message}` : ''}`;
      result = replaceToolResult(result, {
        status: response.action === 'cancel' ? 'cancelled' : 'blocked',
        content: '',
        error: {
          code: response.action === 'cancel' ? 'user_cancelled' : 'user_declined',
          message,
          retryable: false,
        },
      });
    }
  }

  // A cancelled run still owes the host and the history this call's result (#669): its row
  // reads `Running…` until one arrives, and a step missing from history is missing on
  // resume. `runHooks` throws the abort reason before it looks at anything, so a cancel that
  // lands before or during the PostToolUse hooks is caught here rather than lose the result.
  // Those hooks may be what rewrites or scrubs a call's output before anyone sees it, though,
  // so a call whose hooks a cancel skipped publishes and keeps none of its output.
  const postHooks = config.settings.hooks.PostToolUse;
  let postHookResults: Awaited<ReturnType<typeof runHooks>> = [];
  let postHooksSkipped = signal?.aborted === true;
  if (!postHooksSkipped) {
    try {
      postHookResults = await runHooks(
        postHooks,
        'PostToolUse',
        {
          workspace: config.workspace,
          event: 'PostToolUse',
          toolName: canonName,
          toolArgs: call.arguments,
          shell: toolContext.shell ?? config.shell,
          ...(entry.permissionSubject ? { toolTargets: entry.permissionSubject.restrict } : {}),
          toolOutput: toolResultSucceeded(result)
            ? result.content
            : (toolResultErrorMessage(result) ?? ''),
        },
        { onHookEvent: callbacks.onHookEvent, signal },
      );
    } catch (error) {
      if (!signal?.aborted) throw error;
      postHooksSkipped = true;
    }
  }
  if (postHooksSkipped && postHooks.length > 0) {
    result = toolFailure(
      "CANCELLED: the run was cancelled before this call's PostToolUse hooks ran, so its output is withheld. The call itself may have completed.",
      { toolCallId: call.id, code: 'cancelled', status: 'cancelled' },
    );
  }
  for (const hookResult of postHookResults) {
    if (hookResult.action === 'modify' && hookResult.modifiedOutput !== undefined) {
      result = replaceToolResult(result, { content: hookResult.modifiedOutput });
    }
  }

  if (
    !isSubagent &&
    config.settings.agents.routing.exploreReminder &&
    toolResultSucceeded(result) &&
    (canonName === 'Glob' || canonName === 'Grep')
  ) {
    const manager = runtime.agentManager;
    const explorerActive = manager?.hasActiveProfile('explorer') ?? false;
    if (explorerActive) manager?.recordRoutingTelemetry('parent_search_while_explorer_active');
    const reminder = explorationRouting.recordSuccessfulQuery(explorerActive);
    if (reminder) {
      result = replaceToolResult(result, { content: `${result.content}\n\n${reminder}` });
      runtime.agentManager?.recordRoutingTelemetry(
        'explore_reminder',
        explorationRouting.snapshot(),
      );
    }
  }

  if (
    !isSubagent &&
    toolResultSucceeded(result) &&
    canonName === 'AgentSpawn' &&
    call.arguments.agent === 'explorer'
  ) {
    const routing = explorationRouting.snapshot();
    runtime.agentManager?.recordRoutingTelemetry('explorer_spawned', {
      discoveryQueriesBeforeSpawn: routing.discoveryQueries,
      afterReminder: routing.reminderEmitted,
    });
  }

  // Once, here, before anything is derived from the text: the spill file, the clipped
  // preview, `details`, the persisted session and the stream-json event all come from the
  // clean result (#411). Never at render time: earlier turns' bytes must not change.
  const redacted = redactToolResultSecrets(
    enrichToolResultPresentation(result, canonName, call.arguments),
    context.providerSecrets ?? [],
  );
  const bounded = await boundToolResultOutput(
    redacted,
    context.workspaceRoot,
    undefined,
    toolOutputRoot,
  );
  const outputPath = bounded.artifacts?.outputPath;
  if (bounded.pagination?.truncated && outputPath) {
    if (!readOnlyRoots.includes(outputPath)) readOnlyRoots.push(outputPath);
    // Session-scoped, so the next prompt of this session can still Read it.
    runtime.clippedOutputPaths.add(outputPath);
  }
  return bounded;
}
