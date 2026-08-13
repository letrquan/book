import { createDefaultRegistry } from '../tools/registry.js';
import { AgentSession, type AgentSessionDependencies } from './agent-session.js';
import type { ToolDefinition } from '../types/tools.js';

export interface InteractiveAgentSessionDependencies extends AgentSessionDependencies {
  /**
   * Extra tool definitions merged into each per-send registry. Evaluated on
   * every send so late-arriving surfaces (e.g. MCP servers that finish
   * connecting in the background) join the next turn without a restart.
   */
  additionalTools?: () => ToolDefinition[];
}

/** Compose the interactive tool surface outside React host code. */
export function createInteractiveAgentSession(
  dependencies: InteractiveAgentSessionDependencies = {},
): AgentSession {
  const { additionalTools, ...sessionDependencies } = dependencies;
  return new AgentSession({
    ...sessionDependencies,
    registryFactory:
      dependencies.registryFactory ??
      ((request) => {
        const registry = createDefaultRegistry({
          agents: request.config.settings.agents.mode !== 'off',
          ...(request.registryStore
            ? {
                sessionHistory: {
                  store: request.registryStore,
                  sessionId: () => request.sessionId,
                },
              }
            : {}),
        });
        const extra = additionalTools?.() ?? [];
        if (extra.length > 0) registry.registerAll(extra);
        return registry;
      }),
  });
}
