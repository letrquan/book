import type { AgentConfig } from '../types.js';
import { runHooks } from '../hooks.js';
import type { SessionStartSource } from './resolve.js';

export interface SessionLifecycleOptions {
  onHookEvent?: (event: string, payload: Record<string, unknown>) => void;
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
  reason: 'clear' | 'resume' | 'exit' | 'completion',
  options?: SessionLifecycleOptions,
): Promise<void> {
  await runHooks(
    config.settings.hooks.SessionEnd,
    'SessionEnd',
    { workspace: config.workspace, event: 'SessionEnd', sessionId, reason },
    options,
  );
}
