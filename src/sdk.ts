/**
 * Book Agent SDK — programmatic API for embedding book as a library.
 *
 * Usage:
 *   import { query } from 'book';
 *   const stream = query({ prompt: "Fix lint errors", options: { workspace: "./my-project" } });
 *   for await (const event of stream) {
 *     console.log(event.type, event);
 *   }
 */

import type {
  Message,
  Usage,
  ToolCall,
  ToolResult,
  UserQuestionHandler,
  UserQuestionRequest,
  UserQuestionResponse,
  AgentConfig,
} from './types.js';
import type { HeadlessOptions, HeadlessResult } from './types.js';
import { loadConfig, type LoadConfigOptions } from './config.js';
import { runHeadless } from './headless.js';
import { createDefaultRegistry } from './tools/registry.js';
import { connectMcpServers, disconnectMcpServers } from './mcp.js';
import type { AgentRecord, AgentRuntimeEvent, EvidenceItem } from './agents/types.js';
import { AgentManager, getOrCreateAgentManager } from './agents/manager.js';

/** Events emitted by the query() async iterable. */
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
  | { type: 'result'; messages: Message[]; usage: Usage | null; sessionId?: string }
  | { type: 'done' };

/** Options for query(). Mirrors CLI flags + HeadlessOptions. */
export interface QueryOptions {
  /** Workspace root directory. Default: process.cwd(). */
  workspace?: string;
  /** Model to use (overrides config). */
  model?: string;
  /** Permission mode. Default: 'default'. */
  permissionMode?: string;
  /** Max agent turns. */
  maxTurns?: number;
  /** Settings file override path (--settings). */
  settingsPath?: string;
  /** Skip all settings layers. */
  noSettings?: boolean;
  /** Whether to persist the session to disk. Default: true. */
  persistSession?: boolean;
  /** Session ID to resume or assign. */
  sessionId?: string;
  /** Handle structured questions from the root agent or Task subagents. */
  onUserQuestionRequired?: UserQuestionHandler;
  /** Override the configured managed-agent mode. */
  agents?: 'adaptive' | 'manual' | 'off';
}

/**
 * Run a prompt against the book agent and return an async iterable of events.
 *
 * This is the primary SDK entry point. It handles config loading, MCP
 * connection, and headless execution, emitting typed events as they occur.
 *
 * @example
 * for await (const event of query({ prompt: "Explain this code" })) {
 *   if (event.type === 'text') process.stdout.write(event.content);
 *   if (event.type === 'result') console.log('Done. Usage:', event.usage);
 * }
 */
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

  // Connect MCP servers.
  const mcp = await connectMcpServers(config.workspace);
  const registry = createDefaultRegistry({ agents: config.settings.agents.mode !== 'off' });
  if (mcp.tools.length > 0) registry.registerAll(mcp.tools);

  let usage: Usage | null = null;
  const sessionId = options.sessionId;

  try {
    // Emit system event.
    yield { type: 'system', model: config.model, cwd: config.workspace };
    if (sessionId) yield { type: 'session', sessionId };

    // Use a passthrough stdout to capture events.
    const events: QueryEvent[] = [];

    await runHeadless(config, registry, {
      prompt,
      inputFormat: 'text',
      outputFormat: 'stream-json',
      history: [],
      mode: (options.permissionMode as HeadlessOptions['mode']) || 'default',
      maxTurns: options.maxTurns,
      persistSession: options.persistSession,
      sessionId: options.sessionId,
      onUserQuestionRequired: options.onUserQuestionRequired,
      stdout: {
        write: (s: string) => {
          try {
            const parsed = JSON.parse(s.trim());
            if (parsed.type === 'assistant' && parsed.text) {
              events.push({ type: 'text', content: parsed.text as string });
            } else if (parsed.type === 'tool_use') {
              events.push({ type: 'tool_use', toolCall: parsed.tool_call as ToolCall });
            } else if (parsed.type === 'tool_result') {
              events.push({ type: 'tool_result', toolResult: parsed.tool_result as ToolResult });
            } else if (parsed.type === 'user_question') {
              events.push({
                type: 'user_question',
                request: parsed.request as UserQuestionRequest,
                status: parsed.status as 'pending' | 'unavailable',
              });
            } else if (parsed.type === 'user_question_result') {
              events.push({
                type: 'user_question_result',
                requestId: parsed.request_id as string,
                response: parsed.response as UserQuestionResponse,
              });
            } else if (
              parsed.type === 'agent_start' ||
              parsed.type === 'agent_update' ||
              parsed.type === 'agent_result'
            ) {
              events.push({ type: parsed.type, agent: parsed.agent as AgentRecord });
            } else if (parsed.type === 'agent_question') {
              events.push(parsed as Extract<AgentRuntimeEvent, { type: 'agent_question' }>);
            } else if (parsed.type === 'evidence_update') {
              events.push({ type: 'evidence_update', evidence: parsed.evidence as EvidenceItem });
            } else if (parsed.type === 'agent_apply') {
              events.push(parsed as Extract<AgentRuntimeEvent, { type: 'agent_apply' }>);
            } else if (parsed.type === 'error') {
              events.push({ type: 'error', error: parsed.error as string });
            } else if (parsed.type === 'result') {
              usage = (parsed.result as HeadlessResult).usage;
              events.push({
                type: 'result',
                messages: (parsed.result as HeadlessResult).messages,
                usage,
                sessionId,
              });
            }
          } catch {
            // Non-JSON line — ignore.
          }
          return true;
        },
      },
    });

    // Yield buffered events.
    for (const event of events) {
      yield event;
    }
  } catch (e) {
    yield { type: 'error', error: e instanceof Error ? e.message : String(e) };
  } finally {
    disconnectMcpServers(mcp.connections);
    yield { type: 'done' };
  }
}

/**
 * Create a session for programmatic use. Returns session metadata.
 * The session can be resumed later via query({ sessionId }).
 */
export { loadConfig, type LoadConfigOptions };
export { AgentManager };
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
  UserQuestion,
  UserQuestionOption,
  UserQuestionRequest,
  UserQuestionResponse,
  UserQuestionSource,
  UserQuestionHandler,
} from './types.js';
