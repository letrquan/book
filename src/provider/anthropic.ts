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

const log = createDebugLogger('provider:anthropic');

// ── Message format conversion (OpenAI → Anthropic) ──────────────────────────

interface CacheControl {
  type: 'ephemeral';
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result' | 'thinking' | 'redacted_thinking';
  text?: string;
  thinking?: string;
  signature?: string;
  data?: string;
  source?: {
    type: 'base64';
    media_type: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    data: string;
  };
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
  cache_control?: CacheControl;
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  cache_control?: CacheControl;
}

interface AnthropicSystemBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}

function isSystemPromptZones(content: ProviderMessage['content']): content is SystemPromptZones {
  return (
    !!content &&
    typeof content === 'object' &&
    'cachedPrefix' in content &&
    'dynamicSuffix' in content
  );
}

function flattenSystemPrompt(zones: SystemPromptZones): string {
  return [zones.cachedPrefix, zones.dynamicSuffix].filter(Boolean).join('\n\n');
}

function messageText(content: ProviderMessage['content'], fallback = ''): string {
  return typeof content === 'string' ? content : fallback;
}

function regularUserContent(content: ProviderMessage['content']): string | AnthropicContentBlock[] {
  if (!Array.isArray(content)) return messageText(content);
  return content.map((part): AnthropicContentBlock =>
    part.type === 'text'
      ? { type: 'text', text: part.text }
      : {
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.mediaType,
            data: part.data,
          },
        },
  );
}

function isToolResultContent(content: AnthropicMessage['content']): boolean {
  return Array.isArray(content) && content[0]?.type === 'tool_result';
}

export function buildSystemBlocks(
  system: string,
  systemZones?: SystemPromptZones,
): AnthropicSystemBlock[] {
  if (!systemZones) {
    return [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  }

  return [
    {
      type: 'text',
      text: systemZones.cachedPrefix,
      cache_control: { type: 'ephemeral' },
    },
    ...(systemZones.dynamicSuffix
      ? [
          {
            type: 'text' as const,
            text: systemZones.dynamicSuffix,
          },
        ]
      : []),
  ];
}

// ── Prompt cache breakpoints ────────────────────────────────────────────────
//
// Anthropic matches cache prefixes in `tools` → `system` → `messages` order, and
// a cached span is only usable up to a `cache_control` marker. Book places three:
// the last tool, the static system block, and the last message (moving each turn,
// so every turn reuses the previous turn's history span).

/** Anthropic rejects a request carrying more than this many `cache_control` markers. */
const MAX_CACHE_BREAKPOINTS = 4;

/** `cache_control` is rejected on replayed thinking blocks. */
const UNCACHEABLE_BLOCK_TYPES = new Set<AnthropicContentBlock['type']>([
  'thinking',
  'redacted_thinking',
]);

const EPHEMERAL: CacheControl = { type: 'ephemeral' };

/**
 * Mark only the final tool. The breakpoint's prefix span already covers every
 * tool before it, so per-tool markers buy nothing and blow the 4-marker limit.
 */
function withToolCacheBreakpoint(tools: AnthropicTool[]): AnthropicTool[] {
  if (tools.length === 0) return tools;
  return tools.map((tool, index) =>
    index === tools.length - 1 ? { ...tool, cache_control: EPHEMERAL } : tool,
  );
}

/**
 * Move the conversation breakpoint to the newest message so the next request
 * reads back the whole history instead of re-billing it at full input price.
 */
export function markLastMessageForCaching(messages: AnthropicMessage[]): void {
  const last = messages[messages.length - 1];
  if (!last) return;

  // `cache_control` lives on a content block, so string content has to become one.
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content, cache_control: EPHEMERAL }];
    return;
  }

  for (let index = last.content.length - 1; index >= 0; index--) {
    const block = last.content[index];
    if (UNCACHEABLE_BLOCK_TYPES.has(block.type)) continue;
    block.cache_control = EPHEMERAL;
    return;
  }
}

/** Count the markers Book placed, ignoring anything nested inside tool inputs. */
export function countCacheBreakpoints(body: {
  tools?: AnthropicTool[];
  system?: AnthropicSystemBlock[];
  messages?: AnthropicMessage[];
}): number {
  const marked = (blocks: Array<{ cache_control?: CacheControl }> = []) =>
    blocks.filter((block) => block.cache_control).length;

  return (
    marked(body.tools) +
    marked(body.system) +
    (body.messages ?? []).reduce(
      (total, message) =>
        total + (typeof message.content === 'string' ? 0 : marked(message.content)),
      0,
    )
  );
}

/**
 * Fail loudly rather than let the API reject the whole request. Unreachable with
 * the three breakpoints above; it exists so a future edit cannot quietly add more.
 */
function assertCacheBreakpointBudget(body: Parameters<typeof countCacheBreakpoints>[0]): void {
  const count = countCacheBreakpoints(body);
  if (count > MAX_CACHE_BREAKPOINTS) {
    throw new Error(
      `Anthropic request carries ${count} cache_control markers; the API allows at most ${MAX_CACHE_BREAKPOINTS}.`,
    );
  }
}

/** Models that support adaptive thinking. All others get no thinking field. */
const ADAPTIVE_THINKING_MODELS = new Set([
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-opus-4-5',
  'claude-sonnet-5',
  'claude-sonnet-4-6',
  'claude-sonnet-4-5',
  'claude-fable-5',
  'claude-mythos-5',
]);

function supportsAdaptiveThinking(model: string): boolean {
  for (const prefix of ADAPTIVE_THINKING_MODELS) {
    if (model.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Convert Book's internal message format (OpenAI-flavored) to Anthropic Messages API format.
 * Extracts the system prompt (role: 'system') and returns it separately as the top-level `system` string.
 *
 * Tool results from a single assistant turn are merged into one user message to satisfy
 * Anthropic's strict alternating user/assistant requirement.
 */
export function convertMessages(messages: ProviderMessage[]): {
  system: string;
  systemZones?: SystemPromptZones;
  messages: AnthropicMessage[];
} {
  let system = 'You are a helpful AI coding assistant.';
  let systemZones: SystemPromptZones | undefined;

  const anthropicMessages: AnthropicMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (isSystemPromptZones(msg.content)) {
        systemZones = msg.content;
        system = flattenSystemPrompt(msg.content);
      } else {
        system = messageText(msg.content, system);
        systemZones = undefined;
      }
      continue;
    }

    if (msg.role === 'user') {
      if (msg.tool_call_id) {
        // Tool result — merge with previous user message if it's also a tool result
        const block: AnthropicContentBlock = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: messageText(msg.content),
        };
        const last = anthropicMessages[anthropicMessages.length - 1];
        if (
          last?.role === 'user' &&
          Array.isArray(last.content) &&
          last.content.length > 0 &&
          last.content[0].type === 'tool_result'
        ) {
          last.content.push(block);
        } else {
          anthropicMessages.push({ role: 'user', content: [block] });
        }
      } else {
        // Regular user message — merge with previous if it's also a plain user message
        const last = anthropicMessages[anthropicMessages.length - 1];
        const nextContent = regularUserContent(msg.content);
        if (last?.role === 'user' && !isToolResultContent(last.content)) {
          if (typeof last.content === 'string' && typeof nextContent === 'string') {
            last.content = last.content + '\n\n' + nextContent;
          } else {
            const previousBlocks =
              typeof last.content === 'string'
                ? [{ type: 'text' as const, text: last.content }]
                : last.content;
            const nextBlocks =
              typeof nextContent === 'string'
                ? [{ type: 'text' as const, text: nextContent }]
                : nextContent;
            last.content = [...previousBlocks, { type: 'text', text: '\n\n' }, ...nextBlocks];
          }
        } else {
          anthropicMessages.push({ role: 'user', content: nextContent });
        }
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const nativeBlocks = msg.providerMetadata?.anthropicContentBlocks;
      if (nativeBlocks?.length) {
        anthropicMessages.push({
          role: 'assistant',
          content: nativeBlocks.map((block) => ({
            ...block,
          })) as unknown as AnthropicContentBlock[],
        });
        continue;
      }
      const content: AnthropicContentBlock[] = [];

      // Unsigned reasoning cannot be fabricated as an Anthropic thinking block. Replay
      // legacy or cross-provider reasoning as clearly delimited assistant context instead.
      if (msg.reasoningContent) {
        content.push({
          type: 'text',
          text: `<reasoning_context>\n${msg.reasoningContent}\n</reasoning_context>`,
        });
      }

      const assistantText = messageText(msg.content);
      if (assistantText || content.length === 0) {
        // Anthropic requires at least one content block, including tool-only turns.
        content.push({ type: 'text', text: assistantText });
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls as Array<{
          id: string;
          function?: { name: string; arguments: string };
        }>) {
          const input = parseToolArguments(tc.function?.arguments ?? '{}');
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function?.name ?? '',
            input,
          });
        }
      }

      anthropicMessages.push({
        role: 'assistant',
        content:
          content.length === 1 && content[0].type === 'text' ? (content[0].text ?? '') : content,
      });
      continue;
    }

    // role 'tool' — Anthropic doesn't have a separate tool role; merge with prior tool results
    if (msg.role === 'tool') {
      const block: AnthropicContentBlock = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id ?? '',
        content: messageText(msg.content),
      };
      const last = anthropicMessages[anthropicMessages.length - 1];
      if (
        last?.role === 'user' &&
        Array.isArray(last.content) &&
        last.content.length > 0 &&
        last.content[0].type === 'tool_result'
      ) {
        last.content.push(block);
      } else {
        anthropicMessages.push({ role: 'user', content: [block] });
      }
    }
  }

  return { system, systemZones, messages: anthropicMessages };
}

/**
 * Convert Book's ToolDefinition[] to Anthropic Messages API tool format.
 */
export function convertTools(tools: ToolDefinition[]): AnthropicTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema ?? t.parameters,
  }));
}

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { __raw: raw };
  }
}

// ── Main streaming function ──────────────────────────────────────────────────

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
  const normalizedBaseUrl = config.baseUrl.replace(/\/+$/, '');
  const url = `${normalizedBaseUrl}${/\/v1$/i.test(normalizedBaseUrl) ? '' : '/v1'}/messages`;

  // Convert messages and tools to Anthropic format
  const { system, systemZones, messages: anthropicMessages } = convertMessages(messages);
  const anthropicTools = withToolCacheBreakpoint(convertTools(tools));
  markLastMessageForCaching(anthropicMessages);

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: options?.maxOutputTokens ?? config.maxTokens,
    messages: anthropicMessages,
    stream: true,
    stream_options: { include_usage: true },
  };

  // System prompt as top-level field. Book emits a cacheable static prefix
  // and a dynamic per-turn suffix (for example, the active todo list).
  const systemBlocks = buildSystemBlocks(system, systemZones);
  body.system = systemBlocks;

  if (anthropicTools.length > 0) {
    body.tools = anthropicTools;
  }

  assertCacheBreakpointBudget({
    tools: anthropicTools,
    system: systemBlocks,
    messages: anthropicMessages,
  });

  // Thinking / effort — only for models that support adaptive thinking.
  let thinkingEnabled = false;
  if (config.modelInfo?.effort !== false && supportsAdaptiveThinking(config.model)) {
    thinkingEnabled = true;
    const effort = config.effort ?? 'high';
    body.thinking = { type: 'adaptive', display: 'summarized' };
    body.output_config = { effort };
  }

  log.debug('chatCompletionStream request', {
    model: config.model,
    messageCount: anthropicMessages.length,
    toolCount: anthropicTools.length,
    maxTokens: config.maxTokens,
    effort: config.effort ?? 'high',
  });

  let response: Response;
  try {
    response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
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

  // Track state across SSE events
  let currentToolId = '';
  let currentToolName = '';
  let currentToolArgs = '';
  let currentContentBlock: AnthropicContentBlock | undefined;
  const assistantContentBlocks: AnthropicContentBlock[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  let responseModel: string | undefined;
  let responseId: string | undefined;
  const finishReasons = new Set<string>();
  // A thinking model goes quiet on purpose. The chat-tuned 20s ceiling cancels a
  // healthy request mid-thought and reports it as a stalled stream, which is the
  // single most common way a high-effort Opus run "just stops".
  const stallTimeoutMs =
    thinkingEnabled && retry.thinkingStallTimeoutMs
      ? Math.max(retry.streamStallTimeoutMs, retry.thinkingStallTimeoutMs)
      : retry.streamStallTimeoutMs;

  try {
    while (true) {
      const result = await readStreamChunk(reader, signal, stallTimeoutMs);

      if (result.tag === 'abort') {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return;
      }

      if (result.tag === 'stall') {
        log.warn('stream stalled', { timeoutMs: stallTimeoutMs });
        options?.onStreamStall?.(stallTimeoutMs);
        try {
          await reader.cancel();
        } catch {
          /* ignore */
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
        if (!trimmed) continue;
        // Accept both 'data:' and 'data: ' (SSE spec allows optional space)
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).replace(/^ /, '');

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(data);
        } catch {
          continue;
        }

        const eventType = parsed.type as string;

        switch (eventType) {
          case 'message_start': {
            const msg = parsed.message as Record<string, unknown> | undefined;
            if (typeof msg?.model === 'string') responseModel = msg.model;
            if (typeof msg?.id === 'string') responseId = msg.id;
            if (msg?.usage) {
              const usage = msg.usage as Record<string, number>;
              inputTokens = usage.input_tokens ?? 0;
              cacheCreationInputTokens = usage.cache_creation_input_tokens ?? 0;
              cacheReadInputTokens = usage.cache_read_input_tokens ?? 0;
            }
            break;
          }

          case 'content_block_start': {
            const block = parsed.content_block as Record<string, unknown> | undefined;
            if (!block) break;
            currentContentBlock = { ...block } as unknown as AnthropicContentBlock;

            if (block.type === 'tool_use') {
              currentToolId = (block.id as string) ?? '';
              currentToolName = (block.name as string) ?? '';
              currentToolArgs = '';
            }
            break;
          }

          case 'content_block_delta': {
            const delta = parsed.delta as Record<string, unknown> | undefined;
            if (!delta) break;

            if (delta.type === 'text_delta' && delta.text) {
              if (currentContentBlock) {
                currentContentBlock.text = (currentContentBlock.text ?? '') + String(delta.text);
              }
              yield { type: 'text', content: delta.text as string };
            } else if (delta.type === 'thinking_delta' && delta.thinking) {
              if (currentContentBlock) {
                currentContentBlock.thinking =
                  (currentContentBlock.thinking ?? '') + String(delta.thinking);
              }
              yield { type: 'reasoning', reasoning: delta.thinking as string };
            } else if (delta.type === 'signature_delta' && delta.signature) {
              if (currentContentBlock) {
                currentContentBlock.signature =
                  (currentContentBlock.signature ?? '') + String(delta.signature);
              }
            } else if (delta.type === 'input_json_delta' && delta.partial_json) {
              currentToolArgs += delta.partial_json as string;
            }
            break;
          }

          case 'content_block_stop': {
            if (currentContentBlock?.type === 'tool_use') {
              currentContentBlock.input = parseToolArguments(currentToolArgs);
            }
            if (currentContentBlock) assistantContentBlocks.push(currentContentBlock);
            // Emit completed tool call
            if (currentToolId && currentToolName) {
              const toolCall = {
                id: currentToolId,
                name: currentToolName,
                arguments: parseToolArguments(currentToolArgs),
              };
              yield { type: 'tool_call', toolCall };
            }
            currentToolId = '';
            currentToolName = '';
            currentToolArgs = '';
            currentContentBlock = undefined;
            break;
          }

          case 'message_delta': {
            const usage = parsed.usage as Record<string, number> | undefined;
            if (usage) {
              outputTokens = usage.output_tokens ?? 0;
            }
            const stopReason = (parsed.delta as Record<string, unknown> | undefined)?.stop_reason;
            if (typeof stopReason === 'string') finishReasons.add(stopReason);
            break;
          }

          case 'message_stop': {
            const usage: Usage = {
              promptTokens: inputTokens,
              completionTokens: outputTokens,
              totalTokens: inputTokens + outputTokens,
              cacheCreationInputTokens,
              cacheReadInputTokens,
              contextTokens: inputTokens + cacheCreationInputTokens + cacheReadInputTokens,
            };
            log.info('stream done', usage);
            yield {
              type: 'done',
              usage,
              ...(responseModel ? { responseModel } : {}),
              ...(responseId ? { responseId } : {}),
              ...(finishReasons.size > 0 ? { finishReasons: [...finishReasons] } : {}),
              ...(assistantContentBlocks.length > 0
                ? {
                    providerMetadata: {
                      anthropicContentBlocks: assistantContentBlocks.map((block) => ({ ...block })),
                    },
                  }
                : {}),
            };
            return;
          }

          case 'error': {
            const err = parsed.error as Record<string, string> | undefined;
            yield {
              type: 'error',
              error: err?.message ?? 'Unknown Anthropic API error',
              errorCode: err?.type ?? 'provider_error',
            };
            return;
          }

          case 'ping':
            // Heartbeat — ignore
            break;

          default:
            log.debug('unknown SSE event', { type: eventType });
        }
      }
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
      /* ignore */
    }
  }

  yield {
    type: 'error',
    error: 'Provider stream ended before its terminal event.',
    errorCode: 'transport_interrupted',
  };
}

/**
 * Detect whether the given baseUrl targets the Anthropic API.
 * Used by the provider dispatch layer. Returns false for null/empty/undefined inputs.
 */
export function isAnthropicUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false;
  const normalized = baseUrl.toLowerCase();
  return normalized.includes('anthropic.com');
}
