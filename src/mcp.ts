import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn, type ChildProcess } from 'child_process';
import type { ToolDefinition, ToolContext } from './types.js';
import { toolFailure, toolSuccess } from './tools/result.js';
import { getPackageVersion } from './version-info.js';

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpConnection {
  name: string;
  process: ChildProcess;
  tools: McpToolDef[];
  nextId: number;
  pending: Map<number, PendingRequest>;
  buffer: string;
  stderr: string;
  closed: boolean;
}

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface PendingRequest {
  timer: NodeJS.Timeout;
  settled: boolean;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface McpConnectionOptions {
  home?: string;
  signal?: AbortSignal;
  initializationTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxStderrBytes?: number;
}

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STDERR_BYTES = 8_192;

export function loadMcpConfig(
  workspace: string,
  home = homedir(),
): Record<string, McpServerConfig> {
  const sources = [join(home, '.book', 'mcp.json'), join(workspace, '.mcp.json')];
  const servers: Record<string, McpServerConfig> = {};

  for (const path of sources) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as McpConfig;
      if (!parsed || typeof parsed !== 'object' || !parsed.mcpServers) continue;
      for (const [name, config] of Object.entries(parsed.mcpServers)) {
        if (!config || typeof config.command !== 'string' || config.command.trim() === '') {
          console.warn(`⚠  Ignoring invalid MCP server config: ${name} (${path})`);
          continue;
        }
        servers[name] = {
          command: config.command,
          args: Array.isArray(config.args) ? config.args.map(String) : [],
          env: config.env && typeof config.env === 'object' ? config.env : {},
        };
      }
    } catch {
      console.warn(`⚠  Failed to load MCP config: ${path}`);
    }
  }

  return servers;
}

function errorWithContext(conn: McpConnection, message: string): Error {
  const suffix = conn.stderr.trim() ? ` (stderr: ${conn.stderr.trim()})` : '';
  return new Error(`${message}${suffix}`);
}

function settlePending(conn: McpConnection, id: number, error?: Error, value?: unknown): void {
  const pending = conn.pending.get(id);
  if (!pending || pending.settled) return;
  pending.settled = true;
  clearTimeout(pending.timer);
  conn.pending.delete(id);
  if (error) pending.reject(error);
  else pending.resolve(value);
}

function rejectAllPending(conn: McpConnection, error: Error): void {
  for (const id of [...conn.pending.keys()]) settlePending(conn, id, error);
}

function sendNotification(conn: McpConnection, method: string): void {
  if (conn.closed || !conn.process.stdin || conn.process.stdin.destroyed) return;
  conn.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');
}

function sendRequest(
  conn: McpConnection,
  method: string,
  params: Record<string, unknown> | undefined,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (conn.closed)
    return Promise.reject(errorWithContext(conn, `MCP server ${conn.name} is closed`));
  if (signal?.aborted) return Promise.reject(new Error('MCP request aborted'));

  const id = conn.nextId++;
  const request = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => settlePending(conn, id, errorWithContext(conn, `MCP request timed out: ${method}`)),
      timeoutMs,
    );
    conn.pending.set(id, { timer, settled: false, resolve, reject });

    const abort = () => settlePending(conn, id, new Error(`MCP request aborted: ${method}`));
    signal?.addEventListener('abort', abort, { once: true });
    const cleanupAbort = () => signal?.removeEventListener('abort', abort);
    const originalResolve = resolve;
    const originalReject = reject;
    conn.pending.set(id, {
      timer,
      settled: false,
      resolve: (value) => {
        cleanupAbort();
        originalResolve(value);
      },
      reject: (error) => {
        cleanupAbort();
        originalReject(error);
      },
    });

    try {
      if (!conn.process.stdin || conn.process.stdin.destroyed) {
        settlePending(conn, id, errorWithContext(conn, `MCP server ${conn.name} stdin is closed`));
      } else if (!conn.process.stdin.write(request)) {
        conn.process.stdin.once('error', (error) => settlePending(conn, id, error));
      }
    } catch (error) {
      settlePending(conn, id, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function processLine(conn: McpConnection, line: string): void {
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg !== 'object' || !('id' in msg)) return;
  const id = (msg as { id?: unknown }).id;
  if (typeof id !== 'number' || !conn.pending.has(id)) return;
  const response = msg as { error?: { message?: string }; result?: unknown };
  if (response.error) settlePending(conn, id, new Error(response.error.message || 'MCP error'));
  else settlePending(conn, id, undefined, response.result);
}

async function connectMcpServer(
  name: string,
  cfg: McpServerConfig,
  options: Required<Pick<McpConnectionOptions, 'initializationTimeoutMs' | 'requestTimeoutMs'>> &
    Omit<McpConnectionOptions, 'initializationTimeoutMs' | 'requestTimeoutMs'>,
): Promise<McpConnection | null> {
  let child: ChildProcess;
  try {
    child = spawn(cfg.command, cfg.args ?? [], {
      env: { ...process.env, ...cfg.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    console.warn(
      `⚠  Failed to start MCP server "${name}": ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }

  const conn: McpConnection = {
    name,
    process: child,
    tools: [],
    nextId: 1,
    pending: new Map(),
    buffer: '',
    stderr: '',
    closed: false,
  };
  const maxStderrBytes = options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;

  child.stdout?.on('data', (data: Buffer) => {
    conn.buffer += data.toString();
    const lines = conn.buffer.split('\n');
    conn.buffer = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) processLine(conn, line.trim());
  });
  child.stderr?.on('data', (data: Buffer) => {
    conn.stderr = (conn.stderr + data.toString()).slice(-maxStderrBytes);
  });
  const close = (reason: string) => {
    if (conn.closed) return;
    conn.closed = true;
    rejectAllPending(conn, errorWithContext(conn, reason));
  };
  child.once('error', () => close(`MCP server ${name} process error`));
  child.stdin?.once('error', (error) => close(`MCP server ${name} stdin error: ${error.message}`));
  child.once('exit', (code, signal) =>
    close(`MCP server ${name} exited (${code ?? signal ?? 'unknown'})`),
  );
  child.once('close', () => close(`MCP server ${name} closed`));

  try {
    await sendRequest(
      conn,
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'book', version: getPackageVersion() },
      },
      options.initializationTimeoutMs,
      options.signal,
    );
    sendNotification(conn, 'notifications/initialized');
    const result = (await sendRequest(
      conn,
      'tools/list',
      undefined,
      options.requestTimeoutMs,
      options.signal,
    )) as {
      tools?: McpToolDef[];
    };
    conn.tools = Array.isArray(result?.tools) ? result.tools : [];
    return conn;
  } catch (error) {
    console.warn(
      `⚠  Failed to connect to MCP server "${name}": ${error instanceof Error ? error.message : String(error)}`,
    );
    close(`MCP server ${name} disconnected`);
    child.kill();
    return null;
  }
}

export async function connectMcpServers(
  workspace: string,
  options: McpConnectionOptions = {},
): Promise<{ connections: McpConnection[]; tools: ToolDefinition[] }> {
  const configs = loadMcpConfig(workspace, options.home);
  const resolved = {
    ...options,
    initializationTimeoutMs: options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  };
  const results = await Promise.allSettled(
    Object.entries(configs).map(([name, cfg]) => connectMcpServer(name, cfg, resolved)),
  );
  const connections: McpConnection[] = [];
  const tools: ToolDefinition[] = [];

  for (const result of results) {
    if (result.status !== 'fulfilled' || !result.value) continue;
    const conn = result.value;
    connections.push(conn);
    for (const tool of conn.tools) {
      const prefixedName = `mcp__${conn.name}__${tool.name}`;
      tools.push({
        name: prefixedName,
        description: `[MCP:${conn.name}] ${tool.description || tool.name}`,
        parameters: tool.inputSchema || { type: 'object', properties: {} },
        execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
          try {
            const result = await sendRequest(
              conn,
              'tools/call',
              { name: tool.name, arguments: args },
              resolved.requestTimeoutMs,
              ctx.signal,
            );
            return toolSuccess(JSON.stringify(result, null, 2), { data: result });
          } catch (error) {
            return toolFailure(
              `MCP tool ${prefixedName} failed: ${error instanceof Error ? error.message : String(error)}`,
              { code: 'mcp_tool_failed' },
            );
          }
        },
      });
    }
  }

  return { connections, tools };
}

export function disconnectMcpServers(connections: McpConnection[]): void {
  for (const conn of connections) {
    if (conn.closed) continue;
    conn.closed = true;
    rejectAllPending(conn, errorWithContext(conn, `MCP server ${conn.name} disconnected`));
    conn.process.stdin?.end();
    conn.process.kill();
  }
}
