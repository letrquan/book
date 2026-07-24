import type { AgentConfig } from './types/runtime.js';
import type { Message } from './types/messages.js';
import type { NestedToolObserver, UserQuestionHandler } from './types/tools.js';
import { runAgentLoop } from './agent/loop.js';
import { applyModelDefaults, resolveModelProviderConfig } from './config.js';
import { createDefaultRegistry } from './tools/registry.js';
import type { SubagentDef } from './subagent-discovery.js';
import { createCapabilityRegistry } from './agents/capabilities.js';
import { runCompact, usagePressureTokens } from './agent/compact.js';

export { discoverAgents, type SubagentDef } from './subagent-discovery.js';

/**
 * Run a subagent with isolated context and restricted tools.
 *
 * The subagent starts with an empty history, sees only its own system prompt
 * (the agent body), and can only use tools in its allowedTools list. When
 * Missing or empty allowedTools denies all tools; `*` explicitly inherits all
 * non-lifecycle parent tools.
 *
 * @returns The final assistant message content, or an error string.
 */
export async function runSubagent(
  def: SubagentDef,
  prompt: string,
  config: AgentConfig,
  fullRegistry = createDefaultRegistry(),
  options?: {
    signal?: AbortSignal;
    parentToolTraceId?: string;
    nestedToolObserver?: NestedToolObserver;
    onUserQuestionRequired?: UserQuestionHandler;
    agentPath?: string[];
  },
): Promise<{ content: string; error?: string }> {
  const registry = createCapabilityRegistry(fullRegistry, def.allowedTools);

  // Build a subagent-specific config with overrides.
  const baseConfig: AgentConfig = {
    ...config,
    maxTurns: def.maxTurns,
    autoCompactEnabled: true,
  };
  const subConfig = applyModelDefaults(
    def.model ? resolveModelProviderConfig(baseConfig, def.model) : baseConfig,
  );

  // The agent body becomes the system prompt; the Task prompt is the first user message.
  const history: Message[] = [];

  let result = '';
  let error: string | undefined;

  try {
    const updatedHistory = await runAgentLoop(
      subConfig,
      registry,
      prompt,
      history,
      {
        onText: (text) => {
          result += text;
        },
        onToolCall: () => {},
        onToolResult: () => {},
        onError: (err) => {
          error = err;
        },
        onTurnStart: () => {},
        onDone: () => {},
        onPermissionRequired: async () => 'deny',
        onUsage: () => {},
        onCompact: (compactHistory, usage) =>
          runCompact(subConfig, compactHistory, {
            trigger: 'auto',
            preContextTokens: usage ? usagePressureTokens(usage) : undefined,
            signal: options?.signal,
          }),
        onUserQuestionRequired: options?.onUserQuestionRequired,
      },
      'bypassPermissions', // subagents run with bypass to avoid interactive prompts
      {
        signal: options?.signal,
        isNewSession: true,
        isSubagent: true,
        nestedToolObserver: options?.nestedToolObserver,
        parentToolTraceId: options?.parentToolTraceId,
        agentPath: options?.agentPath,
        systemPromptAppend: def.body,
        hideAgents: true,
      },
    );

    // Extract the last assistant message content from the history.
    for (let i = updatedHistory.length - 1; i >= 0; i--) {
      const m = updatedHistory[i];
      if (m.role === 'assistant' && m.content) {
        result = m.content;
        break;
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  // Max turns reached is not a fatal error if the subagent produced output.
  if (error && result && error.includes('max turns')) {
    error = undefined;
  }

  return { content: result, error };
}
