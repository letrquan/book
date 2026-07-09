/**
 * Provider dispatch layer.
 *
 * Resolution order:
 * 1. Explicit `--provider` flag / `BOOK_PROVIDER` env var (anthropic | openai)
 * 2. baseUrl contains 'anthropic.com' → Anthropic
 * 3. model name starts with 'claude-' → Anthropic (catches OpenRouter/LiteLLM proxies)
 * 4. Default → OpenAI-compatible
 */

import type { AgentConfig, ProviderMessage, ProviderStreamEvent, ToolDefinition } from '../types.js';
import { chatCompletionStream as openaiStream } from './openai-compatible.js';
import { chatCompletionStream as anthropicStream, isAnthropicUrl } from './anthropic.js';

/** Detect whether to use the Anthropic provider based on config. */
function isAnthropicProvider(config: AgentConfig): boolean {
  // 1. Explicit override
  if (config.provider === 'anthropic') return true;
  if (config.provider === 'openai') return false;

  // 2. URL-based detection (api.anthropic.com, anthropic.com, etc.)
  if (isAnthropicUrl(config.baseUrl)) return true;

  // 3. Model-name-based detection (catches proxies like OpenRouter, LiteLLM)
  if (config.model && /^claude-/i.test(config.model)) return true;

  // 4. Default: OpenAI-compatible
  return false;
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
  },
): AsyncGenerator<ProviderStreamEvent> {
  if (isAnthropicProvider(config)) {
    yield* anthropicStream(config, messages, tools, options);
  } else {
    yield* openaiStream(config, messages, tools, options);
  }
}
