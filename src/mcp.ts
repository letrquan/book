import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn, ChildProcess } from 'child_process';
import type { ToolDefinition, ToolContext } from './types.js';
import { toolFailure, toolSuccess } from './tools/result.js';

/**
 * MCP server configuration as found in .mcp.json.
 */
export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * A connected MCP server with its discovered tools.
 */
interface McpConnection {
  name: string;
  process: ChildProcess;
  tools: McpToolDef[];
  nextId: number;
  pending: Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
  buffer: string;
}

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Load MCP server configurations from the conventional locations.
 * Priority: project .mcp.json overrides user ~/.book/mcp.json on name collision.
 */
export function loadMcpConfig(workspace: string): Record<string, McpServerConfig> {
  const sources = [join(homedir(), '.book', 'mcp.json'), join(workspace, '.mcp.json')];

  const servers: Record<string, McpServerConfig> = {};

  for (const path of sources) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as McpConfig;
      if (parsed.mcpServers) {
        Object.assign(servers, parsed.mcpServers);
      }
    } catch {
      console.warn(`⚠  Failed to load MCP config: ${path}`);
    }
  }

  return servers;
}

/**
 * Send a JSON-RPC request to an MCP server and wait for the response.
 */
function sendRequest(
  conn: McpConnection,
  method: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const id = conn.nextId++;
  const request = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method,
    params,
  });

  return new Promise((resolve, reject) => {
    conn.pending.set(id, { resolve, reject });
    conn.process.stdin?.write(request + '\n');
  });
}

/**
 * Process a line of JSON-RPC output from an MCP server.
 */
function processLine(conn: McpConnection, line: string): void {
  try {
    const msg = JSON.parse(line);
    if (msg.id !== undefined && conn.pending.has(msg.id)) {
      const { resolve, reject } = conn.pending.get(msg.id)!;
      conn.pending.delete(msg.id);
      if (msg.error) {
        reject(new Error(msg.error.message || 'MCP error'));
      } else {
        resolve(msg.result);
      }
    }
    // Notifications (no id) are silently consumed.
  } catch {
    // non-JSON line — ignore
  }
}

/**
 * Connect to an MCP server over stdio and negotiate the protocol.
 * Returns the connection with discovered tools, or null on failure.
 */
async function connectMcpServer(name: string, cfg: McpServerConfig): Promise<McpConnection | null> {
  const child = spawn(cfg.command, cfg.args ?? [], {
    env: { ...process.env, ...cfg.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const conn: McpConnection = {
    name,
    process: child,
    tools: [],
    nextId: 1,
    pending: new Map(),
    buffer: '',
  };

  // Accumulate stdout lines.
  child.stdout?.on('data', (data: Buffer) => {
    conn.buffer += data.toString();
    const lines = conn.buffer.split('\n');
    conn.buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) processLine(conn, line.trim());
    }
  });

  child.stderr?.on('data', (data: Buffer) => {
    // MCP servers may log to stderr; suppress in normal operation.
  });

  child.on('error', () => {
    // Process died — reject all pending.
    for (const [, { reject }] of conn.pending) {
      reject(new Error(`MCP server ${name} process error`));
    }
    conn.pending.clear();
  });

  // Negotiate protocol: initialize.
  try {
    await sendRequest(conn, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'book', version: '0.1.0' },
    });

    // Send initialized notification.
    conn.process.stdin?.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    );

    // Discover tools.
    const result = (await sendRequest(conn, 'tools/list')) as {
      tools: McpToolDef[];
    };

    conn.tools = result.tools ?? [];
    return conn;
  } catch (e) {
    console.warn(
      `⚠  Failed to connect to MCP server "${name}": ${e instanceof Error ? e.message : String(e)}`,
    );
    child.kill();
    return null;
  }
}

/**
 * Connect to all configured MCP servers and return their tool definitions
 * prefixed with `mcp__<server>__<tool>`.
 */
export async function connectMcpServers(
  workspace: string,
): Promise<{ connections: McpConnection[]; tools: ToolDefinition[] }> {
  const configs = loadMcpConfig(workspace);
  const connections: McpConnection[] = [];
  const tools: ToolDefinition[] = [];

  for (const [name, cfg] of Object.entries(configs)) {
    const conn = await connectMcpServer(name, cfg);
    if (!conn) continue;
    connections.push(conn);

    for (const tool of conn.tools) {
      const prefixedName = `mcp__${name}__${tool.name}`;
      tools.push({
        name: prefixedName,
        description: `[MCP:${name}] ${tool.description || tool.name}`,
        parameters: tool.inputSchema || { type: 'object', properties: {} },
        execute: async (args: Record<string, unknown>, _ctx: ToolContext) => {
          try {
            const result = await sendRequest(conn, 'tools/call', {
              name: tool.name,
              arguments: args,
            });
            return toolSuccess(JSON.stringify(result, null, 2), { data: result });
          } catch (e) {
            return toolFailure(
              `MCP tool ${prefixedName} failed: ${e instanceof Error ? e.message : String(e)}`,
              { code: 'mcp_tool_failed' },
            );
          }
        },
      });
    }
  }

  return { connections, tools };
}

/**
 * Disconnect all MCP connections.
 */
export function disconnectMcpServers(connections: McpConnection[]): void {
  for (const conn of connections) {
    conn.process.kill();
  }
}
