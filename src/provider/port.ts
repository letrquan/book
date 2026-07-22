import type { AgentConfig } from '../types/runtime.js';
import type { ProviderMessage, ProviderStreamEvent } from '../types/providers.js';
import type { ToolDefinition } from '../types/tools.js';
import { chatCompletionStream as openaiStream } from './openai-compatible.js';
import { chatCompletionStream as anthropicStream, isAnthropicUrl } from './anthropic.js';

export interface ProviderStreamOptions {
  signal?: AbortSignal;
  onRetry?: (attempt: number, max: number, delayMs: number) => void;
  onStreamStall?: (countdownMs: number) => void;
  onStreamResume?: () => void;
  maxOutputTokens?: number;
}

export interface Provider {
  readonly id: string;
  stream(
    config: AgentConfig,
    messages: ProviderMessage[],
    tools: ToolDefinition[],
    options?: ProviderStreamOptions,
  ): AsyncGenerator<ProviderStreamEvent>;
}

export function isAnthropicProvider(config: AgentConfig): boolean {
  if (config.provider === 'anthropic') return true;
  if (config.provider === 'openai') return false;
  if (isAnthropicUrl(config.baseUrl)) return true;
  return Boolean(config.model && /^claude-/i.test(config.model));
}

export function createProvider(config: AgentConfig): Provider {
  if (isAnthropicProvider(config)) {
    return {
      id: 'anthropic',
      stream: (currentConfig, messages, tools, options) =>
        anthropicStream(currentConfig, messages, tools, options),
    };
  }
  return {
    id: 'openai-compatible',
    stream: (currentConfig, messages, tools, options) =>
      openaiStream(currentConfig, messages, tools, options),
  };
}
