/**
 * Streaming client for OpenAI's Responses API (`POST <baseUrl>/responses`, SSE).
 *
 * Selected per provider with `provider.<id>.api: "responses"` (`createProvider` in `port.ts`).
 * It does what the Chat Completions client does — text and reasoning deltas, function calls,
 * usage, finish reasons, effort — through the same retry, redirect, error-body and stall policy,
 * so the agent loop cannot tell the two apart.
 *
 * Every request sends `stream: true` and `store: false`. Book resends the whole conversation on
 * each turn and never uses `previous_response_id`, so nothing is gained by OpenAI keeping the
 * response, and plan-billed requests (Sign in with ChatGPT) require both values.
 */

import type { AgentConfig } from '../types/runtime.js';
import type {
  ProviderContentPart,
  ProviderMessage,
  ProviderStreamEvent,
  ProviderStreamOptions,
} from '../types/providers.js';
import type { ToolDefinition } from '../types/tools.js';
import type { Usage } from '../types/messages.js';
import { createDebugLogger } from '../debug-log.js';
import {
  parseCompatibleUsage,
  providerMessageText,
  streamStallCeilings,
  streamedToolCallEvent,
  withReplayedReasoning,
  type StreamedToolCallPart,
} from './openai-compatible.js';
import {
  classifyProviderError,
  fetchWithRetry,
  readErrorBody,
  readStreamChunk,
  statedWaitErrorEvent,
} from './reliability.js';

const log = createDebugLogger('provider:responses');

type InputItem = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inputParts(parts: ProviderContentPart[]): InputItem[] {
  return parts.map((part) =>
    part.type === 'text'
      ? { type: 'input_text', text: part.text }
      : {
          type: 'input_image',
          detail: 'auto',
          image_url: `data:${part.mediaType};base64,${part.data}`,
        },
  );
}

/**
 * Book's provider messages as a Responses request's `instructions` and `input` items.
 *
 * The leading system messages become `instructions`; one that arrives after the conversation
 * started is kept in place as a `developer` message. An assistant turn is its text (with
 * replayed reasoning delimited exactly as the Chat Completions client sends it) followed by one
 * `function_call` item per call, and a tool result is a `function_call_output` paired by
 * `call_id`. No item carries an `id`: with `store: false` OpenAI keeps no items to refer to.
 */
/**
 * How one Responses endpoint differs from the plain API. The ChatGPT plan route
 * (https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) refuses
 * `max_output_tokens` and wants function tools grouped in a namespace.
 */
export interface ResponsesRoute {
  /** Leave `max_output_tokens` out of every request, whatever caps the output. */
  omitMaxOutputTokens?: boolean;
  /** Send the tools as one namespace of this name, and name it on every replayed call. */
  toolNamespace?: string;
}

export function toResponsesInput(
  messages: ProviderMessage[],
  route: ResponsesRoute = {},
): {
  instructions?: string;
  input: InputItem[];
} {
  const instructions: string[] = [];
  const input: InputItem[] = [];
  for (const message of messages) {
    switch (message.role) {
      case 'system': {
        const text = providerMessageText(message.content);
        if (input.length === 0) {
          if (text) instructions.push(text);
        } else {
          input.push({ role: 'developer', content: text });
        }
        break;
      }
      case 'assistant': {
        const text = providerMessageText(message.content);
        const content = withReplayedReasoning(text, message.reasoningContent);
        if (content) input.push({ role: 'assistant', content });
        for (const call of message.tool_calls ?? []) {
          input.push({
            type: 'function_call',
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
            ...(route.toolNamespace ? { namespace: route.toolNamespace } : {}),
          });
        }
        break;
      }
      case 'tool':
        input.push({
          type: 'function_call_output',
          call_id: message.tool_call_id ?? '',
          output: Array.isArray(message.content)
            ? inputParts(message.content)
            : providerMessageText(message.content),
        });
        break;
      default:
        input.push({
          role: 'user',
          content: Array.isArray(message.content)
            ? inputParts(message.content)
            : [{ type: 'input_text', text: providerMessageText(message.content) }],
        });
    }
  }
  return instructions.length > 0 ? { instructions: instructions.join('\n\n'), input } : { input };
}

/** Book's tools as Responses function tools: flat, and not strict, since Book's schemas have optional properties. */
export function convertResponsesTools(tools: ToolDefinition[]): Array<{
  type: 'function';
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: false;
}> {
  return tools.map((tool) => ({
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema ?? tool.parameters,
    strict: false,
  }));
}

/**
 * A Responses `usage` object as Book's `Usage`. The names are translated into the Chat
 * Completions ones so the cache accounting stays in `parseCompatibleUsage`: `cached_tokens`
 * is part of `input_tokens`, as `prompt_tokens_details.cached_tokens` is of `prompt_tokens`.
 */
export function parseResponsesUsage(raw: unknown): Usage | null {
  if (!isRecord(raw)) return null;
  const details = isRecord(raw.input_tokens_details) ? raw.input_tokens_details : {};
  return parseCompatibleUsage({
    prompt_tokens: raw.input_tokens,
    completion_tokens: raw.output_tokens,
    total_tokens: raw.total_tokens,
    prompt_tokens_details: {
      cached_tokens: details.cached_tokens,
      cache_write_tokens: details.cache_write_tokens,
    },
  });
}

/** `ResponseError` codes, and plan-billing refusals, that reject the request as sent. */
const REJECTED_REQUEST_CODES =
  /^(?:invalid_prompt|data_residency_mismatch|bio_policy|misalignment_policy_violation|invalid_image\w*|invalid_base64_image|image_\w+|unsupported_image_media_type|empty_image_file|failed_to_download_image|subscription_sharing_unsupported_capability|subscription_sharing_user_not_eligible|subscription_sharing_route_not_supported|chatpass_v2_\w+)$/;

/**
 * The error code for a `response.failed` or `error` event. Codes that name a verdict the loop
 * already handles are mapped onto the codes it reads, as the Anthropic client does for its
 * mid-stream errors: a spent plan limit parks the run, an oversized request goes through the
 * overflow recovery, a temporary failure is re-sent, and a rejected request is not. The
 * `subscription_sharing_*` codes are the ones OpenAI documents for plan-billed requests.
 */
export function responsesErrorCode(code: string | null | undefined): string {
  switch (code) {
    case 'rate_limit_exceeded':
      return 'rate_limited';
    case 'insufficient_quota':
      return 'quota';
    case 'subscription_sharing_usage_limit_exceeded':
      return 'usage_limit';
    case 'context_length_exceeded':
      return 'context_overflow';
    case 'server_error':
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return 'server_error';
    case 'invalid_api_key':
    case 'subscription_sharing_invalid_user':
      return 'auth';
    case 'model_not_found':
      return 'model_unavailable';
    case 'vector_store_timeout':
      return 'timeout';
    default:
      // The rest of OpenAI's documented `ResponseError` codes, and the plan-billing refusals, are
      // verdicts on the request itself (its prompt, an image, a policy): the same request fails
      // the same way, so none of them may be re-sent.
      if (code && REJECTED_REQUEST_CODES.test(code)) return 'bad_request';
      return code || 'provider_error';
  }
}

function streamErrorEvent(error: unknown): ProviderStreamEvent {
  const fields = isRecord(error) ? error : {};
  const code = typeof fields.code === 'string' ? fields.code : undefined;
  const message =
    typeof fields.message === 'string' && fields.message
      ? fields.message
      : 'The provider did not describe why';
  return {
    type: 'error',
    error: `Responses API error${code ? ` (${code})` : ''}: ${message}`,
    errorCode: responsesErrorCode(code),
  };
}

/**
 * The finish reason of an incomplete response, in the spellings the loop already reads. Only a
 * content filter says something other than "stopped at a limit": any other reason, an unknown or
 * a missing one included, is read as truncation, so the reply is continued rather than taken as
 * finished.
 */
function incompleteFinishReason(response: Record<string, unknown>): string {
  const details = isRecord(response.incomplete_details) ? response.incomplete_details : {};
  return details.reason === 'content_filter' ? 'content_filter' : 'length';
}

/** Book's `max` has no Responses spelling; the API's highest level is `xhigh`. */
function responsesEffort(effort: NonNullable<AgentConfig['effort']>): string {
  return effort === 'max' ? 'xhigh' : effort;
}

/**
 * Whether a refused request was refused for its `reasoning.summary`: an organization OpenAI has
 * not verified for summaries, or a Responses-compatible server without them. Such a request is
 * sent once more without the summary rather than failing every turn that has an effort.
 */
function refusesReasoningSummary(status: number, body: string): boolean {
  return (status === 400 || status === 403 || status === 422) && /summar/i.test(body);
}

export async function* responsesStream(
  config: AgentConfig,
  messages: ProviderMessage[],
  tools: ToolDefinition[],
  options?: ProviderStreamOptions,
  route: ResponsesRoute = {},
): AsyncGenerator<ProviderStreamEvent> {
  const retry = config.retry;
  const signal = options?.signal;
  const url = `${config.baseUrl}/responses`;
  const { instructions, input } = toResponsesInput(messages, route);

  const body: Record<string, unknown> = {
    model: config.model,
    ...(instructions ? { instructions } : {}),
    input,
    stream: true,
    store: false,
  };
  if (
    !route.omitMaxOutputTokens &&
    (options?.maxOutputTokens || config.maxTokensExplicit || config.modelInfo?.maxOutputTokens)
  ) {
    body.max_output_tokens = options?.maxOutputTokens ?? config.maxTokens;
  }
  // The Chat Completions client's rule: a level is sent only when chosen, and never to a model
  // whose catalog entry says it does not reason. Without a summary the API streams no reasoning.
  if (config.effortExplicit && config.effort && config.modelInfo?.effort !== false) {
    body.reasoning = { effort: responsesEffort(config.effort), summary: 'auto' };
  }
  const reasoningEnabled =
    body.reasoning !== undefined || typeof config.modelInfo?.effort === 'object';
  if (tools.length > 0) {
    body.tools = route.toolNamespace
      ? [
          {
            type: 'namespace',
            name: route.toolNamespace,
            description: 'The tools Book runs on this machine.',
            tools: convertResponsesTools(tools),
          },
        ]
      : convertResponsesTools(tools);
  }

  log.debug('responsesStream request', {
    model: config.model,
    messageCount: messages.length,
    toolCount: tools.length,
  });

  const post = (requestBody: Record<string, unknown>): Promise<Response> =>
    fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
      },
      retry,
      signal,
      options?.onRetry,
      log,
    );

  let response: Response;
  // The body of a refusal already read to decide on the resend below, when there was none.
  let refusal: Awaited<ReturnType<typeof readErrorBody>> | undefined;
  try {
    response = await post(body);
    if (!response.ok && isRecord(body.reasoning) && body.reasoning.summary !== undefined) {
      refusal = await readErrorBody(response, signal);
      if (refusesReasoningSummary(response.status, refusal.text)) {
        log.warn('reasoning summary refused; resending without it', { status: response.status });
        body.reasoning = { effort: body.reasoning.effort };
        refusal = undefined;
        response = await post(body);
      }
    }
  } catch (e) {
    if (signal?.aborted) return;
    log.warn('fetchWithRetry failed', e instanceof Error ? e.message : String(e));
    yield {
      type: 'error',
      error: e instanceof Error ? e.message : String(e),
      errorCode: classifyProviderError(e),
    };
    return;
  }

  if (signal?.aborted) {
    await response.body?.cancel();
    return;
  }

  if (!response.ok) {
    const errorBody = refusal ?? (await readErrorBody(response, signal));
    yield statedWaitErrorEvent(response, errorBody.text, {
      url,
      model: config.model,
      bodyReceived: errorBody.received,
    });
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: 'error', error: 'No response body', errorCode: 'protocol_error' };
    return;
  }

  // Calls by output item id; an event that names only its output index finds the call by that.
  const calls = new Map<string, StreamedToolCallPart & { callId: string }>();
  const callFor = (
    event: Record<string, unknown>,
  ): (StreamedToolCallPart & { callId: string }) | undefined => {
    if (typeof event.item_id === 'string' && calls.has(event.item_id))
      return calls.get(event.item_id);
    return [...calls.values()].find((call) => call.index === event.output_index);
  };
  let responseModel: string | undefined;
  let responseId: string | undefined;
  let lastReasoningPart: string | undefined;
  let lastTextItem: string | undefined;

  const ceilings = streamStallCeilings(retry, reasoningEnabled, config.modelInfo?.effort === false);
  let stallTimeoutMs = ceilings.opening;

  const noteResponse = (value: unknown): Record<string, unknown> => {
    const fields = isRecord(value) ? value : {};
    if (typeof fields.model === 'string') responseModel = fields.model;
    if (typeof fields.id === 'string') responseId = fields.id;
    return fields;
  };

  const done = function* (finishReason: string, usageRaw: unknown): Generator<ProviderStreamEvent> {
    const ordered = [...calls.values()].sort((a, b) => a.index - b.index);
    for (const call of ordered) {
      // As on Chat Completions: a call with neither an id nor a name is nothing to run.
      if (!call.callId && !call.name) continue;
      yield streamedToolCallEvent({ ...call, id: call.callId }, log);
    }
    const usage = parseResponsesUsage(usageRaw);
    log.info('stream done', {
      finishReason,
      promptTokens: usage?.promptTokens ?? 0,
      completionTokens: usage?.completionTokens ?? 0,
      cacheReadInputTokens: usage?.cacheReadInputTokens ?? 0,
    });
    yield {
      type: 'done',
      usage: usage ?? undefined,
      ...(responseModel ? { responseModel } : {}),
      ...(responseId ? { responseId } : {}),
      finishReasons: [finishReason],
    };
  };

  /** One SSE line; true once the stream reached its terminal event. */
  const processLine = function* (line: string): Generator<ProviderStreamEvent, boolean> {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return false;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(trimmed.slice(5).trim());
      if (!isRecord(parsed)) return false;
      event = parsed;
    } catch {
      return false;
    }

    switch (event.type) {
      case 'response.created':
      case 'response.in_progress':
      case 'response.queued':
        // Identity only: these say nothing about the model having started, so they keep the
        // first-delta grace in force.
        noteResponse(event.response);
        return false;

      case 'response.output_item.added':
      case 'response.output_item.done': {
        const item = isRecord(event.item) ? event.item : {};
        if (item.type === 'reasoning') {
          // A reasoning item opening is the evidence a silent thinking phase needs.
          if (event.type === 'response.output_item.added') stallTimeoutMs = ceilings.thinking;
          return false;
        }
        if (item.type !== 'function_call') return false;
        stallTimeoutMs = ceilings.answer;
        const key =
          typeof item.id === 'string'
            ? item.id
            : `output-${String(event.output_index ?? calls.size)}`;
        const call = calls.get(key) ?? {
          index: typeof event.output_index === 'number' ? event.output_index : calls.size,
          id: key,
          callId: '',
          name: '',
          arguments: '',
          fragments: 0,
        };
        if (typeof item.call_id === 'string' && item.call_id) call.callId = item.call_id;
        if (typeof item.name === 'string' && item.name) call.name = item.name;
        // The finished item's arguments are the whole text, whatever the deltas carried.
        if (typeof item.arguments === 'string' && item.arguments) call.arguments = item.arguments;
        calls.set(key, call);
        return false;
      }

      case 'response.function_call_arguments.delta': {
        stallTimeoutMs = ceilings.answer;
        const call = callFor(event);
        if (call && typeof event.delta === 'string' && event.delta) {
          call.arguments += event.delta;
          call.fragments += 1;
        }
        return false;
      }

      case 'response.function_call_arguments.done': {
        const call = callFor(event);
        if (call && typeof event.arguments === 'string' && event.arguments) {
          call.arguments = event.arguments;
        }
        return false;
      }

      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        stallTimeoutMs = ceilings.answer;
        if (typeof event.delta !== 'string' || !event.delta) return false;
        // A response can carry more than one message item (a preamble, then the answer): keep
        // them apart as paragraphs instead of running one into the next mid-sentence.
        const item = String(event.item_id ?? event.output_index);
        const separator = lastTextItem !== undefined && lastTextItem !== item ? '\n\n' : '';
        lastTextItem = item;
        yield { type: 'text', content: separator + event.delta };
        return false;
      }

      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta': {
        stallTimeoutMs = ceilings.thinking;
        if (typeof event.delta !== 'string' || !event.delta) return false;
        // Summary parts arrive as separate paragraphs; keep them apart in the reasoning row.
        const part = `${String(event.item_id)}:${String(event.summary_index ?? event.content_index)}`;
        const separator =
          lastReasoningPart !== undefined && lastReasoningPart !== part ? '\n\n' : '';
        lastReasoningPart = part;
        yield { type: 'reasoning', reasoning: separator + event.delta };
        return false;
      }

      case 'response.completed': {
        const fields = noteResponse(event.response);
        yield* done(calls.size > 0 ? 'tool_calls' : 'stop', fields.usage);
        return true;
      }

      case 'response.incomplete': {
        const fields = noteResponse(event.response);
        yield* done(incompleteFinishReason(fields), fields.usage);
        return true;
      }

      case 'response.failed': {
        const fields = noteResponse(event.response);
        log.warn('response failed', { error: fields.error });
        yield streamErrorEvent(fields.error);
        return true;
      }

      case 'error':
        log.warn('stream error event', { code: event.code });
        yield streamErrorEvent(event);
        return true;

      default:
        return false;
    }
  };

  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const result = await readStreamChunk(reader, signal, stallTimeoutMs);
      if (result.tag === 'abort') {
        await reader.cancel().catch(() => undefined);
        return;
      }
      if (result.tag === 'stall') {
        log.warn('stream stalled', { timeoutMs: stallTimeoutMs });
        options?.onStreamStall?.(stallTimeoutMs);
        await reader.cancel().catch(() => undefined);
        yield {
          type: 'error',
          error: 'Stream stalled: no data received for ' + stallTimeoutMs + 'ms',
          errorCode: 'stream_stall',
        };
        return;
      }
      if (result.done) break;
      if (!result.value) continue;

      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (yield* processLine(line)) return;
      }
    }
    buffer += decoder.decode();
    for (const line of buffer.split('\n')) {
      if (yield* processLine(line)) return;
    }
  } catch (e) {
    if (signal?.aborted) return;
    yield {
      type: 'error',
      error: e instanceof Error ? e.message : String(e),
      errorCode: classifyProviderError(e),
    };
    return;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // the reader may already have been cancelled or released
    }
  }

  // Success is only ever `response.completed` (or `response.incomplete`): a stream that closes
  // without one was cut, whatever it delivered first.
  yield {
    type: 'error',
    error: 'Provider stream ended before its terminal event.',
    errorCode: 'transport_interrupted',
  };
}
