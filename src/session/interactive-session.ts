import { createDefaultRegistry } from '../tools/registry.js';
import { AgentSession, type AgentSessionDependencies } from './agent-session.js';
import { runSessionStart } from './lifecycle.js';
import type { ToolDefinition } from '../types/tools.js';
import type { SessionMessagingHandle } from '../types/messaging.js';
import { liveSessionStateOf, type LiveSessionReporter } from '../messaging/writer.js';
import { createSessionListTool } from '../tools/session-list.js';
import { createSessionSendTool } from '../tools/session-send.js';

export interface InteractiveAgentSessionDependencies extends AgentSessionDependencies {
  /**
   * Extra tool definitions merged into each per-send registry. Evaluated on
   * every send so late-arriving surfaces (e.g. MCP servers that finish
   * connecting in the background) join the next turn without a restart.
   */
  additionalTools?: () => ToolDefinition[];
  /**
   * This process's live-session record (#620), kept in step with the session: its status follows
   * the running turn and the pending prompts, and its session id follows `/clear` and `/resume`.
   * Only the TUI's host passes one; a session without it registers nothing.
   */
  liveSession?: LiveSessionReporter;
  /**
   * This process's messaging runtime (#620), when messaging is on. Its tools, `SessionList` and
   * `SessionSend`, join every send's registry, and only this session's: print mode, the SDK and
   * managed agents build registries without it.
   */
  messaging?: SessionMessagingHandle;
}

/** Compose the interactive tool surface outside React host code. */
export function createInteractiveAgentSession(
  dependencies: InteractiveAgentSessionDependencies = {},
): AgentSession {
  const { additionalTools, liveSession, messaging, ...sessionDependencies } = dependencies;
  const messagingTools = messaging
    ? [createSessionListTool(messaging), createSessionSendTool(messaging)]
    : [];
  const startRunner = sessionDependencies.sessionStartRunner ?? runSessionStart;
  const session = new AgentSession({
    ...sessionDependencies,
    // Every session the TUI enters starts here — the launch's, and each `/clear`, `/new` and
    // `/resume` — so this is where the record learns the session it now describes.
    sessionStartRunner: liveSession
      ? (config, sessionId, source, options) => {
          liveSession.setSessionId(sessionId);
          return startRunner(config, sessionId, source, options);
        }
      : sessionDependencies.sessionStartRunner,
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
        if (messagingTools.length > 0) registry.registerAll(messagingTools);
        const extra = additionalTools?.() ?? [];
        if (extra.length > 0) registry.registerAll(extra);
        return registry;
      }),
  });
  if (liveSession) reportLiveSessionState(session, liveSession);
  return session;
}

/**
 * Follow the session's state into its record. The snapshot changes on every streamed event, so
 * the reporter is told the derived state each time and writes only when that changes.
 *
 * Busy is a running turn or any operation holding the session: a send from the moment it is
 * accepted (its prepare phase — auto-compaction, mention expansion, the checkpoint — emits no
 * event), a `/compact`, a `/rewind`. Each operation's start and end is reported as it happens, so
 * the record cannot stay busy after the lease is released.
 */
function reportLiveSessionState(session: AgentSession, liveSession: LiveSessionReporter): void {
  const report = () => {
    const snapshot = session.getSnapshot();
    const pending = session.interactions.getSnapshot();
    liveSession.setState(
      liveSessionStateOf({
        running: snapshot.status === 'running' || session.operations.activeKind !== null,
        permissionPending:
          pending.pendingPermission !== null || pending.pendingPlanApproval !== null,
        inputPending:
          snapshot.status === 'waiting_for_user' ||
          pending.pendingUserQuestions.length > 0 ||
          pending.pendingElicitations.length > 0,
      }),
    );
  };
  session.subscribe(report);
  session.interactions.subscribe(report);
  session.operations.subscribe(report);
}
