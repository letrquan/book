import type { AgentConfig } from '../types/runtime.js';
import type {
  ProviderMessage,
  ProviderStreamEvent,
  ProviderStreamOptions,
} from '../types/providers.js';
import type { ToolDefinition } from '../types/tools.js';
import { supportsMidConversationToolChanges } from '../models.js';
import { chatCompletionStream as openaiStream } from './openai-compatible.js';
import { chatCompletionStream as anthropicStream, isAnthropicUrl } from './anthropic.js';
import { responsesStream } from './openai-responses.js';
import { chatGptStream } from './chatgpt.js';

export type { ProviderStreamOptions };

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
 * loaded one offered by a `tool_addition` message. Only the first-party Anthropic API
 * (`api.anthropic.com`, exactly) on a model that takes mid-conversation tool changes. A `claude-*`
 * model reached through a router or proxy, or an Azure Foundry endpoint (no mid-conversation tool
 * changes there, per the claude-api skill's `shared/platform-availability.md`), keeps the
 * append-only array every other provider gets. `toolDiscovery.stableTools: "off"` is the kill
 * switch.
 */
export function keepsToolsStable(config: AgentConfig): boolean {
  return (
    config.settings.toolDiscovery.stableTools !== 'off' &&
    config.providerAuth !== 'chatgpt' &&
    isAnthropicProvider(config) &&
    isFirstPartyAnthropicApi(config.baseUrl) &&
    supportsMidConversationToolChanges(config.model)
  );
}

/** The base URL's host is the Anthropic API's own, exactly: not one that merely contains the name. */
function isFirstPartyAnthropicApi(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
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
