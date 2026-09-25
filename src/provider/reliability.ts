import type { RetryConfig } from '../types/runtime.js';

interface RetryLogger {
  warn(message: string, data?: Record<string, unknown>): void;
}

import { systemClock, type Clock, type MonotonicMs } from '../clock.js';

export type ProviderErrorCode =
  | 'network'
  | 'timeout'
  | 'context_overflow'
  | 'rate_limited'
  | 'overloaded'
  | 'server_error'
  | 'auth'
  | 'bad_request'
  | 'not_found'
  | 'quota'
  | 'unknown';

export function classifyHttpStatus(status: number): {
  code: ProviderErrorCode;
  retryable: boolean;
} {
  if (status === 413) return { code: 'context_overflow', retryable: false };
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
 * The upstream HTTP status a router quoted inside its own error body, if any.
 *
 * 9router wraps an upstream 4xx as a 503 plus a cooldown, so the wrapper's status
 * says "transient" while the body says the request itself is invalid. Only a 4xx
 * is ever taken from the body: a quoted 5xx says nothing the wrapper did not.
 *
 * Only two shapes count as a quote: 9router's own `[<route>] [400]:` prefix, and
 * a JSON `"error"` object whose `code` is a 4xx. A status mentioned in prose
 * (`upstream sent HTTP 403`, `chunk [404]`) or a longer number that merely starts
 * like one (`"code": 4001`) is not: misreading an outage body ends the run after
 * a single request, or parks it as a rejected credential.
 */
export function quotedUpstreamStatus(body: string): number | undefined {
  if (!body) return undefined;
  const text = body.length > 65536 ? body.slice(0, 65536) : body;
  const patterns = [
    /\[[^\]\s]+\]\s*\[(4\d\d)\]:/,
    /"error"\s*:\s*\{[^{}]*?"code"\s*:\s*"?(4\d\d)(?![\d.])/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return Number(match[1]);
    }
  }
  return undefined;
}

/**
 * The upstream 4xx quoted inside a retryable response, when that quote is what
 * classifies it: 9router answers 503 and names the real status in the body. A
 * non-retryable status is its own answer, and its body is never re-read.
 */
export function wrappedUpstreamStatus(status: number, body: string): number | undefined {
  return classifyHttpStatus(status).retryable ? quotedUpstreamStatus(body) : undefined;
}

export function classifyApiError(status: number, body: string): ProviderErrorCode {
  const code = classifyHttpStatus(wrappedUpstreamStatus(status, body) ?? status).code;
  return code === 'bad_request' && isContextOverflowError(body) ? 'context_overflow' : code;
}

export function classifyProviderError(error: unknown): ProviderErrorCode {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes('timed out') || message.includes('timeout')) return 'timeout';
  if (isContextOverflowError(message)) return 'context_overflow';
  return 'network';
}

export function formatApiError(status: number, body: string): string {
  const code = classifyApiError(status, body);
  const detail = safeErrorDetail(body);
  const base = `API Error: ${status}`;
  switch (code) {
    case 'context_overflow':
      return `${base} ${detail || 'Input exceeds the model context window.'} Reduce the conversation or tool output and try again.`;
    case 'rate_limited':
      return `${base} ${detail}. This may be a temporary capacity issue. Try again in a moment.`;
    case 'overloaded':
      return `${base} Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.`;
    case 'server_error':
      return `${base} ${detail}. This is a server-side issue, usually temporary — try again in a moment.`;
    case 'timeout':
      return 'Request timed out. Check your network connection and try again.';
    case 'auth':
      return `${base} ${detail}. Check BOOK_API_KEY, or provider.<id>.apiKey in settings.`;
    case 'quota':
      return `${base} ${detail}. Check your usage/credits.`;
    default:
      return `${base} ${detail}`;
  }
}

/** Detect provider/router responses that mean the input, rather than transport, is too large. */
export function isContextOverflowError(error: unknown): boolean {
  const normalized = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    /\b(?:api error:\s*)?413\b/.test(normalized) ||
    normalized.includes('request entity too large') ||
    normalized.includes('payload too large') ||
    normalized.includes('request too large') ||
    normalized.includes('context_length_exceeded') ||
    normalized.includes('maximum context length') ||
    normalized.includes('context window') ||
    normalized.includes('prompt too long') ||
    /prompt\s+is\s+too\s+long/.test(normalized) ||
    /input\s+(?:is\s+)?too\s+long/.test(normalized) ||
    normalized.includes('too many tokens') ||
    /input\s+(?:token\s+count\s+)?exceeds?.*(?:context|limit|maximum)/.test(normalized) ||
    /input\s+exceeds?.*(?:context\s+window|context\s+length|token\s+limit)/.test(normalized) ||
    /maximum\s+context|context\s+(?:length|window|size).*(?:exceed|overflow|too\s+(?:long|large)|maximum)/.test(
      normalized,
    ) ||
    /too\s+many\s+(?:input\s+)?tokens|request\s+too\s+large.*token/.test(normalized)
  );
}

/**
 * The longest text still read as an error envelope rather than an answer.
 * OpenAI's server-error sentence is about 260 characters, and a JSON-rendered
 * upstream error rarely passes 1,000.
 */
const ERROR_ENVELOPE_MAX_CHARS = 2_000;

/**
 * True when `text` has the shape a router gives an upstream error it renders as
 * the answer: the whole answer is one `[Error] …` line. 9router's Responses
 * translator writes an upstream `error` or `response.failed` event as
 * `[Error] <message>` (or the error object as JSON when it has no message) and
 * ends the stream there, so an envelope is never one line of a longer reply. An
 * answer that quotes an `[Error]` line and goes on to explain it is an answer.
 */
export function isErrorEnvelopeShape(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.length <= ERROR_ENVELOPE_MAX_CHARS &&
    /^\[Error\]/i.test(trimmed) &&
    !/[\r\n]/.test(trimmed)
  );
}

/**
 * A router that answers 200 with the upstream's error as the assistant text has
 * not answered. The envelope shape (`isErrorEnvelopeShape`) is required; then
 * either a usage block reporting zero tokens both ways (the router wrote the
 * text, no model did) or the upstream's own server-error wording confirms it.
 * The supported shapes are the table in `reliability.test.ts`:
 *   - OpenAI's `[Error] An error occurred while processing your request. …
 *     help.openai.com … Please include the request ID <id> in your message.`,
 *     whatever the usage says;
 *   - any other one-line server error that names its request ID;
 *   - any one-line `[Error] …` with 0/0 usage.
 */
export function isUpstreamErrorEnvelope(
  text: string,
  usage?: { promptTokens: number; completionTokens: number } | null,
): boolean {
  if (!isErrorEnvelopeShape(text)) return false;
  const zeroUsage = usage != null && usage.promptTokens === 0 && usage.completionTokens === 0;
  return (
    zeroUsage ||
    /\brequest id\b/i.test(text) ||
    /help\.openai\.com/i.test(text) ||
    /error occurred while processing/i.test(text)
  );
}

/**
 * How long a retryable response's error body may take to arrive. The body only
 * informs the retry decision (a quoted upstream 4xx stops the retries), so a
 * router that sends its headers and then stalls must not hold every attempt for
 * the full `requestTimeoutMs`: ten attempts at 600 s each by default. After this
 * long the decision is made on what arrived.
 */
export const ERROR_BODY_READ_TIMEOUT_MS = 5_000;

/** The most of an error body that is ever read; the rest is cancelled unread. */
const ERROR_BODY_MAX_BYTES = 65_536;

/**
 * Read at most ERROR_BODY_MAX_BYTES of an error body, for at most
 * ERROR_BODY_READ_TIMEOUT_MS. What arrived before the cap, the deadline, an
 * abort or a stream error is kept, and the rest of the body is cancelled.
 */
async function readErrorBody(response: Response, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted || !response.body) return '';
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    // A body something else already locked has nothing left to read here.
    return '';
  }
  const decoder = new TextDecoder();
  let text = '';
  let received = 0;
  let finished = false;
  // Cancelling resolves the pending read as done, which ends the loop below.
  const stop = (): void => {
    reader.cancel().catch(() => {});
  };
  const timer = setTimeout(stop, ERROR_BODY_READ_TIMEOUT_MS);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    while (received < ERROR_BODY_MAX_BYTES) {
      const chunk = await reader.read();
      if (chunk.done) {
        finished = true;
        break;
      }
      const bytes = chunk.value.subarray(0, ERROR_BODY_MAX_BYTES - received);
      received += bytes.byteLength;
      text += decoder.decode(bytes, { stream: true });
    }
  } catch {
    // A body that fails part-way still leaves what arrived before it.
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    if (!finished) stop();
    try {
      reader.releaseLock();
    } catch {
      // Nothing is pending once the loop has ended.
    }
  }
  return text + decoder.decode();
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retry: RetryConfig,
  signal?: AbortSignal,
  onRetry?: (attempt: number, max: number, delayMs: number) => void,
  logger?: RetryLogger,
  // The retry budget is a duration, so it reads the monotonic clock. On the
  // wall clock an NTP step or a resumed VM could hand a week-long run either
  // failure mode: a backwards correction makes the budget never expire and the
  // call retries forever, a forwards one exhausts it on the first attempt.
  clock: Clock = systemClock,
): Promise<Response> {
  const startMs = clock.monotonicNowMs();
  const maxAttempts = retry.watchdog ? Number.MAX_SAFE_INTEGER : retry.maxAttempts;
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    if (attempt > 0 && signal?.aborted) throw abortError(signal);
    const fetchSignal = requestSignal(signal, retry.requestTimeoutMs);
    let response: Response;
    try {
      response = await fetch(url, { ...init, signal: fetchSignal });
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error instanceof Error ? error.message : String(error);
      if (attempt >= maxAttempts || budgetExhausted(clock, startMs, retry.totalBudgetMs)) break;
      const delay = boundedDelay(clock, backoffMs(attempt, retry), startMs, retry.totalBudgetMs);
      logger?.warn('retry network error', {
        attempt: attempt + 1,
        delayMs: delay,
        error: lastError,
      });
      onRetry?.(attempt + 1, maxAttempts > 100 ? -1 : maxAttempts, delay);
      await sleep(delay, signal);
      continue;
    }

    const classification = classifyHttpStatus(response.status);
    if (!classification.retryable) return response;
    lastError = `API error ${response.status}`;

    const bodyText = await readErrorBody(response, signal);
    const quoted = quotedUpstreamStatus(bodyText);
    if (quoted !== undefined && !classifyHttpStatus(quoted).retryable) {
      logger?.warn('upstream error quoted in retryable status; not retrying', {
        status: response.status,
        upstreamStatus: quoted,
      });
      return new Response(bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    const watchdogRetry = retry.watchdog && (response.status === 429 || response.status === 529);
    const effectiveMax = watchdogRetry ? Number.MAX_SAFE_INTEGER : maxAttempts;
    if (attempt >= effectiveMax || budgetExhausted(clock, startMs, retry.totalBudgetMs)) {
      return new Response(bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    const delay = boundedDelay(
      clock,
      backoffMs(attempt, retry, response.headers.get('retry-after')),
      startMs,
      retry.totalBudgetMs,
    );
    logger?.warn('retry http status', {
      attempt: attempt + 1,
      status: response.status,
      delayMs: delay,
    });
    onRetry?.(attempt + 1, watchdogRetry ? -1 : maxAttempts, delay);
    try {
      await sleep(delay, signal);
    } catch {
      return new Response(bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }
    try {
      await response.body?.cancel();
    } catch {
      // A custom fetch implementation may expose an already-locked body.
    }
  }

  throw new Error(lastError ?? 'request failed after retries');
}

export async function readStreamChunk(
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
      reader.read().then((result) => ({
        tag: 'read' as const,
        done: result.done,
        value: result.value,
      })),
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

function requestSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal | undefined {
  if (timeoutMs <= 0) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('Aborted');
}

function safeErrorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === 'string') return parsed.error.message.slice(0, 2000);
  } catch {
    // Non-JSON response bodies are still useful when kept bounded.
  }
  return body.slice(0, 200);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal ? abortError(signal) : new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function backoffMs(attempt: number, retry: RetryConfig, retryAfter?: string | null): number {
  const retryAfterMs = parseRetryAfter(retryAfter);
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, retry.maxDelayMs);
  const exponential = Math.min(retry.baseDelayMs * 2 ** attempt, retry.maxDelayMs);
  return Math.round(exponential * (0.5 + Math.random()));
}

function parseRetryAfter(value?: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return undefined;
  // Wall clock on purpose, and the one place in this file that should be: the
  // server sent an HTTP date, which is a point on the wall clock by definition.
  // Subtracting a monotonic reading from it would be meaningless.
  return Math.max(0, timestamp - Date.now());
}

function budgetExhausted(clock: Clock, startMs: MonotonicMs, budgetMs: number): boolean {
  return budgetMs > 0 && clock.monotonicNowMs() - startMs >= budgetMs;
}

function boundedDelay(
  clock: Clock,
  delayMs: number,
  startMs: MonotonicMs,
  budgetMs: number,
): number {
  if (budgetMs <= 0) return delayMs;
  return Math.min(delayMs, Math.max(0, budgetMs - (clock.monotonicNowMs() - startMs)));
}
