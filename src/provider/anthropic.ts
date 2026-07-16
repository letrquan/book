import type {
  AgentConfig,
  ProviderMessage,
  ProviderStreamEvent,
  RetryConfig,
  SystemPromptZones,
  ToolDefinition,
  Usage,
} from '../types.js';
import { createDebugLogger } from '../debug-log.js';

const log = createDebugLogger('provider:anthropic');

// ── Retry infrastructure ─────────────────────────────────────────────────────

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function jitter(ms: number): number {
  return ms * (0.5 + Math.random());
}

function backoffMs(attempt: number, retry: RetryConfig, retryAfter?: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (!Number.isNaN(secs) && secs > 0) {
      return Math.min(secs * 1000, retry.maxDelayMs);
    }
  }
  const exponential = Math.min(retry.baseDelayMs * 2 ** attempt, retry.maxDelayMs);
  return Math.round(jitter(exponential));
}

function classifyHttpStatus(status: number): {
  code:
    | 'network'
    | 'timeout'
    | 'rate_limited'
    | 'overloaded'
    | 'server_error'
    | 'auth'
    | 'bad_request'
    | 'not_found'
    | 'quota'
    | 'unknown';
  retryable: boolean;
} {
  if (status === 429) return { code: 'rate_limited', retryable: true };
  if (status === 529) return { code: 'overloaded', retryable: true };
  if (status >= 500 && status < 600) return { code: 'server_error', retryable: true };
  if (status === 408) return { code: 'timeout', retryable: true };
  if (status === 401 || status === 403) return { code: 'auth', retryable: false };
  if (status === 402) return { code: 'quota', retryable: false };
  if (status === 400) return { code: 'bad_request', retryable: false };
  if (status === 404) return { code: 'not_found', retryable: false };
  return { code: 'unknown', retryable: false };
}

function formatApiError(status: number, body: string): string {
  const { code } = classifyHttpStatus(status);
  let detail = body;
  try {
    const parsed = JSON.parse(body);
    if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    detail = body.slice(0, 200);
  }
  const base = `API Error: ${status}`;
  switch (code) {
    case 'rate_limited':
      return `${base} ${detail}. This may be a temporary capacity issue. Try again in a moment.`;
    case 'overloaded':
      return `${base} Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.`;
    case 'server_error':
      return `${base} ${detail}. This is a server-side issue, usually temporary — try again in a moment.`;
    case 'timeout':
      return `Request timed out. Check your network connection and try again.`;
    case 'auth':
      return `${base} ${detail}. Check BOOK_API_KEY or run /login.`;
    case 'quota':
      return `${base} ${detail}. Check your usage/credits.`;
    default:
      return `${base} ${detail}`;
  }
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retry: RetryConfig,
  signal?: AbortSignal,
  onRetry?: (attempt: number, max: number, delayMs: number) => void,
): Promise<Response> {
  const startMs = Date.now();
  const maxAttempts = retry.watchdog ? Number.MAX_SAFE_INTEGER : retry.maxAttempts;
  let lastError: string | null = null;
  let lastStatus: number | null = null;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const fetchInit = { ...init };
    if (retry.requestTimeoutMs > 0) {
      const timeoutSignal = AbortSignal.timeout(retry.requestTimeoutMs);
      if (signal) {
        const merged = new AbortController();
        const onAbort = () => merged.abort(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        timeoutSignal.addEventListener('abort', () => merged.abort(timeoutSignal.reason), {
          once: true,
        });
        fetchInit.signal = merged.signal;
      } else {
        fetchInit.signal = timeoutSignal;
      }
    } else if (signal) {
      fetchInit.signal = signal;
    }

    let resp: Response;
    try {
      resp = await fetch(url, fetchInit);
    } catch (e) {
      if (signal?.aborted) throw e;
      lastError = e instanceof Error ? e.message : String(e);
      if (retry.totalBudgetMs > 0 && Date.now() - startMs > retry.totalBudgetMs) break;
      if (attempt >= maxAttempts) break;
      const delay = backoffMs(attempt, retry);
      log.warn('retry network error', { attempt: attempt + 1, delayMs: delay, error: lastError });
      onRetry?.(attempt + 1, maxAttempts > 100 ? -1 : maxAttempts, delay);
      try {
        await sleep(delay, signal);
      } catch {
        throw e;
      }
      continue;
    }

    if (resp.status === 429 || resp.status === 529 || resp.status === 408 || resp.status >= 500) {
      lastError = `API error ${resp.status}`;
      lastStatus = resp.status;
      const isWatchdogRetryable = retry.watchdog && (resp.status === 429 || resp.status === 529);
      const effectiveMax = isWatchdogRetryable ? Number.MAX_SAFE_INTEGER : maxAttempts;
      if (retry.totalBudgetMs > 0 && Date.now() - startMs > retry.totalBudgetMs) return resp;
      if (attempt >= effectiveMax) return resp;
      const delay = backoffMs(attempt, retry, resp.headers.get('retry-after'));
      log.warn('retry http status', { attempt: attempt + 1, status: resp.status, delayMs: delay });
      onRetry?.(attempt + 1, isWatchdogRetryable ? -1 : maxAttempts, delay);
      try {
        await sleep(delay, signal);
      } catch {
        return resp;
      }
      continue;
    }

    return resp;
  }

  throw new Error(lastError ?? 'request failed after retries');
}

// ── Message format conversion (OpenAI → Anthropic) ──────────────────────────

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface AnthropicContentBlock {
  type: 'text' | 'tool_use' | 'tool_result';
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicContentBlock[];
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
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

export function buildSystemBlocks(
  system: string,
  systemZones?: SystemPromptZones,
): Array<{
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}> {
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

/** Models that support adaptive thinking. All others get no thinking field. */
const ADAPTIVE_THINKING_MODELS = new Set([
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
        if (last?.role === 'user' && typeof last.content === 'string') {
          last.content = last.content + '\n\n' + messageText(msg.content);
        } else {
          anthropicMessages.push({ role: 'user', content: messageText(msg.content) });
        }
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const content: AnthropicContentBlock[] = [];

      // Always include a text block — Anthropic requires at least one content block.
      // Use empty string if content is null/empty (assistant with tool_calls only).
      content.push({ type: 'text', text: messageText(msg.content) });

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
    input_schema: t.parameters,
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

// ── SSE stream reading ──────────────────────────────────────────────────────

async function readStreamChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  stallTimeoutMs: number,
): Promise<
  | { tag: 'read'; done: boolean; value: Uint8Array | undefined }
  | { tag: 'stall' }
  | { tag: 'abort' }
> {
  if (signal?.aborted) return { tag: 'abort' };

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  try {
    return await Promise.race([
      reader.read().then((r) => ({ tag: 'read' as const, done: r.done, value: r.value })),
      ...(stallTimeoutMs > 0
        ? [
            new Promise<{ tag: 'stall' }>((resolve) => {
              timeout = setTimeout(() => resolve({ tag: 'stall' }), stallTimeoutMs);
            }),
          ]
        : []),
      ...(signal
        ? [
            new Promise<{ tag: 'abort' }>((resolve) => {
              onAbort = () => resolve({ tag: 'abort' });
              signal.addEventListener('abort', onAbort, { once: true });
            }),
          ]
        : []),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
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
  },
): AsyncGenerator<ProviderStreamEvent> {
  const retry = config.retry;
  const signal = options?.signal;
  const normalizedBaseUrl = config.baseUrl.replace(/\/+$/, '');
  const url = `${normalizedBaseUrl}${/\/v1$/i.test(normalizedBaseUrl) ? '' : '/v1'}/messages`;

  // Convert messages and tools to Anthropic format
  const { system, systemZones, messages: anthropicMessages } = convertMessages(messages);
  const anthropicTools = convertTools(tools);

  const body: Record<string, unknown> = {
    model: config.model,
    max_tokens: config.maxTokens,
    messages: anthropicMessages,
    stream: true,
    stream_options: { include_usage: true },
  };

  // System prompt as top-level field. Book emits a cacheable static prefix
  // and a dynamic per-turn suffix (for example, the active todo list).
  body.system = buildSystemBlocks(system, systemZones);

  // Tools with cache_control markers on each
  if (anthropicTools.length > 0) {
    body.tools = anthropicTools.map((t) => ({
      ...t,
      cache_control: { type: 'ephemeral' },
    }));
  }

  // Thinking / effort — only for models that support adaptive thinking.
  if (config.modelInfo?.effort !== false && supportsAdaptiveThinking(config.model)) {
    const effort = config.effort ?? 'high';
    body.thinking = { type: 'adaptive', display: 'omitted' };
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
    );
  } catch (e) {
    log.warn('fetchWithRetry failed', e instanceof Error ? e.message : String(e));
    yield { type: 'error', error: e instanceof Error ? e.message : String(e) };
    return;
  }

  log.debug('response received', { status: response.status, ok: response.ok });

  if (!response.ok) {
    const errorText = await response.text();
    yield { type: 'error', error: formatApiError(response.status, errorText) };
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: 'error', error: 'No response body' };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';

  // Track state across SSE events
  let currentToolId = '';
  let currentToolName = '';
  let currentToolArgs = '';
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheCreationInputTokens = 0;
  let cacheReadInputTokens = 0;
  const stallTimeoutMs = retry.streamStallTimeoutMs;

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

            if (block.type === 'tool_use') {
              currentToolId = (block.id as string) ?? '';
              currentToolName = (block.name as string) ?? '';
              currentToolArgs = '';
            }
            // thinking blocks: silently consumed (display: "omitted" default)
            break;
          }

          case 'content_block_delta': {
            const delta = parsed.delta as Record<string, unknown> | undefined;
            if (!delta) break;

            if (delta.type === 'text_delta' && delta.text) {
              yield { type: 'text', content: delta.text as string };
            } else if (delta.type === 'input_json_delta' && delta.partial_json) {
              currentToolArgs += delta.partial_json as string;
            }
            // thinking_delta: silently consumed
            break;
          }

          case 'content_block_stop': {
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
            break;
          }

          case 'message_delta': {
            const usage = parsed.usage as Record<string, number> | undefined;
            if (usage) {
              outputTokens = usage.output_tokens ?? 0;
            }
            break;
          }

          case 'message_stop': {
            const usage: Usage = {
              promptTokens: inputTokens,
              completionTokens: outputTokens,
              totalTokens: inputTokens + outputTokens,
              cacheCreationInputTokens,
              cacheReadInputTokens,
              contextTokens:
                inputTokens + cacheCreationInputTokens + cacheReadInputTokens,
            };
            log.info('stream done', usage);
            yield { type: 'done', usage };
            return;
          }

          case 'error': {
            const err = parsed.error as Record<string, string> | undefined;
            yield { type: 'error', error: err?.message ?? 'Unknown Anthropic API error' };
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
    yield { type: 'error', error: e instanceof Error ? e.message : String(e) };
    return;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }

  // Fallback: if we reached end-of-body without message_stop, emit done
  const usage: Usage = {
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens: inputTokens + outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    contextTokens: inputTokens + cacheCreationInputTokens + cacheReadInputTokens,
  };
  log.info('stream done (end of body)', usage);
  yield { type: 'done', usage };
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
