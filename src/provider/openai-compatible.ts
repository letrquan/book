import type { AgentConfig, ProviderStreamEvent, ToolDefinition, Usage } from '../types.js';

const MAX_RETRIES = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function backoffMs(attempt: number, retryAfter?: string | null): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (!Number.isNaN(secs)) return Math.min(secs * 1000, 8000);
  }
  return Math.min(1000 * 2 ** attempt, 8000);
}

/** Fetch with exponential backoff retry on 429/5xx and transient network errors. */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  let lastError: string | null = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(url, { ...init, signal });
    } catch (e) {
      // Network error — retry with backoff.
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt === MAX_RETRIES) break;
      await sleep(backoffMs(attempt));
      continue;
    }
    if (resp.status === 429 || resp.status >= 500) {
      lastError = `API error ${resp.status}`;
      if (attempt === MAX_RETRIES) return resp;
      await sleep(backoffMs(attempt, resp.headers.get('retry-after')));
      continue;
    }
    return resp;
  }
  throw new Error(lastError ?? 'request failed after retries');
}

export async function* chatCompletionStream(
  config: AgentConfig,
  messages: { role: string; content: string | null; tool_calls?: unknown[] }[],
  tools: ToolDefinition[],
  options?: { signal?: AbortSignal },
): AsyncGenerator<ProviderStreamEvent> {
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
      options?.signal,
    );
  } catch (e) {
    yield { type: 'error', error: e instanceof Error ? e.message : String(e) };
    return;
  }

  if (!response.ok) {
    const errorText = await response.text();
    yield { type: 'error', error: `API error ${response.status}: ${errorText}` };
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) {
    yield { type: 'error', error: 'No response body' };
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let currentToolCall: { id: string; name: string; arguments: string } | null = null;
  let currentUsage: Usage | null = null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        const data = trimmed.slice(6);
        if (data === '[DONE]') {
          if (currentToolCall) {
            yield {
              type: 'tool_call',
              toolCall: {
                id: currentToolCall.id,
                name: currentToolCall.name,
                arguments: JSON.parse(currentToolCall.arguments || '{}'),
              },
            };
          }
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
              if (tc.id) {
                if (currentToolCall) {
                  yield {
                    type: 'tool_call',
                    toolCall: {
                      id: currentToolCall.id,
                      name: currentToolCall.name,
                      arguments: JSON.parse(currentToolCall.arguments || '{}'),
                    },
                  };
                }
                currentToolCall = {
                  id: tc.id,
                  name: tc.function?.name || '',
                  arguments: tc.function?.arguments || '',
                };
              } else if (currentToolCall && tc.function?.arguments) {
                currentToolCall.arguments += tc.function.arguments;
              }
            }
          }
        } catch {
          // Skip unparseable lines
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (currentToolCall) {
    yield {
      type: 'tool_call',
      toolCall: {
        id: currentToolCall.id,
        name: currentToolCall.name,
        arguments: JSON.parse(currentToolCall.arguments || '{}'),
      },
    };
  }
  yield { type: 'done', usage: currentUsage ?? undefined };
}
