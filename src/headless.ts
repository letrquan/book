import type {
  AgentConfig,
  Message,
  ToolCall,
  ToolResult,
  HeadlessOptions,
  HeadlessResult,
  Usage,
  SessionRecord,
  SessionStoreInterface,
} from './types.js';
import { runAgentLoop } from './agent/loop.js';
import type { ToolRegistry } from './tools/registry.js';
import { expandAtMentions } from './tui/input-expansion.js';

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
  if (store && !sessionId) {
    sessionId = store.create({ cwd: config.workspace, name: opts.sessionName });
    if (opts.outputFormat === 'stream-json') {
      emit({ type: 'session', session_id: sessionId });
    }
  }

  // Headless permission policy: if a prompt would be shown and no rule resolves
  // it, deny the tool — headless can't interactively prompt. Callers who want
  // full autonomy should pass mode: 'bypassPermissions'.
  const permissionRequired = async (_call: ToolCall): Promise<'allow' | 'deny' | 'always'> =>
    'deny';

  let lastUsage: Usage | null = null;
  const newHistory: Message[] = [...opts.history];
  config.tasks ??= [];
  config.backgroundShells ??= { nextId: 1, shells: new Map() };

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
    if (store && sessionId) {
      store.append(sessionId, {
        type: 'user',
        timestamp: Date.now(),
        data: {
          content: prompt,
          contextContent: expandedPrompt === prompt ? undefined : expandedPrompt,
        },
      } satisfies SessionRecord);
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
      newHistory,
      {
        onText: (text) => {
          if (store && sessionId) {
            store.append(sessionId, {
              type: 'assistant',
              timestamp: Date.now(),
              data: { content: text },
            } satisfies SessionRecord);
          }
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
        onHookEvent: opts.includeHookEvents
          ? (event, payload) => {
              if (opts.outputFormat === 'stream-json') {
                emit({ type: 'hook_event', event, ...payload });
              }
            }
          : undefined,
        onUsage: (u) => {
          lastUsage = u;
        },
      },
      opts.mode,
      { signal: opts.signal, displayMessage: prompt },
    );
    // Replace newHistory with the loop's authoritative return.
    newHistory.length = 0;
    newHistory.push(...updated);
  }

  const result: HeadlessResult = {
    messages: newHistory,
    usage: lastUsage,
    sessionId,
  };

  if (opts.jsonSchema) {
    const text = lastAssistantText(newHistory);
    try {
      result.structured = JSON.parse(text);
    } catch {
      result.structuredError = 'Failed to parse JSON from assistant output';
    }
  }

  // Prompt suggestions: ask model for follow-up prompts.
  if (opts.promptSuggestions && opts.outputFormat === 'stream-json') {
    try {
      const suggestions = await generatePromptSuggestions(config, registry, newHistory);
      if (suggestions.length > 0) {
        emit({ type: 'prompt_suggestions', suggestions });
      }
    } catch {
      // Non-fatal: suggestions are best-effort.
    }
  }

  if (opts.outputFormat === 'text') {
    const last = lastAssistantText(newHistory);
    if (last) stdout.write(last + '\n');
  } else if (opts.outputFormat === 'json') {
    emit({
      result: {
        messages: newHistory,
        usage: lastUsage,
        structured: result.structured,
        structuredError: result.structuredError,
      },
    });
  } else if (opts.outputFormat === 'stream-json') {
    emit({
      type: 'result',
      result: {
        messages: newHistory,
        usage: lastUsage,
        structured: result.structured,
        structuredError: result.structuredError,
      },
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

async function generatePromptSuggestions(
  config: AgentConfig,
  registry: ToolRegistry,
  history: Message[],
): Promise<string[]> {
  const { chatCompletionStream } = await import('./provider/openai-compatible.js');
  const { buildMessages } = await import('./agent/context.js');

  const suggestionMessages = buildMessages(
    config,
    [
      ...history,
      {
        id: crypto.randomUUID(),
        role: 'user' as const,
        content:
          'Based on the conversation above, suggest 1-3 follow-up prompts the user might want to ask next. Keep each suggestion under 80 characters. Return ONLY a JSON array of strings, no other text.',
        timestamp: Date.now(),
      },
    ],
    [],
  );

  const stream = chatCompletionStream(config, suggestionMessages, [], {});
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
