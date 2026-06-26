import type { AgentConfig, Message, ToolCall, ToolResult, ToolContext, AgentLoopCallbacks, Usage } from '../types.js';
import { chatCompletionStream } from '../provider/openai-compatible.js';
import { buildMessages } from './context.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { PermissionStore } from '../tui/permissionStore.js';
import { loadGitignore } from '../tools/gitignore.js';
import { shouldCompact } from './compact.js';

const PERMISSION_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'git_commit']);

/** Map a (possibly aliased) tool name to its canonical name for rule matching. */
function canonicalToolName(name: string): string {
  const ALIASES: Record<string, string> = {
    read_file: 'Read',
    write_file: 'Write',
    edit_file: 'Edit',
    multi_edit: 'MultiEdit',
    glob: 'Glob',
    grep: 'Grep',
    bash: 'Bash',
  };
  return ALIASES[name] ?? name;
}

/** Extract the primary argument used for rule pattern matching (e.g. bash command, file path). */
function primaryArgForRule(toolName: string, args: Record<string, unknown>): string {
  if (typeof args.command === 'string') return args.command.split('\n')[0];
  if (typeof args.filePath === 'string') return args.filePath;
  if (typeof args.pattern === 'string') return args.pattern;
  if (typeof args.message === 'string') return args.message;
  const keys = Object.keys(args);
  if (keys.length > 0) {
    const v = args[keys[0]];
    return typeof v === 'string' ? v : '';
  }
  return '';
}

function needsPermission(toolName: string, mode: string): boolean {
  const canonical = canonicalToolName(toolName);
  if (mode === 'auto' || mode === 'bypassPermissions') return false;
  if (mode === 'plan' || mode === 'dontAsk') return true;
  if (mode === 'accept-edits') {
    return canonical !== 'Edit' && canonical !== 'Write';
  }
  return PERMISSION_TOOLS.has(canonical);
}

export async function runAgentLoop(
  config: AgentConfig,
  registry: ToolRegistry,
  userMessage: string,
  history: Message[],
  callbacks: AgentLoopCallbacks,
  mode: string = 'default',
  permissionStore?: PermissionStore,
  options?: { signal?: AbortSignal },
): Promise<Message[]> {
  const signal = options?.signal;
  const newHistory = [...history];

  newHistory.push({
    id: crypto.randomUUID(),
    role: 'user',
    content: userMessage,
    timestamp: Date.now(),
  });

  const toolContext: ToolContext = {
    workspaceRoot: config.workspace,
    env: process.env as Record<string, string>,
    gitignorePatterns: loadGitignore(config.workspace).patterns,
  };

  let turn = 0;
  let approveAll: string[] = [];
  let lastUsage: Usage | null = null;

  while (turn < config.maxTurns) {
    if (signal?.aborted) break;

    // Auto-compact when usage approaches the context limit.
    if (
      config.autoCompactEnabled !== false &&
      callbacks.onCompact &&
      shouldCompact(lastUsage, config.maxTokens ?? 128000)
    ) {
      try {
        const compacted = await callbacks.onCompact(newHistory, lastUsage);
        newHistory.length = 0;
        newHistory.push(...compacted);
        lastUsage = null;
      } catch {
        // non-fatal: continue with full history this turn
      }
    }

    turn++;
    callbacks.onTurnStart(turn);

    const messages = buildMessages(config, newHistory, registry.getDefinitions());
    let assistantContent = '';
    const toolCalls: ToolCall[] = [];
    let turnUsage: Usage | null = null;

    const stream = chatCompletionStream(config, messages, registry.getDefinitions(), { signal });

    try {
      for await (const event of stream) {
        if (signal?.aborted) break;
        if (event.type === 'text' && event.content) {
          assistantContent += event.content;
          callbacks.onText(event.content);
        } else if (event.type === 'tool_call' && event.toolCall) {
          toolCalls.push(event.toolCall);
          callbacks.onToolCall(event.toolCall);
        } else if (event.type === 'error' && event.error) {
          callbacks.onError(event.error);
          return newHistory;
        } else if (event.type === 'done' && event.usage) {
          turnUsage = event.usage;
          lastUsage = turnUsage;
        }
      }
    } catch (e) {
      // Abort looks like an AbortError; keep whatever content we have and stop.
      if (signal?.aborted) {
        break;
      }
      callbacks.onError(e instanceof Error ? e.message : String(e));
      return newHistory;
    }

    if (turnUsage) {
      callbacks.onUsage?.(turnUsage);
    }

    const toolResults: ToolResult[] = [];
    for (const call of toolCalls) {
      if (signal?.aborted) break;
      if (needsPermission(call.name, mode) && !approveAll.includes(call.name)) {
        const canonName = canonicalToolName(call.name);
        // First consult the persisted rule store (evaluates deny → ask → allow).
        let permission: 'allow' | 'deny' | 'always' | undefined;
        if (permissionStore && mode !== 'plan' && mode !== 'dontAsk') {
          const verdict = permissionStore.evaluate(canonName, primaryArgForRule(call.name, call.arguments));
          if (verdict === 'allow') {
            permission = 'allow';
          } else if (verdict === 'deny') {
            permission = 'deny';
          }
          // 'ask' falls through to the interactive prompt below
        }

        if (permission === undefined) {
          permission = await callbacks.onPermissionRequired(call);
        }

        if (permission === 'deny') {
          toolResults.push({
            toolCallId: call.id,
            success: false,
            output: '',
            error: 'SKIPPED: Permission denied',
          });
          continue;
        }
        if (permission === 'always') {
          approveAll.push(call.name);
          // Persist the allow-rule for this exact command/path going forward.
          if (permissionStore) {
            permissionStore.allowAlways(canonName, primaryArgForRule(call.name, call.arguments), 'project');
          }
        }
      }

      const result = await registry.execute(call, toolContext);
      result.toolCallId = call.id;
      toolResults.push(result);
      callbacks.onToolResult(result);
    }

    newHistory.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: assistantContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
      timestamp: Date.now(),
    });

    if (toolCalls.length === 0 || signal?.aborted) {
      break;
    }
  }

  if (turn >= config.maxTurns) {
    callbacks.onError(`Reached max turns (${config.maxTurns}). Refine your prompt or increase BOOK_MAX_TURNS.`);
  }

  callbacks.onDone();
  return newHistory;
}

export { PERMISSION_TOOLS, needsPermission };
