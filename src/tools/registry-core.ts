import { createHash } from 'node:crypto';
import type { ToolDefinition, ToolContext, ToolResult, ToolCall } from '../types/tools.js';
import { escapeInvisibleCharacters } from '../control-characters.js';
import { TOOL_ALIASES } from './aliases.js';
import { normalizeToolDefinition } from './catalog.js';
import { validateToolArguments } from './schema.js';
import { enrichToolResultPresentation, normalizeToolResult, toolFailure } from './result.js';
import { MAX_SAFE_TIMEOUT_MS, resolveToolTimeoutMs, SELF_TIMEOUT_GRACE_MS } from './timeouts.js';

const TOOL_ABORT_GRACE_MS = 250;
const REPEATED_FAILURE_MEMORY_CAP = 32;
const PROVIDER_TOOL_PREFIXES = ['parent:', 'default:', 'tool:'] as const;

export interface PreparedToolCall {
  call: ToolCall;
  tool: ToolDefinition;
  timeoutMs: number;
}

export type PrepareToolCallResult =
  { status: 'ready'; prepared: PreparedToolCall } | { status: 'rejected'; result: ToolResult };

function resolveRegisteredTool(
  tools: Map<string, ToolDefinition>,
  name: string,
): ToolDefinition | undefined {
  const exact = tools.get(name);
  if (exact) return exact;

  const aliased = TOOL_ALIASES[name];
  if (aliased) {
    const tool = tools.get(aliased);
    if (tool) return tool;
  }

  const prefix = PROVIDER_TOOL_PREFIXES.find((candidate) => name.startsWith(candidate));
  if (!prefix) return undefined;
  const unwrapped = name.slice(prefix.length);
  return tools.get(unwrapped) ?? tools.get(TOOL_ALIASES[unwrapped] ?? '');
}

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
 * The key both provider clients wrap tool-call arguments in when they are not
 * valid JSON: `{ __raw: "<text>" }` (`parseToolArguments` in
 * provider/openai-compatible.ts and provider/anthropic.ts).
 */
const RAW_ARGUMENTS_KEY = '__raw';

type InvalidJsonShape =
  'truncated_start' | 'truncated_end' | 'concatenated' | 'single_quoted' | 'syntax';

interface InvalidJsonArguments {
  shape: InvalidJsonShape;
  message: string;
  remediation: string;
  position?: number;
}

const ONLY_THIS_CALL = 'Correct only this failed call; do not repeat successful siblings.';

/** A JSON string literal with every invisible character escaped, for quoting raw text. */
function quoteRaw(text: string): string {
  return escapeInvisibleCharacters(JSON.stringify(text));
}

/**
 * Why a call's arguments were not valid JSON, and what to do about it, or
 * undefined when they were.
 *
 * The providers keep only the raw text, so it is parsed again here to recover
 * V8's error, and sorted into a shape with its own advice:
 *
 * - `truncated_start`: the text does not begin with `{`. A router dropped the
 *   call's first fragment on the wire (seen on 9router, #260); the model's JSON
 *   was fine, so it resends as is.
 * - `truncated_end`: the text stops before the JSON is complete (`Unexpected
 *   end of JSON input`, or a parse error at its very end): the output was cut off.
 * - `concatenated`: a second object follows the first.
 * - `single_quoted`: a key or string in single quotes.
 * - `syntax`: anything else, most often an unescaped backslash or newline in a
 *   string.
 *
 * "position N" counts in the raw text, which the model never sees again as such
 * (its replayed call is `JSON.stringify({__raw})`), so the text on both sides of
 * the position is quoted too. V8's message is shown with invisible characters
 * escaped rather than folded, so a rejected NUL or BOM is visible.
 */
function describeInvalidJson(
  toolName: string,
  args: Record<string, unknown>,
): InvalidJsonArguments | undefined {
  const raw = args[RAW_ARGUMENTS_KEY];
  // Exactly the shape the providers emit; anything else is the schema's to judge.
  if (typeof raw !== 'string' || Object.keys(args).length !== 1) return undefined;
  let parseError: string;
  try {
    JSON.parse(raw);
    // Valid JSON under the key is a literal `__raw` argument, not a parse failure.
    return undefined;
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }
  const prefix = `Invalid JSON arguments for ${toolName}:`;
  const opening = raw.trimStart();
  if (!opening.startsWith('{')) {
    return {
      shape: 'truncated_start',
      message: `${prefix} they arrived truncated at the start, beginning ${quoteRaw(opening.slice(0, 40))} instead of "{".`,
      remediation: `The provider or router most likely dropped the first fragment of this call on its way to Book, so none of its arguments were read. Resend the whole call. ${ONLY_THIS_CALL}`,
    };
  }
  const detail = escapeInvisibleCharacters(parseError);
  const positionMatch = /at position (\d+)/.exec(parseError);
  const position = positionMatch ? Number(positionMatch[1]) : undefined;
  // V8 says "Unexpected end of JSON input" only for some cut-off texts; `{"a": "b"` gets
  // "Expected ',' or '}' after property value … at position 9", a position at the very end.
  const endsEarly = parseError.startsWith('Unexpected end of JSON input');
  if (endsEarly || (position !== undefined && position >= raw.trimEnd().length)) {
    return {
      shape: 'truncated_end',
      position: raw.length,
      message: `${prefix} ${endsEarly ? `${detail} at position ${raw.length}` : detail}. The text ends ${quoteRaw(raw.slice(-40))}.`,
      remediation: `The arguments stop before the JSON is complete, so the output was probably cut off, and none of them were read. Resend the whole call; if its arguments are long, split the change into smaller calls. ${ONLY_THIS_CALL}`,
    };
  }
  const around =
    position === undefined
      ? ''
      : ` The text before position ${position} ends ${quoteRaw(raw.slice(Math.max(0, position - 30), position))}, and the text from it starts ${quoteRaw(raw.slice(position, position + 30))}.`;
  const message = `${prefix} ${detail}.${around}`;
  if (
    parseError.startsWith('Unexpected non-whitespace character after JSON') &&
    position !== undefined &&
    raw.slice(position).trimStart().startsWith('{')
  ) {
    return {
      shape: 'concatenated',
      position,
      message,
      remediation: `The arguments hold more than one JSON object, and none of them were read. Send exactly one JSON object per call: merge the arguments into one object, or make separate calls. ${ONLY_THIS_CALL}`,
    };
  }
  if (
    (position !== undefined && raw[position] === "'") ||
    parseError.startsWith("Unexpected token '''")
  ) {
    return {
      shape: 'single_quoted',
      position,
      message,
      remediation: `JSON needs double quotes around every key and string value, and these arguments use single quotes, so none of them were read. Resend the whole call with double quotes. ${ONLY_THIS_CALL}`,
    };
  }
  return {
    shape: 'syntax',
    position,
    message,
    remediation: `None of its arguments were read. Resend the whole call with valid JSON; escape backslashes and newlines inside strings. ${ONLY_THIS_CALL}`,
  };
}

/**
 * Advisory circuit breaker: when the model repeats a call that already failed
 * with the same arguments and error, escalate the remediation instead of
 * letting an identical-retry loop run. Never blocks the call itself.
 */
function noteRepeatedFailure(context: ToolContext, call: ToolCall, result: ToolResult): ToolResult {
  const memory = context.runtime?.recentToolFailures;
  // A refusal the tool itself returns (`blocked`, such as the web network policy's) is never
  // retried, but a model re-issuing it unchanged is spinning just the same.
  const escalates = result.status === 'error' || result.status === 'blocked';
  if (!memory || !escalates || !result.structuredError) return result;
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
    const tool = resolveRegisteredTool(tools, call.name);
    if (!tool) return call;
    return { ...call, name: tool.name, arguments: normalizeToolArguments(tool, call.arguments) };
  };

  const inactiveRejection = (call: ToolCall): ToolResult =>
    toolFailure(`Tool "${call.name}" is not active for this turn.`, {
      toolCallId: call.id,
      code: 'tool_not_active',
      status: 'blocked',
      remediation: 'Call ToolSearch to discover it or use an authorized active tool.',
    });

  /** The invalid-JSON rejection for a normalized call, or undefined when its arguments parsed. */
  const invalidJsonRejection = (
    tool: ToolDefinition,
    normalizedCall: ToolCall,
    context: ToolContext,
  ): ToolResult | undefined => {
    const invalid = describeInvalidJson(tool.name, normalizedCall.arguments);
    if (!invalid) return undefined;
    return noteRepeatedFailure(
      context,
      normalizedCall,
      toolFailure(invalid.message, {
        toolCallId: normalizedCall.id,
        code: 'invalid_json_arguments',
        remediation: invalid.remediation,
        details: {
          shape: invalid.shape,
          ...(invalid.position === undefined ? {} : { position: invalid.position }),
        },
      }),
    );
  };

  /** Name-only visibility, or the whole `canExecute` for a discovery object without `isActive`. */
  const isVisible = (normalizedCall: ToolCall, context: ToolContext): boolean => {
    const discovery = context.toolDiscovery;
    if (!discovery) return true;
    return discovery.isActive
      ? discovery.isActive(normalizedCall.name)
      : discovery.canExecute(normalizedCall);
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
      return resolveRegisteredTool(tools, name);
    },
    getDefinitions(): ToolDefinition[] {
      return Array.from(tools.values());
    },
    /**
     * The rejection for a call whose arguments never parsed (`{__raw}`), or undefined for any
     * other call. The agent loop asks this before PreToolUse hooks and the permission check,
     * because such a call can never run: a hook would judge the wrapper, the user would be asked
     * to approve it, and "Always" would save a rule built from junk. An inactive tool is still
     * refused as inactive first, as in `prepare`.
     */
    rejectUnparsedArguments(call: ToolCall, context: ToolContext): ToolResult | undefined {
      const tool = resolveRegisteredTool(tools, call.name);
      if (!tool) return undefined;
      const normalizedCall: ToolCall = {
        ...call,
        name: tool.name,
        arguments: normalizeToolArguments(tool, call.arguments),
      };
      if (describeInvalidJson(tool.name, normalizedCall.arguments) === undefined) return undefined;
      if (!isVisible(normalizedCall, context)) return inactiveRejection(call);
      return invalidJsonRejection(tool, normalizedCall, context);
    },
    prepare(call: ToolCall, context: ToolContext): PrepareToolCallResult {
      const tool = resolveRegisteredTool(tools, call.name);
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
      const discovery = context.toolDiscovery;
      // A tool that is not active is refused as such, whatever its arguments.
      // A discovery object without the name-only `isActive` gets its whole
      // `canExecute` check here instead, before the JSON check, which is where
      // it ran before `isActive` existed: every call it refused is refused alike.
      if (!isVisible(normalizedCall, context))
        return { status: 'rejected', result: inactiveRejection(call) };
      // Invalid JSON is named before the argument-scoped rules run: a rule such
      // as `Bash(git *)` cannot match text that never parsed, so the gate would
      // report a malformed call to an active tool as an inactive one.
      const jsonRejection = invalidJsonRejection(tool, normalizedCall, context);
      if (jsonRejection) return { status: 'rejected', result: jsonRejection };
      if (discovery?.isActive && !discovery.canExecute(normalizedCall))
        return { status: 'rejected', result: inactiveRejection(call) };

      const providerArguments = { ...normalizedCall.arguments };
      // Hide the host control from validation only while the tool keeps it
      // hidden from the model; a tool that publishes `timeout` gets it checked.
      if (!tool.inputSchema?.properties?.timeout) delete providerArguments.timeout;
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

      const declaredTimeoutMs =
        typeof tool.timeoutMs === 'function' ? tool.timeoutMs(context) : tool.timeoutMs;
      const resolvedTimeoutMs = resolveToolTimeoutMs({
        // Only a tool that publishes `timeout` lets the model set the budget.
        // Honouring a stray value everywhere shrank the backstop under tools
        // that time themselves — a `Check` call carrying `timeout: 5000` got a
        // 15s budget against its own 600s deadline, reinstating the very race
        // this resolver exists to prevent — and an MCP tool whose own `timeout`
        // means seconds turned `timeout: 30` into a 30ms deadline.
        requested: tool.inputSchema?.properties?.timeout
          ? normalizedCall.arguments.timeout
          : undefined,
        // A function-form declaration is the tool's own resolution: it has
        // already ranked its setting against BOOK_TOOL_TIMEOUT_MS (Check, Task),
        // so it outranks the override here too. Ranked the other way round, a
        // one-hour `agents.taskTimeoutMs` under a ten-minute override had the
        // backstop fire first at 610s and the child's partial result lost. A
        // constant declaration is only a default beneath the override.
        configured: typeof tool.timeoutMs === 'function' ? declaredTimeoutMs : undefined,
        env: context.env,
        fallback: declaredTimeoutMs,
      });
      // A tool that enforces its own deadline reports the timeout itself, with
      // whatever output it captured. The registry stays a backstop behind it.
      // The grace must not push the backstop past the timer limit: Node fires a longer timer
      // almost at once, which timed out every Task configured with a very large ceiling.
      const toolTimeoutMs =
        declaredTimeoutMs === undefined
          ? resolvedTimeoutMs
          : Math.min(resolvedTimeoutMs + SELF_TIMEOUT_GRACE_MS, MAX_SAFE_TIMEOUT_MS);
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
          if (result.status === 'blocked')
            return noteRepeatedFailure(context, normalizedCall, result);
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
