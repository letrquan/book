import type { AgentConfig, PermissionMode } from '../types/runtime.js';
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
  resolveContextLimit,
  shouldCompact,
  usagePressureTokens,
} from './compact.js';
import {
  evaluatePermissionDetail,
  permissionRuleForToolCall,
  permissionRuleMatchesCall,
} from '../permissions.js';
import { runHooks } from '../hooks.js';
import { canonicalToolName } from '../tools/aliases.js';
import {
  isToolDefinitionAllowed,
  parseCapabilityRules,
  type CapabilityRule,
} from '../tools/capability-rules.js';
import { createDebugLogger } from '../debug-log.js';
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
  type AgentTerminalOutcome,
} from '../types/terminal.js';
import type { AgentRunContext } from '../types/runs.js';

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
    /** Synthetic host notifications bypass user-authored prompt hooks and memory capture. */
    skipUserPromptHooks?: boolean;
    /** Host identity for each streamed assistant turn. */
    assistantMessageId?: (turn: number) => string | undefined;
    /** True when this loop is a subagent (Task tool) invocation — skips memory auto-capture. */
    isSubagent?: boolean;
    /** Display-only observer for tools invoked by this subagent. */
    nestedToolObserver?: NestedToolObserver;
    /** Trace id of the Task invocation that launched this subagent loop. */
    parentToolTraceId?: string;
    /** Nested agent names from the root agent to this loop. */
    agentPath?: string[];
    /** Extra managed-agent identity and policy appended to the system prompt. */
    systemPromptAppend?: string;
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
  const finishTerminal = (outcome: AgentTerminalOutcome): void => {
    if (terminalEmitted) return;
    terminalEmitted = true;
    callbacks.onTerminal?.(outcome);
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
  skillRegistry.recordPromptCatalog(config.modelInfo?.contextWindow ?? 100_000);
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
      if (verdict.decision === 'allow') permission = 'allow';
      else if (verdict.decision === 'deny') permission = 'deny';
      else if (mode !== 'dontAsk') permission = await callbacks.onPermissionRequired(call);
      approved = permission === 'allow' || permission === 'always';
      if (permission === 'always' && callbacks.onPersistPermissionRule) {
        callbacks.onPersistPermissionRule(permissionRuleForToolCall(call));
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
    todos: [],
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
    /** Avoid re-attempting compact for the same pressure snapshot after skip/fail. */
    let lastCompactAttemptKey: string | null = null;
    let retrySameTurn = false;
    let emptyResponseRetryTurn: number | null = null;
    let forcedCompactTurn: number | null = null;
    let effectiveMode = initialMode;
    /** Set when the user approves a plan with fresh context; ends the turn so the host can reseed. */
    let handoffRequested: { plan: string; mode: PermissionMode } | null = null;
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
            const result = await callbacks.onCompact(newHistory, lastUsage);
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
        log.info('retrying current turn', { turn });
      } else {
        turn++;
        callbacks.onTurnStart(turn);
        log.debug('turn start', { turn, maxTurns: config.maxTurns, mode: effectiveMode });
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
          workflowPolicy: options?.harnessContext?.workflowPolicySection,
        },
        runtime.agentContextCache,
        options?.resolveAttachment,
      );
      let requestTokens = estimateProviderRequestTokens(messages, activeDefinitions);
      const reservedOutputTokens = Math.min(
        Math.max(
          1_024,
          effectiveConfig.modelInfo?.maxOutputTokens ??
            effectiveConfig.maxTokens ??
            Math.floor(contextLimit * 0.2),
        ),
        Math.max(1, contextLimit - 1),
      );
      const usableContextLimit = Math.max(1, contextLimit - reservedOutputTokens);
      const preflightThreshold = Math.floor(usableContextLimit * 0.8);
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
            const result = await callbacks.onCompact(newHistory, estimatedUsage);
            if (result.status === 'compacted') {
              newHistory.length = 0;
              newHistory.push(...result.replacementHistory);
              lastUsage = null;
              lastCompactAttemptKey = null;
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
                  workflowPolicy: options?.harnessContext?.workflowPolicySection,
                },
                runtime.agentContextCache,
                options?.resolveAttachment,
              );
              requestTokens = estimateProviderRequestTokens(messages, activeDefinitions);
            }
          } catch {
            // Deterministic clipping below remains available if model-assisted compaction fails.
          }
        }
      }

      if (preflightEligible) {
        const clippedHistory = clipHistoryToolResults(newHistory);
        if (clippedHistory.some((message, index) => message !== newHistory[index])) {
          newHistory.length = 0;
          newHistory.push(...clippedHistory);
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
              workflowPolicy: options?.harnessContext?.workflowPolicySection,
            },
            runtime.agentContextCache,
            options?.resolveAttachment,
          );
          requestTokens = estimateProviderRequestTokens(messages, activeDefinitions);
          log.info('preflight tool outputs clipped', { requestTokens, contextLimit });
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
      let assistantContent = '';
      let reasoningContent = '';
      const toolCalls: ToolCall[] = [];
      const nestedTraceIds: string[] = [];
      let turnUsage: Usage | null = null;
      let responseMetadata: ProviderResponseMetadata | undefined;
      let assistantProviderMetadata: ProviderMessageMetadata | undefined;

      // Buffer text during streaming so we can discard on retry.
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
          streamError = 'The provider stopped because the response reached its output limit.';
          streamErrorCode = 'protocol_error';
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

      if (
        !streamError &&
        streamDone &&
        assistantContent.trim().length === 0 &&
        toolCalls.length === 0
      ) {
        if (emptyResponseRetryTurn !== turn) {
          emptyResponseRetryTurn = turn;
          log.warn('provider returned an empty completion; retrying once', {
            turn,
            reasoningLen: reasoningContent.length,
            responseId: responseMetadata?.responseId,
          });
          retrySameTurn = true;
          continue;
        }
        streamError =
          'The provider returned an empty response after one retry. Please retry the request.';
        streamErrorCode = 'protocol_error';
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
              const result = await callbacks.onCompact(newHistory, estimatedUsage);
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
          newHistory.push({
            id: crypto.randomUUID(),
            role: 'assistant',
            content: assistantContent,
            reasoningContent: reasoningContent || undefined,
            providerMetadata: assistantProviderMetadata,
            includeInContext: true,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            timestamp: Date.now(),
          });
        }
        callbacks.onError(streamError);
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
                    : createTerminalOutcome('failed', 'provider_error', {
                        partialOutput: hasPartialOutput(),
                        message: streamError,
                        providerCode: streamErrorCode,
                      });
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
          id: options?.assistantMessageId?.(turn) ?? crypto.randomUUID(),
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
            if (
              (forceSkillPermission || effectiveMode !== 'dontAsk') &&
              !persistentBackgroundShell
            ) {
              const verdict = evaluatePermissionDetail(canonName, call.arguments, config.settings);
              if (verdict.decision === 'allow') permission = 'allow';
              else if (verdict.decision === 'deny') permission = 'deny';
            }
            if (permission === undefined && effectiveMode !== 'dontAsk') {
              permission = await callbacks.onPermissionRequired(call);
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
              const rule = permissionRuleForToolCall(call);
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
        const toolStartMs = Date.now();
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
          result.metrics = { ...result.metrics, durationMs: Date.now() - toolStartMs };
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
          if (callbacks.onTodos && toolContext.todos) callbacks.onTodos(toolContext.todos);
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
          if (callbacks.onTodos && toolContext.todos) callbacks.onTodos(toolContext.todos);
        }
      }

      const orderedToolResults = toolResults.map((_result, index) => resultAt(index));
      flushSkillEvents();

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
        id: options?.assistantMessageId?.(turn) ?? crypto.randomUUID(),
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

      if (toolCalls.length === 0 || signal?.aborted || handoffRequested) {
        break;
      }
    }

    const finalMessage = newHistory.at(-1);
    if (
      config.maxTurns != null &&
      config.maxTurns > 0 &&
      turn >= config.maxTurns &&
      finalMessage?.role === 'assistant' &&
      (finalMessage.toolCalls?.length ?? 0) > 0 &&
      !signal?.aborted
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
      finishTerminal(
        signal?.aborted
          ? classifyAbortReason(signal.reason, hasPartialOutput())
          : createTerminalOutcome('completed', 'normal_completion', {
              partialOutput: false,
            }),
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
    if (!options?.isSubagent) {
      runHooks(
        config.settings.hooks.Stop,
        'Stop',
        {
          workspace: config.workspace,
          event: 'Stop',
        },
        { onHookEvent: callbacks.onHookEvent },
      ).catch((err) => console.warn('Stop hook failed:', err));
    }

    // One-shot callers keep the legacy per-loop lifecycle. Multi-turn hosts
    // disable this and fire SessionEnd when the conversation is actually left.
    if (options?.manageSessionHooks !== false) {
      runHooks(
        config.settings.hooks.SessionEnd,
        'SessionEnd',
        {
          workspace: config.workspace,
          event: 'SessionEnd',
        },
        { onHookEvent: callbacks.onHookEvent },
      ).catch((err) => console.warn('SessionEnd hook failed:', err));
    }

    callbacks.onDone();
    return newHistory;
  } finally {
    skillRegistry.endRun(signal?.aborted ? 'run_aborted' : 'run_complete');
    flushSkillEvents();
    disposeSkillRestrictions();
    if (ownsRuntime) runtime.dispose();
  }
}

export { needsPermissionCheck, requiresToolPermission };
