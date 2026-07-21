/** Book Agent SDK — programmatic API for embedding Book as a library. */

import { homedir } from 'os';
import { join } from 'path';
import type {
  Message,
  Usage,
  ToolCall,
  ToolResult,
  UserQuestionHandler,
  UserQuestionRequest,
  UserQuestionResponse,
  AgentConfig,
  SessionStoreInterface,
} from './types.js';
import type { HeadlessOptions, HeadlessResult } from './types.js';
import { loadConfig, type LoadConfigOptions } from './config.js';
import { runHeadless } from './headless.js';
import { createDefaultRegistry } from './tools/registry.js';
import { connectMcpServers, disconnectMcpServers } from './mcp.js';
import type { AgentRecord, AgentRuntimeEvent, EvidenceItem } from './agents/types.js';
import { AgentManager, getOrCreateAgentManager } from './agents/manager.js';
import type { StreamJsonEvent } from './stream-json.js';
import { SessionStore } from './session/store.js';
import { resolveSessionBootstrap } from './session/resolve.js';

export type QueryEvent =
  | { type: 'system'; model: string; cwd: string }
  | { type: 'session'; sessionId: string }
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolCall: ToolCall }
  | { type: 'tool_result'; toolResult: ToolResult }
  | { type: 'user_question'; request: UserQuestionRequest; status: 'pending' | 'unavailable' }
  | { type: 'user_question_result'; requestId: string; response: UserQuestionResponse }
  | { type: 'agent_start'; agent: AgentRecord }
  | { type: 'agent_update'; agent: AgentRecord }
  | { type: 'agent_result'; agent: AgentRecord }
  | Extract<AgentRuntimeEvent, { type: 'agent_question' | 'agent_apply' }>
  | { type: 'evidence_update'; evidence: EvidenceItem }
  | { type: 'error'; error: string }
  | { type: 'result'; messages: Message[]; usage: Usage | null; sessionId: string }
  | { type: 'done' };

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

function mapRuntimeEvent(event: StreamJsonEvent, sessionId: string): QueryEvent | undefined {
  switch (event.type) {
    case 'assistant':
      return event.text ? { type: 'text', content: event.text } : undefined;
    case 'tool_use':
      return event.tool_call
        ? { type: 'tool_use', toolCall: event.tool_call as ToolCall }
        : undefined;
    case 'tool_result':
      return event.tool_result
        ? { type: 'tool_result', toolResult: event.tool_result as ToolResult }
        : undefined;
    case 'user_question':
      return event.request && event.status
        ? {
            type: 'user_question',
            request: event.request as UserQuestionRequest,
            status: event.status,
          }
        : undefined;
    case 'user_question_result':
      return event.request_id && event.response
        ? {
            type: 'user_question_result',
            requestId: event.request_id,
            response: event.response as UserQuestionResponse,
          }
        : undefined;
    case 'agent_start':
    case 'agent_update':
    case 'agent_result':
      return event.agent ? { type: event.type, agent: event.agent as AgentRecord } : undefined;
    case 'agent_question':
    case 'agent_apply':
      return event as Extract<AgentRuntimeEvent, { type: 'agent_question' | 'agent_apply' }>;
    case 'evidence_update':
      return event.evidence
        ? { type: 'evidence_update', evidence: event.evidence as EvidenceItem }
        : undefined;
    case 'error':
      return event.error ? { type: 'error', error: event.error } : undefined;
    case 'result': {
      const result = event.result as HeadlessResult;
      return {
        type: 'result',
        messages: result.messages,
        usage: result.usage,
        sessionId,
      };
    }
    default:
      return undefined;
  }
}

export async function* query(
  prompt: string,
  options: QueryOptions = {},
): AsyncGenerator<QueryEvent, void, undefined> {
  const workspace = options.workspace || process.cwd();
  const config = loadConfig(workspace, {
    settingsOverridePath: options.settingsPath,
    noSettings: options.noSettings,
  });
  if (options.model) config.model = options.model;
  if (options.maxTurns) config.maxTurns = options.maxTurns;
  if (options.agents) config.settings.agents.mode = options.agents;

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

      await runHeadless(config, registry, {
        prompt,
        inputFormat: 'text',
        outputFormat: 'stream-json',
        history: bootstrap.history,
        transcript: bootstrap.transcript,
        compactBoundaries: bootstrap.compactBoundaries,
        mode: (options.permissionMode as HeadlessOptions['mode']) || 'default',
        maxTurns: options.maxTurns,
        persistSession,
        sessionStore,
        sessionId: bootstrap.sessionId,
        sessionCreated: bootstrap.created,
        signal: controller.signal,
        onUserQuestionRequired: options.onUserQuestionRequired,
        stdout: { write: () => true },
        onEvent: (event) => {
          if (event.type === 'system' || event.type === 'session') return;
          const mapped = mapRuntimeEvent(event, bootstrap.sessionId);
          if (mapped) queue.push(mapped);
        },
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
export function createAgentManager(config: AgentConfig): AgentManager {
  return getOrCreateAgentManager(config, createDefaultRegistry({ agents: true }).getDefinitions());
}
export { runPairedEvaluation, evaluateSuccess } from './agents/evaluation.js';
export type {
  EvaluationFixture,
  EvaluationMetric,
  EvaluationRunResult,
} from './agents/evaluation.js';
export type {
  AgentPlanRecord,
  AgentApplyResult,
  AgentRecord,
  AgentRuntimeEvent,
  AgentSnapshot,
  AgentSpawnRequest,
  EvidenceItem,
} from './agents/types.js';
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
} from './types.js';
