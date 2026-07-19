import type { AgentConfig, Message, NestedToolObserver, UserQuestionHandler } from './types.js';
import { runAgentLoop } from './agent/loop.js';
import { applyModelDefaults, resolveModelProviderConfig } from './config.js';
import { createRegistry } from './tools/registry.js';
import type { SubagentDef } from './subagent-discovery.js';

export { discoverAgents, type SubagentDef } from './subagent-discovery.js';

/**
 * Run a subagent with isolated context and restricted tools.
 *
 * The subagent starts with an empty history, sees only its own system prompt
 * (the agent body), and can only use tools in its allowedTools list. When
 * allowedTools is empty, all tools are available.
 *
 * @returns The final assistant message content, or an error string.
 */
export async function runSubagent(
  def: SubagentDef,
  prompt: string,
  config: AgentConfig,
  fullRegistry = createRegistry(),
  options?: {
    signal?: AbortSignal;
    parentToolTraceId?: string;
    nestedToolObserver?: NestedToolObserver;
    onUserQuestionRequired?: UserQuestionHandler;
    agentPath?: string[];
  },
): Promise<{ content: string; error?: string }> {
  // Build the subagent's restricted registry if tools are specified.
  let registry = fullRegistry;
  if (def.allowedTools.length > 0) {
    const allowed = new Set(def.allowedTools.map((t) => t.split('(')[0].trim()));
    registry = createRegistry();
    for (const tool of fullRegistry.getDefinitions()) {
      if (allowed.has(tool.name) || tool.name === 'AskUserQuestion') {
        registry.register(tool);
      }
    }
  }

  // Build a subagent-specific config with overrides.
  const baseConfig: AgentConfig = {
    ...config,
    maxTurns: def.maxTurns,
    autoCompactEnabled: false, // subagents are short-lived, no compaction needed
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
      `${def.body}\n\n## Task\n${prompt}`,
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
