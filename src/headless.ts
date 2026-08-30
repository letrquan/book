import type { AgentConfig } from './types/runtime.js';
import { planWasLost } from './agent/session-state.js';
import { RunStatusWriter } from './run-status.js';
import type { CompactResult, CompactBoundary } from './types/sessions.js';
import type { ImageAttachment, Message, Usage } from './types/messages.js';
import type { HeadlessOptions, HeadlessPlanOutcome, HeadlessResult } from './types/public-sdk.js';
import type {
  PlanApprovalResult,
  UserQuestionRequest,
  UserQuestionResponse,
} from './types/tools.js';
import {
  buildPlanApprovalQuestion,
  planApprovalFromUserQuestionResponse,
  planStopDecision,
} from './tools/plan-mode.js';
import { resolvePrintCommand, type PrintCommandDispatch } from './commands/print-dispatch.js';
import type { CommandContext, HostCommandResult } from './types/commands.js';
import type { AgentCompletionNotification } from './agents/types.js';
import { createTerminalOutcome, type AgentTerminalOutcome } from './types/terminal.js';
import { createAgentRunContext, type AgentRunContext, type AgentRunResult } from './types/runs.js';
import { resolveContextLimit, shouldCompact, usagePressureTokens } from './agent/compact.js';
import type { ToolRegistry } from './tools/registry.js';
import { observationKey } from './tools/file-provenance.js';
import { normalizePersistedTodos } from './tools/todo.js';
import { estimateUsageCost } from './pricing.js';
import { createSessionHistoryTools } from './tools/session-history.js';
import {
  createStreamParser,
  type StreamJsonDiagnostic,
  type StreamJsonEvent,
} from './stream-json.js';
import { AgentSession, type AgentSessionRunRequest } from './session/agent-session.js';
import type { AgentEvent } from './session/agent-events.js';
import {
  buildAgentCompletionMessage,
  takeAgentCompletionBatch,
} from './agents/completion-notification.js';
import { getOrCreateAgentManager } from './agents/manager.js';
import { resolvePermissionMode } from './permission-mode.js';
import { assertHarnessModeAvailable, createHarnessCoordinator } from './harness/coordinator.js';

/**
 * Re-price restored tokens.
 *
 * The tokens are one pool but may have been spent across several models, and the
 * records do not attribute them. Charging the whole pool at the most expensive
 * model's rate keeps the restored total an upper bound — the safe direction for a
 * spend ceiling. Any unpriceable model makes the total unknown.
 */
function carriedCostUsd(usage: Usage, models: readonly string[]): number | null {
  let worst: number | null = null;
  for (const model of models) {
    const quote = estimateUsageCost(model, usage);
    if (quote.status !== 'known') return null;
    worst = worst === null ? quote.costUsd : Math.max(worst, quote.costUsd);
  }
  return worst;
}

/**
 * Read a whole piped prompt for the `text` input format.
 *
 * `-p` has always documented "reads prompt from the flag or stdin", but stdin was
 * only consumed for `--input-format stream-json`, so `book -p < prompt.txt` failed
 * on a prompt it had been handed. A long prompt had to be interpolated into argv.
 *
 * A TTY is left alone and reported as no prompt: an interactive `book -p` with no
 * argument would otherwise block on a read the user has no reason to expect,
 * looking like a hang rather than the usage error it is.
 */
async function readPipedPrompt(stream: NodeJS.ReadableStream): Promise<string | undefined> {
  if ((stream as NodeJS.ReadStream).isTTY) return undefined;
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  }
  const prompt = chunks.join('').trim();
  return prompt || undefined;
}

export async function runHeadless(
  config: AgentConfig,
  registry: ToolRegistry,
  opts: HeadlessOptions,
): Promise<HeadlessResult> {
  // Direct SDK/embedding callers may bypass settings startup. Preserve the
  // fail-before-run-setup boundary for modes this build does not implement.
  const harnessMode = config.settings.harness.mode;
  assertHarnessModeAvailable(harnessMode);
  const mode = resolvePermissionMode(config.settings, opts.mode);
  const stdout = opts.stdout ?? process.stdout;
  const emit = (obj: unknown) => {
    if (obj && typeof obj === 'object' && 'type' in obj) {
      opts.onEvent?.(obj as StreamJsonEvent);
    }
    stdout.write(JSON.stringify(obj) + '\n');
  };
  /** Set once the run's liveness file exists; released in the outer `finally`. */
  let disposeCrashHandlers: (() => void) | undefined;
  const agentSession = new AgentSession();
  const runtime = agentSession.getRuntime();
  // Seed the plan from the resumed session. Both lists are mutated in place by
  // their tools, so pushing into the runtime's arrays is what makes the plan
  // visible to the loop — reassigning would detach the runtime from the
  // ToolContext the loop seeds from.
  runtime.todos.push(...normalizePersistedTodos(opts.plan?.todos));
  if (opts.plan?.tasks?.length) runtime.tasks.push(...opts.plan.tasks);
  // Resuming prior work with nothing to show for it is the case worth naming: an
  // empty list renders as no list at all, so without this the model cannot tell a
  // dropped plan from a task that never had one.
  // `plan === undefined` means no plan record was ever written — an ordinary
  // conversation that never called TodoWrite. Reporting that as "your plan did not
  // survive" told every such resumed session to rebuild a plan it never had, and
  // pushed the model to invent one. Only a record that came back empty is a loss.
  runtime.planUnrestored = planWasLost({
    planRecordExisted: opts.plan !== undefined,
    priorMessages: opts.history.length,
    todos: runtime.todos.length,
    tasks: runtime.tasks.length,
  });
  const harnessCoordinator =
    harnessMode === 'off'
      ? undefined
      : createHarnessCoordinator(harnessMode, { workspace: config.workspace });
  /** Latest terminal outcome per root; the deferred seal uses it after linked turns finish. */
  const harnessRootOutcomes = new Map<string, AgentTerminalOutcome>();

  try {
    if (opts.outputFormat === 'stream-json') {
      emit({ type: 'system', model: config.model, cwd: config.workspace });
    }

    // Resolve or create a session for persistence.
    const store = opts.persistSession === false ? undefined : opts.sessionStore;
    let sessionId = opts.sessionId;
    if (store && !sessionId && opts.sessionName) {
      sessionId = store.findByName(opts.sessionName)?.id;
    }
    if (store && sessionId && opts.forkSession) {
      sessionId = undefined; // start a new session, copy history only
    }
    let sessionName = opts.sessionName;
    let sessionCreated = opts.sessionCreated === true;
    if (store && !sessionId) {
      sessionId = store.create({ cwd: config.workspace, name: sessionName });
      sessionCreated = true;
    }
    if (store && sessionId && !sessionName) {
      sessionName = store.findById(sessionId)?.name;
    }
    if (sessionCreated && sessionId && opts.outputFormat === 'stream-json') {
      emit({ type: 'session', session_id: sessionId });
    }
    if (store && sessionId) {
      registry.registerAll(
        createSessionHistoryTools({ store, sessionId: () => sessionId as string }),
      );
    }

    if (sessionId) {
      await agentSession.startLifecycle(
        config,
        sessionId,
        opts.history.length > 0 ? 'resume' : 'startup',
        {
          onHookEvent: createHookEventHandler(opts, emit),
        },
      );
    }
    const runtimeSessionId = sessionId ?? crypto.randomUUID();

    // The run's liveness file. Headless is the host that most needs it: the
    // default `--output-format text` emits nothing at all until termination, so
    // without this an unattended run is completely opaque while it works. Owned
    // here rather than in the loop because subagents and managed agents call the
    // loop directly and must not each claim to be "the run".
    const statusWriter = new RunStatusWriter({
      sessionId: runtimeSessionId,
      runId: runtimeSessionId,
      workspace: config.workspace,
      budgetUsd: opts.maxBudgetUsd,
      startedAt: Date.now(),
    });
    disposeCrashHandlers = statusWriter.installCrashHandlers();

    // Headless permission policy: if a prompt would be shown and no rule resolves
    // it, deny the tool — headless can't interactively prompt. Callers who want
    // full autonomy should pass mode: 'bypassPermissions'.
    const permissionRequired = async (): Promise<'deny'> => 'deny';

    // The one interactive escape hatch this host has. Everything that needs a
    // human decision (AskUserQuestion, plan approval) goes through it, so
    // `userQuestionStatus` describes both.
    const userQuestionStatus = opts.onUserQuestionRequired ? 'pending' : 'unavailable';
    const askUser = async (
      request: UserQuestionRequest,
      context: { signal?: AbortSignal },
    ): Promise<UserQuestionResponse> => {
      try {
        return opts.onUserQuestionRequired
          ? await opts.onUserQuestionRequired(request, context)
          : {
              action: 'decline',
              message: 'User input is unavailable in non-interactive mode.',
            };
      } catch (error) {
        return {
          action: 'cancel',
          message: `User question handler failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };

    /**
     * Plan approval without a terminal. `bypassPermissions` still auto-approves.
     * A host that supplied a question handler answers the plan through it. A
     * host with no handler cannot approve anything, so the run stops at the
     * first plan instead of retrying ExitPlanMode until --max-turns is gone.
     */
    const decidePlanApproval = async (plan: string): Promise<PlanApprovalResult> => {
      if (mode === 'bypassPermissions') return 'approve';
      if (!opts.onUserQuestionRequired) return planStopDecision('approval_unavailable');
      const request = buildPlanApprovalQuestion(plan, crypto.randomUUID());
      emitAgentEvent({ type: 'user_question', request, status: userQuestionStatus }, opts, emit);
      const response = await askUser(request, { signal: opts.signal });
      emitAgentEvent({ type: 'user_question_result', requestId: request.id, response }, opts, emit);
      return planApprovalFromUserQuestionResponse(request, response);
    };
    /**
     * Set once a plan ends the run because this host could not approve it. Held
     * in a box: the plan-approval callback assigns it from a closure, and a
     * plain `let` would still read as `null` at the output sites below.
     */
    const planNotApplied: { outcome?: HeadlessPlanOutcome } = {};

    let lastUsage: Usage | null = null;
    let lastOutcome: AgentTerminalOutcome | null = null;
    const runResults: AgentRunResult[] = [];
    const recordRunResult = (result: AgentRunResult): void => {
      const existing = runResults.findIndex(
        (candidate) => candidate.context.runId === result.context.runId,
      );
      if (existing >= 0) runResults[existing] = result;
      else runResults.push(result);
    };
    const recordManagedRunResult = (
      agent: Extract<AgentEvent, { type: 'agent_result' }>['agent'],
    ): void => {
      if (!agent.runId) return;
      const context = createAgentRunContext({
        sessionId: agent.parentSessionId ?? runtimeSessionId,
        runId: agent.runId,
        rootRunId: agent.rootRunId ?? agent.runId,
        parentRunId: agent.parentRunId,
        source: 'internal',
        startedAt: agent.runStartedAt ?? agent.startedAt ?? agent.createdAt,
      });
      const outcome =
        agent.runOutcome ??
        (agent.status === 'completed'
          ? createTerminalOutcome('completed', 'normal_completion', { partialOutput: false })
          : createTerminalOutcome('failed', 'runtime_error', {
              partialOutput: Boolean(agent.result),
              message: agent.error ?? `Managed agent ended with status ${agent.status}.`,
            }));
      recordRunResult({
        context,
        outcome,
        usage: agent.runUsage ?? null,
        accounting: runtime.runAccounting.snapshotRun(agent.runId),
        ambient: runtime.snapshotRunAmbient(agent.runId),
      });
    };
    const recordManagedCompletionResult = (notification: AgentCompletionNotification): void => {
      if (
        !notification.runId ||
        runResults.some((candidate) => candidate.context.runId === notification.runId)
      )
        return;
      const completion = notification.completion;
      const outcome =
        notification.outcome ??
        (completion.status === 'completed'
          ? createTerminalOutcome('completed', 'normal_completion', { partialOutput: false })
          : completion.status === 'stopped'
            ? createTerminalOutcome('cancelled', 'user_cancelled', {
                partialOutput: Boolean(completion.summary),
                message: completion.error,
              })
            : completion.status === 'interrupted'
              ? createTerminalOutcome('interrupted', 'transport_interrupted', {
                  partialOutput: Boolean(completion.summary),
                  message: completion.error,
                })
              : createTerminalOutcome('failed', 'runtime_error', {
                  partialOutput: Boolean(completion.summary),
                  message: completion.error,
                }));
      recordRunResult({
        context: createAgentRunContext({
          sessionId: notification.parentSessionId ?? runtimeSessionId,
          runId: notification.runId,
          rootRunId: notification.rootRunId ?? notification.runId,
          parentRunId: notification.parentRunId,
          source: 'internal',
          startedAt: completion.startedAt ?? completion.createdAt,
        }),
        outcome,
        usage: completion.usage ?? null,
        accounting: runtime.runAccounting.snapshotRun(notification.runId),
        ambient: runtime.snapshotRunAmbient(notification.runId),
      });
    };
    const rootContexts = new Map<string, AgentRunContext>();
    let lastHostCompactAttemptKey: string | null = null;
    const contextHistory: Message[] = [...opts.history];
    const transcript: Message[] = [...(opts.transcript ?? opts.history)];
    const compactBoundaries: CompactBoundary[] = [...(opts.compactBoundaries ?? [])];
    for (const message of transcript) {
      for (const observation of message.fileObservations ?? []) {
        const key = observationKey(observation.workspaceId, observation.path);
        const current = runtime.fileObservationLedger.get(key);
        if (!current || current.timestamp <= observation.timestamp) {
          runtime.fileObservationLedger.set(key, observation);
        }
      }
    }

    const loopConfig: AgentConfig = {
      ...config,
      maxTurns: opts.maxTurns ?? config.maxTurns,
    };
    const createRunCallbacks = (
      runContext: AgentRunContext,
      onOutcome: (outcome: AgentTerminalOutcome) => void,
    ): AgentSessionRunRequest['callbacks'] => ({
      onEvent: (event) => {
        if (event.type === 'agent_result') recordManagedRunResult(event.agent);
        if (event.type === 'terminal') {
          lastOutcome = event.outcome;
          onOutcome(event.outcome);
        }
        emitAgentEvent(event, opts, emit);
      },
      // No header rewrite at turn boundaries: load() derives updatedAt from
      // the last appended record, so the on-disk header is never authoritative.
      onTurnStart: () => {},
      onDone: () => {},
      onPermissionRequired: permissionRequired,
      onModeChange: (newMode) => {
        if (opts.outputFormat === 'stream-json') {
          emit({ type: 'mode_change', mode: newMode });
        }
      },
      onPlanApprovalRequired: async (plan) => {
        const decision = await decidePlanApproval(plan);
        if (typeof decision === 'object' && decision.decision === 'stop') {
          planNotApplied.outcome = {
            status: 'not_applied',
            reason: decision.reason,
            plan,
            message: decision.message,
          };
        }
        if (opts.outputFormat === 'stream-json') {
          emit({ type: 'plan_approval', status: planApprovalStatus(decision) });
        }
        return decision;
      },
      onUserQuestionRequired: askUser,
      userQuestionStatus,
      onHookEvent: createHookEventHandler(opts, emit),
      onUsage: (nextUsage) => {
        lastUsage = nextUsage;
        lastHostCompactAttemptKey = null;
      },
      onCompact: async (history, usage) => {
        const outcome = await agentSession.compact({
          config,
          history,
          sourceHistory: transcript,
          compactBoundaries,
          sessionId,
          transcriptOrdinal: transcript.length,
          runContext,
          runtime,
          timelineStore: store,
          onCommitted: (_result, boundary) => compactBoundaries.push(boundary),
          options: {
            trigger: 'auto',
            preContextTokens: usage ? usagePressureTokens(usage) : undefined,
            signal: opts.signal,
            onHookEvent: createHookEventHandler(opts, emit),
          },
        });
        if (outcome.result.status === 'compacted') {
          emitCompactBoundary(opts.outputFormat, emit, outcome.result);
          lastUsage = null;
        }
        return outcome.result;
      },
      onAssistantMessageComplete: (message) => {
        if (!transcript.some((item) => item.id === message.id)) transcript.push(message);
        // The completed turn, always. `--include-partial-messages` adds the deltas
        // on top of this; it does not decide whether the stream carries assistant
        // text at all. Emitting only deltas made the flag load-bearing for the
        // basic contract, which is why leaving it off had to mean "maximum volume".
        if (opts.outputFormat === 'stream-json' && message.content) {
          emit({ type: 'assistant', text: message.content, complete: true });
        }
      },
    });
    const runParentTurn = async (
      prompt: string,
      displayMessage: string,
      userMessage: Message,
      runContext: AgentRunContext,
      commandContext?: CommandContext,
    ): Promise<void> => {
      let runOutcome: AgentTerminalOutcome | undefined;
      lastUsage = null;
      let updated: Message[];
      try {
        updated = await agentSession.run({
          config: loopConfig,
          registry,
          prompt,
          history: contextHistory,
          transcript,
          compactBoundaries,
          mode,
          sessionId: runtimeSessionId,
          timelineStore: store,
          signal: opts.signal,
          callbacks: createRunCallbacks(runContext, (outcome) => {
            runOutcome = outcome;
          }),
          harnessCoordinator,
          harnessFinalize: false,
          runContext,
          maxBudgetUsd: opts.maxBudgetUsd,
          options: {
            displayMessage,
            userMessageId: userMessage.id,
            userMessageTimestamp: userMessage.timestamp,
            userFileObservations: userMessage.fileObservations,
            userAttachments: userMessage.attachments,
            userMessageKind: userMessage.kind,
            manageSessionHooks: sessionId ? false : undefined,
            // Completion messages are host-generated notifications, not user
            // prompts. Keep UserPromptSubmit hooks from rewriting or blocking them.
            skipUserPromptHooks: userMessage.kind === 'agent-notification',
            parentSessionId: runtimeSessionId,
            runContext,
            runtime,
            // Command frontmatter enforcement, exactly as the TUI passes it.
            allowedTools: commandContext?.allowedTools,
            modelOverride: commandContext?.modelOverride,
            commands: commandContext ? [commandContext.command] : undefined,
            statusWriter,
            // No human can resolve a permission prompt here: `permissionRequired`
            // answers `deny` unconditionally.
            unattended: true,
          },
        });
      } catch (error) {
        const failedOutcome =
          runOutcome ??
          createTerminalOutcome('interrupted', 'missing_terminal', { partialOutput: false });
        harnessRootOutcomes.set(runContext.rootRunId, failedOutcome);
        recordRunResult({
          context: runContext,
          outcome: failedOutcome,
          usage: runtime.runAccounting.snapshotRun(runContext.runId)?.directUsage ?? lastUsage,
          accounting: runtime.runAccounting.snapshotRun(runContext.runId),
          ambient: runtime.snapshotRunAmbient(runContext.runId),
        });
        throw error;
      }
      const priorIds = new Set(transcript.map((message) => message.id));
      transcript.push(
        ...updated.filter((message) => !priorIds.has(message.id) && message.role === 'assistant'),
      );
      contextHistory.length = 0;
      contextHistory.push(...updated);
      const turnOutcome =
        runOutcome ??
        createTerminalOutcome('interrupted', 'missing_terminal', {
          partialOutput: updated.some((message) => message.role === 'assistant'),
        });
      harnessRootOutcomes.set(runContext.rootRunId, turnOutcome);
      recordRunResult({
        context: runContext,
        outcome: turnOutcome,
        usage: runtime.runAccounting.snapshotRun(runContext.runId)?.directUsage ?? lastUsage,
        accounting: runtime.runAccounting.snapshotRun(runContext.runId),
        ambient: runtime.snapshotRunAmbient(runContext.runId),
      });
    };

    /**
     * Expand one submitted line's leading `/command` through the same
     * registries and the same `resolveCommandBody` the TUI uses. A command
     * whose effect this host cannot perform throws
     * `UnsupportedPrintCommandError` instead of reaching the model as a
     * literal "/name" string.
     *
     * `runContext` is the root this line is accounted under — the same one a
     * model turn for it would use — so a command the host performs by spawning
     * agents is billed and budget-checked exactly like a turn.
     */
    const dispatchSubmittedPrompt = (
      submitted: string,
      runContext: AgentRunContext,
    ): Promise<PrintCommandDispatch> =>
      opts.expandSlashCommands === false
        ? Promise.resolve({ kind: 'passthrough', prompt: submitted })
        : resolvePrintCommand(submitted, {
            config,
            mode,
            sessionId: runtimeSessionId,
            signal: opts.signal,
            agents: {
              // Built only when an agent-backed command (`/review`) asks for it,
              // and attached to this session's runtime so it is disposed with the
              // run. Its events join the same stream-json output as the main loop,
              // and its finished runs land in `runs` like any other execution.
              manager: () =>
                getOrCreateAgentManager(config, registry.getDefinitions(), {
                  runtime,
                  permissionMode: mode,
                  eventSink: (event) => {
                    if (event.type === 'agent_result') recordManagedRunResult(event.agent);
                    emitAgentEvent(event, opts, emit);
                  },
                  hookEventSink: createHookEventHandler(opts, emit),
                }),
              runContext,
            },
          });

    /**
     * Slash commands the host performed itself, in submission order. A run made
     * only of those never produces a turn outcome, and reporting it as
     * `interrupted` would tell a machine caller that a review which completed
     * had been cut short.
     */
    const commandResults: HostCommandResult[] = [];
    /**
     * Inclusive spend of the most recent host-performed command — the same
     * "latest unit of work" `lastUsage` reports for a model turn.
     *
     * Kept separate rather than folded into `lastUsage`, which drives the
     * cross-turn compaction decision: a review's child-agent totals were never
     * in the parent's context window, and adding them there would compact the
     * parent history against tokens it does not hold.
     */
    let commandUsage: Usage | null = null;

    // Collect prompts: text input -> single prompt, from the flag or stdin;
    // stream-json -> read stdin.
    const prompts: string[] = [];
    if (opts.inputFormat === 'text') {
      const prompt = opts.prompt ?? (await readPipedPrompt(opts.stdin ?? process.stdin));
      if (!prompt) {
        throw new Error(
          'print mode requires a prompt: pass one to -p, pipe one on stdin, or use --input-format stream-json',
        );
      }
      prompts.push(prompt);
    } else {
      // stream-json input: newline-delimited {type:'user', content} from stdin.
      const stream = opts.stdin ?? process.stdin;
      const diagnostics: StreamJsonDiagnostic[] = [];
      const parser = createStreamParser(
        (event) => {
          if (event.type === 'user') prompts.push(event.content);
        },
        {
          maxBufferedLineBytes: opts.maxInputLineBytes,
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        },
      );
      for await (const chunk of stream) {
        parser.feed(chunk as string | Buffer);
      }
      parser.flush();
      if (diagnostics.length > 0) throw new Error(diagnostics[0]?.message);
      if (opts.prompt) prompts.unshift(opts.prompt);
    }

    // A USD cap has to bound the OBJECTIVE, not one prompt. Every submitted line
    // mints a fresh root and `startRoot` seeds the full cap into it, so a hundred
    // stream-json prompts under a $50 cap would authorise $5000 inside a single
    // process. Carry the accumulated spend into each subsequent root through the
    // same seam that already carries it across processes.
    let carriedSpend: { usage: Usage | null; costUsd: number | null } | undefined =
      opts.carriedUsage
        ? {
            usage: opts.carriedUsage,
            costUsd: carriedCostUsd(
              opts.carriedUsage,
              opts.carriedModels?.length ? opts.carriedModels : [config.model],
            ),
          }
        : undefined;

    for (const submitted of prompts) {
      // The run exists before dispatch, not after it. A host-performed command
      // spawns managed agents of its own, and those agents are only budgeted and
      // accounted when they are spawned under a root that already carries
      // `maxBudgetUsd` — resolving the command first would leave `/review`
      // spending outside every cap the caller set.
      const runId = crypto.randomUUID();
      const runContext = createAgentRunContext({
        sessionId: runtimeSessionId,
        runId,
        source: opts.runSource ?? 'headless',
        resumedFromRunId:
          runResults.length === 0
            ? (opts.resumedFromRunId ??
              (opts.history.length > 0
                ? [...opts.history].reverse().find((message) => message.role === 'user')?.id
                : undefined))
            : undefined,
      });
      runtime.runAccounting.startRoot(runContext, opts.maxBudgetUsd);
      // Carry spend forward from earlier processes of this session, so a USD cap
      // bounds the objective rather than one process.
      if (carriedSpend) {
        runtime.runAccounting.seedRoot(runContext.rootRunId, carriedSpend);
      }

      const dispatch = await dispatchSubmittedPrompt(submitted, runContext);
      if (dispatch.kind === 'prompt' && dispatch.shellErrors?.length) {
        // The TUI drops these silently; a non-interactive host that swallowed
        // them would ship "[shell error: …]" into the prompt with no trace.
        for (const shellError of dispatch.shellErrors) {
          process.stderr.write(`warning: ${shellError}\n`);
        }
      }
      if (dispatch.kind === 'handled') {
        // The effect handler already did the work: no model turn for this line.
        const handled: HostCommandResult = {
          command: dispatch.command,
          output: dispatch.output,
          data: dispatch.data,
        };
        commandResults.push(handled);
        const accounting = runtime.runAccounting.snapshotRoot(runContext.rootRunId);
        commandUsage = accounting.inclusiveUsage ?? commandUsage;
        recordRunResult({
          context: runContext,
          outcome: createTerminalOutcome('completed', 'normal_completion', {
            partialOutput: false,
          }),
          // The host itself made no provider call; everything spent here was
          // spent by the agents this command ran, which is the inclusive figure.
          usage: accounting.inclusiveUsage,
          accounting,
          ambient: runtime.snapshotRunAmbient(runContext.runId),
        });
        if (opts.outputFormat === 'text') {
          if (dispatch.output) stdout.write(`${dispatch.output}\n`);
        } else if (
          opts.outputFormat === 'stream-json' &&
          (dispatch.output !== undefined || dispatch.data !== undefined)
        ) {
          // One record carries both renderings: `output` for a human reading the
          // stream, `data` for the machine contract (see review/host.ts).
          // Only on the line-delimited wire: `json` is a single-document format,
          // and a second top-level object there breaks `JSON.parse(stdout)`.
          emit({ type: 'command_result', ...handled });
        }
        continue;
      }
      const prompt = dispatch.prompt;
      const commandContext = dispatch.kind === 'prompt' ? dispatch.commandContext : undefined;
      const userMessage: Message = {
        id: runId,
        role: 'user',
        content: prompt,
        includeInContext: true,
        kind: 'conversation',
        timestamp: Date.now(),
      };

      // Cross-turn auto-compact before appending the new user message.
      const contextLimit = resolveContextLimit(config);
      const hostCompactAttemptKey = `${usagePressureTokens(lastUsage)}:${contextHistory.length}`;
      if (
        !config.experimentalZeroMem &&
        config.autoCompactEnabled !== false &&
        contextLimit != null &&
        shouldCompact(lastUsage, contextLimit) &&
        lastHostCompactAttemptKey !== hostCompactAttemptKey
      ) {
        lastHostCompactAttemptKey = hostCompactAttemptKey;
        try {
          const outcome = await agentSession.compact({
            config,
            history: contextHistory,
            sourceHistory: transcript,
            compactBoundaries,
            sessionId,
            transcriptOrdinal: transcript.length,
            runContext,
            runtime,
            timelineStore: store,
            onCommitted: (compactResult, boundary) => {
              contextHistory.length = 0;
              contextHistory.push(...compactResult.replacementHistory);
              compactBoundaries.push(boundary);
              lastUsage = null;
            },
            options: {
              trigger: 'auto',
              preContextTokens: usagePressureTokens(lastUsage),
              signal: opts.signal,
              upcomingUserIntent: prompt,
              onHookEvent: createHookEventHandler(opts, emit),
            },
          });
          if (outcome.result.status === 'compacted') {
            emitCompactBoundary(opts.outputFormat, emit, outcome.result);
          }
        } catch {
          // non-fatal
        }
      }

      const recorded = await agentSession.recordUserMessage({
        config,
        sessionId: runtimeSessionId,
        displayMessage: prompt,
        userMessage,
        sessionName,
        timelineStore: store && sessionId ? store : undefined,
        expandShellInput: false,
        runtime,
        signal: opts.signal,
      });
      sessionName = recorded.sessionName;
      const contextMessage = recorded.contextMessage;
      transcript.push(userMessage);
      rootContexts.set(runContext.rootRunId, runContext);
      await runParentTurn(contextMessage, prompt, userMessage, runContext, commandContext);
      // Fold this prompt's inclusive spend into the carry so the next root starts
      // where this one finished instead of back at zero.
      const spentSoFar = runtime.runAccounting.snapshotRoot(runContext.rootRunId);
      carriedSpend = {
        usage: spentSoFar.inclusiveUsage,
        costUsd: spentSoFar.inclusiveCostUsd,
      };
      // An unapprovable plan is the deliverable: queued prompts would only
      // re-plan against a workspace nothing is allowed to change.
      if (planNotApplied.outcome) break;
    }

    // Background children outlive the root tool call. Keep the runtime alive,
    // feed each completion back through the parent model, and acknowledge only
    // after that continuation turn succeeds.
    const managedAgentManager = planNotApplied.outcome ? undefined : runtime.agentManager;
    if (managedAgentManager) {
      const deliveredCompletionIds = new Set(
        transcript.flatMap((message) =>
          (message.agentNotifications ?? [])
            .map((notification) => notification.deliveryId)
            .filter((id): id is string => Boolean(id)),
        ),
      );
      while (true) {
        await managedAgentManager.waitForIdle();
        const pending = (await managedAgentManager.listPendingCompletions()).filter(
          (notification) => notification.parentSessionId === runtimeSessionId,
        );
        if (pending.length === 0) break;
        const alreadyDelivered = pending.filter((notification) =>
          deliveredCompletionIds.has(notification.deliveryId),
        );
        for (const notification of alreadyDelivered) {
          await managedAgentManager.acknowledgeCompletion(notification.deliveryId);
        }
        const fresh = pending.filter(
          (notification) => !deliveredCompletionIds.has(notification.deliveryId),
        );
        if (fresh.length === 0) continue;
        const firstRootRunId = fresh[0]?.rootRunId;
        const sameRoot = firstRootRunId
          ? fresh.filter((notification) => notification.rootRunId === firstRootRunId)
          : fresh;
        const batch = takeAgentCompletionBatch(sameRoot);
        for (const notification of batch) recordManagedCompletionResult(notification);
        const built = batch.map((notification: AgentCompletionNotification) =>
          buildAgentCompletionMessage(notification),
        );
        const displayMessage = built.map((item) => item.displayMessage).join('\n');
        const userMessage: Message = {
          id: crypto.randomUUID(),
          role: 'user',
          content: displayMessage,
          contextContent: built.map((item) => item.contextMessage).join('\n'),
          includeInContext: true,
          kind: 'agent-notification',
          agentNotifications: built.map((item) => item.display),
          timestamp: Date.now(),
        };
        const recorded = await agentSession.recordUserMessage({
          config,
          sessionId: runtimeSessionId,
          displayMessage,
          contextMessage: userMessage.contextContent,
          userMessage,
          timelineStore: store && sessionId ? store : undefined,
          expandShellInput: false,
          runtime,
          signal: opts.signal,
        });
        transcript.push(userMessage);
        const parentContext = batch[0]?.rootRunId
          ? rootContexts.get(batch[0].rootRunId)
          : undefined;
        const runContext = createAgentRunContext({
          sessionId: runtimeSessionId,
          source: opts.runSource ?? 'headless',
          rootRunId: parentContext?.rootRunId ?? batch[0]?.rootRunId,
          parentRunId: batch[0]?.runId ?? parentContext?.runId,
        });
        if (parentContext) rootContexts.set(runContext.rootRunId, parentContext);
        else rootContexts.set(runContext.rootRunId, runContext);
        await runParentTurn(recorded.contextMessage, displayMessage, userMessage, runContext);
        for (const notification of batch) {
          deliveredCompletionIds.add(notification.deliveryId);
          await managedAgentManager.acknowledgeCompletion(notification.deliveryId);
        }
      }
    }

    const outcome =
      lastOutcome ??
      (commandResults.length > 0
        ? createTerminalOutcome('completed', 'normal_completion', { partialOutput: false })
        : createTerminalOutcome('interrupted', 'missing_terminal', {
            partialOutput: transcript.some((message) => message.role === 'assistant'),
          }));
    runResults.sort((left, right) => left.context.startedAt - right.context.startedAt);
    // A run made only of host-performed commands has no last turn, so reporting
    // `null` would say "this cost nothing" about work that really spent tokens.
    const reportedUsage = lastUsage ?? commandUsage;
    const result: HeadlessResult = {
      messages: contextHistory,
      transcript,
      compactBoundaries,
      usage: reportedUsage,
      accounting: runtime.runAccounting.snapshotAll(),
      outcome,
      runs: runResults,
      sessionId,
      plan: planNotApplied.outcome,
      commandResults,
    };

    if (opts.jsonSchema) {
      const text = lastAssistantText(contextHistory);
      try {
        result.structured = JSON.parse(text);
      } catch {
        result.structuredError = 'Failed to parse JSON from assistant output';
      }
    }

    // Prompt suggestions: ask model for follow-up prompts.
    if (opts.promptSuggestions && opts.outputFormat === 'stream-json') {
      try {
        const suggestions = await generatePromptSuggestions(
          config,
          registry,
          contextHistory,
          opts.signal,
          store?.readImageAttachment
            ? (attachment) => store.readImageAttachment!(runtimeSessionId, attachment)
            : undefined,
        );
        if (suggestions.length > 0) {
          emit({ type: 'prompt_suggestions', suggestions });
        }
      } catch {
        // Non-fatal: suggestions are best-effort.
      }
    }

    if (opts.outputFormat === 'text') {
      const stopped = planNotApplied.outcome;
      if (stopped) {
        // The plan is the deliverable when nothing could approve it; the
        // trailing status line keeps "produced a plan" from reading as
        // "did the work".
        stdout.write(`${stopped.plan}\n\n${stopped.message}\n`);
      } else {
        const last = lastAssistantText(contextHistory);
        if (last) stdout.write(last + '\n');
      }
    } else if (opts.outputFormat === 'json') {
      // Exactly one top-level document: everything the run produced, including
      // commands the host performed itself, is carried here.
      emit({
        result: {
          messages: contextHistory,
          usage: reportedUsage,
          accounting: result.accounting,
          outcome,
          runs: runResults,
          structured: result.structured,
          structuredError: result.structuredError,
          plan: result.plan,
          commandResults,
        },
      });
    } else if (opts.outputFormat === 'stream-json') {
      emit({
        type: 'result',
        result: {
          messages: contextHistory,
          usage: reportedUsage,
          accounting: result.accounting,
          outcome,
          runs: runResults,
          structured: result.structured,
          structuredError: result.structuredError,
          plan: result.plan,
          commandResults,
        },
      });
    }

    if (sessionId) {
      await agentSession.endLifecycle(config, sessionId, 'completion', {
        onHookEvent: createHookEventHandler(opts, emit),
      });
    }

    return result;
  } finally {
    // Deferred root seal: linked continuation turns share each root stream, so
    // the terminal record and seal land only after every linked turn finished.
    if (harnessCoordinator) {
      for (const [rootRunId, outcome] of harnessRootOutcomes) {
        try {
          await harnessCoordinator.finalizeRun(rootRunId, {
            status: outcome.status === 'timed_out' ? 'timed-out' : outcome.status,
            reasonCode: outcome.reason,
          });
        } catch {
          // Evidence sealing is best-effort; the user-facing result is already decided.
        }
      }
    }
    disposeCrashHandlers?.();
    agentSession.dispose('headless_complete');
  }
}

function lastAssistantText(history: Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'assistant' && m.content) return m.content;
  }
  return '';
}

/** Wire status for the `plan_approval` stream-json event: approve | approve-fresh | reject | revise | stop. */
function planApprovalStatus(decision: PlanApprovalResult): string {
  return typeof decision === 'string' ? decision : decision.decision;
}

type HeadlessEmit = (event: unknown) => void;

function createHookEventHandler(
  opts: HeadlessOptions,
  emit: HeadlessEmit,
): ((event: string, payload: Record<string, unknown>) => void) | undefined {
  if (!opts.includeHookEvents || opts.outputFormat !== 'stream-json') return undefined;
  return (event, payload) => emit({ type: 'hook_event', event, ...payload });
}

function emitAgentEvent(event: AgentEvent, opts: HeadlessOptions, emit: HeadlessEmit): void {
  if (event.type === 'terminal') return;
  if (event.type === 'agent_text_delta' && opts.forwardSubagentText !== true) return;
  opts.onAgentEvent?.(event);
  if (event.type === 'error') {
    if (opts.outputFormat === 'stream-json') emit({ type: 'error', error: event.error });
    else process.stderr.write(`error: ${event.error}\n`);
    return;
  }
  if (opts.outputFormat !== 'stream-json') return;

  switch (event.type) {
    case 'run_started':
      emit({ type: 'run_start', run: event.context, ambient: event.ambient });
      break;
    case 'text':
      // Deltas are opt IN, and are additional to the completed message emitted at
      // turn end. Commander leaves an unpassed boolean `undefined`, so the old
      // `!== false` gate meant the flag did nothing and every run paid maximum
      // stream volume whether or not anyone asked for them.
      if (opts.includePartialMessages === true)
        emit({ type: 'assistant', text: event.content, complete: false });
      break;
    case 'reasoning':
      if (opts.includePartialMessages === true) emit({ type: 'reasoning', text: event.content });
      break;
    case 'tool_use':
      emit({ type: 'tool_use', tool_call: event.toolCall });
      break;
    case 'tool_result':
      emit({ type: 'tool_result', tool_result: event.toolResult });
      break;
    case 'user_question':
      emit({ type: 'user_question', request: event.request, status: event.status });
      break;
    case 'user_question_result':
      emit({
        type: 'user_question_result',
        request_id: event.requestId,
        response: event.response,
      });
      break;
    case 'agent_start':
    case 'background_job_start':
    case 'background_job_update':
    case 'background_job_output':
    case 'background_job_result':
    case 'background_job_dismiss':
    case 'agent_update':
    case 'agent_result':
    case 'agent_question':
    case 'agent_status':
    case 'agent_activity':
    case 'agent_text_delta':
    case 'agent_message':
    case 'agent_completion':
    case 'agent_permission':
    case 'agent_apply':
    case 'evidence_update':
    case 'skill_lifecycle':
    case 'attempt_discarded':
      emit(event);
      break;
    case 'system':
    case 'session':
    case 'result':
    case 'done':
      break;
  }
}

function emitCompactBoundary(
  outputFormat: HeadlessOptions['outputFormat'],
  emit: HeadlessEmit,
  result: Extract<CompactResult, { status: 'compacted' }>,
): void {
  if (outputFormat !== 'stream-json') return;
  emit({
    type: 'system',
    subtype: 'compact_boundary',
    trigger: result.trigger,
    pre_tokens: result.preContextTokens,
    compact_id: result.compactId,
    generation: result.generation,
    pre_messages: result.preMessageCount,
    post_messages: result.replacementHistory.length,
    post_tokens: result.postContextTokens,
    checkpoint_version: 2,
    strategy: result.strategy,
    model_calls: result.modelCalls,
    degraded: result.degraded,
    coverage_status: result.checkpoint.coverage?.status ?? 'complete',
    // This generation's status above; the conversation's accumulated one here.
    coverage_lifetime_status: result.checkpoint.coverage?.lifetime?.status ?? 'complete',
    coverage: result.checkpoint.coverage,
    warning: result.warning,
  });
}

async function generatePromptSuggestions(
  config: AgentConfig,
  _registry: ToolRegistry,
  history: Message[],
  signal?: AbortSignal,
  resolveAttachment?: (attachment: ImageAttachment) => Promise<Uint8Array> | Uint8Array,
): Promise<string[]> {
  const { chatCompletionStream } = await import('./provider/openai-compatible.js');
  const { buildMessages } = await import('./agent/context.js');

  const suggestionMessages = await buildMessages(
    config,
    [
      ...history,
      {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content:
          'Based on the conversation above, suggest 1-3 follow-up prompts the user might want to ask next. Keep each suggestion under 80 characters. Return ONLY a JSON array of strings, no other text.',
        includeInContext: true,
        timestamp: Date.now(),
      },
    ],
    undefined,
    undefined,
    signal,
    undefined,
    undefined,
    resolveAttachment,
  );

  const stream = chatCompletionStream(config, suggestionMessages, [], { signal });
  let content = '';
  for await (const event of stream) {
    if (event.type === 'text' && event.content) {
      content += event.content;
    }
  }

  // Parse JSON array from the response.
  try {
    const jsonMatch = content.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed)) {
        return parsed.filter((s) => typeof s === 'string' && s.length > 0).slice(0, 3);
      }
    }
  } catch {
    // Fallback: try to extract quoted strings.
    const quoted = content.match(/"([^"]+)"/g);
    if (quoted) {
      return quoted.map((s) => s.replace(/^"|"$/g, '')).slice(0, 3);
    }
  }
  return [];
}
