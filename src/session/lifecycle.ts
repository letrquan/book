import type { AgentConfig } from '../types/runtime.js';
import type { AgentTerminalOutcome } from '../types/terminal.js';
import { runHooks } from '../hooks.js';
import type { SessionStartSource } from './resolve.js';

export interface SessionLifecycleOptions {
  onHookEvent?: (event: string, payload: Record<string, unknown>) => void;
  signal?: AbortSignal;
  /**
   * SessionEnd only: how the run that ended the session finished. A print or SDK run
   * passes its terminal outcome, so a hook can tell a stall (`timed_out`) from success,
   * which the `reason` alone cannot (both are `completion`).
   */
  endOutcome?: Pick<AgentTerminalOutcome, 'status' | 'reason'>;
}

export async function runSessionStart(
  config: AgentConfig,
  sessionId: string,
  source: SessionStartSource,
  options?: SessionLifecycleOptions,
): Promise<void> {
  await runHooks(
    config.settings.hooks.SessionStart,
    'SessionStart',
    { workspace: config.workspace, event: 'SessionStart', sessionId, source },
    options,
  );
}

export async function runSessionEnd(
  config: AgentConfig,
  sessionId: string,
  reason: 'clear' | 'resume' | 'exit' | 'completion' | 'aborted' | 'error',
  options?: SessionLifecycleOptions,
): Promise<void> {
  await runHooks(
    config.settings.hooks.SessionEnd,
    'SessionEnd',
    {
      workspace: config.workspace,
      event: 'SessionEnd',
      sessionId,
      reason,
      status: options?.endOutcome?.status,
      stopReason: options?.endOutcome?.reason,
    },
    options,
  );
}
