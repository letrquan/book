import type { AgentConfig } from '../types/runtime.js';
import type {
  ProviderMessage,
  ProviderStreamEvent,
  SystemPromptZones,
} from '../types/providers.js';
import type { ToolDefinition } from '../types/tools.js';
import type { Usage } from '../types/messages.js';
import { createDebugLogger, isDebugEnabled } from '../debug-log.js';
import { escapeInvisibleCharacters } from '../control-characters.js';
import {
  classifyApiError,
  classifyProviderError,
  fetchWithRetry,
  formatApiError,
  readErrorBody,
  readStreamChunk,
  wrappedUpstreamStatus,
} from './reliability.js';

const log = createDebugLogger('provider');

function parseToolArguments(raw: string): {
  arguments: Record<string, unknown>;
  unparsedArguments?: { raw: string; error: string };
} {
  if (!raw.trim()) return { arguments: {} };
  try {
    const parsed = JSON.parse(raw);
    return {
      arguments: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {},
    };
  } catch (error) {
    return {
      arguments: {},
      unparsedArguments: { raw, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function parseReasoningDelta(delta: Record<string, unknown>): string | undefined {
  for (const key of ['reasoning_content', 'reasoning', 'thinking', 'analysis']) {
    const value = delta[key];
    if (typeof value === 'string' && value) return value;
  }
  const details = delta.reasoning_details;
  if (!Array.isArray(details)) return undefined;
  const text = details
    .map((detail) => {
      if (typeof detail === 'string') return detail;
      if (!detail || typeof detail !== 'object') return '';
      const item = detail as Record<string, unknown>;
      for (const key of ['text', 'reasoning', 'content']) {
        if (typeof item[key] === 'string') return item[key] as string;
      }
      return '';
    })
    .filter(Boolean)
    .join('');
  return text || undefined;
}

function isSystemPromptZones(content: ProviderMessage['content']): content is SystemPromptZones {
  return (
    !!content &&
    typeof content === 'object' &&
    'cachedPrefix' in content &&
    'dynamicSuffix' in content
  );
}

function flattenMessages(messages: ProviderMessage[]): Array<{
  role: string;
  content:
    | string
    | null
    | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;
  tool_calls?: ProviderMessage['tool_calls'];
  tool_call_id?: string;
}> {
  return messages.map(({ providerMetadata: _providerMetadata, reasoningContent, ...msg }) => ({
    ...msg,
    content: isSystemPromptZones(msg.content)
      ? [msg.content.cachedPrefix, msg.content.dynamicSuffix].filter(Boolean).join('\n\n')
      : Array.isArray(msg.content)
        ? msg.content.map((part) =>
            part.type === 'text'
              ? part
              : {
                  type: 'image_url' as const,
                  image_url: { url: `data:${part.mediaType};base64,${part.data}` },
                },
          )
        : reasoningContent
          ? ['<reasoning_context>', reasoningContent, '</reasoning_context>', msg.content ?? '']
              .filter(Boolean)
              .join('\n')
          : msg.content,
  }));
}

/**
 * Map an OpenAI-compatible `usage` object onto Book's `Usage`, prompt-cache tokens included.
 *
 * Book's `promptTokens` is the uncached input, as on the Anthropic path, with cache reads and
 * writes counted separately. Where the cache counts sit depends on who reported them:
 *
 * - `prompt_tokens_details.cached_tokens` / `cache_creation_tokens` / `cache_write_tokens`
 *   (OpenAI, xAI, 9router, OpenRouter) and DeepSeek's `prompt_cache_hit_tokens`, plus Moonshot's
 *   top-level `cached_tokens` and DashScope's `prompt_tokens_details.cache_creation_input_tokens`,
 *   are part of `prompt_tokens`, so they are subtracted from it. `total_tokens` already covers them,
 *   so `contextTokens` stays unset and compaction pressure is `total_tokens`, as before.
 * - Anthropic's own top-level names (`cache_read_input_tokens`, `cache_creation_input_tokens`)
 *   from a proxy that sends no `prompt_tokens_details` are Anthropic's numbers passed through,
 *   where the input count excludes the cache: they are added on top, and `contextTokens` carries
 *   the whole prompt. A proxy that reports an OpenAI-style cache field beside
 *   them, even at zero (LiteLLM's `prompt_tokens_details.cached_tokens`), has normalised
 *   `prompt_tokens` to include them.
 *
 * Counts that cannot fit inside `prompt_tokens` are treated as on top of it whatever their
 * source. A usage with no cache tokens maps exactly as before, with no cache fields.
 */
export function parseCompatibleUsage(raw: unknown): Usage | null {
  if (!raw || typeof raw !== 'object') return null;
  const usage = raw as Record<string, unknown>;
  const details =
    usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : {};
  const tokens = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  const firstCount = (...values: unknown[]): number => {
    for (const value of values) {
      const count = tokens(value);
      if (count > 0) return count;
    }
    return 0;
  };
  const prompt = tokens(usage.prompt_tokens);
  const base: Usage = {
    promptTokens: prompt,
    completionTokens: tokens(usage.completion_tokens),
    // A provider that omits `total_tokens` would otherwise read as zero context pressure.
    totalTokens: tokens(usage.total_tokens) || prompt + tokens(usage.completion_tokens),
  };
  const topRead = tokens(usage.cache_read_input_tokens);
  const topWrite = tokens(usage.cache_creation_input_tokens);
  // Inside `prompt_tokens` by the OpenAI convention: OpenAI, xAI, 9router, OpenRouter, DeepSeek,
  // Moonshot (top-level `cached_tokens`) and DashScope (`cache_creation_input_tokens` in details).
  const normalisedRead = firstCount(
    details.cached_tokens,
    usage.prompt_cache_hit_tokens,
    usage.cached_tokens,
  );
  const normalisedWrite = firstCount(
    details.cache_creation_tokens,
    details.cache_write_tokens,
    details.cache_creation_input_tokens,
  );
  const read = normalisedRead || topRead;
  const write = normalisedWrite || topWrite;
  if (read === 0 && write === 0) return base;
  // Anthropic's top-level names with no OpenAI-style cache field beside them (not even a zero)
  // are Anthropic's numbers passed through, where the input count excludes the cache. A field
  // beside them, even `cached_tokens: 0` on LiteLLM's cold turn, says `prompt_tokens` was
  // normalised to include them.
  const reportsOpenAiCacheField = [
    details.cached_tokens,
    details.cache_creation_tokens,
    details.cache_write_tokens,
    details.cache_creation_input_tokens,
    usage.prompt_cache_hit_tokens,
    usage.cached_tokens,
  ].some((value) => typeof value === 'number');
  const anthropicPassThrough = !reportsOpenAiCacheField && topRead + topWrite > 0;
  if (!anthropicPassThrough && read + write <= prompt) {
    return {
      ...base,
      promptTokens: prompt - read - write,
      cacheReadInputTokens: read,
      cacheCreationInputTokens: write,
    };
  }
  return {
    ...base,
    cacheReadInputTokens: read,
    cacheCreationInputTokens: write,
    contextTokens: prompt + read + write,
  };
}

export function convertTools(tools: ToolDefinition[]): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? tool.parameters,
    },
  }));
}

export async function* chatCompletionStream(
  config: AgentConfig,
  messages: ProviderMessage[],
  tools: ToolDefinition[],
  options?: {
    signal?: AbortSignal;
    onRetry?: (attempt: number, max: number, delayMs: number) => void;
    onStreamStall?: (countdownMs: number) => void;
    onStreamResume?: () => void;
    maxOutputTokens?: number;
  },
): AsyncGenerator<ProviderStreamEvent> {
  const retry = config.retry;
  const signal = options?.signal;
  const url = `${config.baseUrl}/chat/completions`;

  const body: Record<string, unknown> = {
    model: config.model,
    messages: flattenMessages(messages),
    stream: true,
    // Request token usage in the final SSE chunk so we can track cost.
    stream_options: { include_usage: true },
  };
  if (options?.maxOutputTokens || config.maxTokensExplicit || config.modelInfo?.maxOutputTokens) {
    body.max_tokens = options?.maxOutputTokens ?? config.maxTokens;
  }
  if (config.effortExplicit && config.effort) body.reasoning_effort = config.effort;

  // Whether this request expects the model to reason before answering: either we
  // asked it to, or the model's catalog entry declares an effort range. An entry
  // of `false` means the model does not reason at all; an absent entry is unknown,
  // and stays on the chat regime rather than guessing.
  const reasoningEnabled =
    body.reasoning_effort !== undefined || typeof config.modelInfo?.effort === 'object';

  if (tools.length > 0) {
    body.tools = convertTools(tools);
  }

  log.debug('chatCompletionStream request', {
    model: config.model,
    messageCount: messages.length,
    toolCount: tools.length,
    maxTokens: config.maxTokens,
  });

  let response: Response;
  try {
    response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      retry,
      signal,
      options?.onRetry,
      log,
    );
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

  log.debug('response received', { status: response.status, ok: response.ok });

  if (!response.ok) {
    const errorText = await readErrorBody(response, signal);
    yield {
      type: 'error',
      error: formatApiError(response.status, errorText),
      errorCode: classifyApiError(response.status, errorText),
      upstreamStatus: wrappedUpstreamStatus(response.status, errorText),
    };
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: 'error', error: 'No response body', errorCode: 'protocol_error' };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  const toolCallParts: Array<{
    index: number;
    id: string;
    name: string;
    arguments: string;
    /** Deltas that carried an arguments fragment: a wire format that sends one, vs many. */
    fragments: number;
  }> = [];
  let currentUsage: Usage | null = null;
  let responseModel: string | undefined;
  let responseId: string | undefined;
  const finishReasons = new Set<string>();

  const emitToolCalls = function* (): Generator<ProviderStreamEvent> {
    for (const part of [...toolCallParts].sort((a, b) => a.index - b.index)) {
      if (!part.id && !part.name) continue;
      const { arguments: arguments_, unparsedArguments } = parseToolArguments(part.arguments);
      if (unparsedArguments) {
        // The head, not the whole text: enough to see whether the call arrived with its
        // first fragment missing (#260), which is a route's wire format, not the model's JSON.
        log.warn('tool call arguments are not valid JSON', {
          index: part.index,
          id: part.id,
          name: escapeInvisibleCharacters(part.name),
          fragments: part.fragments,
          length: part.arguments.length,
          head: escapeInvisibleCharacters(part.arguments.slice(0, 120)),
        });
      }
      yield {
        type: 'tool_call',
        toolCall: {
          id: part.id || `tool-${part.index}`,
          name: part.name,
          arguments: arguments_,
          ...(unparsedArguments ? { unparsedArguments } : {}),
        },
      };
    }
  };

  const emitDone = function* (
    terminal: '[DONE]' | 'finish_reason',
  ): Generator<ProviderStreamEvent> {
    yield* emitToolCalls();
    log.info('stream done', {
      terminal,
      promptTokens: currentUsage?.promptTokens ?? 0,
      completionTokens: currentUsage?.completionTokens ?? 0,
      totalTokens: currentUsage?.totalTokens ?? 0,
      cacheReadInputTokens: currentUsage?.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: currentUsage?.cacheCreationInputTokens ?? 0,
    });
    yield {
      type: 'done',
      usage: currentUsage ?? undefined,
      ...(responseModel ? { responseModel } : {}),
      ...(responseId ? { responseId } : {}),
      ...(finishReasons.size > 0 ? { finishReasons: [...finishReasons] } : {}),
    };
  };

  const processSseLine = function* (line: string): Generator<ProviderStreamEvent, boolean> {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('data:')) return false;

    const data = trimmed.slice(5).replace(/^ /, '');
    if (data === '[DONE]') {
      yield* emitDone('[DONE]');
      return true;
    }

    try {
      const parsed = JSON.parse(data);
      if (typeof parsed.model === 'string') responseModel = parsed.model;
      if (typeof parsed.id === 'string') responseId = parsed.id;
      // OpenAI sends usage on the final chunk when stream_options.include_usage is set.
      const usage = parseCompatibleUsage(parsed.usage);
      if (usage) currentUsage = usage;
      const choice = parsed.choices?.[0];
      if (!choice) return false;
      const finishReason: unknown = choice.finish_reason;
      if (typeof finishReason === 'string' && finishReason) finishReasons.add(finishReason);

      const delta = choice.delta as
        | (Record<string, unknown> & {
            content?: string;
            tool_calls?: Array<{
              index?: number;
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          })
        | undefined;
      if (!delta) return false;

      const reasoning = parseReasoningDelta(delta);
      if (reasoning) {
        // The model is reasoning, whatever the request could not say (#379), so
        // this phase waits out the thinking ceiling. Only this phase does.
        if (retry.thinkingStallTimeoutMs) {
          stallTimeoutMs = Math.max(stallTimeoutMs, retry.thinkingStallTimeoutMs);
        }
        log.debug('stream reasoning', { len: reasoning.length });
        yield { type: 'reasoning', reasoning };
      }

      if (delta.content) {
        // The model has started answering, so the chat ceiling bounds this
        // phase again — reasoning can resume and promote the ceiling back.
        stallTimeoutMs = startingStallTimeoutMs;
        log.debug('stream text', { len: delta.content.length });
        yield { type: 'text', content: delta.content };
      }

      if (delta.tool_calls) {
        // A tool call is the answer phase too, and the one where a stall costs
        // most: the turn is waiting on a function call that is not coming.
        stallTimeoutMs = startingStallTimeoutMs;
        for (const tc of delta.tool_calls) {
          const explicitIndex = Number.isInteger(tc.index) ? tc.index : undefined;
          let index = explicitIndex;

          if (index === undefined && tc.id) {
            index = toolCallParts.find((part) => part.id === tc.id)?.index;
          }
          if (index === undefined) {
            index = toolCallParts.length;
          }

          let part = toolCallParts.find((p) => p.index === index);
          if (!part) {
            part = { index, id: '', name: '', arguments: '', fragments: 0 };
            toolCallParts.push(part);
          }

          if (tc.id) part.id = tc.id;
          if (tc.function?.name) part.name = tc.function.name;
          if (tc.function?.arguments) {
            // The head of each call's first fragment, not of every one: a call that arrives
            // missing its opening `{"filePath": ` is visible here (#260) and nowhere else.
            // Escaped, because the text is the model's and a debug log on stderr may be a
            // terminal; behind the flag, so a large streamed Write does no string work and
            // writes no lines when debugging is off.
            if (part.fragments === 0 && isDebugEnabled()) {
              log.debug('stream tool_call delta', {
                index,
                id: tc.id,
                name: escapeInvisibleCharacters(tc.function.name ?? ''),
                argumentsLength: tc.function.arguments.length,
                argumentsHead: escapeInvisibleCharacters(tc.function.arguments.slice(0, 120)),
              });
            }
            part.arguments += tc.function.arguments;
            part.fragments++;
          }
        }
      }
    } catch {
      // Skip unparseable lines.
    }

    return false;
  };

  // Stream stall detection: if no data arrives for the ceiling in force, call
  // the onStreamStall callback and yield a visible error instead of leaving the
  // TUI stuck in a pending read forever.
  //
  // The ceiling is chosen per stream and follows its phase, not just per
  // request. It starts at what the request can already prove: the thinking
  // ceiling when we asked for reasoning or the model's catalog entry declares an
  // effort range, the chat-tuned `streamStallTimeoutMs` otherwise. What a
  // request cannot prove is whether the model reasons, because plenty of routes
  // serve a reasoning model Book has no catalog entry for, and send it no
  // `reasoning_effort` — there is no evidence before the stream opens, so the
  // first thinking pause lands on the chat ceiling and a healthy request is
  // cancelled mid-thought and reported as a stalled stream (#379), the single
  // most common way a run "just stops". A reasoning delta is that evidence
  // arriving late, so it promotes that phase to the thinking ceiling.
  //
  // A content or tool-call delta ends the thinking phase, and the ceiling goes
  // back to where it started. Keeping the promotion for the rest of the stream
  // would apply fifteen minutes to the answer phase, where a dead socket is the
  // commonest fault by far and is worth noticing in twenty seconds; reasoning
  // that resumes mid-answer promotes the ceiling again. A stream that never
  // reasons keeps the chat ceiling throughout, and a request with an explicit
  // effort or a catalogued one is unchanged.
  const startingStallTimeoutMs =
    reasoningEnabled && retry.thinkingStallTimeoutMs
      ? Math.max(retry.streamStallTimeoutMs, retry.thinkingStallTimeoutMs)
      : retry.streamStallTimeoutMs;
  let stallTimeoutMs = startingStallTimeoutMs;

  try {
    while (true) {
      const result = await readStreamChunk(reader, signal, stallTimeoutMs);

      if (result.tag === 'abort') {
        try {
          await reader.cancel();
        } catch {
          // ignore cancellation failures
        }
        return;
      }

      if (result.tag === 'stall') {
        log.warn('stream stalled', { timeoutMs: stallTimeoutMs });
        options?.onStreamStall?.(stallTimeoutMs);
        try {
          await reader.cancel();
        } catch {
          // ignore cancellation failures
        }
        yield {
          type: 'error',
          error: 'Stream stalled: no data received for ' + stallTimeoutMs + 'ms',
          errorCode: 'stream_stall',
        };
        return;
      }

      if (result.done) break;

      const value = result.value;
      if (!value) continue;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (yield* processSseLine(line)) return;
      }
    }

    buffer += decoder.decode();
    for (const line of buffer.split('\n')) {
      if (yield* processSseLine(line)) return;
    }

    // Some OpenAI-compatible gateways omit [DONE] and close after a finish_reason chunk.
    if (finishReasons.size > 0) {
      yield* emitDone('finish_reason');
      return;
    }
  } catch (e) {
    if (signal?.aborted) return;
    // Unexpected stream error — surface it instead of silently completing,
    // otherwise the TUI can show an empty completed assistant message.
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
      // ignore: the reader may already have been cancelled/released
    }
  }

  yield {
    type: 'error',
    error: 'Provider stream ended before its terminal event.',
    errorCode: 'transport_interrupted',
  };
}
