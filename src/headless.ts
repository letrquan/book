import type { AgentConfig } from './types/runtime.js';
import type { CompactResult, CompactBoundary } from './types/sessions.js';
import type { Message, Usage } from './types/messages.js';
import type { HeadlessOptions, HeadlessResult } from './types/public-sdk.js';
import type { UserQuestionResponse } from './types/tools.js';
import { resolveContextLimit, shouldCompact, usagePressureTokens } from './agent/compact.js';
import type { ToolRegistry } from './tools/registry.js';
import { observationKey } from './tools/file-provenance.js';
import { createSessionHistoryTools } from './tools/session-history.js';
import {
  createStreamParser,
  type StreamJsonDiagnostic,
  type StreamJsonEvent,
} from './stream-json.js';
import { AgentSession } from './session/agent-session.js';
import type { AgentEvent } from './session/agent-events.js';

export async function runHeadless(
  config: AgentConfig,
  registry: ToolRegistry,
  opts: HeadlessOptions,
): Promise<HeadlessResult> {
  const stdout = opts.stdout ?? process.stdout;
  const emit = (obj: unknown) => {
    if (obj && typeof obj === 'object' && 'type' in obj) {
      opts.onEvent?.(obj as StreamJsonEvent);
    }
    stdout.write(JSON.stringify(obj) + '\n');
  };
  const agentSession = new AgentSession();
  const runtime = agentSession.getRuntime();

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
    let sessionCreated = opts.sessionCreated === true;
    if (store && !sessionId) {
      sessionId = store.create({ cwd: config.workspace, name: opts.sessionName });
      sessionCreated = true;
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

    // Headless permission policy: if a prompt would be shown and no rule resolves
    // it, deny the tool — headless can't interactively prompt. Callers who want
    // full autonomy should pass mode: 'bypassPermissions'.
    const permissionRequired = async (): Promise<'deny'> => 'deny';

    let lastUsage: Usage | null = null;
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

    // Collect prompts: text input -> single prompt; stream-json -> read stdin.
    const prompts: string[] = [];
    if (opts.inputFormat === 'text') {
      if (!opts.prompt) throw new Error('text input format requires a prompt');
      prompts.push(opts.prompt);
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

    for (const prompt of prompts) {
      // Cross-turn auto-compact before appending the new user message.
      const contextLimit = resolveContextLimit(config);
      const hostCompactAttemptKey = `${usagePressureTokens(lastUsage)}:${contextHistory.length}`;
      if (
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
            sessionId,
            transcriptOrdinal: transcript.length,
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

      const userMessage: Message = {
        id: crypto.randomUUID(),
        role: 'user',
        content: prompt,
        includeInContext: true,
        kind: 'conversation',
        timestamp: Date.now(),
      };
      const recorded = await agentSession.recordUserMessage({
        config,
        sessionId: runtimeSessionId,
        displayMessage: prompt,
        userMessage,
        timelineStore: store && sessionId ? store : undefined,
        expandShellInput: false,
        runtime,
        signal: opts.signal,
      });
      const contextMessage = recorded.contextMessage;
      transcript.push(userMessage);
      const loopConfig: AgentConfig = {
        ...config,
        maxTurns: opts.maxTurns ?? config.maxTurns,
      };
      const updated = await agentSession.run({
        config: loopConfig,
        registry,
        prompt: contextMessage,
        history: contextHistory,
        mode: opts.mode,
        sessionId: runtimeSessionId,
        timelineStore: store,
        signal: opts.signal,
        callbacks: {
          onEvent: (event) => emitAgentEvent(event, opts, emit),
          // No header rewrite at turn boundaries: load() derives updatedAt from
          // the last appended record, so the on-disk header is never the source
          // of truth for activity ordering.
          onTurnStart: () => {},
          onDone: () => {},
          onPermissionRequired: permissionRequired,
          onModeChange: (newMode) => {
            if (opts.outputFormat === 'stream-json') {
              emit({ type: 'mode_change', mode: newMode });
            }
          },
          onPlanApprovalRequired: async () => {
            const approved = opts.mode === 'bypassPermissions';
            if (opts.outputFormat === 'stream-json') {
              emit({ type: 'plan_approval', status: approved ? 'approve' : 'reject' });
            }
            return approved ? 'approve' : 'reject';
          },
          onUserQuestionRequired: async (request, context): Promise<UserQuestionResponse> => {
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
          },
          userQuestionStatus: opts.onUserQuestionRequired ? 'pending' : 'unavailable',
          onHookEvent: createHookEventHandler(opts, emit),
          onUsage: (u) => {
            lastUsage = u;
            lastHostCompactAttemptKey = null;
          },
          onCompact: async (history, usage) => {
            const outcome = await agentSession.compact({
              config,
              history,
              sessionId,
              transcriptOrdinal: transcript.length,
              timelineStore: store,
              onCommitted: (_result, boundary) => compactBoundaries.push(boundary),
              options: {
                trigger: 'auto',
                preContextTokens: usagePressureTokens(usage),
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
          },
        },
        options: {
          displayMessage: prompt,
          userMessageId: userMessage.id,
          userMessageTimestamp: userMessage.timestamp,
          userFileObservations: userMessage.fileObservations,
          manageSessionHooks: sessionId ? false : undefined,
          parentSessionId: sessionId,
          runtime,
        },
      });
      const priorIds = new Set(transcript.map((message) => message.id));
      transcript.push(
        ...updated.filter((message) => !priorIds.has(message.id) && message.role === 'assistant'),
      );
      contextHistory.length = 0;
      contextHistory.push(...updated);
    }

    const result: HeadlessResult = {
      messages: contextHistory,
      transcript,
      compactBoundaries,
      usage: lastUsage,
      sessionId,
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
        );
        if (suggestions.length > 0) {
          emit({ type: 'prompt_suggestions', suggestions });
        }
      } catch {
        // Non-fatal: suggestions are best-effort.
      }
    }

    if (opts.outputFormat === 'text') {
      const last = lastAssistantText(contextHistory);
      if (last) stdout.write(last + '\n');
    } else if (opts.outputFormat === 'json') {
      emit({
        result: {
          messages: contextHistory,
          usage: lastUsage,
          structured: result.structured,
          structuredError: result.structuredError,
        },
      });
    } else if (opts.outputFormat === 'stream-json') {
      emit({
        type: 'result',
        result: {
          messages: contextHistory,
          usage: lastUsage,
          structured: result.structured,
          structuredError: result.structuredError,
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

type HeadlessEmit = (event: unknown) => void;

function createHookEventHandler(
  opts: HeadlessOptions,
  emit: HeadlessEmit,
): ((event: string, payload: Record<string, unknown>) => void) | undefined {
  if (!opts.includeHookEvents || opts.outputFormat !== 'stream-json') return undefined;
  return (event, payload) => emit({ type: 'hook_event', event, ...payload });
}

function emitAgentEvent(event: AgentEvent, opts: HeadlessOptions, emit: HeadlessEmit): void {
  opts.onAgentEvent?.(event);
  if (event.type === 'error') {
    if (opts.outputFormat === 'stream-json') emit({ type: 'error', error: event.error });
    else process.stderr.write(`error: ${event.error}\n`);
    return;
  }
  if (opts.outputFormat !== 'stream-json') return;

  switch (event.type) {
    case 'text':
      if (opts.includePartialMessages !== false) emit({ type: 'assistant', text: event.content });
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
    case 'agent_update':
    case 'agent_result':
    case 'agent_question':
    case 'agent_apply':
    case 'evidence_update':
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
    coverage: result.checkpoint.coverage,
    warning: result.warning,
  });
}

async function generatePromptSuggestions(
  config: AgentConfig,
  _registry: ToolRegistry,
  history: Message[],
  signal?: AbortSignal,
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
    [],
    undefined,
    undefined,
    signal,
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
