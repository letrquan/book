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
  return messages.map((msg) => ({
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
        : msg.content,
  }));
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

  // Stream stall detection: if no data arrives for streamStallTimeoutMs,
  // call the onStreamStall callback and yield a visible error instead of
  // leaving the TUI stuck in a pending read forever.
  const stallTimeoutMs = retry.streamStallTimeoutMs;

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
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          yield* emitToolCalls();
          log.info('stream done', {
            promptTokens: currentUsage?.promptTokens ?? 0,
            completionTokens: currentUsage?.completionTokens ?? 0,
            totalTokens: currentUsage?.totalTokens ?? 0,
          });
          yield {
            type: 'done',
            usage: currentUsage ?? undefined,
            ...(responseModel ? { responseModel } : {}),
            ...(responseId ? { responseId } : {}),
            ...(finishReasons.size > 0 ? { finishReasons: [...finishReasons] } : {}),
          };
          return;
        }

        try {
          const parsed = JSON.parse(data);
          if (typeof parsed.model === 'string') responseModel = parsed.model;
          if (typeof parsed.id === 'string') responseId = parsed.id;
          // OpenAI sends usage on the final chunk when stream_options.include_usage is set.
          if (parsed.usage) {
            currentUsage = {
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
              totalTokens: parsed.usage.total_tokens ?? 0,
            };
          }
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          const finishReason: unknown = choice.finish_reason;
          if (typeof finishReason === 'string') finishReasons.add(finishReason);

          const delta = choice.delta;
          if (!delta) continue;

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
          // Skip unparseable lines
        }
      }
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
