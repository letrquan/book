import type { McpHostSnapshot, McpServerStatus } from './mcp-host.js';

const STATUS_LABELS: Record<McpServerStatus, string> = {
  'pending-approval': 'approval required',
  deferred: 'deferred',
  rejected: 'rejected',
  connecting: 'connecting',
  connected: 'connected',
  disconnected: 'disconnected',
  failed: 'failed',
};

/** Plain-text MCP status report shared by the TUI command and tests. */
export function buildMcpStatusReport(snapshot: McpHostSnapshot | undefined): string {
  if (!snapshot || snapshot.servers.length === 0) {
    return 'MCP servers: none configured. Add servers to ~/.book/mcp.json or .mcp.json.';
  }

  const lines = ['MCP servers:'];
  for (const server of snapshot.servers) {
    const tools = server.toolCount === undefined ? '' : ` · ${server.toolCount} tools`;
    const source = server.source === 'user' ? 'user' : 'project';
    const error = server.error ? ` · ${server.error}` : '';
    lines.push(`  ${server.name} — ${STATUS_LABELS[server.status]}${tools} · ${source}${error}`);
    lines.push(`    ${server.target}`);
    if (server.envKeys.length > 0) lines.push(`    env: ${server.envKeys.join(', ')}`);
    if (server.headerKeys.length > 0) {
      lines.push(`    headers: ${server.headerKeys.join(', ')} (values hidden)`);
    }
  }
  return lines.join('\n');
}
