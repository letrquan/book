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

import type { AgentConfig, Message, Usage, ToolCall, ToolResult } from './types.js';
import type { HeadlessOptions, HeadlessResult } from './types.js';
import { loadConfig, type LoadConfigOptions } from './config.js';
import { runHeadless } from './headless.js';
import { createDefaultRegistry } from './tools/registry.js';
import type { ToolRegistry } from './tools/registry.js';
import { connectMcpServers, disconnectMcpServers } from './mcp.js';

/** Events emitted by the query() async iterable. */
export type QueryEvent =
  | { type: 'system'; model: string; cwd: string }
  | { type: 'session'; sessionId: string }
  | { type: 'text'; content: string }
  | { type: 'tool_use'; toolCall: ToolCall }
  | { type: 'tool_result'; toolResult: ToolResult }
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

  // Connect MCP servers.
  const mcp = await connectMcpServers(config.workspace);
  const registry = createDefaultRegistry();
  if (mcp.tools.length > 0) registry.registerAll(mcp.tools);

  // Buffer to collect partial text for text events.
  let textBuffer = '';
  let usage: Usage | null = null;
  const sessionId = options.sessionId;

  try {
    // Emit system event.
    yield { type: 'system', model: config.model, cwd: config.workspace };
    if (sessionId) yield { type: 'session', sessionId };

    // Use a passthrough stdout to capture events.
    const events: QueryEvent[] = [];

    const result = await runHeadless(config, registry, {
      prompt,
      inputFormat: 'text',
      outputFormat: 'stream-json',
      history: [],
      mode: (options.permissionMode as HeadlessOptions['mode']) || 'default',
      maxTurns: options.maxTurns,
      persistSession: options.persistSession,
      sessionId: options.sessionId,
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
