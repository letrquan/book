import type {
  AgentConfig,
  CompactBoundary,
  HeadlessOptions,
  HeadlessResult,
  Message,
  SessionRecord,
  ToolCall,
  Usage,
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
import { expandAtMentionsWithObservations } from './tui/input-expansion.js';
import { runSessionEnd, runSessionStart } from './session/lifecycle.js';
import { buildCompactRecord } from './session/compact-record.js';
import { createFileObservationLedger, observationsFromMessages } from './tools/file-observation.js';
import { createSessionHistoryCapability } from './tools/session-history.js';

function emitCompactBoundary(emit: (value: unknown) => void, boundary: CompactBoundary): void {
  emit({
    type: 'system',
    subtype: 'compact_boundary',
    trigger: boundary.trigger,
    pre_tokens: boundary.preContextTokens,
    boundary_id: boundary.id,
    after_transcript_ordinal: boundary.afterTranscriptOrdinal,
    pre_context_messages: boundary.preContextMessages,
    retained_context_messages: boundary.retainedContextMessages,
    estimated_post_tokens: boundary.estimatedPostTokens,
    checkpoint_version: boundary.checkpointVersion,
    generation: boundary.generation,
  });
}

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

  if (sessionId) {
    await runSessionStart(config, sessionId, opts.history.length > 0 ? 'resume' : 'startup', {
      onHookEvent: opts.includeHookEvents
        ? (event, payload) => {
            if (opts.outputFormat === 'stream-json') {
              emit({ type: 'hook_event', event, ...payload });
            }
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
  const transcript: Message[] = [...(opts.transcript ?? opts.history)];
  const contextHistory: Message[] = [...(opts.contextHistory ?? opts.history)];
  let compactGeneration = (opts.compactBoundaries ?? []).reduce(
    (max, boundary) => Math.max(max, boundary.generation),
    0,
  );
  const fileObservationLedger = createFileObservationLedger(
    observationsFromMessages([...transcript, ...contextHistory]),
  );
  const sessionHistory =
    store && sessionId
      ? createSessionHistoryCapability(store, sessionId, config.workspace)
      : undefined;
  config.tasks ??= [];
  config.backgroundShells ??= { nextId: 1, shells: new Map() };

  const commitCompactResult = async (
    result: Extract<Awaited<ReturnType<typeof runCompact>>, { status: 'compacted' }>,
  ): Promise<CompactBoundary> => {
    const built = buildCompactRecord(result, {
      afterTranscriptOrdinal: transcript.length,
      generation: compactGeneration + 1,
      estimatedPostTokens: result.estimatedPostTokens,
      checkpoint: result.checkpoint,
    });
    // Durable append is the commit point. If this throws, provider context is unchanged.
    if (store && sessionId) store.append(sessionId, built.record);
    compactGeneration = built.boundary.generation;
    contextHistory.length = 0;
    contextHistory.push(...result.replacementHistory);
    lastUsage = null;
    return built.boundary;
  };

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
    const userMessageId = crypto.randomUUID();
    const mentionExpansion = expandAtMentionsWithObservations(
      prompt,
      config.workspace,
      `session://current/event/${userMessageId}`,
    );
    const expandedPrompt = mentionExpansion.text;

    // Cross-turn auto-compact before appending the new user message.
    const contextLimit = resolveContextLimit(config);
    if (
      config.autoCompactEnabled !== false &&
      contextLimit != null &&
      shouldCompact(lastUsage, contextLimit)
    ) {
      try {
        const compactResult = await runCompact(config, contextHistory, {
          trigger: 'auto',
          sessionId,
          preContextTokens: usagePressureTokens(lastUsage),
          signal: opts.signal,
          onHookEvent: opts.includeHookEvents
            ? (event, payload) => {
                if (opts.outputFormat === 'stream-json') {
                  emit({ type: 'hook_event', event, ...payload });
                }
              }
            : undefined,
          upcomingUserIntent: expandedPrompt,
          fileObservations: fileObservationLedger.all(),
        });
        if (compactResult.status === 'compacted') {
          const boundary = await commitCompactResult(compactResult);
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
          if (opts.outputFormat === 'stream-json') emitCompactBoundary(emit, boundary);
        }
      } catch {
        // Non-fatal. Preserve the existing context if compact or persistence fails.
      }
    }

    const userMessage: Message = {
      id: userMessageId,
      role: 'user',
      content: prompt,
      contextContent: expandedPrompt === prompt ? undefined : expandedPrompt,
      includeInContext: true,
      kind: 'conversation',
      fileObservations:
        mentionExpansion.fileObservations.length > 0
          ? mentionExpansion.fileObservations
          : undefined,
      timestamp: Date.now(),
    };
    if (store && sessionId) {
      store.append(sessionId, {
        type: 'user',
        eventId: userMessage.id,
        timestamp: userMessage.timestamp,
        data: {
          content: prompt,
          contextContent: userMessage.contextContent,
          fileObservations: userMessage.fileObservations,
        },
      } satisfies SessionRecord);
    }
    transcript.push(userMessage);
    for (const observation of userMessage.fileObservations ?? []) {
      fileObservationLedger.remember(observation);
    }

    const updated = await runAgentLoop(
      {
        ...config,
        maxTurns: opts.maxTurns ?? config.maxTurns,
        tasks: config.tasks,
        backgroundShells: config.backgroundShells,
      },
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
        onHookEvent: opts.includeHookEvents
          ? (event, payload) => {
              if (opts.outputFormat === 'stream-json') {
                emit({ type: 'hook_event', event, ...payload });
              }
            }
          : undefined,
        onUsage: (usage) => {
          lastUsage = usage;
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
            fileObservations: fileObservationLedger.all(),
          });
          if (result.status === 'compacted') {
            const boundary = await commitCompactResult(result);
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
            if (opts.outputFormat === 'stream-json') emitCompactBoundary(emit, boundary);
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
                complete: true,
                content: message.content,
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
        userMessageId,
        fileObservations: userMessage.fileObservations,
        fileObservationLedger,
        sessionHistory,
        manageSessionHooks: sessionId ? false : undefined,
      },
    );
    // Completed assistant turns append through onAssistantMessageComplete; the
    // complete loop return replaces provider context (including mid-loop compact).
    contextHistory.length = 0;
    contextHistory.push(...updated);
  }

  const result: HeadlessResult = {
    messages: transcript,
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
        messages: transcript,
        usage: lastUsage,
        structured: result.structured,
        structuredError: result.structuredError,
      },
    });
  } else if (opts.outputFormat === 'stream-json') {
    emit({
      type: 'result',
      result: {
        messages: transcript,
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
            if (opts.outputFormat === 'stream-json') {
              emit({ type: 'hook_event', event, ...payload });
            }
          }
        : undefined,
    });
  }

  return result;
}

function lastAssistantText(history: Message[]): string {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    if (message.role === 'assistant' && message.content) return message.content;
  }
  return '';
}

async function generatePromptSuggestions(
  config: AgentConfig,
  _registry: ToolRegistry,
  history: Message[],
  signal?: AbortSignal,
): Promise<string[]> {
  const { chatCompletionStream } = await import('./provider/index.js');
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
        return parsed.filter((value) => typeof value === 'string' && value.length > 0).slice(0, 3);
      }
    }
  } catch {
    // Fallback: try to extract quoted strings.
    const quoted = content.match(/"([^"]+)"/g);
    if (quoted) {
      return quoted.map((value) => value.replace(/^"|"$/g, '')).slice(0, 3);
    }
  }
  return [];
}
