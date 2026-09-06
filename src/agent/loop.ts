import type { AgentConfig, PermissionMode } from '../types/runtime.js';
import { systemClock, type Clock } from '../clock.js';
import type { HarnessRunContext } from '../harness/contracts.js';
import { createHash } from 'node:crypto';
import type {
  ImageAttachment,
  Message,
  ProviderMessageMetadata,
  Usage,
} from '../types/messages.js';
import type { ProviderResponseMetadata } from '../types/providers.js';
import type { SlashCommand } from '../types/commands.js';
import type {
  ToolCall,
  ToolResult,
  ToolContext,
  NestedToolObserver,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../types/tools.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import { createProvider, type Provider } from '../provider/index.js';
import { buildMessages } from './context.js';
import type { PreparedToolCall, ToolRegistry } from '../tools/registry.js';
import { loadGitignore } from '../tools/gitignore.js';
import {
  clipHistoryToolResults,
  estimateHistoryTokens,
  estimateProviderRequestTokens,
  resolveCompactBudgets,
  shouldCompact,
  usagePressureTokens,
} from './compact.js';
import { resolveContextLimit } from '../models.js';
import {
  evaluatePermissionDetail,
  permissionResultOf,
  permissionRuleForToolCall,
  permissionRuleMatchesCall,
  permissionRuleOf,
} from '../permissions.js';
import { runHooks } from '../hooks.js';
import { canonicalToolName } from '../tools/aliases.js';
import {
  isToolDefinitionAllowed,
  parseCapabilityRules,
  type CapabilityRule,
} from '../tools/capability-rules.js';
import { createDebugLogger } from '../debug-log.js';
import { stripReasoningTags } from '../reasoning-tags.js';
import { maybeCaptureMemoryCandidate } from '../memory-autosave.js';
import { PLAN_PERMISSION_REQUIRED_TOOLS, READ_ONLY_PLAN_TOOLS } from '../tools/plan-mode.js';
import { isFileMutatingTool } from '../tools/tool-capabilities.js';
import {
  formatUserQuestionAnswers,
  validateUserQuestionResponse,
} from '../tools/ask-user-question.js';
import { createToolSurface } from '../tools/catalog.js';
import {
  enrichToolResultPresentation,
  boundToolResultOutput,
  replaceToolResult,
  toolFailure,
  toolResultErrorMessage,
  toolResultSucceeded,
} from '../tools/result.js';
import { toolSearchTools } from '../tools/tool-search.js';
import { appendToolUseRecords } from '../tool-telemetry.js';
import type { ToolUseRecord } from '../types/tool-telemetry.js';
import { SessionRuntime } from '../session/runtime.js';
import { ExplorationRoutingTracker } from './exploration-routing.js';
import { permissionDeniedError } from './actionable-errors.js';
import { isContextOverflowError } from '../provider/reliability.js';
import {
  classifyAbortReason,
  createTerminalOutcome,
  terminalRecovery,
  type AgentTerminalOutcome,
} from '../types/terminal.js';
import type { AgentRunContext } from '../types/runs.js';
import { delay } from '../async.js';
import {
  buildProgressWitness,
  decideContinuation,
  renderWorkState,
  witnessSignature,
  type ContinuationStopReason,
} from './continuation.js';

const log = createDebugLogger('agent');
const SKILL_INFRASTRUCTURE_TOOLS = new Set(['InvokeSkill', 'ReadSkillResource', 'ToolSearch']);

/**
 * Check whether a tool call should be evaluated against permission rules,
 * based solely on the current mode. When false, the tool runs without
 * any permission gate (e.g. auto / bypassPermissions).
 */
function needsPermissionCheck(mode: string): boolean {
  if (mode === 'auto' || mode === 'bypassPermissions') return false;
  return true; // all other modes (default, accept-edits, plan, dontAsk) check rules
}

function requiresToolPermission(mode: string, persistentBackgroundShell: boolean): boolean {
  return needsPermissionCheck(mode) || (persistentBackgroundShell && mode !== 'bypassPermissions');
}

export async function runAgentLoop(
  config: AgentConfig,
  registry: ToolRegistry,
  userMessage: string,
  history: Message[],
  callbacks: AgentLoopCallbacks,
  mode: string = 'default',
  options?: {
    signal?: AbortSignal;
    isNewSession?: boolean;
    /** When false, the host owns SessionStart/SessionEnd boundaries. */
    manageSessionHooks?: boolean;
    commands?: SlashCommand[];
    allowedTools?: string[];
    modelOverride?: string;
    /** User-facing text to retain in history when userMessage is expanded context. */
    displayMessage?: string;
    /** Stable host-assigned identity for the user event. */
    userMessageId?: string;
    userMessageTimestamp?: number;
    userFileObservations?: Message['fileObservations'];
    userAttachments?: Message['attachments'];
    resolveAttachment?: (attachment: ImageAttachment) => Promise<Uint8Array> | Uint8Array;
    userMessageKind?: Message['kind'];
    /** The prompt was resolved from a command or delegated, not typed by the user. */
    userMessageDerived?: boolean;
    /** Synthetic host notifications bypass user-authored prompt hooks and memory capture. */
    skipUserPromptHooks?: boolean;
    /** Host identity for each streamed assistant turn. */
    assistantMessageId?: (turn: number) => string | undefined;
    /** True when this loop is a subagent (Task tool) invocation — skips memory auto-capture. */
    isSubagent?: boolean;
    /**
     * True when nobody is watching this run, so a refusal cannot be resolved by
     * asking. Set by headless and the SDK; the TUI leaves it false.
     */
    unattended?: boolean;
    /**
     * Liveness writer for the run's status file, supplied by the host that owns
     * the session. Subagents and managed agents call this loop directly, so
     * letting the loop create its own would make "is the run alive" ambiguous.
     */
    statusWriter?: import('../run-status.js').RunStatusWriter;
    /** Display-only observer for tools invoked by this subagent. */
    nestedToolObserver?: NestedToolObserver;
    /** Trace id of the Task invocation that launched this subagent loop. */
    parentToolTraceId?: string;
    /** Nested agent names from the root agent to this loop. */
    agentPath?: string[];
    /** Extra managed-agent identity and policy appended to the system prompt. */
    systemPromptAppend?: string;
    /**
     * Injected by tests. The loop reads it only for durations — how long this
     * run has been going, how long a tool took — never for a stamp anything
     * else will read.
     */
    clock?: Clock;
    /** Hide delegation discovery from child agents. */
    hideAgents?: boolean;
    /** Managed child identity and parent-session attribution. */
    agentId?: string;
    agentRole?: import('../agents/types.js').AgentRole;
    parentSessionId?: string;
    /** Non-owning managed-agent coordinator used by child-only evidence tools. */
    agentManager?: ToolContext['agentManager'];
    /** Mutable resources owned by the logical session. */
    runtime?: SessionRuntime;
    /** Frozen attribution for this root or linked child execution. */
    runContext?: AgentRunContext;
    /** Optional frozen harness metadata; absent when harness mode is off. */
    harnessContext?: Readonly<HarnessRunContext>;
    /** Observe-only runtime sink for facts unavailable through public callbacks. */
    harnessObserver?: import('../harness/contracts.js').HarnessRuntimeObserver;
    /** Override user-local oversized tool-output storage (primarily for isolated hosts/tests). */
    toolOutputRoot?: string;
    /** Override user-local tool-use telemetry storage (primarily for isolated hosts/tests). */
    toolTelemetryRoot?: string;
    provider?: Provider;
  },
): Promise<Message[]> {
  const signal = options?.signal;
  const emitHarnessRuntimeEvent = (
    type: import('../harness/contracts.js').HarnessEventType,
    attributes?: Record<string, string | number | boolean | null>,
  ): void => {
    const harness = options?.harnessObserver;
    if (!harness) return;
    try {
      harness.observer.enqueue({
        type,
        runId: harness.runId,
        occurredAt: Date.now(),
        sourceClass: 'derived',
        payloadClass: 'safe-metadata',
        attributes: attributes as never,
      });
    } catch {
      // Observation may drop one fact, never alter the model/tool path.
    }
  };
  const newHistory = [...history];
  let assistantOutputProduced = false;
  let terminalEmitted = false;
  /** The settled outcome, so the terminal hooks can report why the run stopped. */
  let settledOutcome: AgentTerminalOutcome | undefined;
  const finishTerminal = (outcome: AgentTerminalOutcome): void => {
    if (terminalEmitted) return;
    terminalEmitted = true;
    settledOutcome = outcome;
    // Stamp the outcome into the liveness file before telling anyone else: this is
    // what lets a supervisor distinguish "finished the objective" from "the
    // process is gone and left nothing behind".
    options?.statusWriter?.update({
      turn: options.statusWriter.snapshot().turn,
      openTodos: options.statusWriter.snapshot().openTodos,
      currentTodo: options.statusWriter.snapshot().currentTodo,
      costUsd: options.statusWriter.snapshot().costUsd,
      terminal: { status: outcome.status, reason: outcome.reason, message: outcome.message },
    });
    callbacks.onTerminal?.(outcome);
  };
  let terminalHooksFired = false;
  /**
   * Set when the completion gate has just run `Stop` for the completion the run is
   * about to report, so the terminal fire does not run the same hooks again.
   *
   * Deliberately NOT `terminalHooksFired`. Reusing that latch meant one blocked
   * completion at turn 40 permanently suppressed both the terminal `Stop` and
   * `SessionEnd` for the rest of the run — the exact paths a supervisor needs —
   * and it is cleared again the moment the gate lets the run continue, because a
   * later terminal is a different event that must report for itself.
   */
  let stopGateSatisfied = false;
  /**
   * Stop and SessionEnd, fired once when the agent has actually stopped.
   *
   * Both carry the settled outcome so a hook can distinguish an honest completion
   * from a failure. Neither passes `signal`: they are notifications about a run
   * that has already ended, and `runHooks` throws on an aborted signal ahead of
   * its empty-list guard — which made every Ctrl-C log a hook failure.
   *
   * Subagents are excluded: `Task` and every managed agent run this same loop with
   * the parent's hook config, and the manager already fires SubagentStop per child.
   */
  const fireTerminalHooks = (): void => {
    if (terminalHooksFired) return;
    terminalHooksFired = true;
    const payload = {
      workspace: config.workspace,
      stopReason: settledOutcome?.reason,
      status: settledOutcome?.status,
    };
    // `stopGateSatisfied` suppresses only Stop, and only when the gate just ran it
    // for this same completion. SessionEnd below is never suppressed by it.
    if (!options?.isSubagent && !stopGateSatisfied) {
      runHooks(
        config.settings.hooks.Stop,
        'Stop',
        { ...payload, event: 'Stop' },
        {
          onHookEvent: callbacks.onHookEvent,
        },
      ).catch((err) => console.warn('Stop hook failed:', err));
    }
    // One-shot callers keep the legacy per-loop lifecycle. Multi-turn hosts
    // disable this and fire SessionEnd when the conversation is actually left.
    if (options?.manageSessionHooks !== false) {
      runHooks(
        config.settings.hooks.SessionEnd,
        'SessionEnd',
        { ...payload, event: 'SessionEnd' },
        {
          onHookEvent: callbacks.onHookEvent,
        },
      ).catch((err) => console.warn('SessionEnd hook failed:', err));
    }
  };
  const hasPartialOutput = (): boolean => assistantOutputProduced;
  const retry = config.retry;
  const ownsRuntime = !options?.runtime;
  const runtime = options?.runtime ?? new SessionRuntime();
  runtime.toolExecutionScheduler.setLimit(config.settings.toolExecution.maxConcurrent);
  runtime.agentContextCache.beginTurn();
  if (!registry.getTool('ToolSearch')) registry.registerAll(toolSearchTools);

  // Apply model override from command frontmatter.
  const effectiveConfig = options?.modelOverride
    ? { ...config, model: options.modelOverride }
    : config;

  // SessionStart hook — hosts with a multi-turn lifecycle (the TUI/headless
  // session wrapper) disable this and fire it at the actual session boundary.
  if (
    options?.manageSessionHooks !== false &&
    options?.isNewSession !== false &&
    history.length === 0
  ) {
    runHooks(
      config.settings.hooks.SessionStart,
      'SessionStart',
      {
        workspace: config.workspace,
        event: 'SessionStart',
      },
      { onHookEvent: callbacks.onHookEvent, signal },
    ).catch((err) => console.warn('SessionStart hook failed:', err));
  }

  // UserPromptSubmit hook — can modify or block the user prompt.
  let effectivePrompt = userMessage;
  let displayPrompt = options?.displayMessage ?? userMessage;
  const userHookResults = options?.skipUserPromptHooks
    ? []
    : await runHooks(
        config.settings.hooks.UserPromptSubmit,
        'UserPromptSubmit',
        { workspace: config.workspace, event: 'UserPromptSubmit', userPrompt: userMessage },
        { onHookEvent: callbacks.onHookEvent, signal },
      );
  for (const r of userHookResults) {
    if (r.action === 'block') {
      newHistory.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `[UserPromptSubmit hook blocked the prompt${r.message ? `: ${r.message}` : ''}]`,
        includeInContext: false,
        timestamp: Date.now(),
      });
      finishTerminal(
        createTerminalOutcome('failed', 'blocked_by_policy', {
          partialOutput: false,
          message: r.message ?? 'The prompt was blocked by a user hook.',
        }),
      );
      return newHistory;
    }
    if (r.action === 'modify' && r.modifiedPrompt) {
      effectivePrompt = r.modifiedPrompt;
      displayPrompt = r.modifiedPrompt;
    }
  }

  const skillRegistry = ownsRuntime
    ? runtime.skills(config.workspace, config.settings.skills)
    : runtime.consumeSkillChanges(config.workspace, config.settings.skills);
  skillRegistry.recordPromptCatalog(resolveContextLimit(config));
  const hasUsableSkills = skillRegistry
    .list()
    .some((skill) => skill.valid && skill.activation !== 'off');
  const availableToolDefinitions = registry
    .getDefinitions()
    .filter(
      (definition) =>
        hasUsableSkills ||
        (definition.name !== 'InvokeSkill' && definition.name !== 'ReadSkillResource'),
    );
  const explicitSkillFailures: string[] = [];
  const explicitRestrictionSets: CapabilityRule[][] = [];
  const explicitSkillNames = skillRegistry.beginRun(effectivePrompt);
  for (const skillName of explicitSkillNames) {
    const call: ToolCall = {
      id: `explicit-skill:${skillName}`,
      name: 'InvokeSkill',
      arguments: { skill: skillName },
    };
    const activationPolicy = skillRegistry.activationPolicy(skillName, 'user');
    let approved = activationPolicy !== 'deny';
    if (activationPolicy === 'ask') {
      skillRegistry.requestConsent(skillName, 'user');
      const verdict = evaluatePermissionDetail(call.name, call.arguments, config.settings);
      let permission: 'allow' | 'deny' | 'always' | undefined;
      let chosenRule: string | undefined;
      if (verdict.decision === 'allow') permission = 'allow';
      else if (verdict.decision === 'deny') permission = 'deny';
      else if (mode !== 'dontAsk') {
        const decision = await callbacks.onPermissionRequired(call);
        permission = permissionResultOf(decision);
        chosenRule = permissionRuleOf(decision);
      }
      approved = permission === 'allow' || permission === 'always';
      if (permission === 'always' && callbacks.onPersistPermissionRule) {
        callbacks.onPersistPermissionRule(chosenRule ?? permissionRuleForToolCall(call));
      }
    }
    if (!approved) {
      const code =
        activationPolicy === 'deny' ? 'skill_execution_denied' : 'skill_permission_denied';
      const message =
        activationPolicy === 'deny'
          ? `Skill activation is denied: ${skillName}`
          : `Explicit skill activation was denied: ${skillName}`;
      if (activationPolicy === 'ask') skillRegistry.denyConsent(skillName, 'user');
      skillRegistry.recordActivationBlocked(skillName, 'user', code, message);
      explicitSkillFailures.push(message);
      continue;
    }
    const descriptor = skillRegistry.get(skillName);
    const candidateRestriction = descriptor?.allowedTools?.length
      ? parseCapabilityRules([
          ...new Set([...descriptor.allowedTools, 'InvokeSkill', 'ReadSkillResource']),
        ])
      : undefined;
    if (candidateRestriction) {
      const effectiveTools = availableToolDefinitions.filter((definition) => {
        const name = canonicalToolName(definition.name);
        return (
          !SKILL_INFRASTRUCTURE_TOOLS.has(name) &&
          [...explicitRestrictionSets, candidateRestriction].every((rules) =>
            isToolDefinitionAllowed(rules, definition),
          )
        );
      });
      if (effectiveTools.length === 0) {
        const message = `Skill "${skillName}" conflicts with the active tool ceiling; no task tools would remain.`;
        skillRegistry.recordActivationBlocked(
          skillName,
          'user',
          'skill_tool_intersection_empty',
          message,
        );
        explicitSkillFailures.push(message);
        continue;
      }
    }
    try {
      if (activationPolicy === 'ask') skillRegistry.grantConsent(skillName, 'user');
      skillRegistry.activate(skillName, 'user', 0);
      if (candidateRestriction) explicitRestrictionSets.push(candidateRestriction);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      explicitSkillFailures.push(message);
      callbacks.onError(message);
    }
  }

  newHistory.push({
    id: options?.userMessageId ?? crypto.randomUUID(),
    role: 'user',
    content: displayPrompt,
    contextContent: effectivePrompt === displayPrompt ? undefined : effectivePrompt,
    includeInContext: true,
    kind: options?.userMessageKind ?? 'conversation',
    derivedContent: options?.userMessageDerived ? true : undefined,
    fileObservations: options?.userFileObservations,
    attachments: options?.userAttachments,
    timestamp: options?.userMessageTimestamp ?? Date.now(),
  });

  if (!options?.isSubagent && !options?.skipUserPromptHooks) {
    try {
      let previousAssistant: string | undefined;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i].role === 'assistant' && history[i].includeInContext) {
          previousAssistant = history[i].content;
          break;
        }
      }
      const memoryCapture = maybeCaptureMemoryCandidate({
        workspace: config.workspace,
        settings: config.settings,
        userMessage: effectivePrompt,
        previousAssistant,
      });
      if (memoryCapture.saved) log.info('memory candidate captured', { path: memoryCapture.path });
    } catch (e) {
      log.warn('memory candidate capture failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  const initialMode = mode as PermissionMode;
  const toolContext: ToolContext = {
    workspaceRoot: config.workspace,
    env: process.env as Record<string, string>,
    envOverrides: {},
    gitignorePatterns: loadGitignore(config.workspace).patterns,
    sandbox: config.settings.sandbox,
    agentConfig: config,
    signal,
    nestedToolObserver: options?.nestedToolObserver,
    // Seed from the runtime, not an empty literal. A fresh `[]` here meant the plan
    // died at every invocation boundary: on `--resume` the model came back to a
    // compacted narrative and no todos, and an empty list renders identically to
    // never having had one, so nothing prompted it to rebuild.
    todos: runtime.todos,
    tasks: runtime.tasks,
    backgroundShells: runtime.backgroundShells,
    fileObservationLedger: runtime.fileObservationLedger,
    currentMode: initialMode,
    userQuestionHandler: callbacks.onUserQuestionRequired,
    agentPath: options?.agentPath ?? [],
    availableTools: availableToolDefinitions,
    agentManager: options?.agentManager ?? runtime.agentManager,
    agentId: options?.agentId,
    agentRole: options?.agentRole,
    parentSessionId: options?.parentSessionId,
    runContext: options?.runContext,
    harnessObserver: options?.harnessObserver,
    onAgentEvent: callbacks.onAgentEvent,
    onHookEvent: callbacks.onHookEvent,
    runtime,
  };
  const toolSurface = createToolSurface({
    config: effectiveConfig,
    context: toolContext,
    definitions: availableToolDefinitions,
    capabilityRules: options?.allowedTools,
    isSubagent: options?.isSubagent,
  });
  toolContext.toolDiscovery = toolSurface;
  const appliedSkillRestrictions = new Map<string, () => void>();
  const disposeSkillRestrictions = (): void => {
    for (const dispose of appliedSkillRestrictions.values()) dispose();
    appliedSkillRestrictions.clear();
  };
  const syncSkillRestrictions = (currentTurn: number): void => {
    const frames = skillRegistry.activeFrames(currentTurn);
    const activeKeys = new Set(frames.map((frame) => `${frame.skillId}:${frame.bodyDigest}`));
    for (const [key, dispose] of appliedSkillRestrictions) {
      if (activeKeys.has(key)) continue;
      dispose();
      appliedSkillRestrictions.delete(key);
    }
    for (const frame of frames) {
      if (!frame.allowedTools) continue;
      const key = `${frame.skillId}:${frame.bodyDigest}`;
      if (appliedSkillRestrictions.has(key)) continue;
      appliedSkillRestrictions.set(key, toolSurface.pushRestriction(frame.allowedTools));
    }
    if (frames.length > 0) toolSurface.activate(['ReadSkillResource']);
    skillRegistry.recordEffectiveTools(
      frames.length > 0
        ? toolSurface
            .previewRestriction(['*'])
            .map((definition) => canonicalToolName(definition.name))
            .filter((name) => name !== 'ToolSearch')
        : undefined,
    );
  };
  /**
   * Activation-class prompt text: skill frames and their notices change on
   * activation and expiry, so they ride the dynamic zone. Managed-agent identity
   * (`options.systemPromptAppend`) is session-stable and stays cached.
   */
  const dynamicPolicy = (currentTurn: number): string | undefined => {
    const sections = [
      skillRegistry.renderActivePolicy(currentTurn),
      explicitSkillFailures.length
        ? `## Skill activation notices\n${explicitSkillFailures.map((failure) => `- ${failure}`).join('\n')}`
        : undefined,
    ].filter((section): section is string => Boolean(section));
    return sections.length ? sections.join('\n\n') : undefined;
  };
  let skillEventCursor = 0;
  const flushSkillEvents = (): void => {
    while (skillEventCursor < skillRegistry.events.length) {
      const event = skillRegistry.events[skillEventCursor++];
      callbacks.onAgentEvent?.({ type: 'skill_lifecycle', event });
    }
  };
  flushSkillEvents();

  try {
    let turn = 0;
    const approveAllRules: string[] = [];
    let lastUsage: Usage | null = null;
    /**
     * The loop's own estimate of the request `lastUsage` measures, and how much of
     * it was not history. Compaction shrinks its target by the ratio of the two
     * counts, and sizes it against the gate that includes the overhead.
     */
    let lastRequestEstimate: { requestTokens: number; overheadTokens: number } | null = null;
    /** Avoid re-attempting compact for the same pressure snapshot after skip/fail. */
    let lastCompactAttemptKey: string | null = null;
    let retrySameTurn = false;
    /** True while replaying a turn, so its messages do not reuse the host's id. */
    let reissuedThisTurn = false;
    /** Turn re-sends spent on transport faults; bounded by retry.streamReissueAttempts. */
    let streamReissues = 0;
    /** Continuations after an output cap; budgeted separately from transport faults. */
    let outputCapContinues = 0;
    /** Host-authored continuations spent, and the witnesses they were taken at. */
    let continuationCount = 0;
    const continuationWitnesses: string[] = [];
    let continuationStop: ContinuationStopReason | undefined;
    /**
     * Tool calls that actually ran. The no-progress witness counts THIS, not every
     * attempted call: `toolCallStats` increments unconditionally, including for
     * refusals, so a denial spin would move the one leg of the witness that is
     * supposed to prove nothing is moving.
     */
    let executedToolCalls = 0;
    /** Consecutive turns whose every tool call was refused. */
    let blockedTurnStreak = 0;
    /** The tools refused on the streak's most recent turn, for the terminal message. */
    let blockedTurnTools: string[] = [];
    // Monotonic, and never leaves this function as a stamp. Over a run measured
    // in days a wall-clock correction would silently rewrite how long the model
    // is told it has been working, in either direction.
    const clock = options?.clock ?? systemClock;
    const runStartedAt = clock.monotonicNowMs();
    /** Guards the periodic work-state message against a same-turn re-issue. */
    let lastWorkStateTurn = -1;
    let emptyResponseRetryTurn: number | null = null;
    let forcedCompactTurn: number | null = null;
    let effectiveMode = initialMode;
    /** Set when the user approves a plan with fresh context; ends the turn so the host can reseed. */
    let handoffRequested: { plan: string; mode: PermissionMode } | null = null;
    /**
     * Set when the host cannot approve a plan at all (no approver in a
     * non-interactive host). The plan is the deliverable, so the run ends here
     * instead of burning the remaining turns on ExitPlanMode retries.
     */
    let planStopRequested: { plan: string; message: string } | null = null;
    const syncHostMode = (): void => {
      const hostMode = callbacks.getMode?.();
      if (hostMode !== undefined) toolContext.currentMode = hostMode;
      effectiveMode = toolContext.currentMode ?? effectiveMode;
    };
    const explorationRouting = new ExplorationRoutingTracker(
      config.settings.agents.routing.inlineSearchBudget,
    );

    // maxTurns undefined/0 = unlimited; otherwise stop once the cap is hit.
    while (
      retrySameTurn ||
      config.maxTurns == null ||
      config.maxTurns <= 0 ||
      turn < config.maxTurns
    ) {
      if (signal?.aborted) break;
      syncHostMode();

      // Mid-loop auto-compact safety net (host also runs pre-turn compact).
      const contextLimit = resolveContextLimit(config);
      if (
        config.autoCompactEnabled !== false &&
        callbacks.onCompact &&
        contextLimit != null &&
        shouldCompact(lastUsage, contextLimit)
      ) {
        const attemptKey = `${usagePressureTokens(lastUsage)}:${newHistory.length}`;
        if (attemptKey !== lastCompactAttemptKey) {
          lastCompactAttemptKey = attemptKey;
          log.info('auto-compact triggered', {
            tokens: usagePressureTokens(lastUsage),
            contextLimit,
          });
          try {
            const result = await callbacks.onCompact(newHistory, lastUsage, {
              requestOverheadTokens: lastRequestEstimate?.overheadTokens,
              estimatedRequestTokens: lastRequestEstimate?.requestTokens,
            });
            if (result.status === 'compacted') {
              newHistory.length = 0;
              newHistory.push(...result.replacementHistory);
              lastUsage = null;
              lastCompactAttemptKey = null;
            }
            // skipped/failed: keep lastUsage so the host can still act; do not retry same snapshot
          } catch {
            // non-fatal: continue with full history this turn
          }
        }
      }

      if (retrySameTurn) {
        retrySameTurn = false;
        // A re-issue produces a SECOND assistant message for the same turn - the
        // truncated partial is already pushed and persisted, by design, so the
        // history stays valid and no tool re-executes. What must not be reused is
        // its identity: the host's `assistantMessageId` is keyed on `turn`, which
        // has not changed, so both messages landed under one session `eventId`
        // (collapsing them in `load()` and leaving `/rewind` unable to address
        // either) and both were emitted as `complete: true`.
        reissuedThisTurn = true;
        log.info('retrying current turn', { turn });
      } else {
        reissuedThisTurn = false;
        turn++;
        callbacks.onTurnStart(turn);
        log.debug('turn start', { turn, maxTurns: config.maxTurns, mode: effectiveMode });
      }

      // Periodic host-authored plan restatement. It keeps the plan fresh across a
      // long tool-grinding stretch, and it is the only guaranteed producer of
      // compaction bundle boundaries in a run with one user turn: a run that never
      // stops never produces a continuation message either, so without this the
      // candidate span is all-assistant and the retained tail is unconditionally
      // zero from generation 2 onward.
      const refreshTurns = config.settings.continuation.planRefreshTurns;
      if (
        config.settings.continuation.enabled &&
        refreshTurns > 0 &&
        turn > 0 &&
        turn !== lastWorkStateTurn &&
        turn % refreshTurns === 0
      ) {
        const workState = renderWorkState({
          todos: toolContext.todos ?? [],
          tasks: toolContext.tasks ?? [],
        });
        if (workState) {
          lastWorkStateTurn = turn;
          const message: Message = {
            id: crypto.randomUUID(),
            role: 'user',
            content: workState,
            includeInContext: true,
            kind: 'conversation',
            timestamp: Date.now(),
          };
          newHistory.push(message);
          callbacks.onUserMessageAppended?.(message);
          log.debug('work-state refresh appended', { turn });
        }
      }

      toolContext.currentTurn = turn;
      syncSkillRestrictions(turn);
      const activeDefinitions = toolSurface.activeDefinitions();
      let messages = await buildMessages(
        effectiveConfig,
        newHistory,
        toolContext.todos,
        options?.commands,
        signal,
        {
          append: options?.systemPromptAppend,
          dynamicPolicy: dynamicPolicy(turn),
          hideAgents: options?.hideAgents,
          toolCatalogSummary: toolSurface.catalogSummary(),
          planMode: effectiveMode === 'plan',
          planUnrestored: runtime.planUnrestored,
          runElapsedMs: clock.monotonicNowMs() - runStartedAt,
          workflowPolicy: options?.harnessContext?.workflowPolicySection,
        },
        runtime.agentContextCache,
        options?.resolveAttachment,
      );
      let requestTokens = estimateProviderRequestTokens(messages, activeDefinitions);
      const rebuildRequest = async (): Promise<void> => {
        messages = await buildMessages(
          effectiveConfig,
          newHistory,
          toolContext.todos,
          options?.commands,
          signal,
          {
            append: options?.systemPromptAppend,
            dynamicPolicy: dynamicPolicy(turn),
            hideAgents: options?.hideAgents,
            toolCatalogSummary: toolSurface.catalogSummary(),
            planMode: effectiveMode === 'plan',
            planUnrestored: runtime.planUnrestored,
            runElapsedMs: clock.monotonicNowMs() - runStartedAt,
            workflowPolicy: options?.harnessContext?.workflowPolicySection,
          },
          runtime.agentContextCache,
          options?.resolveAttachment,
        );
        requestTokens = estimateProviderRequestTokens(messages, activeDefinitions);
      };
      // Everything in the request that is not history: system prompt, tool schemas, session
      // state. Compaction sizes its target against the gate, which counts all of it.
      const requestOverheadTokens = Math.max(0, requestTokens - estimateHistoryTokens(newHistory));
      // One resolver for the loop and the compactor, so the gate enforced here and the target
      // compaction aims for are computed from the same clamped output reserve.
      const budgets = resolveCompactBudgets(effectiveConfig, { requestOverheadTokens });
      const usableContextLimit = budgets.usableContextLimit;
      const preflightThreshold = budgets.preflightThreshold;
      const hasToolResults = newHistory.some((message) => (message.toolResults?.length ?? 0) > 0);
      const preflightEligible = requestTokens >= preflightThreshold && hasToolResults;

      // Usage from the prior request cannot see a tool result added afterward. Measure the complete
      // request that is about to be sent and compact it before the provider has to reject it.
      if (config.autoCompactEnabled !== false && callbacks.onCompact && preflightEligible) {
        const attemptKey = `preflight:${requestTokens}:${newHistory.length}`;
        if (attemptKey !== lastCompactAttemptKey) {
          lastCompactAttemptKey = attemptKey;
          const estimatedUsage: Usage = {
            promptTokens: requestTokens,
            completionTokens: 0,
            totalTokens: requestTokens,
            contextTokens: requestTokens,
          };
          log.info('preflight compact triggered', { requestTokens, contextLimit });
          try {
            const result = await callbacks.onCompact(newHistory, estimatedUsage, {
              requestOverheadTokens,
            });
            if (result.status === 'compacted') {
              newHistory.length = 0;
              newHistory.push(...result.replacementHistory);
              lastUsage = null;
              lastCompactAttemptKey = null;
              await rebuildRequest();
            }
          } catch {
            // Deterministic clipping below remains available if model-assisted compaction fails.
          }
        }
      }

      if (preflightEligible) {
        // The scaled cap keeps what compaction just retained intact.
        const clippedHistory = clipHistoryToolResults(
          newHistory,
          budgets.retainedToolResultMaxTokens,
        );
        if (clippedHistory.some((message, index) => message !== newHistory[index])) {
          newHistory.length = 0;
          newHistory.push(...clippedHistory);
          await rebuildRequest();
          log.info('preflight tool outputs clipped', { requestTokens, contextLimit });
        }
        // When the request would still be refused -- compaction disabled, failed, or
        // skipped -- the flat cap the loop always had is the last valve: less evidence
        // in the tool results beats a dead turn.
        if (requestTokens >= usableContextLimit && hasToolResults) {
          const shortClipped = clipHistoryToolResults(newHistory);
          if (shortClipped.some((message, index) => message !== newHistory[index])) {
            newHistory.length = 0;
            newHistory.push(...shortClipped);
            await rebuildRequest();
            log.info('preflight tool outputs clipped to the short cap', {
              requestTokens,
              contextLimit,
            });
          }
        }
      }

      if (requestTokens >= usableContextLimit && hasToolResults) {
        callbacks.onError(
          `Request is too large for ${effectiveConfig.model} (${requestTokens} estimated input tokens, ${usableContextLimit} available input tokens after reserving output space). Start a new session or reduce the current prompt.`,
        );
        finishTerminal(
          createTerminalOutcome('failed', 'context_overflow', {
            partialOutput: hasPartialOutput(),
            message: `Request is too large for ${effectiveConfig.model}.`,
          }),
        );
        return newHistory;
      }
      lastRequestEstimate = { requestTokens, overheadTokens: requestOverheadTokens };
      let assistantContent = '';
      let reasoningContent = '';
      const toolCalls: ToolCall[] = [];
      const nestedTraceIds: string[] = [];
      let turnUsage: Usage | null = null;
      let responseMetadata: ProviderResponseMetadata | undefined;
      let assistantProviderMetadata: ProviderMessageMetadata | undefined;

      // Accumulate text so a retried turn rebuilds `assistantContent` from the
      // attempt that actually counted. This discards the abandoned attempt from
      // the loop's accounting only: the host was handed those deltas through
      // `onText` as they arrived, and there is no callback to take them back, so
      // a retry leaves the abandoned text on screen and persists only the
      // replacement. Retries fire only when an attempt answered nothing, so what
      // is stranded is a reasoning block the transcript collapses to one row.
      let textBuffer = '';
      let heldText = '';
      let textStreamingStarted = false;
      let reasoningStreamingStarted = false;
      const flushReasoning = (): void => {
        if (reasoningStreamingStarted) return;
        reasoningStreamingStarted = true;
        if (!reasoningContent) return;
        assistantOutputProduced = true;
        callbacks.onReasoning?.(reasoningContent);
      };

      const provider = options?.provider ?? createProvider(effectiveConfig);
      let usageRecorded = false;
      const recordTurnUsage = (): void => {
        if (!turnUsage || usageRecorded) return;
        usageRecorded = true;
        const metadata = responseMetadata ?? {
          provider: provider.id,
          requestedModel: effectiveConfig.model,
        };
        callbacks.onUsage?.(turnUsage, metadata);
        if (options?.runContext)
          runtime.runAccounting.record(options.runContext, turnUsage, metadata);
      };
      if (options?.runContext) {
        const budget = runtime.runAccounting.checkBeforeModelCall(
          options.runContext.rootRunId,
          effectiveConfig.model,
        );
        if (!budget.allowed) {
          const reason = budget.status === 'exceeded' ? 'budget_exceeded' : 'budget_unverifiable';
          const outcome = createTerminalOutcome('failed', reason, {
            partialOutput: hasPartialOutput(),
            message: budget.message,
          });
          callbacks.onError(budget.message ?? 'Run budget cannot be enforced.');
          finishTerminal(outcome);
          return newHistory;
        }
      }
      const stream = provider.stream(effectiveConfig, messages, activeDefinitions, {
        signal,
        onRetry: (attempt, max, delayMs) => {
          if (options?.runContext) {
            runtime.runAccounting.markUsageUnknown(
              options.runContext,
              { provider: provider.id, requestedModel: effectiveConfig.model },
              'failed_provider_attempt_usage',
            );
          }
          callbacks.onRetry?.(max === -1 ? 'watchdog' : 'transport', attempt, max, delayMs);
        },
        onStreamStall: (countdownMs) => {
          callbacks.onStreamStall?.(countdownMs);
        },
        onStreamResume: () => {
          callbacks.onStreamResume?.();
        },
      });
      emitHarnessRuntimeEvent('provider_requested', {
        provider: provider.id,
        requestedModel: effectiveConfig.model,
      });

      let streamError: string | null = null;
      let streamErrorCode: string | undefined;
      let streamDone = false;

      try {
        for await (const event of stream) {
          if (event.type === 'reasoning' && event.reasoning) {
            reasoningContent += event.reasoning;
            if (reasoningStreamingStarted) callbacks.onReasoning?.(event.reasoning);
          } else if (event.type === 'text' && event.content) {
            textBuffer += event.content;
            if (textStreamingStarted) {
              assistantOutputProduced = true;
              callbacks.onText(event.content);
            } else {
              heldText += event.content;
              const candidate = heldText.trimStart().toLowerCase();
              const errorPrefix = '[error]';
              if (!errorPrefix.startsWith(candidate) && !candidate.startsWith(errorPrefix)) {
                textStreamingStarted = true;
                assistantOutputProduced = true;
                flushReasoning();
                callbacks.onText(heldText);
                heldText = '';
              }
            }
          } else if (event.type === 'tool_call' && event.toolCall) {
            flushReasoning();
            assistantOutputProduced = true;
            toolCalls.push(event.toolCall);
            callbacks.onToolCall(event.toolCall);
            if (options?.nestedToolObserver && options.parentToolTraceId) {
              const traceId = `${options.parentToolTraceId}/${turn}-${nestedTraceIds.length + 1}:${event.toolCall.id}`;
              nestedTraceIds.push(traceId);
              options.nestedToolObserver.onToolCall({
                traceId,
                parentTraceId: options.parentToolTraceId,
                call: event.toolCall,
              });
            }
          } else if (event.type === 'error' && event.error) {
            streamError = event.error;
            streamErrorCode = event.errorCode;
            break;
          } else if (event.type === 'done') {
            streamDone = true;
            if (event.usage) {
              turnUsage = event.usage;
              lastUsage = turnUsage;
            }
            responseMetadata = {
              provider: provider.id,
              requestedModel: effectiveConfig.model,
              responseModel: event.responseModel,
              responseId: event.responseId,
              finishReasons: event.finishReasons,
            };
            assistantProviderMetadata = event.providerMetadata;
          }
          if (signal?.aborted) break;
        }
      } catch (e) {
        // Abort looks like an AbortError; keep whatever content we have and stop.
        if (signal?.aborted) {
          if (options?.runContext && !turnUsage) {
            runtime.runAccounting.markUsageUnknown(
              options.runContext,
              responseMetadata ?? { provider: provider.id, requestedModel: effectiveConfig.model },
              'cancelled_provider_attempt_usage',
            );
          }
          break;
        }
        streamError = e instanceof Error ? e.message : String(e);
        streamErrorCode = 'provider_error';
      }

      assistantContent = textBuffer;
      recordTurnUsage();
      if (options?.runContext && !turnUsage) {
        runtime.runAccounting.markUsageUnknown(
          options.runContext,
          responseMetadata ?? { provider: provider.id, requestedModel: effectiveConfig.model },
          signal?.aborted
            ? 'cancelled_provider_attempt_usage'
            : streamError
              ? 'provider_attempt_usage'
              : 'provider_usage',
        );
      }

      const finishReason = responseMetadata?.finishReasons?.find((reason) =>
        [
          'length',
          'max_tokens',
          'model_context_window_exceeded',
          'content_filter',
          'refusal',
          'error',
        ].includes(reason),
      );
      if (!streamError && streamDone && finishReason) {
        if (finishReason === 'length' || finishReason === 'max_tokens') {
          // Not a protocol error. On a migration or a generated file, hitting the
          // output cap is the shape of the work, not an anomaly — and classifying
          // it as a protocol error made it unrecoverable.
          streamError =
            'The provider stopped because the response reached its output limit. Continue from exactly where you stopped; do not restart the answer.';
          streamErrorCode = 'output_cap';
        } else if (finishReason === 'model_context_window_exceeded') {
          streamError = 'The provider stopped because the model context window was exceeded.';
          streamErrorCode = 'context_overflow';
        } else {
          streamError = `The provider stopped with finish reason: ${finishReason}.`;
          streamErrorCode =
            finishReason === 'error' || finishReason === 'refusal'
              ? 'provider_error'
              : 'protocol_error';
        }
      }

      // A turn that produced neither an answer nor a tool call is worth exactly
      // one retry. Two provider behaviours land here and both are transient:
      //
      //   - A clean stream whose only content was a reasoning block. Routers
      //     that inline thinking as `<think></think>` rather than sending
      //     `reasoning_content` leave `assistantContent` non-empty in the raw,
      //     so the emptiness test has to look past the tags or it never fires
      //     and the loop ends the run believing the model answered.
      //   - A stream cut before its terminal event. That never set `streamDone`
      //     and did set `streamError`, so it used to skip the retry entirely.
      //
      // Every other `streamError` is either terminal (a refusal, an output cap)
      // or has its own recovery below (context overflow), so it is left alone.
      const answeredNothing =
        stripReasoningTags(assistantContent).trim().length === 0 && toolCalls.length === 0;
      if (
        answeredNothing &&
        !signal?.aborted &&
        (!streamError || streamErrorCode === 'transport_interrupted')
      ) {
        if (emptyResponseRetryTurn !== turn) {
          emptyResponseRetryTurn = turn;
          log.warn('provider returned an empty completion; retrying once', {
            turn,
            reasoningLen: reasoningContent.length,
            contentLen: assistantContent.length,
            streamDone,
            streamErrorCode,
            responseId: responseMetadata?.responseId,
          });
          // The attempt's deltas are already with the host; tell it to drop
          // them so the retry's answer does not queue up behind an abandoned
          // reasoning block that no history will ever record.
          callbacks.onAttemptDiscarded?.();
          retrySameTurn = true;
          continue;
        }
        // Keep a transport diagnosis rather than overwriting it with a generic
        // one; `transport_interrupted` tells the user something different.
        if (!streamError) {
          streamError =
            'The provider returned an empty response after one retry. Please retry the request.';
          streamErrorCode = 'protocol_error';
        }
      }

      const routerOverflowResponse =
        !streamError &&
        streamDone &&
        toolCalls.length === 0 &&
        /^\s*\[Error\]/i.test(assistantContent) &&
        isContextOverflowError(assistantContent);
      if (routerOverflowResponse) {
        streamError = assistantContent.trim();
        streamErrorCode = 'context_overflow';
        assistantContent = '';
      }
      if (heldText && !routerOverflowResponse) {
        assistantOutputProduced = true;
        flushReasoning();
        callbacks.onText(heldText);
      }

      // If the stream ended with an error, surface it and stop the loop. Keep
      // any partial assistant text/tool call metadata in returned history so
      // callers that persist sessions do not lose what was already rendered.
      if (streamError && !signal?.aborted) {
        const canRecoverContextOverflow =
          forcedCompactTurn !== turn &&
          assistantContent.length === 0 &&
          toolCalls.length === 0 &&
          isContextOverflowError(streamError);
        if (canRecoverContextOverflow) {
          forcedCompactTurn = turn;
          log.warn('provider context overflow; forcing compaction before retry', {
            turn,
            historyLength: newHistory.length,
            error: streamError,
          });
          let beforeTokens = estimateHistoryTokens(newHistory);
          let compactedTokens: number | undefined;
          let compacted = false;
          if (callbacks.onCompact) {
            const estimatedUsage: Usage = {
              promptTokens: requestTokens,
              completionTokens: 0,
              totalTokens: requestTokens,
              contextTokens: requestTokens,
            };
            try {
              // The provider has refused the request the residual tail was sized for; the
              // compactor keeps the short tail so the one retry fits any real window.
              const result = await callbacks.onCompact(newHistory, estimatedUsage, {
                recovery: true,
                requestOverheadTokens: lastRequestEstimate?.overheadTokens,
              });
              if (result.status === 'compacted') {
                newHistory.length = 0;
                newHistory.push(...result.replacementHistory);
                lastUsage = null;
                lastCompactAttemptKey = null;
                beforeTokens = Math.max(
                  beforeTokens,
                  result.preContextTokens ?? result.checkpoint.statistics.preTokens,
                );
                compactedTokens = result.postContextTokens;
                compacted = true;
              } else {
                log.warn('context-overflow compaction did not complete', {
                  status: result.status,
                });
              }
            } catch (error) {
              log.warn('context-overflow compaction failed', {
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
          if (!compacted) {
            const clippedHistory = clipHistoryToolResults(newHistory);
            newHistory.length = 0;
            newHistory.push(...clippedHistory);
          }
          const afterTokens = compactedTokens ?? estimateHistoryTokens(newHistory);
          if (afterTokens < beforeTokens) {
            log.warn('context overflow recovered; retrying with reduced history', {
              beforeTokens,
              afterTokens,
            });
            retrySameTurn = true;
            continue;
          }
        }
        log.warn('stream error', {
          error: streamError,
          contentLen: assistantContent.length,
          toolCallCount: toolCalls.length,
        });
        flushReasoning();
        if (assistantContent.length > 0 || reasoningContent.length > 0 || toolCalls.length > 0) {
          assistantOutputProduced = true;
          // A stream can carry a complete tool call and then die before the loop
          // ever runs it. Every such call needs a result: `buildMessages` emits
          // `tool_calls` on the assistant message but only emits results for
          // calls that have one, so a dangling call makes every later request
          // malformed — Anthropic rejects a `tool_use` with no `tool_result`.
          // Persisting one would carry that past a `--resume` and wedge the
          // session for good, so it is settled here the way an abort settles it.
          const abandonedResults = toolCalls.map<ToolResult>((call, callIndex) => {
            const result = toolFailure(
              'INTERRUPTED: the provider stream ended before this tool ran',
              { toolCallId: call.id, code: 'cancelled', status: 'cancelled' },
            );
            callbacks.onToolResult(result);
            const nestedTraceId = nestedTraceIds[callIndex];
            if (nestedTraceId && options?.nestedToolObserver) {
              options.nestedToolObserver.onToolResult(nestedTraceId, result);
            }
            return result;
          });
          const partialMessage: Message = {
            id:
              (reissuedThisTurn ? undefined : options?.assistantMessageId?.(turn)) ??
              crypto.randomUUID(),
            role: 'assistant',
            content: assistantContent,
            reasoningContent: reasoningContent || undefined,
            providerMetadata: assistantProviderMetadata,
            includeInContext: true,
            kind: 'conversation',
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            toolResults: abandonedResults.length > 0 ? abandonedResults : undefined,
            timestamp: Date.now(),
          };
          newHistory.push(partialMessage);
          // Half an answer that reached the screen has to reach the session file
          // too. This callback is the only writer to it, and skipping it here
          // left the live conversation holding a turn that a `--resume` could
          // not see — the transcript read as though the model never spoke.
          callbacks.onAssistantMessageComplete?.(partialMessage);
        }
        const streamOutcome =
          streamErrorCode === 'stream_stall'
            ? createTerminalOutcome('timed_out', 'stream_stall', {
                partialOutput: hasPartialOutput(),
                message: streamError,
              })
            : streamErrorCode === 'timeout'
              ? createTerminalOutcome('timed_out', 'provider_timeout', {
                  partialOutput: hasPartialOutput(),
                  message: streamError,
                })
              : streamErrorCode === 'transport_interrupted'
                ? createTerminalOutcome('interrupted', 'transport_interrupted', {
                    partialOutput: hasPartialOutput(),
                    message: streamError,
                  })
                : streamErrorCode === 'context_overflow'
                  ? createTerminalOutcome('failed', 'context_overflow', {
                      partialOutput: hasPartialOutput(),
                      message: streamError,
                      providerCode: streamErrorCode,
                    })
                  : streamErrorCode === 'protocol_error'
                    ? createTerminalOutcome('failed', 'protocol_error', {
                        partialOutput: hasPartialOutput(),
                        message: streamError,
                        providerCode: streamErrorCode,
                      })
                    : streamErrorCode === 'auth' || streamErrorCode === 'quota'
                      ? createTerminalOutcome('failed', 'credentials_rejected', {
                          partialOutput: hasPartialOutput(),
                          message: streamError,
                          providerCode: streamErrorCode,
                        })
                      : streamErrorCode === 'output_cap'
                        ? createTerminalOutcome('failed', 'output_cap', {
                            partialOutput: hasPartialOutput(),
                            message: streamError,
                            providerCode: streamErrorCode,
                          })
                        : createTerminalOutcome('failed', 'provider_error', {
                            partialOutput: hasPartialOutput(),
                            message: streamError,
                            providerCode: streamErrorCode,
                          });

        // A transport fault is not a failure of the work. Everything needed to send
        // the turn again is already committed: the partial assistant message was
        // pushed above and every dangling `tool_use` was settled with a `cancelled`
        // result, so the history stays valid to the provider and no tool re-executes.
        //
        // Output-cap continuations draw on their own allowance: a large generated
        // file legitimately hits the cap turn after turn, and sharing the transport
        // budget would leave nothing for a real socket drop afterwards.
        const recovery = terminalRecovery(streamOutcome);
        const spent = recovery === 'continue' ? outputCapContinues : streamReissues;
        const allowed =
          recovery === 'continue'
            ? (config.retry.outputCapContinuations ?? 0)
            : (config.retry.streamReissueAttempts ?? 0);
        if (
          (recovery === 'reissue' || recovery === 'continue') &&
          spent < allowed &&
          !signal?.aborted
        ) {
          if (recovery === 'continue') outputCapContinues++;
          else streamReissues++;
          log.warn('stream ended mid-turn; re-issuing', {
            turn,
            recovery,
            attempt: spent + 1,
            allowed,
            reason: streamOutcome.reason,
          });
          // Back off before re-sending a transport fault: an immediate retry against
          // a provider that just went quiet usually buys another stall. An output cap
          // is not a fault, so it continues immediately.
          const reissueDelayMs =
            recovery === 'continue'
              ? 0
              : Math.min(config.retry.maxDelayMs, config.retry.baseDelayMs * 2 ** streamReissues);
          callbacks.onRetry?.('transport', spent + 1, allowed, reissueDelayMs);
          await delay(reissueDelayMs, signal);
          if (!signal?.aborted) {
            // Never re-send a request that ENDS with an assistant message.
            //
            // That shape is assistant prefill, which Anthropic rejects outright
            // while extended thinking is on — the default for every Opus and Sonnet
            // model here. The 400 comes back as `provider_error`, whose recovery is
            // `reissue`, so the loop would re-send the identical rejected request
            // until the transport allowance ran out and then report a transport
            // fault for what was really a malformed request. A turn that made tool
            // calls is unaffected: its cancelled `tool_result`s already end the
            // history with a user message.
            //
            // It also delivers the instruction that was otherwise composed into
            // `streamError` and then dropped, because this branch returns before
            // `callbacks.onError`.
            if (newHistory.at(-1)?.role === 'assistant') {
              const resume: Message = {
                id: crypto.randomUUID(),
                role: 'user',
                content:
                  recovery === 'continue'
                    ? '[continuation] Your previous message was cut off at the output limit. Continue from exactly where you stopped. Do not restart or repeat what you already wrote.'
                    : '[continuation] The connection dropped before your previous message finished. Continue from exactly where you stopped. Do not restart or repeat what you already wrote.',
                includeInContext: true,
                kind: 'conversation',
                timestamp: Date.now(),
              };
              newHistory.push(resume);
              callbacks.onUserMessageAppended?.(resume);
            }
            retrySameTurn = true;
            continue;
          }
        }

        // A parked run is not a failed one: nothing is wrong with the work, it
        // needs an operator. Escalate so a supervisor can wait for a new key
        // rather than tear the objective down.
        if (terminalRecovery(streamOutcome) === 'park' && !options?.isSubagent) {
          runHooks(
            config.settings.hooks.Notification,
            'Notification',
            {
              workspace: config.workspace,
              event: 'Notification',
              severity: 'alarm',
              kind: 'credentials_rejected',
              message: streamError,
            },
            { onHookEvent: callbacks.onHookEvent },
          ).catch(() => {});
        }

        callbacks.onError(streamError);
        finishTerminal(streamOutcome);
        return newHistory;
      }

      // If we got no done event and no error, the stream was aborted or
      // ended unexpectedly — keep what we have and finish.
      if (!streamDone && signal?.aborted) {
        flushReasoning();
        const cancelledResults = toolCalls.map<ToolResult>((call, callIndex) => {
          const result = toolFailure('CANCELLED: Agent execution was interrupted', {
            toolCallId: call.id,
            code: 'cancelled',
            status: 'cancelled',
          });
          callbacks.onToolResult(result);
          const nestedTraceId = nestedTraceIds[callIndex];
          if (nestedTraceId && options?.nestedToolObserver) {
            options.nestedToolObserver.onToolResult(nestedTraceId, result);
          }
          return result;
        });
        if (assistantContent.length > 0 || reasoningContent.length > 0 || toolCalls.length > 0) {
          assistantOutputProduced = true;
          const cancelledMessage: Message = {
            id: crypto.randomUUID(),
            role: 'assistant',
            content: assistantContent,
            reasoningContent: reasoningContent || undefined,
            providerMetadata: assistantProviderMetadata,
            includeInContext: true,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            toolResults: cancelledResults.length > 0 ? cancelledResults : undefined,
            timestamp: Date.now(),
          };
          newHistory.push(cancelledMessage);
          callbacks.onAssistantMessageComplete?.(cancelledMessage);
        }
        break;
      }

      recordTurnUsage();

      const publishResult = (callIndex: number, result: ToolResult): void => {
        callbacks.onToolResult(result);
        const nestedTraceId = nestedTraceIds[callIndex];
        if (nestedTraceId && options?.nestedToolObserver) {
          options.nestedToolObserver.onToolResult(nestedTraceId, result);
        }
      };

      const duplicateIds = [
        ...new Set(
          toolCalls.map((call) => call.id).filter((id, index, ids) => ids.indexOf(id) !== index),
        ),
      ];
      if (duplicateIds.length > 0) {
        const message = `Provider returned duplicate tool call IDs: ${duplicateIds.join(', ')}. The batch was rejected before execution.`;
        for (let index = 0; index < toolCalls.length; index++) {
          publishResult(
            index,
            toolFailure(message, {
              toolCallId: toolCalls[index].id,
              code: 'duplicate_tool_call_id',
              status: 'blocked',
              remediation: 'Retry with a unique ID for every tool call in the assistant turn.',
            }),
          );
        }
        callbacks.onError(message);
        finishTerminal(
          createTerminalOutcome('failed', 'protocol_error', {
            partialOutput: assistantContent.length > 0 || hasPartialOutput(),
            message,
          }),
        );
        const malformedMessage: Message = {
          id:
            (reissuedThisTurn ? undefined : options?.assistantMessageId?.(turn)) ??
            crypto.randomUUID(),
          role: 'assistant',
          content: [assistantContent, `[Tool batch rejected: ${message}]`]
            .filter(Boolean)
            .join('\n\n'),
          reasoningContent: reasoningContent || undefined,
          providerMetadata: assistantProviderMetadata,
          includeInContext: true,
          timestamp: Date.now(),
        };
        assistantOutputProduced = true;
        newHistory.push(malformedMessage);
        callbacks.onAssistantMessageComplete?.(malformedMessage);
        break;
      }

      type PreparedLoopCall = {
        index: number;
        call: ToolCall;
        canonName: string;
        nestedTraceId?: string;
        prepared: PreparedToolCall;
        context: ToolContext;
        parallel: boolean;
        modeAtPreparation: PermissionMode;
        previousModeAtPreparation: PermissionMode | undefined;
        pendingPlanApprovalAtPreparation: ToolContext['pendingPlanApproval'];
        pendingUserQuestionAtPreparation: ToolContext['pendingUserQuestion'];
      };

      // Canonicalize tool names and argument spellings once, before hooks,
      // permission evaluation, primary-arg display, and persistence see the call —
      // aliased arguments must not bypass path-scoped permission rules.
      for (let index = 0; index < toolCalls.length; index++) {
        toolCalls[index] = registry.normalizeCall(toolCalls[index]);
      }

      const toolResults: Array<ToolResult | undefined> = new Array(toolCalls.length);
      const prepareToolCall = async (
        callIndex: number,
        parallel: boolean,
      ): Promise<PreparedLoopCall | undefined> => {
        const originalCall = toolCalls[callIndex];
        if (signal?.aborted) {
          toolResults[callIndex] = toolFailure('CANCELLED: Agent execution was interrupted', {
            toolCallId: originalCall.id,
            code: 'cancelled',
            status: 'cancelled',
          });
          return undefined;
        }

        const call = originalCall;
        const canonName = canonicalToolName(registry.getTool(call.name)?.name ?? call.name);
        const nestedTraceId = nestedTraceIds[callIndex];

        const preHookResults = await runHooks(
          config.settings.hooks.PreToolUse,
          'PreToolUse',
          {
            workspace: config.workspace,
            event: 'PreToolUse',
            toolName: canonName,
            toolArgs: call.arguments,
          },
          { onHookEvent: callbacks.onHookEvent, signal },
        );
        const blocked = preHookResults.find((result) => result.action === 'block');
        if (blocked) {
          toolResults[callIndex] = toolFailure(
            `SKIPPED: Blocked by hook${blocked.message ? `: ${blocked.message}` : ''}`,
            { toolCallId: call.id, code: 'hook_blocked', status: 'blocked' },
          );
          return undefined;
        }

        syncHostMode();
        const planReadOnly = effectiveMode === 'plan' && READ_ONLY_PLAN_TOOLS.has(canonName);
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
          toolResults[callIndex] = toolFailure(`SKIPPED: ${message}`, {
            toolCallId: call.id,
            code: 'skill_execution_denied',
            status: 'blocked',
          });
          return undefined;
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
            toolResults[callIndex] = toolFailure(`SKIPPED: ${message}`, {
              toolCallId: call.id,
              code: 'skill_tool_intersection_empty',
              status: 'blocked',
              remediation:
                'Finish the active skill or choose skills with compatible allowed-tools.',
            });
            return undefined;
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

        if (isUserQuestion && effectiveMode === 'dontAsk') {
          toolResults[callIndex] = toolFailure(
            'SKIPPED: User questions are disabled in dontAsk mode',
            { toolCallId: call.id, code: 'user_questions_disabled', status: 'blocked' },
          );
          return undefined;
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
        const hardDeny = evaluatePermissionDetail(canonName, call.arguments, config.settings);
        if (hardDeny.decision === 'deny') {
          // Consent was requested a few lines up; close it out, or the registry
          // keeps an activation request that never resolves. The later
          // permission-block deny does the same.
          if (forceSkillPermission && invokedSkillName && skillActivationReason) {
            skillRegistry.denyConsent(invokedSkillName, skillActivationReason, 'permission_denied');
          }
          toolResults[callIndex] = toolFailure('SKIPPED: Permission denied', {
            toolCallId: call.id,
            code: 'permission_denied',
            status: 'blocked',
            content: permissionDeniedError(canonName, hardDeny.matchedRule),
          });
          return undefined;
        }

        if (
          (forceSkillPermission ||
            requiresToolPermission(effectiveMode, persistentBackgroundShell)) &&
          (persistentBackgroundShell ||
            !approveAllRules.some((rule) => permissionRuleMatchesCall(rule, call))) &&
          !autoSafeTool &&
          (effectiveMode !== 'plan' || planReadOnly)
        ) {
          const autoApproved = effectiveMode === 'accept-edits' && isFileMutatingTool(canonName);
          if (!autoApproved) {
            let permission: 'allow' | 'deny' | 'always' | undefined;
            let chosenRule: string | undefined;
            if (
              (forceSkillPermission || effectiveMode !== 'dontAsk') &&
              !persistentBackgroundShell
            ) {
              const verdict = evaluatePermissionDetail(canonName, call.arguments, config.settings);
              if (verdict.decision === 'allow') permission = 'allow';
              else if (verdict.decision === 'deny') permission = 'deny';
            }
            if (permission === undefined && effectiveMode !== 'dontAsk') {
              const decision = await callbacks.onPermissionRequired(call);
              permission = permissionResultOf(decision);
              chosenRule = permissionRuleOf(decision);
            }
            permission ??= 'deny';
            emitHarnessRuntimeEvent('permission_resolved', {
              toolName: canonName,
              decision: permission,
            });

            if (permission === 'deny') {
              log.debug('permission denied', { tool: canonName });
              if (forceSkillPermission && invokedSkillName && skillActivationReason) {
                skillRegistry.denyConsent(
                  invokedSkillName,
                  skillActivationReason,
                  effectiveMode === 'dontAsk' ? 'dont_ask' : 'user_denied',
                );
              }
              const verdict = evaluatePermissionDetail(canonName, call.arguments, config.settings);
              toolResults[callIndex] = toolFailure('SKIPPED: Permission denied', {
                toolCallId: call.id,
                code: 'permission_denied',
                status: 'blocked',
                content: permissionDeniedError(canonName, verdict.matchedRule),
              });
              return undefined;
            }
            if (permission === 'always' && !persistentBackgroundShell) {
              log.debug('permission always', { tool: canonName });
              const rule = chosenRule ?? permissionRuleForToolCall(call);
              approveAllRules.push(rule);
              if (callbacks.onPersistPermissionRule) {
                callbacks.onPersistPermissionRule(rule);
              }
            }
          }
        }

        if (effectiveMode === 'plan' && !READ_ONLY_PLAN_TOOLS.has(canonName)) {
          log.debug('plan mode blocked mutating tool', { tool: canonName });
          toolResults[callIndex] = toolFailure(
            `SKIPPED: Tool "${canonName}" is not allowed in plan mode. Call ExitPlanMode with your plan and wait for approval before making changes.`,
            { toolCallId: call.id, code: 'plan_mode_blocked', status: 'blocked' },
          );
          return undefined;
        }

        if (forceSkillPermission && invokedSkillName && skillActivationReason) {
          skillRegistry.grantConsent(invokedSkillName, skillActivationReason);
        }

        const preparedResult = registry.prepare(call, toolContext);
        if (preparedResult.status === 'rejected') {
          toolResults[callIndex] = preparedResult.result;
          return undefined;
        }
        const prepared = preparedResult.prepared;

        const context = parallel
          ? {
              ...toolContext,
              currentToolTraceId: nestedTraceId ?? prepared.call.id,
              todos: toolContext.todos ? [...toolContext.todos] : undefined,
              tasks: toolContext.tasks ? [...toolContext.tasks] : undefined,
              agentPath: toolContext.agentPath ? [...toolContext.agentPath] : undefined,
            }
          : toolContext;
        if (!parallel) context.currentToolTraceId = nestedTraceId ?? prepared.call.id;

        return {
          index: callIndex,
          call: prepared.call,
          canonName,
          nestedTraceId,
          prepared,
          context,
          parallel,
          modeAtPreparation: effectiveMode,
          previousModeAtPreparation: context.previousMode,
          pendingPlanApprovalAtPreparation: context.pendingPlanApproval,
          pendingUserQuestionAtPreparation: context.pendingUserQuestion,
        };
      };

      const executeToolCall = async (entry: PreparedLoopCall): Promise<ToolResult> => {
        const toolStartMs = clock.monotonicNowMs();
        emitHarnessRuntimeEvent('tool_started', {
          toolName: entry.canonName,
          toolCallId: entry.call.id,
        });
        log.debug('tool start', {
          name: entry.canonName,
          id: entry.call.id,
          args: Object.keys(entry.call.arguments),
          parallel: entry.parallel,
        });
        try {
          const execute = () =>
            registry.executePrepared(entry.prepared, entry.context, retry.toolRetries);
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
      };

      const finalizeToolCall = async (
        entry: PreparedLoopCall,
        initialResult: ToolResult,
      ): Promise<ToolResult> => {
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
          if (
            result.artifacts?.fileMutation ||
            result.artifacts?.fileMutations ||
            canonName === 'Bash'
          ) {
            runtime.agentContextCache.invalidateWorkspace(config.workspace);
          } else if (canonName.startsWith('Git')) {
            runtime.agentContextCache.invalidateGit(config.workspace);
          }
        }

        const modeAfterTool = context.currentMode ?? effectiveMode;
        if (modeAfterTool !== effectiveMode) {
          effectiveMode = modeAfterTool;
          callbacks.onModeChange?.(effectiveMode);
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
              handoffRequested = { plan: approvedPlan, mode: restoredMode };
              callbacks.onPlanHandoff?.(handoffRequested);
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
            planStopRequested = { plan: submittedPlan, message: approval.message };
            result = replaceToolResult(result, {
              status: 'blocked',
              content: '',
              error: {
                code: 'plan_approval_unavailable',
                message: `STOPPED: ${approval.message}`,
                retryable: false,
                remediation:
                  'Do not call ExitPlanMode again: this run ends with the plan as its result.',
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

          const modeAfterApproval = context.currentMode ?? effectiveMode;
          if (modeAfterApproval !== effectiveMode) {
            effectiveMode = modeAfterApproval;
            callbacks.onModeChange?.(effectiveMode);
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

        const postHookResults = await runHooks(
          config.settings.hooks.PostToolUse,
          'PostToolUse',
          {
            workspace: config.workspace,
            event: 'PostToolUse',
            toolName: canonName,
            toolArgs: call.arguments,
            toolOutput: toolResultSucceeded(result)
              ? result.content
              : (toolResultErrorMessage(result) ?? ''),
          },
          { onHookEvent: callbacks.onHookEvent, signal },
        );
        for (const hookResult of postHookResults) {
          if (hookResult.action === 'modify' && hookResult.modifiedOutput !== undefined) {
            result = replaceToolResult(result, { content: hookResult.modifiedOutput });
          }
        }

        if (
          !options?.isSubagent &&
          config.settings.agents.routing.exploreReminder &&
          toolResultSucceeded(result) &&
          (canonName === 'Glob' || canonName === 'Grep')
        ) {
          const manager = runtime.agentManager;
          const explorerActive = manager?.hasActiveProfile('explorer') ?? false;
          if (explorerActive)
            manager?.recordRoutingTelemetry('parent_search_while_explorer_active');
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
          !options?.isSubagent &&
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

        return boundToolResultOutput(
          enrichToolResultPresentation(result, canonName, call.arguments),
          context.workspaceRoot,
          undefined,
          options?.toolOutputRoot,
        );
      };

      const finishCall = async (entry: PreparedLoopCall, result: ToolResult): Promise<void> => {
        const normalized = await finalizeToolCall(entry, result);
        toolResults[entry.index] = normalized;
      };
      const resultAt = (index: number): ToolResult => {
        const result = toolResults[index];
        if (result) return result;
        const fallback = toolFailure('Tool execution finished without a result', {
          toolCallId: toolCalls[index].id,
          code: 'missing_tool_result',
        });
        toolResults[index] = fallback;
        return fallback;
      };

      for (let callIndex = 0; callIndex < toolCalls.length;) {
        const definition = registry.getTool(toolCalls[callIndex].name);
        const parallel = definition?.policy?.concurrency === 'parallel';
        if (!parallel) {
          const entry = await prepareToolCall(callIndex, false);
          if (entry) await finishCall(entry, await executeToolCall(entry));
          publishResult(callIndex, resultAt(callIndex));
          // A COPY. The runtime's array is mutated in place (M2's discipline, so the
          // context and the runtime cannot diverge), which means every call would
          // otherwise hand a consumer the identical reference — and React's
          // `useState` identity bail-out, plus any `useMemo` keyed on it, would stop
          // seeing changes.
          if (callbacks.onTodos && toolContext.todos) callbacks.onTodos([...toolContext.todos]);
          if (callbacks.onTasks && toolContext.tasks) callbacks.onTasks(toolContext.tasks);
          callIndex++;
          continue;
        }

        const waveStart = callIndex;
        while (
          callIndex < toolCalls.length &&
          registry.getTool(toolCalls[callIndex].name)?.policy?.concurrency === 'parallel'
        ) {
          callIndex++;
        }
        const entries: PreparedLoopCall[] = [];
        for (let index = waveStart; index < callIndex; index++) {
          const entry = await prepareToolCall(index, true);
          if (entry) entries.push(entry);
        }
        const settled = await Promise.allSettled(entries.map((entry) => executeToolCall(entry)));
        for (let index = 0; index < entries.length; index++) {
          const execution = settled[index];
          const result =
            execution.status === 'fulfilled'
              ? execution.value
              : toolFailure(
                  execution.reason instanceof Error
                    ? execution.reason.message
                    : String(execution.reason),
                  { toolCallId: entries[index].call.id, code: 'tool_exception' },
                );
          await finishCall(entries[index], result);
        }
        for (let index = waveStart; index < callIndex; index++) {
          publishResult(index, resultAt(index));
          // A COPY. The runtime's array is mutated in place (M2's discipline, so the
          // context and the runtime cannot diverge), which means every call would
          // otherwise hand a consumer the identical reference — and React's
          // `useState` identity bail-out, plus any `useMemo` keyed on it, would stop
          // seeing changes.
          if (callbacks.onTodos && toolContext.todos) callbacks.onTodos([...toolContext.todos]);
          if (callbacks.onTasks && toolContext.tasks) callbacks.onTasks(toolContext.tasks);
        }
      }

      const orderedToolResults = toolResults.map((_result, index) => resultAt(index));
      flushSkillEvents();

      // Two counters the brakes depend on, kept here because this is the only place
      // a turn's calls and their settled results are both in scope.
      //
      // A refused call is not progress and must not read as progress. `blocked` is a
      // policy or user decision and `cancelled` is an abort; neither ran, so neither
      // counts toward the witness. Everything that did run counts, including errors —
      // an error-spin is caught by the witness freezing on identical file hashes.
      let refusedThisTurn = 0;
      for (let index = 0; index < toolCalls.length; index++) {
        const status = orderedToolResults[index]?.status;
        // Neither a refusal nor an abort ran, so neither counts as progress. Only a
        // refusal feeds the spin streak though: an abort already ends the run by
        // its own path, and counting it would attribute a user's Ctrl-C to policy.
        if (status === 'blocked') refusedThisTurn++;
        if (status === 'blocked' || status === 'cancelled') continue;
        executedToolCalls++;
      }
      if (toolCalls.length > 0 && refusedThisTurn === toolCalls.length) {
        blockedTurnStreak++;
        blockedTurnTools = toolCalls.map((call) => canonicalToolName(call.name));
      } else {
        blockedTurnStreak = 0;
        blockedTurnTools = [];
      }

      const toolStats = toolContext.runtime?.toolCallStats;
      if (toolStats) {
        for (let index = 0; index < toolCalls.length; index++) {
          const name = canonicalToolName(toolCalls[index].name);
          const entry = toolStats.get(name) ?? { calls: 0, failures: {} };
          entry.calls++;
          const result = orderedToolResults[index];
          // Blocked (policy/user decision) and cancelled outcomes are not tool
          // failures; only real errors and timeouts count against reliability.
          if (result.status === 'error' || result.status === 'timed_out') {
            const code = result.structuredError?.code ?? result.status;
            entry.failures[code] = (entry.failures[code] ?? 0) + 1;
          }
          toolStats.set(name, entry);
        }
      }

      // Persistent, cross-session tool-use telemetry (additive to toolCallStats
      // above). Captured here so status reflects post-mutation outcomes. Records
      // the raw status plus a derived isFailure — blocked/cancelled are not
      // reliability failures and must not inflate the fail rate. Best-effort.
      if (config.settings.observability.toolTelemetry && toolCalls.length > 0) {
        const recordedAt = Date.now();
        const records: ToolUseRecord[] = [];
        for (let index = 0; index < toolCalls.length; index++) {
          const result = orderedToolResults[index];
          const isFailure = result.status === 'error' || result.status === 'timed_out';
          records.push({
            ts: recordedAt,
            session: runtime.traceId,
            tool: canonicalToolName(toolCalls[index].name),
            status: result.status,
            isFailure,
            errorCode: isFailure ? (result.structuredError?.code ?? result.status) : undefined,
            durationMs: result.metrics?.durationMs,
            retries: Math.max(0, (result.metrics?.retryAttempt ?? 1) - 1),
            model: effectiveConfig.model,
            subagent: options?.isSubagent === true,
            agentRole: options?.agentRole,
          });
        }
        void appendToolUseRecords(records, { root: options?.toolTelemetryRoot });
      }

      const assistantMessage: Message = {
        id:
          (reissuedThisTurn ? undefined : options?.assistantMessageId?.(turn)) ??
          crypto.randomUUID(),
        role: 'assistant',
        content: assistantContent,
        reasoningContent: reasoningContent || undefined,
        providerMetadata: assistantProviderMetadata,
        includeInContext: true,
        kind: 'conversation',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        toolResults: orderedToolResults.length > 0 ? orderedToolResults : undefined,
        fileObservations: orderedToolResults.flatMap(
          (result) => result.artifacts?.fileObservations ?? [],
        ),
        timestamp: Date.now(),
      };
      if (assistantContent.length > 0 || reasoningContent.length > 0 || toolCalls.length > 0) {
        assistantOutputProduced = true;
      }
      newHistory.push(assistantMessage);
      callbacks.onAssistantMessageComplete?.(assistantMessage);

      log.info('turn complete', {
        turn,
        contentLen: assistantContent.length,
        toolCallCount: toolCalls.length,
        toolResultCount: toolResults.length,
      });

      // The run's only always-on liveness signal. Written at the turn boundary
      // because that is the one place a stalled run is distinguishable from a
      // working one: the transcript's mtime advances identically for both.
      if (options?.statusWriter) {
        const todos = toolContext.todos ?? [];
        options.statusWriter.update({
          turn,
          lastTool: toolCalls.length
            ? canonicalToolName(toolCalls[toolCalls.length - 1].name)
            : undefined,
          currentTodo: todos.find((todo) => todo.status === 'in_progress')?.content,
          openTodos: todos.filter((todo) => todo.status !== 'completed').length,
          costUsd: options.runContext
            ? runtime.runAccounting.snapshotRoot(options.runContext.rootRunId).inclusiveCostUsd
            : null,
        });
      }

      // Every tool call refused, N turns running.
      //
      // This is checked BEFORE the turn-end gate below, and that placement is the
      // whole point: a refusal spin never has an empty turn, so the gate never
      // fires and the continuation brake never gets to look at it. The run simply
      // bills forever with a plan that cannot move. Nothing else catches it either
      // — `noteRepeatedFailure` returns early unless the status is `error`, and
      // `toolCallStats.failures` excludes `blocked` by construction.
      //
      // Not gated on `continuation.enabled`: this spin predates continuation and
      // happens today in headless, which answers every unresolved prompt `deny`.
      //
      // Unattended hosts only. In the TUI a refusal is a person saying no, and they
      // are right there to say something else next; ending their session as
      // `failed / all_tools_blocked` because they declined three calls would be
      // absurd. Plan mode is excluded for the same reason — a model probing `Edit`
      // before it calls `ExitPlanMode` is blocked by design, not stuck.
      const blockedTurnLimit = options?.unattended
        ? config.settings.continuation.blockedToolTurnLimit
        : 0;
      if (
        blockedTurnLimit > 0 &&
        effectiveMode !== 'plan' &&
        blockedTurnStreak >= blockedTurnLimit
      ) {
        const refused = [...new Set(blockedTurnTools)].sort().join(', ');
        log.warn('every tool call refused on consecutive turns; stopping', {
          turn,
          turns: blockedTurnStreak,
          tools: refused,
        });
        const detail =
          `Every tool call was refused on ${blockedTurnStreak} consecutive turns (${refused}). ` +
          'Nothing can proceed: grant the permission, add an allow rule, or change the permission mode.';
        callbacks.onError(detail);
        finishTerminal(
          createTerminalOutcome('failed', 'all_tools_blocked', {
            partialOutput: hasPartialOutput(),
            message: detail,
          }),
        );
        return newHistory;
      }

      if (toolCalls.length === 0 || signal?.aborted || handoffRequested || planStopRequested) {
        // The turn produced no tool calls. Historically that ended the run, making
        // one user message the whole run — a model that says "I've finished"
        // stopped there with half its plan outstanding. Ask whether there is
        // demonstrably work left, and if so append a host-authored user turn and
        // keep going in the SAME invocation, so the tool context and todo list
        // survive and `ensureSessionState` attaches a fresh block.
        const witness = buildProgressWitness({
          todos: toolContext.todos ?? [],
          fileObservations: runtime.fileObservationLedger,
          toolCallCount: executedToolCalls,
        });
        const decision = decideContinuation({
          settings: config.settings.continuation,
          todos: toolContext.todos ?? [],
          tasks: toolContext.tasks ?? [],
          consecutive: continuationCount,
          priorWitnesses: continuationWitnesses,
          witness,
          elapsedMs: clock.monotonicNowMs() - runStartedAt,
          aborted: signal?.aborted,
          handoffRequested: Boolean(handoffRequested),
          planStopRequested: Boolean(planStopRequested),
        });
        if (decision.kind === 'continue') {
          continuationCount++;
          continuationWitnesses.push(witnessSignature(witness));
          const message: Message = {
            id: crypto.randomUUID(),
            role: 'user',
            content: decision.prompt,
            includeInContext: true,
            // Load-bearing: `splitUserLedBundles` opens a compaction bundle on
            // `role === 'user' && kind !== 'checkpoint'`.
            kind: 'conversation',
            timestamp: Date.now(),
          };
          newHistory.push(message);
          callbacks.onUserMessageAppended?.(message);
          log.info('continuing run', {
            turn,
            consecutive: continuationCount,
            trigger: decision.trigger,
          });
          continue;
        }
        // A completed plan is the model's opinion. Give the project a chance to
        // refuse it: a blocking Stop hook (`npm run check`, a lint gate) turns
        // "I'm finished" into another turn carrying the reason it is not.
        if (
          decision.reason === 'objective_complete' &&
          config.settings.continuation.enabled &&
          !options?.isSubagent &&
          config.settings.hooks.Stop.length > 0 &&
          continuationCount < config.settings.continuation.maxConsecutive
        ) {
          const gate = await runHooks(
            config.settings.hooks.Stop,
            'Stop',
            { workspace: config.workspace, event: 'Stop', status: 'completed' },
            { onHookEvent: callbacks.onHookEvent },
          ).catch(() => []);
          const blocked = gate.find((result) => result.action === 'block');
          // Either way the gate has just run `Stop` for this completion. If it
          // blocked, the run continues and a later terminal is a fresh event, so
          // this is cleared below; if it passed, the terminal fire must not run the
          // same check a second time.
          stopGateSatisfied = true;
          if (blocked) {
            stopGateSatisfied = false;
            continuationCount++;
            continuationWitnesses.push(witnessSignature(witness));
            const message: Message = {
              id: crypto.randomUUID(),
              role: 'user',
              content: [
                '[continuation] A completion gate refused this as finished.',
                '',
                blocked.message ?? 'The configured Stop hook blocked completion.',
                '',
                'Address that, then finish. Do not simply repeat that you are done.',
              ].join('\n'),
              includeInContext: true,
              kind: 'conversation',
              timestamp: Date.now(),
            };
            newHistory.push(message);
            callbacks.onUserMessageAppended?.(message);
            log.info('completion gate blocked; continuing', { turn });
            continue;
          }
        }
        continuationStop = decision.reason;
        break;
      }
    }

    // Both are assigned inside `finalizeToolCall`, a nested async arrow. TypeScript's
    // control-flow analysis does not follow assignments made in a nested function, so
    // out here it still believes each holds its initialiser and narrows the truthy
    // branch to `never` — reading `.message` off it is a compile error without this.
    // The existing truthiness tests above survive only because they never dereference.
    const planStopOutcome = planStopRequested as { plan: string; message: string } | null;
    const handoffOutcome = handoffRequested as { plan: string; mode: PermissionMode } | null;

    const finalMessage = newHistory.at(-1);
    if (
      config.maxTurns != null &&
      config.maxTurns > 0 &&
      turn >= config.maxTurns &&
      finalMessage?.role === 'assistant' &&
      (finalMessage.toolCalls?.length ?? 0) > 0 &&
      !signal?.aborted &&
      // A plan stop is a deliberate stop, not an exhausted budget: the last
      // turn ends with tool calls, but nothing was left to do.
      !planStopRequested
    ) {
      log.warn('max turns reached', { maxTurns: config.maxTurns });
      callbacks.onError(
        `Reached max turns (${config.maxTurns}). Refine your prompt or increase BOOK_MAX_TURNS.`,
      );
      finishTerminal(
        createTerminalOutcome('failed', 'max_turns', {
          partialOutput: hasPartialOutput(),
          message: `Reached max turns (${config.maxTurns}).`,
        }),
      );
    }

    if (!terminalEmitted) {
      // A continued run reports why it stopped. `no_progress`, `blocked_plan`, and
      // `continuation_limit` are failures — the objective was not reached, and a
      // supervisor must be able to tell that from an honest completion.
      const continuationOutcome =
        continuationStop === 'no_progress'
          ? createTerminalOutcome('failed', 'no_progress', {
              partialOutput: hasPartialOutput(),
              message:
                'The run made no observable progress across consecutive continuations: no todo, file, or tool-call change.',
            })
          : continuationStop === 'blocked_plan'
            ? createTerminalOutcome('failed', 'blocked_plan', {
                partialOutput: hasPartialOutput(),
                message:
                  'Every remaining task is blocked by unfinished work, so nothing can be done next.',
              })
            : continuationStop === 'continuation_limit' || continuationStop === 'wall_clock'
              ? createTerminalOutcome('failed', 'continuation_limit', {
                  partialOutput: hasPartialOutput(),
                  message:
                    continuationStop === 'wall_clock'
                      ? 'Stopped at the configured wall-clock ceiling.'
                      : `Stopped after ${continuationCount} continuations without finishing the plan.`,
                })
              : continuationStop === 'objective_complete'
                ? createTerminalOutcome('completed', 'objective_complete', {
                    partialOutput: false,
                  })
                : undefined;
      // A plan stop and a handoff are both honest ends, but they are not the same
      // end as "the model finished". They used to be byte-identical to real
      // success, so a supervisor could not tell an objective that completed from
      // one that stopped to hand the plan back — and the operator's own message
      // explaining the stop was dropped on the floor. Status stays `completed`,
      // because neither is a failure; only the vocabulary gets more precise.
      const handoverOutcome = planStopOutcome
        ? createTerminalOutcome('completed', 'plan_stop', {
            partialOutput: false,
            message: planStopOutcome.message,
          })
        : handoffOutcome
          ? createTerminalOutcome('completed', 'handoff_requested', {
              partialOutput: false,
              message: 'The approved plan was handed back to the host to execute.',
            })
          : undefined;
      finishTerminal(
        signal?.aborted
          ? classifyAbortReason(signal.reason, hasPartialOutput())
          : (continuationOutcome ??
              handoverOutcome ??
              createTerminalOutcome('completed', 'normal_completion', {
                partialOutput: false,
              })),
      );
    }

    // Terminal hooks — fire-and-forget once the agent has actually stopped.
    //
    // Stop used to run inside the turn loop, so a task that took twelve
    // tool-call turns fired it twelve times: a hook meant to observe "the agent
    // finished" instead observed "a provider round-trip finished". Here it
    // fires once, after the terminal outcome is settled and before SessionEnd.
    //
    // Neither passes `signal`. Both are pure notifications about a run that has
    // already ended, so there is nothing left to cancel — and `runHooks` calls
    // `signal.throwIfAborted()` ahead of its empty-list guard, so passing an
    // aborted signal skipped the hook and logged a failure warning on every
    // Ctrl-C, even for the majority of users with no terminal hooks configured.
    // Cancellation is precisely when a "the agent stopped" hook matters most.
    //
    // They do share a blind spot: the early `return newHistory` paths (prompt
    // blocked by hook, context overflow, run budget, stream error) skip both.
    // Keeping the two on the same footing is deliberate — a Stop that fired on
    // paths SessionEnd does not would be harder to reason about than one gap
    // covering both.
    //
    // Subagents are excluded: `Task` and every managed agent run this same loop
    // with the parent's hook config, and the manager already fires SubagentStop
    // per child. Without the guard, one user prompt that spawns three managed
    // agents would fire Stop four times, three of them reporting a worktree as
    // the workspace.
    fireTerminalHooks();

    callbacks.onDone();
    return newHistory;
  } finally {
    // Every early `return newHistory` above — a blocked prompt, a context overflow,
    // a spent run budget, an unrecoverable stream error — used to skip both
    // terminal hooks. That gap was defensible for a session a human is watching. It
    // is not when a shell script is the only observer and cannot otherwise tell
    // "finished the objective" from "the socket died". Firing from `finally` closes
    // it; `terminalHooksFired` keeps it exactly once.
    fireTerminalHooks();
    skillRegistry.endRun(signal?.aborted ? 'run_aborted' : 'run_complete');
    flushSkillEvents();
    disposeSkillRestrictions();
    if (ownsRuntime) runtime.dispose();
  }
}

export { needsPermissionCheck, requiresToolPermission };
