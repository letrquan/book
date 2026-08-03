/** Book Agent SDK — programmatic API for embedding Book as a library. */

import { homedir } from 'os';
import { join } from 'path';
import type { UserQuestionHandler } from './types/tools.js';
import type { AgentConfig } from './types/runtime.js';
import type { SessionStoreInterface } from './types/sessions.js';
import {
  freezeAgentConfig,
  loadConfig,
  runConfigMigrations,
  type LoadConfigOptions,
} from './config.js';
import { runHeadless } from './headless.js';
import { createDefaultRegistry } from './tools/registry.js';
import { connectMcpServers, disconnectMcpServers } from './mcp.js';
import { AgentManager } from './agents/manager.js';
import { SessionStore } from './session/store.js';
import { resolveSessionBootstrap } from './session/resolve.js';
import type { AgentEvent } from './session/agent-events.js';
import {
  cleanupDebugLogs,
  DEFAULT_LOCAL_DATA_RETENTION_DAYS,
  getDebugLogPath,
} from './debug-log.js';
import { resolvePermissionMode } from './permission-mode.js';

export type QueryEvent = AgentEvent;

export interface QueryOptions {
  workspace?: string;
  model?: string;
  permissionMode?: string;
  maxTurns?: number;
  settingsPath?: string;
  noSettings?: boolean;
  persistSession?: boolean;
  sessionId?: string;
  sessionStore?: SessionStoreInterface;
  signal?: AbortSignal;
  onUserQuestionRequired?: UserQuestionHandler;
  agents?: 'adaptive' | 'manual' | 'off';
  /** Forward high-volume managed-agent text deltas. Defaults to false. */
  forwardSubagentText?: boolean;
}

class AsyncEventQueue<T> {
  private values: T[] = [];
  private waiters: Array<(value: T | undefined) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(value);
    else this.values.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(undefined);
  }

  next(): Promise<T | undefined> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve(value);
    if (this.closed) return Promise.resolve(undefined);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export async function* query(
  prompt: string,
  options: QueryOptions = {},
): AsyncGenerator<QueryEvent, void, undefined> {
  const workspace = options.workspace || process.cwd();
  if (!options.noSettings) runConfigMigrations(workspace);
  const loadedConfig = loadConfig(workspace, {
    settingsOverridePath: options.settingsPath,
    noSettings: options.noSettings,
  });
  const config = freezeAgentConfig({
    ...loadedConfig,
    ...(options.model ? { model: options.model } : {}),
    ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
    ...(options.agents
      ? {
          settings: {
            ...loadedConfig.settings,
            agents: { ...loadedConfig.settings.agents, mode: options.agents },
          },
        }
      : {}),
  });

  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true });

  const persistSession = options.persistSession !== false;
  const sessionStore = persistSession
    ? (options.sessionStore ?? new SessionStore(join(homedir(), '.book', 'sessions')))
    : undefined;
  const bootstrap = resolveSessionBootstrap(sessionStore, {
    cwd: config.workspace,
    sessionId: options.sessionId,
  });
  if (persistSession && !options.sessionStore && sessionStore) {
    cleanupDebugLogs(DEFAULT_LOCAL_DATA_RETENTION_DAYS, getDebugLogPath());
    sessionStore.cleanup(DEFAULT_LOCAL_DATA_RETENTION_DAYS, new Set([bootstrap.sessionId]));
  }
  const queue = new AsyncEventQueue<QueryEvent>();
  let connections: Awaited<ReturnType<typeof connectMcpServers>>['connections'] = [];

  queue.push({ type: 'system', model: config.model, cwd: config.workspace });
  queue.push({ type: 'session', sessionId: bootstrap.sessionId });

  const running = (async () => {
    try {
      const mcp = await connectMcpServers(config.workspace, { signal: controller.signal });
      connections = mcp.connections;
      const registry = createDefaultRegistry({ agents: config.settings.agents.mode !== 'off' });
      if (mcp.tools.length > 0) registry.registerAll(mcp.tools);

      const result = await runHeadless(config, registry, {
        prompt,
        inputFormat: 'text',
        outputFormat: 'text',
        history: bootstrap.history,
        transcript: bootstrap.transcript,
        compactBoundaries: bootstrap.compactBoundaries,
        mode: resolvePermissionMode(config.settings, options.permissionMode),
        maxTurns: options.maxTurns,
        persistSession,
        sessionStore,
        sessionId: bootstrap.sessionId,
        sessionCreated: bootstrap.created,
        runSource: 'sdk',
        signal: controller.signal,
        onUserQuestionRequired: options.onUserQuestionRequired,
        forwardSubagentText: options.forwardSubagentText,
        stdout: { write: () => true },
        onAgentEvent: (event) => {
          if (
            event.type !== 'system' &&
            event.type !== 'session' &&
            event.type !== 'result' &&
            event.type !== 'done' &&
            (event.type !== 'agent_text_delta' || options.forwardSubagentText === true)
          ) {
            queue.push(event);
          }
        },
      });
      queue.push({
        type: 'result',
        messages: result.messages,
        usage: result.usage,
        sessionId: bootstrap.sessionId,
        outcome: result.outcome,
        runs: result.runs,
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        queue.push({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      disconnectMcpServers(connections);
      queue.push({ type: 'done' });
      queue.close();
    }
  })();

  try {
    while (true) {
      const event = await queue.next();
      if (!event) break;
      yield event;
    }
  } finally {
    controller.abort(new Error('SDK event consumer stopped'));
    options.signal?.removeEventListener('abort', abortFromCaller);
    await running;
  }
}

export { loadConfig, type LoadConfigOptions };
export type { ToolDiscoverySettings } from './settings.js';
export { AgentManager };
export { createDefaultRegistry, createRegistry } from './tools/registry.js';
export { createToolSurface } from './tools/catalog.js';
export { toolFailure, toolSuccess } from './tools/result.js';
export {
  applySkillOverrides,
  buildSkillListing,
  discoverSkills,
  explicitSkillMentions,
  generateSkillListing,
  loadSkillBody,
  skillRoots,
} from './skills.js';
export type {
  DiscoverSkillsOptions,
  LoadedSkillBody,
  ShadowedSkill,
  Skill,
  SkillIssue,
  SkillListingResult,
  SkillResource,
  SkillRoot,
  SkillRootKind,
  SkillSource,
} from './skills.js';
export {
  SkillRegistry,
  SkillRegistryError,
  type SkillActivationFrame,
  type SkillActivationFrameSummary,
  type SkillActivationReason,
  type SkillLifecycleEvent,
  type SkillLifecycleEventType,
  type SkillRegistrySnapshot,
} from './skill-registry.js';
export {
  DEFAULT_SKILL_EVALUATION_THRESHOLDS,
  DEFAULT_SKILL_EVALUATION_FIXTURES,
  SKILL_EVALUATION_CATEGORIES,
  evaluateSkillActivation,
  observeSkillEvaluation,
  renderSkillEvaluationReport,
  runSkillActivationEvaluation,
  writeSkillEvaluationReport,
} from './skill-evaluation.js';
export type {
  SkillEvaluationCategory,
  SkillEvaluationFixture,
  SkillEvaluationObservation,
  SkillEvaluationOutcome,
  SkillEvaluationPromptFixture,
  SkillEvaluationReport,
  SkillEvaluationThresholds,
} from './skill-evaluation.js';
export { SessionRuntime } from './session/runtime.js';
export { buildSkillReport } from './skill-report.js';
export function createAgentManager(config: AgentConfig): AgentManager {
  return new AgentManager(config, createDefaultRegistry({ agents: true }).getDefinitions());
}
export { runPairedEvaluation, evaluateSuccess } from './agents/evaluation.js';
export { createAgentSessionSnapshot, reduceAgentSessionSnapshot } from './session/agent-events.js';
export type {
  AgentEvent,
  AgentSessionSnapshot,
  AgentSessionStatus,
} from './session/agent-events.js';
export type {
  EvaluationFixture,
  EvaluationMetric,
  EvaluationRunResult,
} from './agents/evaluation.js';
export type {
  AgentPlanRecord,
  AgentApplyResult,
  AgentRecord,
  AgentSummary,
  AgentCompletion,
  AgentCompletionNotification,
  AgentProfile,
  AgentActivity,
  AgentRuntimeEvent,
  AgentRunMetrics,
  AgentSnapshot,
  AgentSpawnRequest,
  EvidenceItem,
} from './agents/types.js';
export type {
  AgentTerminalOutcome,
  AgentTerminalReason,
  AgentTerminalStatus,
} from './types/terminal.js';
export type {
  AgentModelIdentity,
  AgentModelIdentityStatus,
  AgentRunAccounting,
  AgentRunContext,
  AgentRunResult,
  AgentRunSource,
} from './types/runs.js';
export type {
  JsonSchemaObject,
  ToolCatalogMetadata,
  ToolCategory,
  ToolDefinition,
  ToolDiscoveryContext,
  ToolEffect,
  ToolPolicy,
  ToolResult,
  ToolResultArtifacts,
  ToolResultError,
  ToolResultPresentation,
  ToolResultStatus,
  ToolSearchMatch,
  UserQuestion,
  UserQuestionOption,
  UserQuestionRequest,
  UserQuestionResponse,
  UserQuestionSource,
  UserQuestionHandler,
} from './types/tools.js';
