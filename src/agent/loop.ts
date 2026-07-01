import type { AgentConfig, Message, ToolCall, ToolResult, ToolContext, AgentLoopCallbacks, Usage, RetryPhase } from '../types.js';
import { chatCompletionStream } from '../provider/openai-compatible.js';
import { buildMessages } from './context.js';
import type { ToolRegistry } from '../tools/registry.js';
import { loadGitignore } from '../tools/gitignore.js';
import { shouldCompact } from './compact.js';
import { evaluatePermission } from '../permissions.js';
import { runHooks } from '../hooks.js';
import type { HookContext } from '../hooks.js';
import { canonicalToolName } from '../tools/aliases.js';
import { createDebugLogger } from '../debug-log.js';

const log = createDebugLogger('agent');

/**
 * Check whether a tool call should be evaluated against permission rules,
 * based solely on the current mode. When false, the tool runs without
 * any permission gate (e.g. auto / bypassPermissions).
 */
function needsPermissionCheck(mode: string): boolean {
  if (mode === 'auto' || mode === 'bypassPermissions') return false;
  return true; // all other modes (default, accept-edits, plan, dontAsk) check rules
}

export async function runAgentLoop(
  config: AgentConfig,
  registry: ToolRegistry,
  userMessage: string,
  history: Message[],
  callbacks: AgentLoopCallbacks,
  mode: string = 'default',
  options?: { signal?: AbortSignal; isNewSession?: boolean },
): Promise<Message[]> {
  const signal = options?.signal;
  const newHistory = [...history];
  const retry = config.retry;

  // SessionStart hook — fires once at session begin.
  if (options?.isNewSession !== false && history.length === 0) {
    runHooks(config.settings.hooks.SessionStart, 'SessionStart', {
      workspace: config.workspace,
      event: 'SessionStart',
    }).catch((err) => console.warn('SessionStart hook failed:', err));
  }

  // UserPromptSubmit hook — can modify or block the user prompt.
  let effectivePrompt = userMessage;
  const userHookResults = await runHooks(
    config.settings.hooks.UserPromptSubmit,
    'UserPromptSubmit',
    { workspace: config.workspace, event: 'UserPromptSubmit', userPrompt: userMessage },
  );
  for (const r of userHookResults) {
    if (r.action === 'block') {
      newHistory.push({
        id: crypto.randomUUID(),
        role: 'assistant',
        content: `[UserPromptSubmit hook blocked the prompt${r.message ? `: ${r.message}` : ''}]`,
        timestamp: Date.now(),
      });
      return newHistory;
    }
    if (r.action === 'modify' && r.modifiedPrompt) {
      effectivePrompt = r.modifiedPrompt;
    }
  }

  newHistory.push({
    id: crypto.randomUUID(),
    role: 'user',
    content: effectivePrompt,
    timestamp: Date.now(),
  });

  const toolContext: ToolContext = {
    workspaceRoot: config.workspace,
    env: process.env as Record<string, string>,
    gitignorePatterns: loadGitignore(config.workspace).patterns,
    sandbox: config.settings.sandbox,
    agentConfig: config,
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
      log.info('auto-compact triggered', { tokens: lastUsage?.totalTokens ?? 0, maxTokens: config.maxTokens });
      // PreCompact hook — fire-and-forget before compaction.
      runHooks(config.settings.hooks.PreCompact, 'PreCompact', {
        workspace: config.workspace,
        event: 'PreCompact',
      }).catch((err) => console.warn('PreCompact hook failed:', err));

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
    log.debug('turn start', { turn, maxTurns: config.maxTurns, mode });

    const messages = buildMessages(config, newHistory, registry.getDefinitions(), toolContext.todos);
    let assistantContent = '';
    const toolCalls: ToolCall[] = [];
    let turnUsage: Usage | null = null;

    // Buffer text during streaming so we can discard on retry.
    let textBuffer = '';

    const stream = chatCompletionStream(config, messages, registry.getDefinitions(), {
      signal,
      onRetry: (attempt, max, delayMs) => {
        callbacks.onRetry?.(max === -1 ? 'watchdog' : 'transport', attempt, max, delayMs);
      },
      onStreamStall: (countdownMs) => {
        callbacks.onStreamStall?.(countdownMs);
      },
      onStreamResume: () => {
        callbacks.onStreamResume?.();
      },
    });

    let streamError: string | null = null;
    let streamDone = false;

    try {
      for await (const event of stream) {
        if (event.type === 'text' && event.content) {
          textBuffer += event.content;
          // Still stream to the UI so the user sees tokens arriving.
          // If a retry occurs at the provider level, the user sees it restart.
          callbacks.onText(event.content);
        } else if (event.type === 'tool_call' && event.toolCall) {
          toolCalls.push(event.toolCall);
          callbacks.onToolCall(event.toolCall);
        } else if (event.type === 'error' && event.error) {
          streamError = event.error;
          break;
        } else if (event.type === 'done') {
          streamDone = true;
          if (event.usage) {
            turnUsage = event.usage;
            lastUsage = turnUsage;
          }
        }
        if (signal?.aborted) break;
      }
    } catch (e) {
      // Abort looks like an AbortError; keep whatever content we have and stop.
      if (signal?.aborted) {
        break;
      }
      streamError = e instanceof Error ? e.message : String(e);
    }

    assistantContent = textBuffer;

    // If the stream ended with an error, surface it and stop the loop. Keep
    // any partial assistant text/tool call metadata in returned history so
    // callers that persist sessions do not lose what was already rendered.
    if (streamError) {
      log.warn('stream error', { error: streamError, contentLen: assistantContent.length, toolCallCount: toolCalls.length });
      if (assistantContent.length > 0 || toolCalls.length > 0) {
        newHistory.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: assistantContent,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          timestamp: Date.now(),
        });
      }
      callbacks.onError(streamError);
      return newHistory;
    }

    // If we got no done event and no error, the stream was aborted or
    // ended unexpectedly — keep what we have and finish.
    if (!streamDone && signal?.aborted) {
      if (assistantContent.length > 0 || toolCalls.length > 0) {
        newHistory.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: assistantContent,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          timestamp: Date.now(),
        });
      }
      break;
    }

    if (turnUsage) {
      callbacks.onUsage?.(turnUsage);
    }

    const toolResults: ToolResult[] = [];
    for (const call of toolCalls) {
      if (signal?.aborted) break;

      const canonName = canonicalToolName(call.name);

      // PreToolUse hook — can block the tool before execution.
      const preHookResults = await runHooks(
        config.settings.hooks.PreToolUse,
        'PreToolUse',
        {
          workspace: config.workspace,
          event: 'PreToolUse',
          toolName: canonName,
          toolArgs: call.arguments,
        },
      );
      const blocked = preHookResults.find((r) => r.action === 'block');
      if (blocked) {
        toolResults.push({
          toolCallId: call.id,
          success: false,
          output: '',
          error: `SKIPPED: Blocked by hook${blocked.message ? `: ${blocked.message}` : ''}`,
        });
        callbacks.onToolResult(toolResults[toolResults.length - 1]);
        continue;
      }

      if (needsPermissionCheck(mode) && !approveAll.includes(call.name)) {
        const canonName = canonicalToolName(call.name);
        // When in accept-edits mode, Edit and Write are automatically allowed.
        const autoApproved =
          mode === 'accept-edits' && (canonName === 'Edit' || canonName === 'Write');

        if (!autoApproved) {
          // Consult the resolved permission rules from settings (deny → ask → allow).
          let permission: 'allow' | 'deny' | 'always' | undefined;
          if (mode !== 'plan' && mode !== 'dontAsk') {
            const verdict = evaluatePermission(canonName, call.arguments, config.settings);
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
            log.debug('permission denied', { tool: canonName });
            const deniedResult: ToolResult = {
              toolCallId: call.id,
              success: false,
              output: '',
              error: 'SKIPPED: Permission denied',
            };
            toolResults.push(deniedResult);
            callbacks.onToolResult(deniedResult);
            continue;
          }
          if (permission === 'always') {
            log.debug('permission always', { tool: canonName });
            approveAll.push(call.name);
          }
        }
      }

      const toolStartMs = Date.now();
      log.debug('tool start', { name: canonName, id: call.id, args: Object.keys(call.arguments) });
      const result = await registry.execute(call, toolContext, retry.toolRetries);
      result.toolCallId = call.id;
      result.durationMs = Date.now() - toolStartMs;
      log.info('tool done', {
        name: canonName,
        success: result.success,
        durationMs: result.durationMs,
        outputLen: result.output?.length ?? 0,
      });

      // PostToolUse hook — can modify the result output.
      const postHookResults = await runHooks(
        config.settings.hooks.PostToolUse,
        'PostToolUse',
        {
          workspace: config.workspace,
          event: 'PostToolUse',
          toolName: canonName,
          toolArgs: call.arguments,
          toolOutput: result.success ? result.output : result.error ?? '',
        },
      );
      for (const r of postHookResults) {
        if (r.action === 'modify' && r.modifiedOutput !== undefined) {
          result.output = r.modifiedOutput;
        }
      }

      toolResults.push(result);
      callbacks.onToolResult(result);

      // Sync the agent todo list after each tool execution.
      if (callbacks.onTodos && toolContext.todos) {
        callbacks.onTodos(toolContext.todos);
      }
    }

    // Stop hook — fire-and-forget after each turn.
    runHooks(config.settings.hooks.Stop, 'Stop', {
      workspace: config.workspace,
      event: 'Stop',
    }).catch((err) => console.warn('Stop hook failed:', err));

    newHistory.push({
      id: crypto.randomUUID(),
      role: 'assistant',
      content: assistantContent,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
      timestamp: Date.now(),
    });

    log.info('turn complete', {
      turn,
      contentLen: assistantContent.length,
      toolCallCount: toolCalls.length,
      toolResultCount: toolResults.length,
    });

    if (toolCalls.length === 0 || signal?.aborted) {
      break;
    }
  }

  if (turn >= config.maxTurns) {
    log.warn('max turns reached', { maxTurns: config.maxTurns });
    callbacks.onError(`Reached max turns (${config.maxTurns}). Refine your prompt or increase BOOK_MAX_TURNS.`);
  }

  // SessionEnd hook — fire-and-forget at session end.
  runHooks(config.settings.hooks.SessionEnd, 'SessionEnd', {
    workspace: config.workspace,
    event: 'SessionEnd',
  }).catch((err) => console.warn('SessionEnd hook failed:', err));

  callbacks.onDone();
  return newHistory;
}

export { needsPermissionCheck };
