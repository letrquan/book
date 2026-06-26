import type { AgentConfig, ProviderStreamEvent, ToolDefinition } from '../types.js';

export async function* chatCompletionStream(
  config: AgentConfig,
  messages: { role: string; content: string | null; tool_calls?: unknown[] }[],
  tools: ToolDefinition[],
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

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 429) {
      yield { type: 'error', error: 'Rate limited. Retrying...' };
      return;
    }
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
          yield { type: 'done' };
          return;
        }

        try {
          const parsed = JSON.parse(data);
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
  yield { type: 'done' };
}
