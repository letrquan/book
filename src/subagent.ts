import type { AgentConfig } from './types/runtime.js';
import type { Message, Usage } from './types/messages.js';
import type { FileObservation, NestedToolObserver, UserQuestionHandler } from './types/tools.js';
import type { HarnessObserver } from './harness/contracts.js';
import { wrapAgentLoopCallbacks } from './harness/coordinator.js';
import { runAgentLoop } from './agent/loop.js';
import { SessionRuntime } from './session/runtime.js';
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
    /** Parent file observations, copied so same-workspace edits need no re-Read. */
    fileObservationSeed?: ReadonlyMap<string, FileObservation>;
    /** Observe-mode evidence: child events join the parent's root stream. */
    harness?: {
      observer: HarnessObserver;
      runId: string;
      rootRunId?: string;
      parentRunId?: string;
    };
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

  const runtime = new SessionRuntime({
    fileObservationLedger: new Map(options?.fileObservationSeed ?? []),
  });
  let result = '';
  let error: string | undefined;

  const harness = options?.harness;
  if (harness) {
    try {
      const attributes: Record<string, import('./harness/contracts.js').HarnessEventAttribute> = {
        agentName: def.name.slice(0, 128) as never,
        child: true,
      };
      if (harness.rootRunId) attributes.rootRunId = harness.rootRunId.slice(0, 128) as never;
      if (harness.parentRunId) attributes.parentRunId = harness.parentRunId.slice(0, 128) as never;
      harness.observer.enqueue({
        type: 'subagent_handoff_created',
        occurredAt: Date.now(),
        runId: harness.runId,
        parentRunId: harness.parentRunId,
        attributes,
      });
    } catch {
      // Evidence is best-effort here; the child task result must not change.
    }
  }
  const baseCallbacks = {
    onText: (text: string) => {
      result += text;
    },
    onToolCall: () => {},
    onToolResult: () => {},
    onError: (err: string) => {
      error = err;
    },
    onTurnStart: () => {},
    onDone: () => {},
    onPermissionRequired: async () => 'deny' as const,
    onUsage: () => {},
    onCompact: (compactHistory: Message[], usage: Usage | null) =>
      runCompact(subConfig, compactHistory, {
        trigger: 'auto',
        preContextTokens: usage ? usagePressureTokens(usage) : undefined,
        signal: options?.signal,
      }),
    onUserQuestionRequired: options?.onUserQuestionRequired,
  };

  try {
    const updatedHistory = await runAgentLoop(
      subConfig,
      registry,
      prompt,
      history,
      harness
        ? wrapAgentLoopCallbacks(baseCallbacks, {
            observer: harness.observer,
            runId: harness.runId,
          })
        : baseCallbacks,
      'bypassPermissions', // subagents run with bypass to avoid interactive prompts
      {
        signal: options?.signal,
        isNewSession: true,
        isSubagent: true,
        runtime,
        nestedToolObserver: options?.nestedToolObserver,
        parentToolTraceId: options?.parentToolTraceId,
        agentPath: options?.agentPath,
        systemPromptAppend: def.body,
        hideAgents: true,
        harnessObserver: harness ? { observer: harness.observer, runId: harness.runId } : undefined,
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
  } finally {
    runtime.dispose();
  }

  // Max turns reached is not a fatal error if the subagent produced output.
  if (error && result && error.includes('max turns')) {
    error = undefined;
  }

  return { content: result, error };
}
