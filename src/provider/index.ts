/**
 * Provider dispatch layer.
 *
 * Resolution order:
 * 1. Explicit `--provider` flag / `BOOK_PROVIDER` env var (anthropic | openai)
 * 2. baseUrl contains 'anthropic.com' → Anthropic
 * 3. model name starts with 'claude-' → Anthropic (catches OpenRouter/LiteLLM proxies)
 * 4. Default → OpenAI-compatible
 */

import type { AgentConfig } from '../types/runtime.js';
import type { ProviderMessage, ProviderStreamEvent } from '../types/providers.js';
import type { ToolDefinition } from '../types/tools.js';
import { createProvider } from './port.js';
export { createProvider, isAnthropicProvider } from './port.js';
export type { Provider, ProviderStreamOptions } from './port.js';

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
  yield* createProvider(config).stream(config, messages, tools, options);
}
