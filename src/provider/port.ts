import type { AgentConfig } from '../types/runtime.js';
import type {
  ProviderMessage,
  ProviderStreamEvent,
  StableToolsRequest,
} from '../types/providers.js';
import type { ToolDefinition } from '../types/tools.js';
import { supportsMidConversationToolChanges } from '../models.js';
import { chatCompletionStream as openaiStream } from './openai-compatible.js';
import { chatCompletionStream as anthropicStream, isAnthropicUrl } from './anthropic.js';
import { responsesStream } from './openai-responses.js';
import { chatGptStream } from './chatgpt.js';

export interface ProviderStreamOptions {
  signal?: AbortSignal;
  onRetry?: (attempt: number, max: number, delayMs: number) => void;
  onStreamStall?: (countdownMs: number) => void;
  onStreamResume?: () => void;
  maxOutputTokens?: number;
  /** Set only where `keepsToolsStable` holds; every other provider ignores it. */
  stableTools?: StableToolsRequest;
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

/**
 * Whether this config's requests keep `tools[]` the same for the whole session (#619): every
 * authorized tool declared from the first request, the deferred ones with `defer_loading`, and a
 * loaded one offered by a `tool_addition` message. Only the first-party Anthropic API on a model
 * that takes mid-conversation tool changes: a `claude-*` model reached through a router, or an
 * Azure Foundry endpoint (which has no mid-conversation tool changes, per the claude-api skill's
 * `shared/platform-availability.md`), keeps the append-only array every other provider gets.
 * `toolDiscovery.stableTools: "off"` is the kill switch.
 */
export function keepsToolsStable(config: AgentConfig): boolean {
  return (
    config.settings.toolDiscovery.stableTools !== 'off' &&
    config.providerAuth !== 'chatgpt' &&
    isAnthropicProvider(config) &&
    isAnthropicUrl(config.baseUrl) &&
    supportsMidConversationToolChanges(config.model)
  );
}

export function createProvider(config: AgentConfig): Provider {
  // First: a chatgpt config is OpenAI-typed, and must never reach a client that sends its key.
  if (config.providerAuth === 'chatgpt') {
    return {
      id: 'chatgpt',
      stream: (currentConfig, messages, tools, options) =>
        chatGptStream(currentConfig, messages, tools, options),
    };
  }
  if (isAnthropicProvider(config)) {
    return {
      id: 'anthropic',
      stream: (currentConfig, messages, tools, options) =>
        anthropicStream(currentConfig, messages, tools, options),
    };
  }
  if (config.providerApi === 'responses') {
    return {
      id: 'openai-responses',
      stream: (currentConfig, messages, tools, options) =>
        responsesStream(currentConfig, messages, tools, options),
    };
  }
  return {
    id: 'openai-compatible',
    stream: (currentConfig, messages, tools, options) =>
      openaiStream(currentConfig, messages, tools, options),
  };
}
