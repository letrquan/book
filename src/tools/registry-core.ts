import type { ToolDefinition, ToolContext, ToolResult, ToolCall } from '../types/tools.js';
import { TOOL_ALIASES } from './aliases.js';
import { normalizeToolDefinition } from './catalog.js';
import { validateToolArguments } from './schema.js';
import { enrichToolResultPresentation, normalizeToolResult, toolFailure } from './result.js';

const TOOL_ARGUMENT_ALIASES: Record<string, Record<string, string>> = {
  Bash: { runInBackground: 'run_in_background' },
  BashOutput: { shellId: 'shell_id' },
  KillShell: { shellId: 'shell_id' },
  TaskGet: { task_id: 'taskId' },
  TaskUpdate: { task_id: 'taskId' },
  TaskStop: { task_id: 'taskId' },
};

function normalizeToolArguments(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = { ...args };
  for (const [alias, canonical] of Object.entries(TOOL_ARGUMENT_ALIASES[toolName] ?? {})) {
    if (!(canonical in normalized) && alias in normalized)
      normalized[canonical] = normalized[alias];
    delete normalized[alias];
  }
  return normalized;
}

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
          result: toolFailure(timeoutError, {
            toolCallId: call.id,
            code: 'tool_timeout',
            status: 'timed_out',
            retryable: tool.idempotent === true,
          }),
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
              result: toolFailure(cancelledError, {
                toolCallId: call.id,
                code: 'cancelled',
                status: 'cancelled',
              }),
            });
          };
          if (parentSignal.aborted) onAbort();
          else {
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
        parentObserver.onToolResult(
          traceId,
          toolFailure(error, {
            toolCallId,
            code: outcome === 'timeout' ? 'tool_timeout' : 'cancelled',
            status: outcome === 'timeout' ? 'timed_out' : 'cancelled',
          }),
        );
      }
    }
  }
}

export function createRegistry() {
  const tools = new Map<string, ToolDefinition>();

  return {
    register(tool: ToolDefinition): void {
      const normalized = normalizeToolDefinition(tool);
      tools.set(normalized.name, normalized);
    },
    registerAll(toolList: ToolDefinition[]): void {
      for (const tool of toolList) this.register(tool);
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
        return toolFailure(`Unknown tool: ${call.name}`, {
          toolCallId: call.id,
          code: 'unknown_tool',
          remediation: 'Call ToolSearch or use a provider-visible tool name.',
        });
      }

      const normalizedCall: ToolCall = {
        ...call,
        name: tool.name,
        arguments: normalizeToolArguments(tool.name, call.arguments),
      };
      if (context.toolDiscovery && !context.toolDiscovery.canExecute(normalizedCall)) {
        return toolFailure(`Tool "${call.name}" is not active for this turn.`, {
          toolCallId: call.id,
          code: 'tool_not_active',
          status: 'blocked',
          remediation: 'Call ToolSearch to discover it or use an authorized active tool.',
        });
      }

      const providerArguments = { ...normalizedCall.arguments };
      delete providerArguments.timeout;
      const validationErrors = validateToolArguments(providerArguments, tool.inputSchema!);
      if (validationErrors.length > 0) {
        return toolFailure(`Invalid arguments for ${tool.name}: ${validationErrors.join('; ')}`, {
          toolCallId: call.id,
          code: 'invalid_arguments',
          remediation: 'Correct the named arguments and retry the tool call.',
        });
      }

      const toolTimeoutMs =
        (normalizedCall.arguments.timeout as number) ??
        (context.env?.BOOK_TOOL_TIMEOUT_MS ? Number(context.env.BOOK_TOOL_TIMEOUT_MS) : 120_000);
      const retries = tool.idempotent ? maxRetries : 0;
      let lastResult: ToolResult | null = null;
      for (let attempt = 0; attempt <= retries; attempt++) {
        try {
          const result = enrichToolResultPresentation(
            normalizeToolResult(
              await executeWithTimeout(tool, normalizedCall, context, toolTimeoutMs),
            ),
            tool.name,
            normalizedCall.arguments,
          );
          if (result.status === 'success') {
            if (attempt > 0) result.metrics = { ...result.metrics, retryAttempt: attempt + 1 };
            return result;
          }
          if (result.status === 'blocked') return result;
          lastResult = result;
        } catch (error) {
          lastResult = toolFailure(error instanceof Error ? error.message : String(error), {
            toolCallId: call.id,
            code: 'tool_exception',
            retryable: tool.idempotent === true,
          });
        }
        if (attempt < retries)
          await new Promise((resolve) => setTimeout(resolve, 250 + Math.random() * 500));
      }
      return lastResult!;
    },
  };
}

export type ToolRegistry = ReturnType<typeof createRegistry>;
