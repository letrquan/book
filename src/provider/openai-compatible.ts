import type { AgentConfig } from '../types/runtime.js';
import type {
  ProviderMessage,
  ProviderStreamEvent,
  SystemPromptZones,
} from '../types/providers.js';
import type { ToolDefinition } from '../types/tools.js';
import type { Usage } from '../types/messages.js';
import { createDebugLogger } from '../debug-log.js';
import {
  classifyApiError,
  classifyProviderError,
  fetchWithRetry,
  formatApiError,
  readStreamChunk,
  wrappedUpstreamStatus,
} from './reliability.js';

const log = createDebugLogger('provider');

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { __raw: raw };
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
 * Book's `promptTokens` is the uncached input, as on the Anthropic path: cache reads and writes
 * are counted separately and `contextTokens` holds the whole prompt. OpenAI-style `prompt_tokens`
 * already includes cached tokens, so they are subtracted from it; a provider whose cache counts
 * exceed `prompt_tokens` evidently reports them on top of it, and they are added instead.
 *
 * Shapes read: `prompt_tokens_details.cached_tokens` (OpenAI, xAI, 9router),
 * `prompt_tokens_details.cache_creation_tokens` (9router), `prompt_tokens_details.cache_write_tokens`
 * (OpenRouter), `prompt_cache_hit_tokens` (DeepSeek), and top-level `cache_read_input_tokens` /
 * `cache_creation_input_tokens` (LiteLLM and other Anthropic-shaped proxies). A usage with no cache
 * tokens maps exactly as before, with no cache fields.
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
    totalTokens: tokens(usage.total_tokens),
  };
  const read = firstCount(
    details.cached_tokens,
    usage.prompt_cache_hit_tokens,
    usage.cache_read_input_tokens,
  );
  const write = firstCount(
    details.cache_creation_tokens,
    details.cache_write_tokens,
    usage.cache_creation_input_tokens,
  );
  if (read === 0 && write === 0) return base;
  const inclusive = read + write <= prompt;
  return {
    ...base,
    promptTokens: inclusive ? prompt - read - write : prompt,
    cacheReadInputTokens: read,
    cacheCreationInputTokens: write,
    contextTokens: inclusive ? prompt : prompt + read + write,
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
    const errorText = await response.text();
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
  const toolCallParts: Array<{ index: number; id: string; name: string; arguments: string }> = [];
  let currentUsage: Usage | null = null;
  let responseModel: string | undefined;
  let responseId: string | undefined;
  const finishReasons = new Set<string>();

  const emitToolCalls = function* (): Generator<ProviderStreamEvent> {
    for (const part of [...toolCallParts].sort((a, b) => a.index - b.index)) {
      if (!part.id && !part.name) continue;
      yield {
        type: 'tool_call',
        toolCall: {
          id: part.id || `tool-${part.index}`,
          name: part.name,
          arguments: parseToolArguments(part.arguments),
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
        log.debug('stream reasoning', { len: reasoning.length });
        yield { type: 'reasoning', reasoning };
      }

      if (delta.content) {
        log.debug('stream text', { len: delta.content.length });
        yield { type: 'text', content: delta.content };
      }

      if (delta.tool_calls) {
        log.debug('stream tool_call delta', { count: delta.tool_calls.length });
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
            part = { index, id: '', name: '', arguments: '' };
            toolCallParts.push(part);
          }

          if (tc.id) part.id = tc.id;
          if (tc.function?.name) part.name = tc.function.name;
          if (tc.function?.arguments) part.arguments += tc.function.arguments;
        }
      }
    } catch {
      // Skip unparseable lines.
    }

    return false;
  };

  // Stream stall detection: if no data arrives for streamStallTimeoutMs,
  // call the onStreamStall callback and yield a visible error instead of
  // leaving the TUI stuck in a pending read forever.
  //
  // A reasoning model goes quiet on purpose, and many OpenAI-compatible endpoints
  // buffer the whole thinking block before emitting anything. The chat-tuned 20s
  // ceiling cancels a healthy request mid-thought and reports it as a stalled
  // stream, which is the single most common way a high-effort run "just stops".
  const stallTimeoutMs =
    reasoningEnabled && retry.thinkingStallTimeoutMs
      ? Math.max(retry.streamStallTimeoutMs, retry.thinkingStallTimeoutMs)
      : retry.streamStallTimeoutMs;

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
