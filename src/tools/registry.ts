import type { ToolDefinition, ToolContext, ToolResult, ToolCall } from '../types.js';
import { fileTools } from './file.js';
import { shellTools } from './shell.js';
import { gitTools } from './git.js';
import { todoTools } from './todo.js';
import { webTools } from './web.js';
import { skillsTool } from './skills-tool.js';
import { taskTool } from './task-tool.js';
import { taskTools } from './tasks.js';
import { planModeTools } from './plan-mode.js';
import { notebookTools } from './notebook.js';
import { TOOL_ALIASES } from './aliases.js';
import { createSessionHistoryTools, type SessionHistoryCapability } from './session-history.js';
import { askUserQuestionTools } from './ask-user-question.js';
import { agentLifecycleTools, evidenceTools } from './agent-tools.js';
import { checkTools } from '../agents/check.js';

async function executeWithTimeout(
  tool: ToolDefinition,
  call: ToolCall,
  context: ToolContext,
  timeoutMs: number,
): Promise<ToolResult> {
  const parentSignal = context.signal;
  const controller = new AbortController();
  const pendingNestedCalls = new Map<string, string>();
  let active = true;
  let timer: NodeJS.Timeout | undefined;
  let removeParentAbort: (() => void) | undefined;
  let outcome: 'tool' | 'timeout' | 'cancelled' = 'tool';

  const parentObserver = context.nestedToolObserver;
  const scopedObserver = parentObserver
    ? {
        onToolCall: (invocation: Parameters<typeof parentObserver.onToolCall>[0]) => {
          if (!active) return;
          pendingNestedCalls.set(invocation.traceId, invocation.call.id);
          parentObserver.onToolCall(invocation);
        },
        onToolResult: (traceId: string, result: ToolResult) => {
          if (!active) return;
          pendingNestedCalls.delete(traceId);
          parentObserver.onToolResult(traceId, result);
        },
      }
    : undefined;

  const attemptContext = new Proxy(context, {
    get(target, property, receiver) {
      if (property === 'signal') return controller.signal;
      if (property === 'nestedToolObserver') return scopedObserver;
      return Reflect.get(target, property, receiver);
    },
    set(target, property, value, receiver) {
      if (property === 'signal' || property === 'nestedToolObserver') return false;
      return Reflect.set(target, property, value, receiver);
    },
  });

  const timeoutError = `Tool timeout: ${tool.name} exceeded ${timeoutMs}ms`;
  const cancelledError = `CANCELLED: ${tool.name} was cancelled`;

  try {
    const execution = Promise.resolve()
      .then(() => tool.execute(call.arguments, attemptContext))
      .then((result) => ({ kind: 'tool' as const, result }));

    const timeout = new Promise<{ kind: 'timeout'; result: ToolResult }>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error(timeoutError));
        resolve({
          kind: 'timeout',
          result: { toolCallId: call.id, success: false, output: '', error: timeoutError },
        });
      }, timeoutMs);
    });

    const races: Array<Promise<{ kind: 'tool' | 'timeout' | 'cancelled'; result: ToolResult }>> = [
      execution,
      timeout,
    ];
    if (parentSignal) {
      races.push(
        new Promise<{ kind: 'cancelled'; result: ToolResult }>((resolve) => {
          const onAbort = () => {
            controller.abort(parentSignal.reason);
            resolve({
              kind: 'cancelled',
              result: { toolCallId: call.id, success: false, output: '', error: cancelledError },
            });
          };
          if (parentSignal.aborted) {
            onAbort();
          } else {
            parentSignal.addEventListener('abort', onAbort, { once: true });
            removeParentAbort = () => parentSignal.removeEventListener('abort', onAbort);
          }
        }),
      );
    }

    const settled = await Promise.race(races);
    outcome = settled.kind;
    return settled.result;
  } finally {
    if (timer) clearTimeout(timer);
    removeParentAbort?.();

    active = false;
    if (parentObserver && pendingNestedCalls.size > 0) {
      const error =
        outcome === 'timeout'
          ? timeoutError
          : outcome === 'cancelled'
            ? cancelledError
            : `${tool.name} finished before its nested tool completed`;
      for (const [traceId, toolCallId] of pendingNestedCalls) {
        parentObserver.onToolResult(traceId, {
          toolCallId,
          success: false,
          output: '',
          error,
        });
      }
    }
  }
}

export function createRegistry() {
  const tools = new Map<string, ToolDefinition>();

  return {
    register(tool: ToolDefinition): void {
      tools.set(tool.name, tool);
    },

    registerAll(toolList: ToolDefinition[]): void {
      for (const t of toolList) {
        tools.set(t.name, t);
      }
    },

    getTool(name: string): ToolDefinition | undefined {
      return tools.get(TOOL_ALIASES[name] ?? name);
    },

    getDefinitions(): ToolDefinition[] {
      return Array.from(tools.values());
    },

    async execute(
      call: ToolCall,
      context: ToolContext,
      maxRetries: number = 0,
    ): Promise<ToolResult> {
      const tool = tools.get(TOOL_ALIASES[call.name] ?? call.name);
      if (!tool) {
        return {
          toolCallId: call.id,
          success: false,
          output: '',
          error: `Unknown tool: ${call.name}`,
        };
      }

      // Default tool timeout: 120s, falling back to per-tool or explicit timeout.
      const toolTimeoutMs =
        (call.arguments.timeout as number) ??
        (context.env?.BOOK_TOOL_TIMEOUT_MS ? Number(context.env.BOOK_TOOL_TIMEOUT_MS) : 120_000);

      // Only retry idempotent tools.
      const retries = tool.idempotent ? maxRetries : 0;

      let lastResult: ToolResult | null = null;

      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const result = await executeWithTimeout(tool, call, context, toolTimeoutMs);

          if (result.success) {
            if (attempt > 0) {
              result.retryAttempt = attempt + 1;
            }
            return result;
          }

          // Don't retry on SKIPPED results (permission/hook blocks).
          if (result.error?.startsWith('SKIPPED')) {
            return result;
          }

          lastResult = result;
          // Fall through to retry if attempts remain.
        } catch (e) {
          lastResult = {
            toolCallId: call.id,
            success: false,
            output: '',
            error: e instanceof Error ? e.message : String(e),
          };
          // Fall through to retry if attempts remain.
        }

        // Small fixed delay before retry with jitter.
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 250 + Math.random() * 500));
        }
      }

      return lastResult!;
    },
  };
}

export function createDefaultRegistry(capabilities?: {
  sessionHistory?: SessionHistoryCapability;
  agents?: boolean;
}): ReturnType<typeof createRegistry> {
  const registry = createRegistry();
  registry.registerAll([
    ...fileTools,
    ...shellTools,
    ...gitTools,
    ...todoTools,
    ...webTools,
    ...skillsTool,
    ...taskTools,
    ...planModeTools,
    ...askUserQuestionTools,
    ...notebookTools,
  ]);
  if (capabilities?.agents !== false) {
    registry.registerAll([...agentLifecycleTools, ...evidenceTools, ...taskTool, ...checkTools]);
  }
  if (capabilities?.sessionHistory) {
    registry.registerAll(createSessionHistoryTools(capabilities.sessionHistory));
  }
  return registry;
}

export type ToolRegistry = ReturnType<typeof createRegistry>;
