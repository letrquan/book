/**
 * MCP client host: connects declared servers over stdio, Streamable HTTP, or
 * legacy SSE and exposes their tools as `mcp__<server>__<tool>` definitions.
 *
 * The protocol layer (handshake/version negotiation, request lifecycle,
 * cancellation notifications, result validation) is the official
 * `@modelcontextprotocol/sdk` `Client`. Remote transports come from the SDK.
 * The stdio transport stays in-repo so Book retains child-process observation,
 * bounded stderr capture, deterministic listener cleanup, and
 * SIGTERM→SIGKILL escalation on shutdown.
 */
import spawn from 'cross-spawn';
import type { ChildProcess } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import {
  ErrorCode,
  McpError,
  ToolListChangedNotificationSchema,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolContext } from './types/tools.js';
import { toolFailure, toolSuccess } from './tools/result.js';
import { getPackageVersion } from './version-info.js';
import {
  consoleMcpDiagnosticSink,
  resolveMcpServerList,
  type McpDiagnosticSink,
  type McpServerConfig,
} from './mcp-config.js';

export {
  loadMcpConfig,
  resolveMcpServerList,
  formatMcpServerCommand,
  consoleMcpDiagnosticSink,
} from './mcp-config.js';
export type {
  McpServerConfig,
  McpServerSource,
  ResolvedMcpServer,
  McpDiagnostic,
  McpDiagnosticSink,
} from './mcp-config.js';

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpConnection {
  name: string;
  client: Client;
  /** Present only for locally spawned stdio servers. */
  process?: ChildProcess;
  tools: McpToolDef[];
  /** In-flight requests issued through this host, visible to hosts and tests. */
  pending: Map<number, { method: string }>;
  closed: boolean;
  /** Bounded tail of the server's stderr output. */
  readonly stderr: string;
  /** Negotiated protocol revision reported by the server. */
  protocolVersion?: string;
  serverInfo?: { name: string; version: string };
  capabilities?: Record<string, unknown>;
  /** Gracefully terminate any remote session and close the owned transport. */
  close(): Promise<void>;
}

export interface McpConnectionOptions {
  home?: string;
  signal?: AbortSignal;
  initializationTimeoutMs?: number;
  requestTimeoutMs?: number;
  maxStderrBytes?: number;
  /** Lifecycle observer used by hosts/tests that account for owned child processes. */
  onProcessSpawn?: (name: string, process: ChildProcess) => void;
  /**
   * Explicit servers to connect. When omitted, servers resolve from
   * <BOOK_HOME>/.book/mcp.json and <workspace>/.mcp.json. Hosts that enforce
   * project-server approval pass the approved subset here.
   */
  servers?: Record<string, McpServerConfig>;
  /** Warning sink; defaults to stderr. Ink hosts must supply a non-console sink. */
  onDiagnostic?: McpDiagnosticSink;
  /** Invoked after this host refreshes `connection.tools` for a list_changed notification. */
  onToolListChanged?: (serverName: string) => void;
  /** Invoked when a successfully initialized server later disconnects. */
  onConnectionClosed?: (serverName: string) => void;
}

const DEFAULT_INITIALIZATION_TIMEOUT_MS = 10_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STDERR_BYTES = 8_192;

type ResolvedConnectionOptions = McpConnectionOptions &
  Required<Pick<McpConnectionOptions, 'initializationTimeoutMs' | 'requestTimeoutMs'>> & {
    onDiagnostic: McpDiagnosticSink;
  };

function waitForProcessExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    child.once('exit', onExit);
  });
}

async function terminateProcess(child: ChildProcess): Promise<void> {
  child.stdin?.end();
  if (child.exitCode === null && child.signalCode === null) child.kill();
  if (!(await waitForProcessExit(child, 250))) {
    child.kill('SIGKILL');
    await waitForProcessExit(child, 750);
  }
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
}

/**
 * Newline-delimited JSON-RPC transport over a child process this host spawns
 * and owns. Mirrors the SDK's stdio transport contract while keeping the
 * ChildProcess observable and the shutdown path deterministic.
 */
class StdioProcessTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private child?: ChildProcess;
  private readonly readBuffer = new ReadBuffer();
  private stderrTail = '';
  private closed = false;
  private cleanupListeners: () => void = () => {};
  protocolVersion?: string;

  constructor(
    private readonly name: string,
    private readonly config: McpServerConfig,
    private readonly options: {
      maxStderrBytes: number;
      onSpawn?: (child: ChildProcess) => void;
    },
  ) {}

  get process(): ChildProcess | undefined {
    return this.child;
  }

  get stderr(): string {
    return this.stderrTail;
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
  }

  start(): Promise<void> {
    if (this.child) {
      return Promise.reject(new Error(`MCP server ${this.name} transport already started`));
    }
    if (!this.config.command) {
      return Promise.reject(new Error(`MCP server ${this.name} is not a stdio server`));
    }
    const child = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...this.config.env },
      cwd: this.config.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.options.onSpawn?.(child);

    const onStdoutData = (data: Buffer) => {
      this.readBuffer.append(data);
      while (true) {
        let message: JSONRPCMessage | null;
        try {
          message = this.readBuffer.readMessage();
        } catch (error) {
          // readMessage consumes the offending line before throwing, so the
          // loop always advances past malformed output.
          this.onerror?.(error instanceof Error ? error : new Error(String(error)));
          continue;
        }
        if (!message) break;
        this.onmessage?.(message);
      }
    };
    const onStderrData = (data: Buffer) => {
      this.stderrTail = (this.stderrTail + data.toString()).slice(-this.options.maxStderrBytes);
    };
    const onChildError = (error: Error) => {
      this.onerror?.(error);
      this.teardown();
    };
    // Swallowed here; write failures surface through the send() callback.
    const onStdinError = () => {};
    const onExit = () => this.teardown();
    const onClose = () => this.teardown();

    this.cleanupListeners = () => {
      child.stdout?.removeListener('data', onStdoutData);
      child.stderr?.removeListener('data', onStderrData);
      child.removeListener('error', onChildError);
      child.stdin?.removeListener('error', onStdinError);
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
      this.cleanupListeners = () => {};
    };
    child.stdout?.on('data', onStdoutData);
    child.stderr?.on('data', onStderrData);
    child.once('error', onChildError);
    child.stdin?.on('error', onStdinError);
    child.once('exit', onExit);
    child.once('close', onClose);
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (this.closed || !stdin || stdin.destroyed) {
        reject(new Error(`MCP server ${this.name} stdin is closed`));
        return;
      }
      try {
        stdin.write(serializeMessage(message), (error) => {
          if (error) reject(error);
          else resolve();
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Child died or streams closed underneath us: settle pending work, then reap. */
  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    this.cleanupListeners();
    this.onclose?.();
    if (this.child) void terminateProcess(this.child).catch(() => {});
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.cleanupListeners();
    // Reject pending requests before the (graceful, up to ~1s) process reap.
    this.onclose?.();
    if (this.child) await terminateProcess(this.child).catch(() => {});
  }
}

function isMcpErrorWithCode(error: unknown, code: ErrorCode): boolean {
  return error instanceof McpError && error.code === code;
}

function withStderrContext(message: string, transport: { stderr: string }): string {
  const tail = transport.stderr.trim();
  return tail ? `${message} (stderr: ${tail})` : message;
}

function createSecretRedactor(config: McpServerConfig): (message: string) => string {
  let queryValues: string[] = [];
  try {
    queryValues = config.url ? [...new URL(config.url).searchParams.values()] : [];
  } catch {
    // Explicit configs are validated by the transport path; redaction remains best effort.
  }
  const secrets = [
    ...Object.values(config.env ?? {}),
    ...Object.values(config.headers ?? {}),
    ...queryValues,
  ]
    .filter((value) => value.length > 0)
    .sort((left, right) => right.length - left.length);
  return (message) => {
    let redacted = message;
    for (const secret of secrets) redacted = redacted.replaceAll(secret, '<redacted>');
    return redacted;
  };
}

interface McpContentBlock {
  type?: string;
  text?: string;
  mimeType?: string;
  uri?: string;
  resource?: { uri?: string; text?: string; mimeType?: string };
}

/** Flatten MCP content blocks into the plain-text tool output Book renders. */
export function renderMcpContent(result: Record<string, unknown>): {
  text: string;
  isError: boolean;
} {
  const blocks = Array.isArray(result.content) ? (result.content as McpContentBlock[]) : [];
  const parts: string[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text);
        break;
      case 'image':
      case 'audio':
        parts.push(`[${block.type}${block.mimeType ? `: ${block.mimeType}` : ''}]`);
        break;
      case 'resource_link':
        parts.push(`[resource_link: ${block.uri ?? 'unknown'}]`);
        break;
      case 'resource': {
        const resource = block.resource;
        if (resource && typeof resource.text === 'string') parts.push(resource.text);
        else if (resource?.uri) {
          parts.push(
            `[resource: ${resource.uri}${resource.mimeType ? ` (${resource.mimeType})` : ''}]`,
          );
        }
        break;
      }
      default:
        break;
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  return { text: parts.join('\n'), isError: result.isError === true };
}

async function listAllTools(
  client: Client,
  requestTimeoutMs: number,
  signal?: AbortSignal,
): Promise<McpToolDef[]> {
  const tools: McpToolDef[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined, {
      timeout: requestTimeoutMs,
      signal,
    });
    for (const tool of page.tools) {
      tools.push({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<
          string,
          unknown
        >,
      });
    }
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

interface LiveConnection extends McpConnection {
  requestCounter: number;
  redact: (message: string) => string;
}

type OwnedTransport = Transport & {
  process?: ChildProcess;
  protocolVersion?: string;
  terminateSession?: () => Promise<void>;
};

interface TransportHandle {
  transport: OwnedTransport;
  getStderr: () => string;
  getProtocolVersion: () => string | undefined;
}

function isRemoteConfig(config: McpServerConfig): boolean {
  return config.type === 'http' || config.type === 'sse' || Boolean(config.url && !config.command);
}

function createTransport(
  name: string,
  cfg: McpServerConfig,
  options: ResolvedConnectionOptions,
): TransportHandle {
  if (isRemoteConfig(cfg)) {
    if (!cfg.url) throw new Error(`MCP server ${name} has no URL`);
    const url = new URL(cfg.url);
    const headers = { ...(cfg.headers ?? {}) };
    if (cfg.type === 'sse') {
      let protocolVersion: string | undefined;
      const transport = new SSEClientTransport(url, {
        // The SDK derives the SSE GET headers from requestInit too. Supplying
        // them here therefore covers both the initial stream and later POSTs.
        requestInit: { headers },
      });
      const sdkSetProtocolVersion = transport.setProtocolVersion.bind(transport);
      transport.setProtocolVersion = (version: string) => {
        protocolVersion = version;
        sdkSetProtocolVersion(version);
      };
      return {
        transport,
        getStderr: () => '',
        getProtocolVersion: () => protocolVersion,
      };
    }
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
    });
    return {
      transport,
      getStderr: () => '',
      getProtocolVersion: () => transport.protocolVersion,
    };
  }

  const transport = new StdioProcessTransport(name, cfg, {
    maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
    onSpawn: (child) => options.onProcessSpawn?.(name, child),
  });
  return {
    transport,
    getStderr: () => transport.stderr,
    getProtocolVersion: () => transport.protocolVersion,
  };
}

async function connectMcpServer(
  name: string,
  cfg: McpServerConfig,
  options: ResolvedConnectionOptions,
): Promise<McpConnection | null> {
  let handle: TransportHandle | undefined;
  let liveConnection: LiveConnection | undefined;
  let transportClosed = false;
  const redact = createSecretRedactor(cfg);

  try {
    handle = createTransport(name, cfg, options);
    const { transport, getStderr, getProtocolVersion } = handle;
    // Protocol.connect wraps these callbacks and preserves the callbacks that
    // were installed first. Keep the host's lifecycle state in that preserved
    // callback so a remote disconnect or a child exit removes stale tools from
    // the next provider request.
    transport.onclose = () => {
      transportClosed = true;
      if (!liveConnection || liveConnection.closed) return;
      liveConnection.closed = true;
      options.onConnectionClosed?.(name);
    };
    transport.onerror = (error) => {
      options.onDiagnostic({
        level: 'warn',
        message: redact(`MCP server "${name}" transport error: ${error.message}`),
        server: name,
      });
    };
    const client = new Client({ name: 'book', version: getPackageVersion() }, { capabilities: {} });

    await client.connect(transport, {
      timeout: options.initializationTimeoutMs,
      signal: options.signal,
    });
    const supportsTools = client.getServerCapabilities()?.tools !== undefined;
    const tools = supportsTools
      ? await listAllTools(client, options.requestTimeoutMs, options.signal)
      : [];
    if (transportClosed) throw new Error('connection closed during initialization');

    const conn: LiveConnection = {
      name,
      client,
      process: transport.process,
      tools,
      pending: new Map(),
      closed: false,
      requestCounter: 0,
      redact,
      get stderr() {
        return redact(getStderr());
      },
      protocolVersion: getProtocolVersion(),
      serverInfo: client.getServerVersion(),
      capabilities: client.getServerCapabilities() as Record<string, unknown> | undefined,
      async close() {
        try {
          await transport.terminateSession?.();
        } catch (error) {
          options.onDiagnostic({
            level: 'warn',
            message: redact(
              `Failed to terminate MCP server "${name}" session: ${error instanceof Error ? error.message : String(error)}`,
            ),
            server: name,
          });
        } finally {
          await client.close();
        }
      },
    };
    liveConnection = conn;

    if (supportsTools) {
      let refreshing = false;
      client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
        if (refreshing || conn.closed) return;
        refreshing = true;
        try {
          conn.tools = await listAllTools(client, options.requestTimeoutMs);
          options.onToolListChanged?.(name);
        } catch (error) {
          options.onDiagnostic({
            level: 'warn',
            message: redact(
              `Failed to refresh tools for MCP server "${name}": ${error instanceof Error ? error.message : String(error)}`,
            ),
            server: name,
          });
        } finally {
          refreshing = false;
        }
      });
    }

    return conn;
  } catch (error) {
    const message = redact(error instanceof Error ? error.message : String(error));
    options.onDiagnostic({
      level: 'warn',
      message: withStderrContext(`Failed to connect to MCP server "${name}": ${message}`, {
        stderr: redact(handle?.getStderr() ?? ''),
      }),
      server: name,
    });
    if (handle?.transport.terminateSession) {
      await handle.transport.terminateSession().catch(() => {});
    }
    await handle?.transport.close().catch(() => {});
    return null;
  }
}

function buildToolDefinition(
  conn: McpConnection,
  tool: McpToolDef,
  requestTimeoutMs: number,
): ToolDefinition {
  const prefixedName = `mcp__${conn.name}__${tool.name}`;
  const live = conn as LiveConnection;
  return {
    name: prefixedName,
    description: `[MCP:${conn.name}] ${tool.description || tool.name}`,
    parameters: tool.inputSchema || { type: 'object', properties: {} },
    execute: async (args: Record<string, unknown>, ctx: ToolContext) => {
      const requestId = ++live.requestCounter;
      conn.pending.set(requestId, { method: tool.name });
      try {
        const result = await conn.client.callTool({ name: tool.name, arguments: args }, undefined, {
          timeout: requestTimeoutMs,
          resetTimeoutOnProgress: true,
          signal: ctx.signal,
        });
        const rendered = renderMcpContent(result as Record<string, unknown>);
        if (rendered.isError) {
          return toolFailure(
            `MCP tool ${prefixedName} failed: ${rendered.text || 'the server reported an error'}`,
            { code: 'mcp_tool_error', content: rendered.text },
          );
        }
        return toolSuccess(rendered.text, { data: result });
      } catch (error) {
        let message: string;
        if (ctx.signal?.aborted) {
          message = `MCP request aborted: ${tool.name}`;
        } else if (conn.closed && isMcpErrorWithCode(error, ErrorCode.ConnectionClosed)) {
          message = `MCP server ${conn.name} disconnected`;
        } else {
          message = live.redact(error instanceof Error ? error.message : String(error));
        }
        const tail = conn.stderr.trim();
        return toolFailure(
          `MCP tool ${prefixedName} failed: ${message}${tail ? ` (stderr: ${tail})` : ''}`,
          { code: 'mcp_tool_failed' },
        );
      } finally {
        conn.pending.delete(requestId);
      }
    },
  };
}

/** Current tool definitions for live connections; hosts rebuild per turn to pick up list changes. */
export function buildMcpToolDefinitions(
  connections: McpConnection[],
  requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  for (const conn of connections) {
    if (conn.closed) continue;
    for (const tool of conn.tools) tools.push(buildToolDefinition(conn, tool, requestTimeoutMs));
  }
  return tools;
}

export async function connectMcpServers(
  workspace: string,
  options: McpConnectionOptions = {},
): Promise<{ connections: McpConnection[]; tools: ToolDefinition[] }> {
  const resolved: ResolvedConnectionOptions = {
    ...options,
    initializationTimeoutMs: options.initializationTimeoutMs ?? DEFAULT_INITIALIZATION_TIMEOUT_MS,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    onDiagnostic: options.onDiagnostic ?? consoleMcpDiagnosticSink,
  };
  const servers = options.servers
    ? Object.entries(options.servers).map(([name, config]) => ({ name, config }))
    : resolveMcpServerList(workspace, {
        home: options.home,
        onDiagnostic: resolved.onDiagnostic,
      });

  const results = await Promise.allSettled(
    servers.map(({ name, config }) => connectMcpServer(name, config, resolved)),
  );
  const connections: McpConnection[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      const server = servers[index];
      resolved.onDiagnostic({
        level: 'warn',
        message: `Failed to connect to MCP server "${server.name}": ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
        server: server.name,
      });
      continue;
    }
    if (!result.value) continue;
    connections.push(result.value);
  }
  return { connections, tools: buildMcpToolDefinitions(connections, resolved.requestTimeoutMs) };
}

export async function disconnectMcpServers(connections: McpConnection[]): Promise<void> {
  const closing = connections.map(async (conn) => {
    if (conn.closed) return;
    conn.closed = true;
    await conn.close().catch(() => {});
  });
  await Promise.all(closing);
}
