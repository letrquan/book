import type { AgentConfig, ProviderStreamEvent, ToolDefinition, Usage, RetryConfig } from '../types.js';

/**
 * Sleep with optional AbortSignal — throws if aborted during sleep.
 */
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

/**
 * Jittered exponential backoff.
 * Applies ±50% jitter to prevent thundering-herd on retry storms.
 */
function jitter(ms: number): number {
  return ms * (0.5 + Math.random());
}

/**
 * Compute the backoff delay for a given attempt.
 * Respects the Retry-After header when present (capped at maxDelayMs).
 */
function backoffMs(
  attempt: number,
  retry: RetryConfig,
  retryAfter?: string | null,
): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (!Number.isNaN(secs) && secs > 0) {
      return Math.min(secs * 1000, retry.maxDelayMs);
    }
  }
  const exponential = Math.min(retry.baseDelayMs * 2 ** attempt, retry.maxDelayMs);
  return Math.round(jitter(exponential));
}

/**
 * Classify an HTTP status code into a machine-readable error code.
 */
function classifyHttpStatus(status: number): {
  code: 'network' | 'timeout' | 'rate_limited' | 'overloaded' | 'server_error' | 'auth' | 'bad_request' | 'not_found' | 'quota' | 'unknown';
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

/**
 * Fetch with configurable exponential backoff retry.
 *
 * Retries on: network errors, 429, 529, 5xx, 408.
 * In watchdog mode, 429 and 529 are retried indefinitely.
 * A per-fetch timeout is applied via AbortSignal.timeout().
 */
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
    // Apply per-fetch timeout if configured.
    const fetchInit = { ...init };
    if (retry.requestTimeoutMs > 0) {
      const timeoutSignal = AbortSignal.timeout(retry.requestTimeoutMs);
      // Merge with the caller's signal if present.
      if (signal) {
        const merged = new AbortController();
        const onAbort = () => merged.abort(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        timeoutSignal.addEventListener('abort', () => merged.abort(timeoutSignal.reason), { once: true });
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
      if (signal?.aborted) throw e; // user cancelled — don't retry
      lastError = e instanceof Error ? e.message : String(e);

      // Total budget check.
      if (retry.totalBudgetMs > 0 && Date.now() - startMs > retry.totalBudgetMs) {
        break;
      }
      if (attempt >= maxAttempts) break;

      const delay = backoffMs(attempt, retry);
      onRetry?.(attempt + 1, maxAttempts > 100 ? -1 : maxAttempts, delay);
      try {
        await sleep(delay, signal);
      } catch {
        throw e; // aborted during sleep
      }
      continue;
    }

    // Retryable HTTP statuses.
    if (resp.status === 429 || resp.status === 529 || resp.status === 408 || resp.status >= 500) {
      lastError = `API error ${resp.status}`;
      lastStatus = resp.status;

      // Watchdog mode: only retry 429 and 529 indefinitely; 5xx still capped.
      const isWatchdogRetryable = retry.watchdog && (resp.status === 429 || resp.status === 529);
      const effectiveMax = isWatchdogRetryable ? Number.MAX_SAFE_INTEGER : maxAttempts;

      if (retry.totalBudgetMs > 0 && Date.now() - startMs > retry.totalBudgetMs) {
        return resp; // budget exhausted — return the error response to caller
      }
      if (attempt >= effectiveMax) return resp; // last attempt — return response so caller can read body

      const delay = backoffMs(attempt, retry, resp.headers.get('retry-after'));
      onRetry?.(attempt + 1, isWatchdogRetryable ? -1 : maxAttempts, delay);
      try {
        await sleep(delay, signal);
      } catch {
        // Aborted during sleep — return response so caller can clean up
        return resp;
      }
      continue;
    }

    return resp; // success
  }

  throw new Error(lastError ?? 'request failed after retries');
}

/**
 * Build a human-readable error message in Claude Code format:
 *   API Error: <status> <message>. <recovery hint>. <status page link if applicable>.
 */
function formatApiError(status: number, body: string): string {
  const { code } = classifyHttpStatus(status);

  // Try to extract a clean message from the body.
  let detail = body;
  try {
    const parsed = JSON.parse(body);
    if (parsed.error?.message) detail = parsed.error.message;
  } catch {
    // not JSON — use as-is, truncated
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

function parseToolArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return { __raw: raw };
  }
}

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

export async function* chatCompletionStream(
  config: AgentConfig,
  messages: { role: string; content: string | null; tool_calls?: unknown[] }[],
  tools: ToolDefinition[],
  options?: { signal?: AbortSignal; onRetry?: (attempt: number, max: number, delayMs: number) => void; onStreamStall?: (countdownMs: number) => void; onStreamResume?: () => void },
): AsyncGenerator<ProviderStreamEvent> {
  const retry = config.retry;
  const signal = options?.signal;
  const url = `${config.baseUrl}/chat/completions`;

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
    // Request token usage in the final SSE chunk so we can track cost.
    stream_options: { include_usage: true },
  };

  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  let response: Response;
  try {
    response = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      retry,
      signal,
      options?.onRetry,
    );
  } catch (e) {
    yield { type: 'error', error: e instanceof Error ? e.message : String(e) };
    return;
  }

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
  const toolCallParts: Array<{ index: number; id: string; name: string; arguments: string }> = [];
  let currentUsage: Usage | null = null;

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
        options?.onStreamStall?.(stallTimeoutMs);
        try {
          await reader.cancel();
        } catch {
          // ignore cancellation failures
        }
        yield { type: 'error', error: 'Stream stalled: no data received for ' + stallTimeoutMs + 'ms' };
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
          yield { type: 'done', usage: currentUsage ?? undefined };
          return;
        }

        try {
          const parsed = JSON.parse(data);
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

          const delta = choice.delta;
          if (!delta) continue;

          if (delta.content) {
            yield { type: 'text', content: delta.content };
          }

          if (delta.tool_calls) {
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
    // Unexpected stream error — surface it instead of silently completing,
    // otherwise the TUI can show an empty completed assistant message.
    yield { type: 'error', error: e instanceof Error ? e.message : String(e) };
    return;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore: the reader may already have been cancelled/released
    }
  }

  yield* emitToolCalls();
  yield { type: 'done', usage: currentUsage ?? undefined };
}
