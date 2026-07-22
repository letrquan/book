import { createDefaultRegistry } from '../tools/registry.js';
import { AgentSession, type AgentSessionDependencies } from './agent-session.js';

/** Compose the interactive tool surface outside React host code. */
export function createInteractiveAgentSession(
  dependencies: AgentSessionDependencies = {},
): AgentSession {
  return new AgentSession({
    ...dependencies,
    registryFactory:
      dependencies.registryFactory ??
      ((request) =>
        createDefaultRegistry({
          agents: request.config.settings.agents.mode !== 'off',
          ...(request.registryStore
            ? {
                sessionHistory: {
                  store: request.registryStore,
                  sessionId: () => request.sessionId,
                },
              }
            : {}),
        })),
  });
}
