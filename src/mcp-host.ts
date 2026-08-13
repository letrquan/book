/**
 * Session-scoped MCP owner for interactive hosts.
 *
 * Resolves declared servers, enforces the project-server approval boundary,
 * connects approved servers in the background, and exposes a subscribe/snapshot
 * surface plus live tool definitions for per-send registry assembly. All
 * diagnostics route through the debug log — never the console — so Ink output
 * stays intact.
 */
import type { ChildProcess } from 'child_process';
import {
  buildMcpToolDefinitions,
  connectMcpServers,
  disconnectMcpServers,
  type McpConnection,
} from './mcp.js';
import {
  formatMcpServerCommand,
  resolveMcpServerList,
  type McpServerSource,
  type ResolvedMcpServer,
} from './mcp-config.js';
import {
  evaluateMcpServerApproval,
  mcpServerFingerprint,
  persistMcpProjectServerChoice,
} from './mcp-approvals.js';
import { createDebugLogger } from './debug-log.js';
import type { McpSettings } from './settings.js';
import type { ToolDefinition } from './types/tools.js';

const log = createDebugLogger('mcp');

export type McpServerStatus =
  | 'pending-approval'
  | 'deferred'
  | 'rejected'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'failed';

export interface McpHostServerSnapshot {
  name: string;
  source: McpServerSource;
  path: string;
  /** Full non-secret connection target the user is trusting. */
  target: string;
  envKeys: string[];
  headerKeys: string[];
  fingerprint: string;
  status: McpServerStatus;
  /** True when a recorded decision exists but the config changed since. */
  configChangedSinceApproval: boolean;
  toolCount?: number;
  error?: string;
}

export type McpHostEvent =
  | { id: number; type: 'connected'; server: string; toolCount: number }
  | { id: number; type: 'disconnected'; server: string }
  | { id: number; type: 'failed'; server: string; error: string }
  | { id: number; type: 'tools-changed'; server: string; toolCount: number };

type McpHostEventInput<T = McpHostEvent> = T extends McpHostEvent ? Omit<T, 'id'> : never;

export interface McpHostSnapshot {
  servers: McpHostServerSnapshot[];
  /** Project servers awaiting a user decision, in declaration order. */
  pendingApprovals: McpHostServerSnapshot[];
  /** Bounded event feed with monotonic IDs; hosts track the last consumed ID. */
  events: McpHostEvent[];
}

export interface McpSessionHostOptions {
  home?: string;
  initializationTimeoutMs?: number;
  requestTimeoutMs?: number;
  /** Injectable for tests; defaults to the settings.local.json writer. */
  persistChoice?: typeof persistMcpProjectServerChoice;
  /** Lifecycle observer for spawned server processes. */
  onProcessSpawn?: (name: string, process: ChildProcess) => void;
  /** Injectable connector used by lifecycle tests. */
  connectServers?: typeof connectMcpServers;
}

const MAX_EVENTS = 50;

interface HostServerState {
  server: ResolvedMcpServer;
  fingerprint: string;
  status: McpServerStatus;
  configChangedSinceApproval: boolean;
  toolCount?: number;
  error?: string;
}

interface McpApprovalSettings {
  mcp?: Partial<McpSettings>;
}

export class McpSessionHost {
  private readonly states = new Map<string, HostServerState>();
  private readonly connections: McpConnection[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly events: McpHostEvent[] = [];
  private readonly abortController = new AbortController();
  private readonly persistChoice: typeof persistMcpProjectServerChoice;
  private nextEventId = 1;
  private snapshot: McpHostSnapshot = { servers: [], pendingApprovals: [], events: [] };
  private started = false;
  private disposed = false;

  constructor(
    private readonly workspace: string,
    private readonly settings: McpApprovalSettings,
    private readonly options: McpSessionHostOptions = {},
  ) {
    this.persistChoice = options.persistChoice ?? persistMcpProjectServerChoice;
  }

  /** Resolve declared servers and begin connecting every already-trusted one. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const servers = resolveMcpServerList(this.workspace, {
      home: this.options.home,
      onDiagnostic: (diagnostic) => log.debug(diagnostic.message),
    });
    for (const server of servers) {
      const approval = evaluateMcpServerApproval(this.settings, server);
      const recorded = this.settings.mcp?.projectServers?.[server.name];
      const fingerprint = mcpServerFingerprint(server.config);
      this.states.set(server.name, {
        server,
        fingerprint,
        status:
          approval === 'approved'
            ? 'connecting'
            : approval === 'rejected'
              ? 'rejected'
              : 'pending-approval',
        configChangedSinceApproval:
          approval === 'unknown' && recorded !== undefined && recorded.fingerprint !== fingerprint,
      });
    }
    this.rebuildSnapshot();
    for (const state of this.states.values()) {
      if (state.status === 'connecting') void this.connect(state);
    }
  }

  /** Persist approval for a pending project server and connect it. */
  approve(name: string): { ok: boolean; error?: string } {
    const state = this.states.get(name);
    if (!state || state.status !== 'pending-approval') {
      return { ok: false, error: `No pending approval for MCP server "${name}".` };
    }
    const persisted = this.persistChoice(this.workspace, name, state.fingerprint, 'approved');
    if (!persisted.ok) return persisted;
    state.status = 'connecting';
    state.configChangedSinceApproval = false;
    this.rebuildSnapshot();
    void this.connect(state);
    return { ok: true };
  }

  /** Persist rejection for a pending project server. */
  reject(name: string): { ok: boolean; error?: string } {
    const state = this.states.get(name);
    if (!state || state.status !== 'pending-approval') {
      return { ok: false, error: `No pending approval for MCP server "${name}".` };
    }
    const persisted = this.persistChoice(this.workspace, name, state.fingerprint, 'rejected');
    if (!persisted.ok) return persisted;
    state.status = 'rejected';
    this.rebuildSnapshot();
    return { ok: true };
  }

  /** Leave a pending server undecided for this session (re-prompts next session). */
  defer(name: string): void {
    const state = this.states.get(name);
    if (!state || state.status !== 'pending-approval') return;
    state.status = 'deferred';
    this.rebuildSnapshot();
  }

  /** Live tool definitions; hosts call this per send so list changes surface. */
  getToolDefinitions(): ToolDefinition[] {
    return buildMcpToolDefinitions(this.connections, this.options.requestTimeoutMs);
  }

  getSnapshot(): McpHostSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.abortController.abort(new Error('MCP host disposed'));
    await disconnectMcpServers(this.connections);
    this.listeners.clear();
  }

  private async connect(state: HostServerState): Promise<void> {
    const { name } = state.server;
    try {
      const result = await (this.options.connectServers ?? connectMcpServers)(this.workspace, {
        servers: { [name]: state.server.config },
        home: this.options.home,
        signal: this.abortController.signal,
        initializationTimeoutMs: this.options.initializationTimeoutMs,
        requestTimeoutMs: this.options.requestTimeoutMs,
        onProcessSpawn: this.options.onProcessSpawn,
        onDiagnostic: (diagnostic) => log.debug(diagnostic.message),
        onToolListChanged: (serverName) => this.handleToolListChanged(serverName),
        onConnectionClosed: (serverName) => this.handleConnectionClosed(serverName),
      });
      const connection = result.connections[0];
      if (this.disposed) {
        if (connection) await disconnectMcpServers([connection]);
        return;
      }
      if (!connection) {
        state.status = 'failed';
        state.error = 'connection failed (see debug log)';
        this.pushEvent({ type: 'failed', server: name, error: state.error });
        return;
      }
      if (connection.closed) {
        state.status = 'failed';
        state.error = 'connection closed during startup';
        this.pushEvent({ type: 'failed', server: name, error: state.error });
        return;
      }
      this.connections.push(connection);
      state.status = 'connected';
      state.toolCount = connection.tools.length;
      state.error = undefined;
      this.pushEvent({ type: 'connected', server: name, toolCount: connection.tools.length });
    } catch (error) {
      state.status = 'failed';
      state.error = error instanceof Error ? error.message : String(error);
      log.debug(`MCP host connect error for "${name}": ${state.error}`);
      this.pushEvent({ type: 'failed', server: name, error: state.error });
    }
  }

  private handleToolListChanged(serverName: string): void {
    const state = this.states.get(serverName);
    const connection = this.connections.find((conn) => conn.name === serverName);
    if (!state || !connection) return;
    state.toolCount = connection.tools.length;
    this.pushEvent({ type: 'tools-changed', server: serverName, toolCount: state.toolCount });
  }

  private handleConnectionClosed(serverName: string): void {
    if (this.disposed) return;
    const state = this.states.get(serverName);
    if (!state || state.status !== 'connected') return;
    state.status = 'disconnected';
    state.error = 'connection closed';
    state.toolCount = 0;
    this.pushEvent({ type: 'disconnected', server: serverName });
  }

  private pushEvent(event: McpHostEventInput): void {
    this.events.push({ ...event, id: this.nextEventId++ } as McpHostEvent);
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
    this.rebuildSnapshot();
  }

  private rebuildSnapshot(): void {
    const servers = [...this.states.values()].map((state) => ({
      name: state.server.name,
      source: state.server.source,
      path: state.server.path,
      target: formatMcpServerCommand(state.server.config),
      envKeys: Object.keys(state.server.config.env ?? {}).sort(),
      headerKeys: Object.keys(state.server.config.headers ?? {}).sort(),
      fingerprint: state.fingerprint,
      status: state.status,
      configChangedSinceApproval: state.configChangedSinceApproval,
      toolCount: state.toolCount,
      error: state.error,
    }));
    this.snapshot = {
      servers,
      pendingApprovals: servers.filter((server) => server.status === 'pending-approval'),
      events: [...this.events],
    };
    for (const listener of this.listeners) listener();
  }
}
