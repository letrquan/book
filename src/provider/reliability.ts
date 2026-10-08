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
  | 'unprocessable'
  | 'quota'
  | 'model_unavailable'
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
  if (status === 422) return { code: 'unprocessable', retryable: false };
  return { code: 'unknown', retryable: false };
}

/**
 * The two 404 wordings a router hands back when its route has nothing left to
 * serve a model with (#383). Recognized only when the body also states a
 * `(reset after …)` cooldown, so a permanent "No endpoints found for
 * unknown-model" — a missing model, not a capacity moment — stays a terminal
 * 404.
 */
const CAPACITY_OUTAGE_404 = /no\s+(?:endpoints|accounts)\s+found/i;

/** The cooldown statement the capacity outage arrives with. */
const RESET_AFTER = /\(reset after\s*[^)]+\)/i;

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
 *
 * A quoted 404 whose body says no endpoints or no accounts were found — and
 * states a cooldown — is a capacity outage (#383): the router turns an upstream
 * `[CommandCode error: No endpoints found for <model>.]` into a 503 with a
 * `(reset after …)` cooldown, so it is transient and the quote must not end the
 * retries. The read ends there: such a body can also carry a JSON error object
 * with some other code, and reading that quote would park the run as if the
 * credential had been refused. A cooldown-less "no endpoints found" is kept as
 * the 404 it is.
 */
export function quotedUpstreamStatus(body: string): number | undefined {
  if (!body) return undefined;
  const text = body.length > 65536 ? body.slice(0, 65536) : body;
  const patterns = [
    /\[[^\]\s]+\]\s*\[(4\d\d)\]:/,
    /"error"\s*:\s*\{[^{}]*?"code"\s*:\s*"?(4\d\d)(?![\d.])/,
  ];
  const capacityOutage = CAPACITY_OUTAGE_404.test(text) && RESET_AFTER.test(text);
  if (capacityOutage) return undefined;
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
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

/** `error.code` or `error.type` values that name a context overflow outright. */
const CONTEXT_OVERFLOW_ERROR_NAMES: ReadonlySet<string> = new Set([
  'context_length_exceeded',
  'request_too_large',
  // llama.cpp's server.
  'exceed_context_size_error',
]);

/**
 * `error.code` or `error.type` values that name the model itself as gone (#387):
 * OpenAI's `model_not_found`, and the spellings routers invent for the same
 * verdict. Names, not statuses — a `model_not_found` code on a wrapped 403 is
 * still about the model, not about the request or the key.
 */
const MODEL_UNAVAILABLE_ERROR_NAMES: ReadonlySet<string> = new Set([
  'model_not_found',
  'model_not_available',
  'model_unavailable',
]);

/**
 * The wordings a provider uses to say the model itself is gone or unusable
 * (#387). An explicit "please pick another" instruction needs no corroboration;
 * every other phrase is only believed when it shares a sentence with a model
 * word, so a 403 that says an endpoint is "not available today" is not read as
 * a retirement of the model named three sentences earlier.
 */
const MODEL_GONE_PHRASES = [
  'no longer available',
  'no longer supported',
  'not found',
  'does not exist',
  'is not supported',
  'not available',
  'has been retired',
  'has been removed',
  'has been deprecated',
];

/** "Please pick another model" — the wordings that name their own remedy. */
const CHOOSE_ANOTHER_MODEL =
  /(?:select|choose)\s+(?:another|a\s+different)\s+model\b(?!\s+provider\b)/i;

/** How far a gone-phrase may sit from a model word and still be about it. */
const MODEL_GONE_PROXIMITY_CHARS = 60;

/** Credential words: a sentence that names a credential is never about a model. */
const CREDENTIAL_WORD = /\b(?:api\s+key|key|token|credential)s?\b/i;

/** `error.code` or `error.type` values that name a spent quota outright (#400). */
const INSUFFICIENT_QUOTA_ERROR_NAMES: ReadonlySet<string> = new Set(['insufficient_quota']);

/** Limit phrases for spent quota or plan usage limits (#400). */
const SPENT_USAGE_LIMIT_PHRASES =
  /\b(?:usage\s+limits?|plan\s+limits?|quotas?|subscription\s+limits?|limits?\s+for\s+your\s+plan)\b/i;

/** Long window phrases: weekly, daily, monthly, N-hour, per day/week/month (#400). */
const LONG_WINDOW_PHRASES =
  /\b(?:weekly|daily|monthly|\d+(?:\.\d+)?(?:-|\s+)hours?|per\s+(?:day|week|month))\b/i;

/**
 * Short window phrases that designate rate limits rather than plan quotas (#400).
 * A sentence containing any of these stays rate_limited.
 */
const SHORT_WINDOW_PHRASES = /\b(?:per\s+min(?:ute)?|per\s+sec(?:ond)?|rpm|tpm|rps)\b/i;

/**
 * True when an error body says a usage or plan limit is spent over a long
 * window (weekly, daily, monthly, N-hour), or names OpenAI's `insufficient_quota`
 * (#400).
 *
 * Read through `errorBodyParts` (the message, the `code` / `type` names, and
 * OpenRouter's forwarded `raw`). A short window (per minute, RPM, TPM) stays
 * a rate limit.
 */
function statesSpentUsageLimit(body: string): boolean {
  if (!body) return false;
  const { message, names, raw } = errorBodyParts(body);
  if (names.some((name) => INSUFFICIENT_QUOTA_ERROR_NAMES.has(name.toLowerCase()))) {
    return true;
  }
  const saysIt = (text: string): boolean => {
    for (const sentence of text.split(/[.!?:;]+(?:\s+|$)|[\r\n]+/)) {
      if (SHORT_WINDOW_PHRASES.test(sentence)) continue;
      if (SPENT_USAGE_LIMIT_PHRASES.test(sentence) && LONG_WINDOW_PHRASES.test(sentence)) {
        return true;
      }
    }
    return false;
  };
  return saysIt(message) || (raw !== undefined && statesSpentUsageLimit(raw));
}

/**
 * An absolute reset time stated in an error body (#400):
 * `resets at <ISO>`, `reset at <ISO>`, `resets on <ISO>`, `reset on <ISO>`.
 * The ISO timestamp must have a date, `T`, time, and `Z` or `±hh:mm` offset.
 */
const ABSOLUTE_RESET_PATTERN =
  /\b(?:resets?)\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))\b/i;

export function parseAbsoluteResetIso(body?: string | null): string | undefined {
  if (!body) return undefined;
  const match = body.match(ABSOLUTE_RESET_PATTERN);
  if (!match) return undefined;
  const timestamp = Date.parse(match[1]);
  return Number.isFinite(timestamp) ? match[1] : undefined;
}

export function parseAbsoluteReset(body?: string | null): number | undefined {
  const iso = parseAbsoluteResetIso(body);
  return iso !== undefined ? Date.parse(iso) : undefined;
}

/**
 * True when an error body says the model is gone or unusable, read from the
 * same message parts every other body reading uses (`errorBodyParts`: the
 * message, the `code` / `type` names, and OpenRouter's forwarded `raw`) —
 * never from arbitrary text elsewhere in the body, which may echo the request
 * or a model list.
 *
 * A match is either an explicit "select / choose another model" instruction, a
 * gone-phrase within `MODEL_GONE_PROXIMITY_CHARS` after a model word in the same
 * sentence, Anthropic's 404 `not_found_error` naming `model:`, or a `code` /
 * `type` name that says so outright. A body that says only "Invalid API key
 * provided", "Forbidden" or "Not Found" never matches, so a genuine credential
 * problem keeps its own classification.
 */
function statesModelUnavailable(body: string, effectiveStatus?: number): boolean {
  const { message, names, raw } = errorBodyParts(body);
  if (names.some((name) => MODEL_UNAVAILABLE_ERROR_NAMES.has(name.toLowerCase()))) return true;
  if (
    effectiveStatus === 404 &&
    names.some((name) => name.toLowerCase() === 'not_found_error') &&
    message.trim().toLowerCase().startsWith('model:')
  ) {
    return true;
  }
  const saysIt = (text: string): boolean => {
    // Sentence punctuation followed by whitespace or end of string, or newlines.
    // Dotted model ids (gpt-4.1) and route colons stay within one sentence.
    for (const sentence of text.split(/[.!?:;]+(?:\s+|$)|[\r\n]+/)) {
      if (CREDENTIAL_WORD.test(sentence)) continue;
      if (CHOOSE_ANOTHER_MODEL.test(sentence)) return true;
      const lower = sentence.toLowerCase();
      const modelWords = [...lower.matchAll(/\bmodels?\b/g)].map((m) => m.index);
      if (modelWords.length === 0) continue;
      for (const phrase of MODEL_GONE_PHRASES) {
        let gone = lower.indexOf(phrase);
        while (gone >= 0) {
          if (modelWords.some((at) => at < gone && gone - at <= MODEL_GONE_PROXIMITY_CHARS)) {
            return true;
          }
          gone = lower.indexOf(phrase, gone + 1);
        }
      }
    }
    return false;
  };
  return saysIt(message) || (raw !== undefined && statesModelUnavailable(raw, effectiveStatus));
}

/**
 * The message and the `code` / `type` names of a provider's error body. The
 * message is `error.message` (or `error` itself when it is a string), else a
 * top-level `message` or `detail`; a body that is not JSON is its own message.
 * A body that reached the read cap and starts like JSON but does not parse is
 * read for its first `"message"`, `"error"` or `"detail"` string and its first
 * `"code"` / `"type"` names alone, never for the rest, which may echo the
 * request. `raw` is the upstream's own error body that OpenRouter forwards in
 * `error.metadata.raw`, as a string or as an object. `parsed` says the body
 * read as a JSON object, so a reader can tell a body with no message of its own
 * from a body that is not JSON at all.
 */
function errorBodyParts(body: string): {
  message: string;
  names: string[];
  raw?: string;
  parsed: boolean;
} {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(body);
  } catch {
    // Only a body that reached the read cap can be JSON the cap cut; a short malformed one
    // (a Python-repr `{'error': …}`) is plain text, read whole. A router's plain text can open
    // with a bracket of its own (9router's `[antigravity/x] [400]: …`), so only a `{` or an
    // array of objects counts as JSON.
    // The `- 3` allows for a multi-byte character the cap cut and the decoder replaced.
    const reachedCap = new TextEncoder().encode(body).byteLength >= ERROR_BODY_MAX_BYTES - 3;
    if (!reachedCap || !/^\s*(?:\{|\[\s*\{)/.test(body)) {
      return { message: body, names: [], parsed: false };
    }
    // Cut JSON: the first string of `"message"`, else of `"error"`, else of `"detail"`, and
    // the first `"code"` / `"type"` names — never the rest, which may echo the request.
    const readString = (key: string): string => {
      const match = body.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
      if (!match) return '';
      try {
        return JSON.parse(`"${match[1]}"`) as string;
      } catch {
        return '';
      }
    };
    const message = readString('message') || readString('error') || readString('detail');
    const names = [body.match(/"code"\s*:\s*"([^"]*)"/), body.match(/"type"\s*:\s*"([^"]*)"/)]
      .filter((name): name is RegExpMatchArray => name !== null)
      .map((name) => name[1]);
    return { message, names, parsed: true };
  }
  const root: unknown = Array.isArray(parsedJson) ? parsedJson[0] : parsedJson;
  if (typeof root !== 'object' || root === null) {
    return { message: body, names: [], parsed: false };
  }
  const error: unknown = (root as { error?: unknown }).error;
  if (typeof error === 'string') return { message: error, names: [], parsed: true };
  const source = (typeof error === 'object' && error !== null ? error : root) as Record<
    string,
    unknown
  >;
  const fallback = (root as { detail?: unknown }).detail;
  const message =
    typeof source.message === 'string'
      ? source.message
      : typeof fallback === 'string'
        ? fallback
        : '';
  const metadata = source.metadata as { raw?: unknown } | null | undefined;
  const raw = metadata?.raw;
  return {
    message,
    names: [source.code, source.type].filter((name): name is string => typeof name === 'string'),
    raw:
      typeof raw === 'string'
        ? raw
        : typeof raw === 'object' && raw !== null
          ? JSON.stringify(raw)
          : undefined,
    parsed: true,
  };
}

/**
 * True when an error body states that the input is too large: its `error.code`
 * or `error.type` names an overflow, or its message says so
 * (`isContextOverflowError`). Only the message is read for wording, never the
 * rest of the body: a field path such as `contents[413]` or an id such as
 * `req-413-x` elsewhere in a 400 says nothing about the context window, and a
 * stated overflow permanently lowers the model's learned window. OpenRouter's
 * own message is generic (`Provider returned error`), so the upstream body it
 * forwards is read the same way; each level is shorter than the last.
 */
function statesContextOverflow(body: string): boolean {
  const { message, names, raw } = errorBodyParts(body);
  return (
    names.some((name) => CONTEXT_OVERFLOW_ERROR_NAMES.has(name.toLowerCase())) ||
    isContextOverflowError(message) ||
    (raw !== undefined && statesContextOverflow(raw))
  );
}

/**
 * Classify a provider error response.
 *
 * The effective status is the upstream one a router quoted, else the response's
 * own: a 503 that quotes `[403]` is the 403. On an effective 403 or 404 the body
 * is read for a statement that the model itself is gone (#387) — a retirement
 * notice, a `model_not_found` code — which is `model_unavailable`, not `auth`:
 * nothing is wrong with the credential, and an operator must pick another
 * model. A 401 is always `auth` and its body is never read for this; a 403 or
 * 404 without such wording keeps the plain classification. The #383 capacity
 * outage stays out of this path: its quote is suppressed by
 * `quotedUpstreamStatus`, so the 503 classifies as a retryable server error.
 */
export function classifyApiError(status: number, body: string): ProviderErrorCode {
  const effective = wrappedUpstreamStatus(status, body) ?? status;
  if (effective === 429 && statesSpentUsageLimit(body)) {
    return 'quota';
  }
  const code = classifyHttpStatus(effective).code;
  if ((effective === 403 || effective === 404) && statesModelUnavailable(body, effective)) {
    return 'model_unavailable';
  }
  return code === 'bad_request' && statesContextOverflow(body) ? 'context_overflow' : code;
}

export function classifyProviderError(error: unknown): ProviderErrorCode {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout';
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes('timed out') || message.includes('timeout')) return 'timeout';
  if (isContextOverflowError(message)) return 'context_overflow';
  return 'network';
}

/**
 * The message detail for model_unavailable errors. When OpenRouter forwarded
 * an upstream error body in `error.metadata.raw`, its sanitized message is
 * included so the retirement wording reaches the user.
 */
function safeModelUnavailableDetail(body: string): string {
  const { raw } = errorBodyParts(body);
  const main = safeErrorDetail(body);
  if (raw) {
    const rawDetail = safeErrorDetail(raw);
    if (rawDetail && rawDetail !== main) {
      return main ? `${main}: ${rawDetail}` : rawDetail;
    }
  }
  return main || 'The provider did not describe why';
}

export function formatApiError(status: number, body: string): string {
  const code = classifyApiError(status, body);
  const detail = safeErrorDetail(body);
  const base = `API Error: ${status}`;
  switch (code) {
    case 'context_overflow':
      return `${base} ${detail || 'Input exceeds the model context window.'} Reduce the conversation or tool output and try again.`;
    case 'rate_limited': {
      if (isOversizedForRateLimit(detail)) {
        return `${base} ${detail}. The request is larger than the rate limit allows at once, so it has to shrink; waiting will not help.`;
      }
      const resetTime = parseAbsoluteReset(body);
      if (resetTime !== undefined && resetTime > Date.now()) {
        const resetIso = parseAbsoluteResetIso(body);
        return `${base} ${detail}. It resets at ${resetIso}.`;
      }
      return `${base} ${detail}. This may be a temporary capacity issue. Try again in a moment.`;
    }
    case 'overloaded':
      return `${base} Repeated 529 Overloaded errors. The API is at capacity — this is usually temporary. Try again in a moment.`;
    case 'server_error':
      return `${base} ${detail}. This is a server-side issue, usually temporary — try again in a moment.`;
    case 'timeout':
      return 'Request timed out. Check your network connection and try again.';
    case 'auth':
      return `${base} ${detail}. Check BOOK_API_KEY, or provider.<id>.apiKey in settings.`;
    case 'model_unavailable': {
      // Not a credential problem (#387): the key is fine, the model is not
      // served here any more. Name the remedy, never the API key.
      const modelDetail = safeModelUnavailableDetail(body);
      return `${base} ${modelDetail}. This model is not available on this provider or route — choose another with --model or /model.`;
    }
    case 'quota': {
      if (statesSpentUsageLimit(body)) {
        const resetIso = parseAbsoluteResetIso(body);
        const resetClause = resetIso !== undefined ? `; it resets at ${resetIso}` : '';
        return `${base} ${detail}. The usage limit for this plan is spent${resetClause}. Wait for the reset, or choose another model with --model or /model.`;
      }
      return `${base} ${detail}. Check your usage/credits.`;
    }
    default:
      return `${base} ${detail}`;
  }
}

/**
 * Detect provider/router responses that mean the input, rather than transport, is
 * too large. A 413 counts only where it is named as a status (`API Error: 413`,
 * `HTTP 413`, `status 413`, `Error code: 413`), never as a bare number: a field
 * path such as `contents[413]` or an id such as `req-413-x` is not one.
 */
export function isContextOverflowError(error: unknown): boolean {
  const normalized = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    /\b(?:api\s+error|http|(?:error|status)(?:\s+code)?)\s*:?\s*413\b/.test(normalized) ||
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
    // Gemini names the count: `The input token count (1196266) exceeds the maximum …`.
    /input\s+(?:token\s+count\s+)?(?:\(\d+\)\s+)?exceeds?.*(?:context|limit|maximum)/.test(
      normalized,
    ) ||
    /input\s+exceeds?.*(?:context\s+window|context\s+length|token\s+limit)/.test(normalized) ||
    /maximum\s+context|context\s+(?:length|window|size).*(?:exceed|overflow|too\s+(?:long|large)|maximum)/.test(
      normalized,
    ) ||
    /too\s+many\s+(?:input\s+)?tokens|request\s+too\s+large.*token/.test(normalized)
  );
}

/**
 * True when a rate-limit error says the request itself is larger than the limit allows at
 * once, which no amount of waiting fixes: OpenAI's `Request too large for <model> … on tokens
 * per min (TPM): Limit 30000, Requested 45000.` A transient per-minute limit reads `Rate limit
 * reached …` and is not this, and neither is a bare "too many tokens". When the text gives
 * both numbers, the request must exceed the limit.
 */
export function isOversizedForRateLimit(text: string): boolean {
  if (!/\brequest too large\b/i.test(text)) return false;
  const limit = text.match(/\blimit:?\s*(\d+)/i);
  const requested = text.match(/\brequested:?\s*(\d+)/i);
  return !limit || !requested || Number(requested[1]) > Number(limit[1]);
}

/** The per-request limit an oversized rate-limit error states (`Limit 30000`), if any. */
export function statedRateLimit(text: string): number | undefined {
  if (!isOversizedForRateLimit(text)) return undefined;
  const limit = text.match(/\blimit:?\s*(\d+)/i);
  return limit ? Number(limit[1]) : undefined;
}

/**
 * The longest text still read as an error envelope rather than an answer when a
 * model may have written it. OpenAI's server-error sentence is about 260
 * characters, and a JSON-rendered upstream error rarely passes 1,000.
 */
const ERROR_ENVELOPE_MAX_CHARS = 2_000;

type EnvelopeUsage = {
  promptTokens: number;
  completionTokens: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
} | null;

/**
 * A usage block that reports zero tokens both ways: what a router reports for
 * text it wrote itself. A provider that sends no usage block at all gives
 * `undefined`, which is not this.
 */
function isZeroUsage(usage?: EnvelopeUsage): boolean {
  // A full cache hit leaves `promptTokens` at 0 on its own; the cache counts are usage too.
  return (
    usage != null &&
    usage.promptTokens === 0 &&
    usage.completionTokens === 0 &&
    (usage.cacheReadInputTokens ?? 0) === 0 &&
    (usage.cacheCreationInputTokens ?? 0) === 0
  );
}

/**
 * True when `text` has the shape a router gives an upstream error it renders as
 * the answer. 9router's Responses translator writes an upstream `error` or
 * `response.failed` event as `[Error] <message>` (or the error object as JSON
 * when it has no message) and ends the stream there. When a model may have
 * written the text, the envelope must be the whole answer: one `[Error] …` line.
 * An answer that quotes such a line and goes on to explain it is an answer. With
 * a usage block that reports zero tokens both ways any answer that opens with
 * `[Error]` is read as the router's, however many lines it runs to.
 */
export function isErrorEnvelopeShape(text: string, usage?: EnvelopeUsage): boolean {
  if (isZeroUsage(usage)) return /^\s*\[Error\]/i.test(text);
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
 * either a usage block reporting zero tokens both ways or the upstream's own
 * server-error wording confirms it. The supported shapes are the table in
 * `reliability.test.ts`:
 *   - OpenAI's `[Error] An error occurred while processing your request. …
 *     help.openai.com … Please include the request ID <id> in your message.`,
 *     whatever the usage says;
 *   - any other one-line server error that names its request ID;
 *   - with a usage block that reports zero tokens both ways, any answer that
 *     opens with `[Error]`, one line or many.
 */
export function isUpstreamErrorEnvelope(text: string, usage?: EnvelopeUsage): boolean {
  if (!isErrorEnvelopeShape(text, usage)) return false;
  return (
    isZeroUsage(usage) ||
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
 *
 * Every error body goes through here, retryable or not: a non-retryable one is
 * what the classification and the text the user is shown are both read from, so
 * an unbounded read there is a socket held for as long as the provider sends.
 */
export async function readErrorBody(response: Response, signal?: AbortSignal): Promise<string> {
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
      onRetry?.(attempt + 1, maxAttempts === Number.MAX_SAFE_INTEGER ? -1 : maxAttempts, delay);
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

    if (classifyApiError(response.status, bodyText) === 'quota') {
      logger?.warn('usage limit reached; not retrying', {
        status: response.status,
      });
      return new Response(bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    // A 429 that states the request itself is too large (OpenAI's per-minute cap on one request
    // that can never fit under it) is refused the same way however long the retries wait: the
    // loop's overflow recovery is what lets it through, so it gets the response now. Tested on
    // the same formatted text the loop reads, so a statement buried in `metadata.raw` — which
    // that text does not carry — leaves the retries running. A router may wrap that 429 in
    // another status (`503 [route] [429]: …`), so the quoted one counts.
    if (
      (quoted ?? response.status) === 429 &&
      isOversizedForRateLimit(formatApiError(response.status, bodyText))
    ) {
      logger?.warn('rate limit on a request too large to ever fit; not retrying', {
        status: response.status,
      });
      return new Response(bodyText, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    }

    // For a retryable 429 (plain or quoted) whose body states an absolute reset: if the reset
    // is longer than what this call can still wait, return at once rather than burning attempts.
    if ((quoted ?? response.status) === 429) {
      const resetEpochMs = parseAbsoluteReset(bodyText);
      if (resetEpochMs !== undefined && !retry.watchdog) {
        // Wall clock on purpose, exactly like parseRetryAfter: the server sent an
        // absolute timestamp, which is a point on the wall clock by definition.
        // Subtracting a monotonic reading from it would be meaningless.
        const remainingWaitMs =
          retry.totalBudgetMs > 0
            ? Math.max(0, retry.totalBudgetMs - (clock.monotonicNowMs() - startMs))
            : (maxAttempts - attempt) * retry.maxDelayMs;
        if (resetEpochMs - Date.now() > remainingWaitMs) {
          logger?.warn('reset time beyond retry budget; not retrying', {
            status: response.status,
          });
          return new Response(bodyText, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
      }
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
      backoffMs(attempt, retry, response.headers.get('retry-after'), bodyText),
      startMs,
      retry.totalBudgetMs,
    );
    logger?.warn('retry http status', {
      attempt: attempt + 1,
      status: response.status,
      delayMs: delay,
    });
    onRetry?.(attempt + 1, effectiveMax === Number.MAX_SAFE_INTEGER ? -1 : effectiveMax, delay);
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

/**
 * The message `errorBodyParts` reads, so the text shown and the text classified are the
 * same. A body with no message of its own (a nested `error.error.message`) or that is not
 * JSON shows its first characters instead.
 */
function safeErrorDetail(body: string): string {
  const { message, parsed } = errorBodyParts(body);
  if (parsed && message) return message.slice(0, 2000);
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

function backoffMs(
  attempt: number,
  retry: RetryConfig,
  retryAfter?: string | null,
  body?: string,
): number {
  const retryAfterMs = parseRetryAfter(retryAfter) ?? parseCooldownReset(body);
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

/**
 * How many milliseconds each unit word in a stated cooldown is worth. Keyed by
 * every spelling the matcher accepts.
 */
const COOLDOWN_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
};

// Longest unit spellings first, and no unit may be followed by another letter:
// the boundary is what keeps `500ms` from being read as 500 minutes — the `m`
// would otherwise swallow the `ms` — while still reading compound forms such as
// `1m26s`, where a digit follows the unit.
const COOLDOWN_UNIT = /(\d+)\s*(ms|sec(?:ond)?s?|min(?:ute)?s?|h(?:ours?|rs?)?|s|m)(?![a-z])/gi;

/**
 * The cooldown a router states in its error body (`(reset after 5s)`), read when
 * there is no Retry-After header to wait by (#383). Forms seen in the wild:
 * `5s`, `42s`, `1m26s`, `1 min 26 s`, and millisecond durations such as `500ms`
 * and `1s 200ms`. Units are ms, s/sec/seconds, m/min/minutes and h/hours, so `m`
 * is never read when it belongs to `ms`. Returns milliseconds, or undefined
 * when the body states no duration.
 */
function parseCooldownReset(body?: string | null): number | undefined {
  if (!body) return undefined;
  const stated = body.match(/\(reset after\s*([^)]+)\)/i);
  if (!stated) return undefined;
  let totalMs = 0;
  let statedUnits = 0;
  for (const unit of stated[1].matchAll(COOLDOWN_UNIT)) {
    totalMs += Number(unit[1]) * COOLDOWN_UNIT_MS[unit[2].toLowerCase()];
    statedUnits++;
  }
  return statedUnits > 0 && totalMs > 0 ? totalMs : undefined;
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
