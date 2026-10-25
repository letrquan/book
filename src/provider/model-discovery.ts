import type { RetryConfig } from '../types/runtime.js';

export type ProviderProtocol = 'openai' | 'anthropic';

export interface DiscoveredModel {
  id: string;
  label?: string;
  /**
   * The model's input limit as the endpoint reported it, from Anthropic's `max_input_tokens`.
   * Present only for a valid figure from an Anthropic endpoint: an OpenAI-compatible router's
   * figure is not authoritative. It is stored apart from the user's `contextWindow`.
   */
  reportedContextWindow?: number;
}

import { systemClock, type Clock } from '../clock.js';
import { isRedirectResponse, refuseRedirect, type ProviderRedirectError } from './reliability.js';

export interface ModelDiscoveryOptions {
  type: ProviderProtocol;
  baseUrl: string;
  apiKey: string;
  retry: RetryConfig;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onRetry?: (attempt: number, max: number, delayMs: number) => void;
  /** Injected by tests; the retry budget below is a duration, not a stamp. */
  clock?: Clock;
}

export const DEFAULT_PROVIDER_BASE_URLS: Record<ProviderProtocol, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

const RETRYABLE_STATUSES = new Set([408, 429, 529]);
const MAX_ANTHROPIC_PAGES = 100;

export class ModelDiscoveryError extends Error {
  constructor(
    message: string,
    readonly code: 'aborted' | 'auth' | 'unsupported' | 'invalid_response' | 'network' | 'request',
  ) {
    super(message);
    this.name = 'ModelDiscoveryError';
  }
}

export function normalizeProviderBaseUrl(_type: ProviderProtocol, raw: string): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ModelDiscoveryError('Enter a valid HTTP(S) base URL.', 'request');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ModelDiscoveryError('Base URL must use HTTP or HTTPS.', 'request');
  }
  if (url.username || url.password) {
    throw new ModelDiscoveryError('Base URL cannot contain embedded credentials.', 'request');
  }
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString().replace(/\/$/, '');
}

function discoveryUrl(type: ProviderProtocol, baseUrl: string, afterId?: string): string {
  const base = normalizeProviderBaseUrl(type, baseUrl);
  if (type === 'openai') return `${base}/models`;
  const url = new URL(`${base}${/\/v1$/i.test(new URL(base).pathname) ? '' : '/v1'}/models`);
  url.searchParams.set('limit', '100');
  if (afterId) url.searchParams.set('after_id', afterId);
  return url.toString();
}

function safeStatusError(status: number): ModelDiscoveryError {
  if (status === 401 || status === 403) {
    return new ModelDiscoveryError(
      'Model discovery was not authorized. Check the API key and endpoint permissions.',
      'auth',
    );
  }
  if (status === 404 || status === 405 || status === 501) {
    return new ModelDiscoveryError(
      'This endpoint does not expose a supported model-list API.',
      'unsupported',
    );
  }
  return new ModelDiscoveryError(`Model discovery request failed with HTTP ${status}.`, 'request');
}

/** One line for the wizard's and picker's error slot: discovery sends no prompt. */
function redirectMessage({ status, target }: ProviderRedirectError): string {
  const http = status === 0 ? '' : ` (HTTP ${status})`;
  const what =
    target === undefined
      ? `answered${status === 0 ? '' : ` HTTP ${status}`} with no redirect target Book could read`
      : `redirected to ${target}${http}`;
  return `The model-list endpoint ${what}; Book does not follow provider redirects. Check the provider's base URL.`;
}

function retryDelay(attempt: number, retry: RetryConfig, retryAfter: string | null): number {
  const retryAfterSeconds = retryAfter === null ? NaN : Number(retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, retry.maxDelayMs);
  }
  return Math.min(retry.baseDelayMs * 2 ** attempt, retry.maxDelayMs);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new ModelDiscoveryError('Model discovery was cancelled.', 'aborted'));
  }
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new ModelDiscoveryError('Model discovery was cancelled.', 'aborted'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: ModelDiscoveryOptions,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clock = options.clock ?? systemClock;
  const startedAt = clock.monotonicNowMs();
  let lastNetworkError: unknown;

  for (let attempt = 0; attempt <= options.retry.maxAttempts; attempt++) {
    if (options.signal?.aborted) {
      throw new ModelDiscoveryError('Model discovery was cancelled.', 'aborted');
    }

    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', abortFromCaller, { once: true });
    const timeout = setTimeout(
      () => controller.abort(new Error('request timeout')),
      options.retry.requestTimeoutMs,
    );

    let response: Response | undefined;
    try {
      // `redirect` comes after the spread so no caller can turn following back on (#445).
      response = await fetchImpl(url, { ...init, redirect: 'manual', signal: controller.signal });
    } catch (error) {
      if (options.signal?.aborted) {
        throw new ModelDiscoveryError('Model discovery was cancelled.', 'aborted');
      }
      lastNetworkError = error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abortFromCaller);
    }

    // Never retried: the key must not follow a redirect, and a second ask gets the same answer.
    if (response && isRedirectResponse(response)) {
      const refused = await refuseRedirect(response, url);
      throw new ModelDiscoveryError(redirectMessage(refused), 'request');
    }

    if (response && !(RETRYABLE_STATUSES.has(response.status) || response.status >= 500)) {
      return response;
    }

    if (attempt >= options.retry.maxAttempts) {
      if (response) return response;
      throw new ModelDiscoveryError('Could not reach the model-list endpoint.', 'network');
    }
    if (
      options.retry.totalBudgetMs > 0 &&
      clock.monotonicNowMs() - startedAt >= options.retry.totalBudgetMs
    ) {
      if (response) return response;
      throw new ModelDiscoveryError('Could not reach the model-list endpoint.', 'network');
    }

    const delay = retryDelay(attempt, options.retry, response?.headers.get('retry-after') ?? null);
    options.onRetry?.(attempt + 1, options.retry.maxAttempts, delay);
    await wait(delay, options.signal);
  }

  throw new ModelDiscoveryError(
    lastNetworkError ? 'Could not reach the model-list endpoint.' : 'Model discovery failed.',
    'network',
  );
}

function parseModels(payload: unknown, type: ProviderProtocol): DiscoveredModel[] {
  if (!payload || typeof payload !== 'object') {
    throw new ModelDiscoveryError(
      'The model-list endpoint returned invalid JSON.',
      'invalid_response',
    );
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new ModelDiscoveryError(
      'The model-list endpoint returned an unsupported response shape.',
      'invalid_response',
    );
  }

  const models: DiscoveredModel[] = [];
  for (const item of data) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || /[\x00-\x1f\x7f]/.test(id)) continue;
    const rawLabel =
      type === 'anthropic'
        ? record.display_name
        : (record.name ?? record.display_name ?? record.label);
    const label = typeof rawLabel === 'string' && rawLabel.trim() ? rawLabel.trim() : undefined;
    const model: DiscoveredModel = { id, label };
    const limit = record.max_input_tokens;
    if (
      type === 'anthropic' &&
      typeof limit === 'number' &&
      Number.isSafeInteger(limit) &&
      limit > 0
    ) {
      model.reportedContextWindow = limit;
    }
    models.push(model);
  }
  return models;
}

/**
 * The model list Sign in with ChatGPT documents for a plan: a `models` array whose entries name a
 * `slug` and a `display_name`, of which only `visibility: "list"` are offered, in the server's
 * order (https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference).
 */
export function parseChatGptModels(payload: unknown): DiscoveredModel[] {
  const list =
    payload && typeof payload === 'object' ? (payload as { models?: unknown }).models : undefined;
  if (!Array.isArray(list)) {
    throw new ModelDiscoveryError(
      'The ChatGPT model list is not the documented `models` array.',
      'invalid_response',
    );
  }
  const models: DiscoveredModel[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.visibility !== 'list') continue;
    const id = typeof record.slug === 'string' ? record.slug.trim() : '';
    if (!id || /[\x00-\x1f\x7f/]/.test(id) || models.some((model) => model.id === id)) continue;
    const label =
      typeof record.display_name === 'string' && record.display_name.trim()
        ? record.display_name.trim()
        : undefined;
    models.push({ id, ...(label ? { label } : {}) });
  }
  return models;
}

/** The signed-in plan's models, asked once with the access token. */
export async function discoverChatGptModels(options: {
  apiBase: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<DiscoveredModel[]> {
  const response = await (options.fetchImpl ?? fetch)(`${options.apiBase}/models`, {
    headers: { Authorization: `Bearer ${options.accessToken}` },
    redirect: 'error',
    signal: options.signal,
  });
  if (!response.ok) throw safeStatusError(response.status);
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ModelDiscoveryError('The ChatGPT model list is not JSON.', 'invalid_response');
  }
  return parseChatGptModels(payload);
}

export async function discoverModels(options: ModelDiscoveryOptions): Promise<DiscoveredModel[]> {
  const headers: Record<string, string> =
    options.type === 'anthropic'
      ? {
          'x-api-key': options.apiKey,
          'anthropic-version': '2023-06-01',
        }
      : { Authorization: `Bearer ${options.apiKey}` };

  const discovered: DiscoveredModel[] = [];
  let afterId: string | undefined;
  let finished = false;

  for (let page = 0; page < MAX_ANTHROPIC_PAGES; page++) {
    const response = await fetchWithRetry(
      discoveryUrl(options.type, options.baseUrl, afterId),
      { method: 'GET', headers },
      options,
    );
    if (!response.ok) throw safeStatusError(response.status);

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ModelDiscoveryError(
        'The model-list endpoint returned invalid JSON.',
        'invalid_response',
      );
    }
    discovered.push(...parseModels(payload, options.type));

    if (options.type !== 'anthropic') {
      finished = true;
      break;
    }
    const pageInfo = payload as { has_more?: unknown; last_id?: unknown };
    if (pageInfo.has_more !== true) {
      finished = true;
      break;
    }
    const nextId = typeof pageInfo.last_id === 'string' ? pageInfo.last_id : undefined;
    if (!nextId || nextId === afterId) {
      throw new ModelDiscoveryError(
        'The model-list endpoint returned invalid pagination metadata.',
        'invalid_response',
      );
    }
    afterId = nextId;
  }

  if (options.type === 'anthropic' && !finished) {
    throw new ModelDiscoveryError(
      'The model-list endpoint exceeded the pagination limit.',
      'invalid_response',
    );
  }

  const deduped = new Map<string, DiscoveredModel>();
  for (const model of discovered) {
    const existing = deduped.get(model.id);
    if (!existing) {
      deduped.set(model.id, model);
      continue;
    }
    // Field by field, first non-empty value wins: the entries may each know a different part.
    const label = existing.label || model.label;
    const reportedContextWindow = existing.reportedContextWindow ?? model.reportedContextWindow;
    const merged: DiscoveredModel = { id: model.id, label };
    if (reportedContextWindow !== undefined) merged.reportedContextWindow = reportedContextWindow;
    deduped.set(model.id, merged);
  }
  const models = [...deduped.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (models.length === 0) {
    throw new ModelDiscoveryError(
      'The endpoint did not return any usable models.',
      'invalid_response',
    );
  }
  return models;
}
