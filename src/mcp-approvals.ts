/**
 * Trust decisions for MCP servers.
 *
 * Servers declared in a workspace `.mcp.json` are repository-controlled input:
 * connecting one executes an arbitrary command. Hosts therefore require a
 * one-time per-project approval, recorded against a fingerprint of the full
 * connection configuration in the user-global trust store, outside the
 * workspace, where nothing the repository ships can reach it (see
 * `workspace-trust.ts`).
 * A config change after approval invalidates the decision and re-prompts.
 * User-global servers (<BOOK_HOME>/.book/mcp.json) were written by the user
 * and never require approval.
 */
import { createHash } from 'crypto';
import type { McpProjectServerChoice, McpSettings } from './settings.js';
import type { McpServerConfig, ResolvedMcpServer } from './mcp-config.js';
import { updateWorkspaceTrust } from './workspace-trust.js';

/** Stable digest of everything the user is asked to trust about a server. */
export function mcpServerFingerprint(config: McpServerConfig): string {
  const sortedRecord = (record: Record<string, string> | undefined) =>
    Object.fromEntries(Object.entries(record ?? {}).sort(([a], [b]) => a.localeCompare(b)));
  const canonical = JSON.stringify({
    type: config.type ?? (config.url ? 'http' : 'stdio'),
    command: config.command,
    args: config.args ?? [],
    env: sortedRecord(config.env),
    cwd: config.cwd,
    url: config.url,
    // Values intentionally participate in the digest: changing an auth token
    // or any other header changes what the user has approved. The digest is
    // one-way and neither the UI nor diagnostics render these values.
    headers: sortedRecord(config.headers),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export type McpServerApprovalState = 'approved' | 'rejected' | 'unknown';

interface McpApprovalSettings {
  mcp?: Partial<McpSettings>;
}

export function evaluateMcpServerApproval(
  settings: McpApprovalSettings,
  server: ResolvedMcpServer,
): McpServerApprovalState {
  if (server.source === 'user') return 'approved';
  const choice: McpProjectServerChoice | undefined = settings.mcp?.projectServers?.[server.name];
  if (!choice) return 'unknown';
  if (choice.fingerprint !== mcpServerFingerprint(server.config)) return 'unknown';
  return choice.choice;
}

export interface McpApprovalPartition {
  /** User-global servers plus approved project servers — safe to connect. */
  allowed: ResolvedMcpServer[];
  /** Project servers with no (valid) recorded decision — prompt or skip. */
  pending: ResolvedMcpServer[];
  /** Project servers the user rejected. */
  rejected: ResolvedMcpServer[];
}

export function partitionMcpServersByApproval(
  servers: ResolvedMcpServer[],
  settings: McpApprovalSettings,
): McpApprovalPartition {
  const partition: McpApprovalPartition = { allowed: [], pending: [], rejected: [] };
  for (const server of servers) {
    const state = evaluateMcpServerApproval(settings, server);
    if (state === 'approved') partition.allowed.push(server);
    else if (state === 'rejected') partition.rejected.push(server);
    else partition.pending.push(server);
  }
  return partition;
}

export function mcpServersToRecord(servers: ResolvedMcpServer[]): Record<string, McpServerConfig> {
  return Object.fromEntries(servers.map((server) => [server.name, server.config]));
}

/**
 * Record an approve/reject decision for one server, leaving every other
 * recorded decision — in this workspace and in every other — untouched.
 */
export function persistMcpProjectServerChoice(
  workspace: string,
  name: string,
  fingerprint: string,
  choice: McpProjectServerChoice['choice'],
  options: { trustStorePath?: string } = {},
): { ok: boolean; error?: string } {
  return updateWorkspaceTrust(
    workspace,
    (trust) => {
      trust.mcpServers[name] = { fingerprint, choice } satisfies McpProjectServerChoice;
    },
    options.trustStorePath,
  );
}
