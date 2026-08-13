import { loadConfig } from '../config.js';
import { getPackageVersion } from '../version-info.js';
import { collectAgentDiagnostics } from '../agents/diagnostics.js';
import { withBuiltInAgents } from '../agents/profiles.js';
import { discoverAgents } from '../subagent-discovery.js';
import { resolveBookHome } from '../book-home.js';

export async function runDoctorCommand(workspace: string): Promise<void> {
  const config = loadConfig(workspace, { runMigrations: true });
  const settings = config.settings;

  console.log('Book Doctor');
  console.log('===========');
  console.log();
  console.log('Version:', getPackageVersion());
  console.log('Node:', process.version);
  console.log('Platform:', process.platform, process.arch);
  console.log('Workspace:', config.workspace);
  console.log('Model:', config.model, '(' + config.baseUrl + ')');
  console.log();

  // Settings layers.
  console.log('Settings layers:');
  const { existsSync } = await import('fs');
  const { join } = await import('path');
  const layers = [
    ['User', join(resolveBookHome(), 'settings.json')],
    ['Project', join(config.workspace, '.book', 'settings.json')],
    ['Local', join(config.workspace, '.book', 'settings.local.json')],
  ];
  for (const [label, path] of layers) {
    console.log('  ' + (existsSync(path) ? '[x]' : '[ ]') + ' ' + label + ': ' + path);
  }
  console.log();

  // Permissions.
  const perms = settings.permissions;
  console.log('Permissions:');
  console.log('  Allow rules: ' + perms.allow.length);
  console.log('  Ask rules:   ' + perms.ask.length);
  console.log('  Deny rules:  ' + perms.deny.length);
  console.log();

  // Hooks.
  const hooks = settings.hooks;
  let hookTotal = 0;
  for (const entries of Object.values(hooks)) hookTotal += entries.length;
  console.log('Hooks:');
  for (const [event, entries] of Object.entries(hooks)) {
    if (entries.length > 0) console.log('  ' + event + ': ' + entries.length);
  }
  if (hookTotal === 0) console.log('  (none)');
  console.log();

  // MCP.
  const { formatMcpServerCommand, resolveMcpServerList } = await import('../mcp-config.js');
  const { evaluateMcpServerApproval } = await import('../mcp-approvals.js');
  const mcpServers = resolveMcpServerList(config.workspace);
  console.log('MCP Servers:');
  for (const server of mcpServers) {
    const trust =
      server.source === 'user' ? 'user' : `project: ${evaluateMcpServerApproval(settings, server)}`;
    console.log('  ' + server.name + ': ' + formatMcpServerCommand(server.config) + ` [${trust}]`);
  }
  if (mcpServers.length === 0) console.log('  (none)');
  console.log();

  // Sandbox.
  const { createSandbox } = await import('../sandbox.js');
  const sandbox = createSandbox(settings.sandbox);
  console.log('Sandbox:');
  console.log('  Enabled: ' + settings.sandbox.enabled);
  console.log('  Available: ' + (sandbox !== null));
  console.log();

  // Managed agents.
  console.log('Managed agents:');
  const agentDiagnostics = collectAgentDiagnostics(
    config,
    withBuiltInAgents(discoverAgents(config.workspace)),
  );
  if (agentDiagnostics.length === 0) {
    console.log('  [x] Profiles and overrides look valid');
  } else {
    for (const diagnostic of agentDiagnostics) {
      console.log(`  [!] ${diagnostic.message}`);
    }
  }
  for (const directory of [
    join(config.workspace, '.claude', 'agents'),
    join(config.workspace, '.agents', 'agents'),
  ]) {
    if (existsSync(directory)) {
      console.log(
        `  [!] Third-party definitions found at ${directory}; preview them with /agents import ${directory}.`,
      );
    }
  }
  console.log();

  // Environment.
  console.log('Environment:');
  for (const key of ['BOOK_API_KEY', 'BOOK_BASE_URL', 'BOOK_MODEL', 'BOOK_WORKSPACE']) {
    const val = process.env[key];
    if (key === 'BOOK_API_KEY' && val) {
      console.log('  ' + key + ': *** (set)');
    } else {
      console.log('  ' + key + ': ' + (val || '(not set)'));
    }
  }
}
