import { createHash } from 'node:crypto';
import type { ToolDefinition, ToolContext, ToolResult, ToolCall } from '../types/tools.js';
import { TOOL_ALIASES } from './aliases.js';
import { normalizeToolDefinition } from './catalog.js';
import { validateToolArguments } from './schema.js';
import { enrichToolResultPresentation, normalizeToolResult, toolFailure } from './result.js';

const TOOL_ABORT_GRACE_MS = 250;
const REPEATED_FAILURE_MEMORY_CAP = 32;

export interface PreparedToolCall {
  call: ToolCall;
  tool: ToolDefinition;
  timeoutMs: number;
}

export type PrepareToolCallResult =
  { status: 'ready'; prepared: PreparedToolCall } | { status: 'rejected'; result: ToolResult };

function applyAliasKeys(
  target: Record<string, unknown>,
  aliases: Record<string, string>,
): Record<string, unknown> {
  const normalized = { ...target };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (!(canonical in normalized) && alias in normalized)
      normalized[canonical] = normalized[alias];
    delete normalized[alias];
  }
  return normalized;
}

/** Apply the definition-declared argument aliases (top-level and per array item). */
function normalizeToolArguments(
  tool: ToolDefinition,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const normalized = applyAliasKeys(args, tool.argumentAliases ?? {});
  for (const [argName, itemAliases] of Object.entries(tool.arrayItemArgumentAliases ?? {})) {
    const items = normalized[argName];
    if (!Array.isArray(items)) continue;
    normalized[argName] = items.map((item) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? applyAliasKeys(item as Record<string, unknown>, itemAliases)
        : item,
    );
  }
  return normalized;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Advisory circuit breaker: when the model repeats a call that already failed
 * with the same arguments and error, escalate the remediation instead of
 * letting an identical-retry loop run. Never blocks the call itself.
 */
function noteRepeatedFailure(context: ToolContext, call: ToolCall, result: ToolResult): ToolResult {
  const memory = context.runtime?.recentToolFailures;
  if (!memory || result.status !== 'error' || !result.structuredError) return result;
  const significantArgs = { ...call.arguments };
  delete significantArgs.timeout;
  const signature = `${call.name}:${result.structuredError.code}:${createHash('sha256')
    .update(stableStringify(significantArgs))
    .digest('hex')}`;
  const previousFailures = memory.get(signature) ?? 0;
  memory.delete(signature);
  memory.set(signature, previousFailures + 1);
  while (memory.size > REPEATED_FAILURE_MEMORY_CAP) {
    const oldest = memory.keys().next().value;
    if (oldest === undefined) break;
    memory.delete(oldest);
  }
  // Escalate only genuine repeats; a retryable transient failure may legitimately
  // be retried unchanged, and the tool's own remediation must stay visible.
  if (previousFailures === 0 || result.structuredError.retryable) return result;
  const escalation = `This exact ${call.name} call already failed ${previousFailures} time(s) with the same arguments. Do not retry it unchanged: re-read the target, revise the arguments, or use a different tool.`;
  const existing = result.structuredError.remediation;
  return {
    ...result,
    structuredError: {
      ...result.structuredError,
      remediation: existing ? `${existing} ${escalation}` : escalation,
    },
  };
}

async function executeWithTimeout(
  tool: ToolDefinition,
  call: ToolCall,
  context: ToolContext,
  timeoutMs: number,
): Promise<ToolResult> {
  const parentSignal = context.signal;
  const controller =
    context.runtime?.trackAbortController(new AbortController()) ?? new AbortController();
  const pendingNestedCalls = new Map<string, string>();
  let active = true;
  let timer: NodeJS.Timeout | undefined;
  let removeParentAbort: (() => void) | undefined;
  let outcome: 'tool' | 'timeout' | 'cancelled' = 'tool';
  let abortOutcome: 'timeout' | 'cancelled' = 'cancelled';

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
    const executionSettled = execution.then(
      () => undefined,
      () => undefined,
    );
    const interruption = new Promise<{
      kind: 'timeout' | 'cancelled';
      result: ToolResult;
    }>((resolve) => {
      const onAbort = () => {
        const timedOut = abortOutcome === 'timeout';
        resolve({
          kind: abortOutcome,
          result: toolFailure(timedOut ? timeoutError : cancelledError, {
            toolCallId: call.id,
            code: timedOut ? 'tool_timeout' : 'cancelled',
            status: timedOut ? 'timed_out' : 'cancelled',
            retryable: timedOut && tool.idempotent === true,
          }),
        });
      };
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener('abort', onAbort, { once: true });
    });

    timer = setTimeout(() => {
      abortOutcome = 'timeout';
      controller.abort(new Error(timeoutError));
    }, timeoutMs);
    if (context.runtime) context.runtime.trackTimer(timer);

    if (parentSignal) {
      const onAbort = () => {
        abortOutcome = 'cancelled';
        controller.abort(parentSignal.reason);
      };
      if (parentSignal.aborted) onAbort();
      else {
        parentSignal.addEventListener('abort', onAbort, { once: true });
        removeParentAbort = () => parentSignal.removeEventListener('abort', onAbort);
      }
    }

    const settled = await Promise.race([execution, interruption]);
    outcome = settled.kind;
    if (outcome !== 'tool') {
      active = false;
      await waitForSettlement(executionSettled, TOOL_ABORT_GRACE_MS);
    }
    return settled.result;
  } finally {
    if (timer) {
      if (context.runtime) context.runtime.releaseTimer(timer);
      else clearTimeout(timer);
    }
    context.runtime?.releaseAbortController(controller);
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

async function waitForSettlement(settled: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      settled,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createRegistry() {
  const tools = new Map<string, ToolDefinition>();

  /** Canonicalize a call's tool name and argument spellings without executing it. */
  const normalizeCall = (call: ToolCall): ToolCall => {
    const tool = tools.get(TOOL_ALIASES[call.name] ?? call.name);
    if (!tool) return call;
    return { ...call, name: tool.name, arguments: normalizeToolArguments(tool, call.arguments) };
  };

  return {
    normalizeCall,
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
    prepare(call: ToolCall, context: ToolContext): PrepareToolCallResult {
      const tool = tools.get(TOOL_ALIASES[call.name] ?? call.name);
      if (!tool) {
        return {
          status: 'rejected',
          result: noteRepeatedFailure(
            context,
            call,
            toolFailure(`Unknown tool: ${call.name}`, {
              toolCallId: call.id,
              code: 'unknown_tool',
              remediation: 'Call ToolSearch or use a provider-visible tool name.',
            }),
          ),
        };
      }

      const normalizedCall: ToolCall = {
        ...call,
        name: tool.name,
        arguments: normalizeToolArguments(tool, call.arguments),
      };
      if (context.toolDiscovery && !context.toolDiscovery.canExecute(normalizedCall)) {
        return {
          status: 'rejected',
          result: toolFailure(`Tool "${call.name}" is not active for this turn.`, {
            toolCallId: call.id,
            code: 'tool_not_active',
            status: 'blocked',
            remediation: 'Call ToolSearch to discover it or use an authorized active tool.',
          }),
        };
      }

      const providerArguments = { ...normalizedCall.arguments };
      delete providerArguments.timeout;
      const validationErrors = validateToolArguments(providerArguments, tool.inputSchema!);
      if (validationErrors.length > 0) {
        const allowedKeys = Object.keys(tool.inputSchema?.properties ?? {});
        const allowedSuffix = allowedKeys.length
          ? ` Allowed arguments: ${allowedKeys.join(', ')}.`
          : '';
        return {
          status: 'rejected',
          result: noteRepeatedFailure(
            context,
            normalizedCall,
            toolFailure(
              `Invalid arguments for ${tool.name}: ${validationErrors.join('; ')}.${allowedSuffix}`,
              {
                toolCallId: call.id,
                code: 'invalid_arguments',
                remediation: 'Correct only this failed call; do not repeat successful siblings.',
              },
            ),
          ),
        };
      }

      const toolTimeoutMs =
        (normalizedCall.arguments.timeout as number) ??
        (context.env?.BOOK_TOOL_TIMEOUT_MS ? Number(context.env.BOOK_TOOL_TIMEOUT_MS) : 120_000);
      return {
        status: 'ready',
        prepared: { call: normalizedCall, tool, timeoutMs: toolTimeoutMs },
      };
    },
    async executePrepared(
      prepared: PreparedToolCall,
      context: ToolContext,
      maxRetries: number = 0,
    ): Promise<ToolResult> {
      const { call: normalizedCall, tool, timeoutMs: toolTimeoutMs } = prepared;
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
            toolCallId: normalizedCall.id,
            code: 'tool_exception',
            retryable: tool.idempotent === true,
          });
        }
        if (attempt < retries)
          await new Promise((resolve) => setTimeout(resolve, 250 + Math.random() * 500));
      }
      return noteRepeatedFailure(context, normalizedCall, lastResult!);
    },
    async execute(
      call: ToolCall,
      context: ToolContext,
      maxRetries: number = 0,
    ): Promise<ToolResult> {
      const prepared = this.prepare(call, context);
      if (prepared.status === 'rejected') return prepared.result;
      return this.executePrepared(prepared.prepared, context, maxRetries);
    },
  };
}

export type ToolRegistry = ReturnType<typeof createRegistry>;
