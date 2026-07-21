import type {
  AgentConfig,
  CompactRecordData,
  Message,
  ToolCall,
  HeadlessOptions,
  HeadlessResult,
  Usage,
  SessionRecord,
  CompactBoundary,
  UserQuestionResponse,
} from './types.js';
import { runAgentLoop } from './agent/loop.js';
import {
  resolveContextLimit,
  runCompact,
  runPostCompactHooks,
  shouldCompact,
  usagePressureTokens,
} from './agent/compact.js';
import type { ToolRegistry } from './tools/registry.js';
import { collectAtMentionObservations, expandAtMentions } from './tui/input-expansion.js';
import { observationKey } from './tools/file-provenance.js';
import { runSessionEnd, runSessionStart } from './session/lifecycle.js';
import { createSessionHistoryTools } from './tools/session-history.js';

export async function runHeadless(
  config: AgentConfig,
  registry: ToolRegistry,
  opts: HeadlessOptions,
): Promise<HeadlessResult> {
  const stdout = opts.stdout ?? process.stdout;
  const emit = (obj: unknown) => {
    stdout.write(JSON.stringify(obj) + '\n');
  };

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
    await runSessionStart(config, sessionId, opts.history.length > 0 ? 'resume' : 'startup', {
      onHookEvent: opts.includeHookEvents
        ? (event, payload) => {
            if (opts.outputFormat === 'stream-json')
              emit({ type: 'hook_event', event, ...payload });
          }
        : undefined,
    });
  }

  // Headless permission policy: if a prompt would be shown and no rule resolves
  // it, deny the tool — headless can't interactively prompt. Callers who want
  // full autonomy should pass mode: 'bypassPermissions'.
  const permissionRequired = async (_call: ToolCall): Promise<'allow' | 'deny' | 'always'> =>
    'deny';

  let lastUsage: Usage | null = null;
  let lastHostCompactAttemptKey: string | null = null;
  const contextHistory: Message[] = [...opts.history];
  const transcript: Message[] = [...(opts.transcript ?? opts.history)];
  const compactBoundaries: CompactBoundary[] = [...(opts.compactBoundaries ?? [])];
  config.fileObservationLedger ??= new Map();
  for (const message of transcript) {
    for (const observation of message.fileObservations ?? []) {
      const key = observationKey(observation.workspaceId, observation.path);
      const current = config.fileObservationLedger.get(key);
      if (!current || current.timestamp <= observation.timestamp) {
        config.fileObservationLedger.set(key, observation);
      }
    }
  }
  config.tasks ??= [];
  config.backgroundShells ??= { nextId: 1, shells: new Map() };
  config.toolDiscoveryState ??= { clock: 0, loaded: new Map() };

  // Collect prompts: text input -> single prompt; stream-json -> read stdin.
  const prompts: string[] = [];
  if (opts.inputFormat === 'text') {
    if (!opts.prompt) throw new Error('text input format requires a prompt');
    prompts.push(opts.prompt);
  } else {
    // stream-json input: newline-delimited {type:'user', content} from stdin.
    const stream = opts.stdin ?? process.stdin;
    for await (const chunk of stream) {
      const line = chunk.toString().trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'user' && typeof parsed.content === 'string') {
          prompts.push(parsed.content);
        }
      } catch {
        // skip unparseable lines
      }
    }
    if (opts.prompt) prompts.unshift(opts.prompt);
  }

  for (const prompt of prompts) {
    const expandedPrompt = expandAtMentions(prompt, config.workspace);

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
        const compactResult = await runCompact(config, contextHistory, {
          trigger: 'auto',
          sessionId,
          preContextTokens: usagePressureTokens(lastUsage),
          signal: opts.signal,
          upcomingUserIntent: prompt,
          onHookEvent: opts.includeHookEvents
            ? (event, payload) => {
                if (opts.outputFormat === 'stream-json') {
                  emit({ type: 'hook_event', event, ...payload });
                }
              }
            : undefined,
        });
        if (compactResult.status === 'compacted') {
          const timestamp = Date.now();
          const boundary = makeBoundary(compactResult, transcript.length, timestamp);
          if (store && sessionId) {
            const data: CompactRecordData = {
              version: 2,
              compactId: compactResult.compactId,
              generation: compactResult.generation,
              trigger: compactResult.trigger,
              checkpoint: compactResult.checkpoint,
              summary: compactResult.summary,
              preContextTokens: compactResult.preContextTokens,
              postContextTokens: compactResult.postContextTokens,
              replacementHistory: compactResult.replacementHistory,
              boundary,
              throughEventRef: compactResult.throughEventRef,
              summarizedCount: compactResult.summarizedCount,
              retainedCount: compactResult.retainedCount,
              strategy: compactResult.strategy,
              modelCalls: compactResult.modelCalls,
              degraded: compactResult.degraded,
              warning: compactResult.warning,
            };
            store.append(sessionId, {
              type: 'compact',
              eventId: compactResult.compactId,
              timestamp,
              data,
            } satisfies SessionRecord);
          }
          contextHistory.length = 0;
          contextHistory.push(...compactResult.replacementHistory);
          compactBoundaries.push(boundary);
          lastUsage = null;
          await runPostCompactHooks(config, {
            trigger: 'auto',
            sessionId,
            onHookEvent: opts.includeHookEvents
              ? (event, payload) => {
                  if (opts.outputFormat === 'stream-json') {
                    emit({ type: 'hook_event', event, ...payload });
                  }
                }
              : undefined,
          });
          if (opts.outputFormat === 'stream-json') {
            emit({
              type: 'system',
              subtype: 'compact_boundary',
              trigger: 'auto',
              pre_tokens: compactResult.preContextTokens,
              compact_id: compactResult.compactId,
              generation: compactResult.generation,
              pre_messages: compactResult.preMessageCount,
              post_messages: compactResult.replacementHistory.length,
              post_tokens: compactResult.postContextTokens,
              checkpoint_version: 2,
              strategy: compactResult.strategy,
              model_calls: compactResult.modelCalls,
              degraded: compactResult.degraded,
              coverage_status: compactResult.checkpoint.coverage?.status ?? 'complete',
              coverage: compactResult.checkpoint.coverage,
              warning: compactResult.warning,
            });
          }
        }
      } catch {
        // non-fatal
      }
    }

    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: prompt,
      contextContent: expandedPrompt === prompt ? undefined : expandedPrompt,
      includeInContext: true,
      kind: 'conversation',
      timestamp: Date.now(),
    };
    userMessage.fileObservations = collectAtMentionObservations(
      prompt,
      config.workspace,
      userMessage.id,
    );
    config.fileObservationLedger ??= new Map();
    for (const observation of userMessage.fileObservations) {
      config.fileObservationLedger.set(
        observationKey(observation.workspaceId, observation.path),
        observation,
      );
    }
    transcript.push(userMessage);
    if (store && sessionId) {
      store.append(sessionId, {
        type: 'user',
        eventId: userMessage.id,
        timestamp: userMessage.timestamp,
        data: {
          id: userMessage.id,
          content: prompt,
          contextContent: expandedPrompt === prompt ? undefined : expandedPrompt,
          kind: 'conversation',
          fileObservations: userMessage.fileObservations,
        },
      } satisfies SessionRecord);
    }
    const loopConfig: AgentConfig = {
      ...config,
      maxTurns: opts.maxTurns ?? config.maxTurns,
      tasks: config.tasks,
      backgroundShells: config.backgroundShells,
    };
    const updated = await runAgentLoop(
      loopConfig,
      registry,
      expandedPrompt,
      contextHistory,
      {
        onText: (text) => {
          // Streaming partials only — complete assistant turns persist via
          // onAssistantMessageComplete so tool metadata is not lost.
          if (opts.outputFormat === 'stream-json' && opts.includePartialMessages !== false) {
            emit({ type: 'assistant', text });
          }
        },
        onToolCall: (call) => {
          if (opts.outputFormat === 'stream-json') {
            emit({ type: 'tool_use', tool_call: call });
          }
        },
        onToolResult: (result) => {
          if (opts.outputFormat === 'stream-json') {
            emit({ type: 'tool_result', tool_result: result });
          }
        },
        onError: (err) => {
          if (opts.outputFormat === 'stream-json') {
            emit({ type: 'error', error: err });
          } else {
            process.stderr.write(`error: ${err}\n`);
          }
        },
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
          if (opts.outputFormat === 'stream-json') {
            emit({
              type: 'user_question',
              request,
              status: opts.onUserQuestionRequired ? 'pending' : 'unavailable',
            });
          }

          let response: UserQuestionResponse;
          try {
            response = opts.onUserQuestionRequired
              ? await opts.onUserQuestionRequired(request, context)
              : {
                  action: 'decline',
                  message: 'User input is unavailable in non-interactive mode.',
                };
          } catch (error) {
            response = {
              action: 'cancel',
              message: `User question handler failed: ${error instanceof Error ? error.message : String(error)}`,
            };
          }

          if (opts.outputFormat === 'stream-json') {
            emit({ type: 'user_question_result', request_id: request.id, response });
          }
          return response;
        },
        onAgentEvent: (event) => {
          if (opts.outputFormat === 'stream-json') emit(event);
        },
        onHookEvent: opts.includeHookEvents
          ? (event, payload) => {
              if (opts.outputFormat === 'stream-json') {
                emit({ type: 'hook_event', event, ...payload });
              }
            }
          : undefined,
        onUsage: (u) => {
          lastUsage = u;
          lastHostCompactAttemptKey = null;
        },
        onCompact: async (history, usage) => {
          const result = await runCompact(config, history, {
            trigger: 'auto',
            sessionId,
            preContextTokens: usagePressureTokens(usage),
            signal: opts.signal,
            onHookEvent: opts.includeHookEvents
              ? (event, payload) => {
                  if (opts.outputFormat === 'stream-json') {
                    emit({ type: 'hook_event', event, ...payload });
                  }
                }
              : undefined,
          });
          if (result.status === 'compacted') {
            const timestamp = Date.now();
            const boundary = makeBoundary(result, transcript.length, timestamp);
            if (store && sessionId) {
              const data: CompactRecordData = {
                version: 2,
                compactId: result.compactId,
                generation: result.generation,
                trigger: result.trigger,
                checkpoint: result.checkpoint,
                summary: result.summary,
                preContextTokens: result.preContextTokens,
                postContextTokens: result.postContextTokens,
                replacementHistory: result.replacementHistory,
                boundary,
                throughEventRef: result.throughEventRef,
                summarizedCount: result.summarizedCount,
                retainedCount: result.retainedCount,
                strategy: result.strategy,
                modelCalls: result.modelCalls,
                degraded: result.degraded,
                warning: result.warning,
              };
              store.append(sessionId, {
                type: 'compact',
                eventId: result.compactId,
                timestamp,
                data,
              } satisfies SessionRecord);
            }
            compactBoundaries.push(boundary);
            await runPostCompactHooks(config, {
              trigger: 'auto',
              sessionId,
              onHookEvent: opts.includeHookEvents
                ? (event, payload) => {
                    if (opts.outputFormat === 'stream-json') {
                      emit({ type: 'hook_event', event, ...payload });
                    }
                  }
                : undefined,
            });
            if (opts.outputFormat === 'stream-json') {
              emit({
                type: 'system',
                subtype: 'compact_boundary',
                trigger: 'auto',
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
            lastUsage = null;
          }
          return result;
        },
        onAssistantMessageComplete: (message) => {
          if (!transcript.some((item) => item.id === message.id)) transcript.push(message);
          if (store && sessionId) {
            store.append(sessionId, {
              type: 'assistant',
              eventId: message.id,
              timestamp: message.timestamp,
              data: {
                id: message.id,
                complete: true,
                content: message.content,
                kind: message.kind ?? 'conversation',
                toolCalls: message.toolCalls,
                toolResults: message.toolResults,
                fileObservations: message.fileObservations,
              },
            } satisfies SessionRecord);
          }
        },
      },
      opts.mode,
      {
        signal: opts.signal,
        displayMessage: prompt,
        userMessageId: userMessage.id,
        userMessageTimestamp: userMessage.timestamp,
        userFileObservations: userMessage.fileObservations,
        manageSessionHooks: sessionId ? false : undefined,
        parentSessionId: sessionId,
      },
    );
    config.agentManager ??= loopConfig.agentManager;
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
    await runSessionEnd(config, sessionId, 'completion', {
      onHookEvent: opts.includeHookEvents
        ? (event, payload) => {
            if (opts.outputFormat === 'stream-json')
              emit({ type: 'hook_event', event, ...payload });
          }
        : undefined,
    });
  }

  return result;
}

function lastAssistantText(history: Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === 'assistant' && m.content) return m.content;
  }
  return '';
}

function makeBoundary(
  result: Extract<Awaited<ReturnType<typeof runCompact>>, { status: 'compacted' }>,
  transcriptOrdinal: number,
  timestamp: number,
): CompactBoundary {
  return {
    id: result.compactId,
    trigger: result.trigger,
    transcriptOrdinal,
    preContextCount: result.preMessageCount,
    postContextCount: result.replacementHistory.length,
    preContextTokens: result.preContextTokens,
    postContextTokens: result.postContextTokens,
    generation: result.generation,
    checkpointVersion: 2,
    timestamp,
  };
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
