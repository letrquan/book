import type {
  AgentConfig,
  Message,
  ToolCall,
  ToolResult,
  HeadlessOptions,
  HeadlessResult,
  Usage,
  SessionRecord,
} from './types.js';
import { runAgentLoop } from './agent/loop.js';
import type { ToolRegistry } from './tools/registry.js';
import type { SessionStore } from './session/store.js';

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
  const store = opts.persistSession === false ? undefined : (opts.sessionStore as SessionStore | undefined);
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
  const permissionRequired = async (_call: ToolCall): Promise<'allow' | 'deny' | 'always'> => 'deny';

  let lastUsage: Usage | null = null;
  const newHistory: Message[] = [...opts.history];

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
    if (store && sessionId) {
      store.append(sessionId, { type: 'user', timestamp: Date.now(), data: { content: prompt } } satisfies SessionRecord);
    }
    const updated = await runAgentLoop(
      { ...config, maxTurns: opts.maxTurns ?? config.maxTurns },
      registry,
      prompt,
      newHistory,
      {
        onText: (text) => {
          if (store && sessionId) {
            store.append(sessionId, { type: 'assistant', timestamp: Date.now(), data: { content: text } } satisfies SessionRecord);
          }
          if (opts.outputFormat === 'stream-json') {
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
        onTurnStart: () => {},
        onDone: () => {},
        onPermissionRequired: permissionRequired,
        onUsage: (u) => {
          lastUsage = u;
        },
      },
      opts.mode,
      undefined,
      { signal: opts.signal },
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

  if (opts.outputFormat === 'text') {
    const last = lastAssistantText(newHistory);
    if (last) stdout.write(last + '\n');
  } else if (opts.outputFormat === 'json') {
    emit({ result: { messages: newHistory, usage: lastUsage, structured: result.structured, structuredError: result.structuredError } });
  } else if (opts.outputFormat === 'stream-json') {
    emit({ type: 'result', result: { messages: newHistory, usage: lastUsage, structured: result.structured, structuredError: result.structuredError } });
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
