import { loadConfig } from '../config.js';
import { getPackageVersion } from '../version-info.js';
import { collectAgentDiagnostics } from '../agents/diagnostics.js';
import { withBuiltInAgents } from '../agents/profiles.js';
import { discoverAgents } from '../subagent-discovery.js';
import { resolveBookHome } from '../book-home.js';

/** The settings files doctor reads, in the order they are layered. */
async function settingsLayers(workspace: string): Promise<Array<[string, string]>> {
  const { join, resolve } = await import('path');
  const root = resolve(workspace);
  return [
    ['User', join(resolveBookHome(), 'settings.json')],
    ['Project', join(root, '.book', 'settings.json')],
    ['Local', join(root, '.book', 'settings.local.json')],
  ];
}

/**
 * Report a configuration that would not load at all.
 *
 * A missing credential is already handled by allowMissingApiKey, but every
 * other rejection - malformed JSON, a schema violation, an unknown harness
 * workflow - used to escape loadConfig as an unhandled stack trace. A broken
 * settings file is precisely what doctor exists to diagnose, so it is a finding
 * to render, not a reason to die.
 */
async function reportUnloadableConfig(workspace: string, error: unknown): Promise<void> {
  const { existsSync } = await import('fs');
  const { resolve } = await import('path');

  console.log('Book Doctor');
  console.log('===========');
  console.log();
  console.log('Version:', getPackageVersion());
  console.log('Node:', process.version);
  console.log('Platform:', process.platform, process.arch);
  console.log('Workspace:', resolve(workspace));
  console.log();
  console.log('Configuration: FAILED TO LOAD');
  console.log('  ' + (error instanceof Error ? error.message : String(error)));
  console.log();
  console.log('  No other check can run until the configuration loads.');
  console.log('  Settings layers, in the order they are applied:');
  for (const [label, path] of await settingsLayers(workspace)) {
    console.log('    ' + (existsSync(path) ? '[x]' : '[ ]') + ' ' + label + ': ' + path);
  }
  console.log();
  console.log('  Fix the offending file above, or point BOOK_HOME at a clean one.');
}

export async function runDoctorCommand(workspace: string): Promise<void> {
  // Doctor must diagnose a broken environment, so it cannot require a working one:
  // a missing credential is a finding to report, not a reason to abort, and
  // neither is a settings file that fails to load.
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(workspace, { runMigrations: true, allowMissingApiKey: true });
  } catch (error) {
    await reportUnloadableConfig(workspace, error);
    return;
  }
  const settings = config.settings;

  console.log('Book Doctor');
  console.log('===========');
  console.log();
  console.log('Version:', getPackageVersion());
  console.log('Node:', process.version);
  console.log('Platform:', process.platform, process.arch);
  console.log('Workspace:', config.workspace);
  console.log('Model:', config.model, '(' + config.baseUrl + ')');
  console.log(
    'Credentials:',
    config.apiKey
      ? 'resolved'
      : 'not resolved - set BOOK_API_KEY or provider.<id>.apiKey in settings',
  );
  console.log();

  // Settings layers.
  console.log('Settings layers:');
  const { existsSync } = await import('fs');
  const { join } = await import('path');
  for (const [label, path] of await settingsLayers(config.workspace)) {
    console.log('  ' + (existsSync(path) ? '[x]' : '[ ]') + ' ' + label + ': ' + path);
  }
  console.log();

  // Permissions.
  const perms = settings.permissions;
  console.log('Permissions:');
  console.log('  Allow rules: ' + perms.allow.length);
  console.log('  Ask rules:   ' + perms.ask.length);
  console.log('  Deny rules:  ' + perms.deny.length);

  // Allow rules the repository declared are withheld until the user decides on
  // them, so doctor is where an unexplained "my project rule does nothing" is
  // meant to be answered.
  const { loadSettingsFile } = await import('../settings-loader.js');
  const { partitionProjectAllowRules } = await import('../permission-approvals.js');
  const projectSettings = loadSettingsFile(join(config.workspace, '.book', 'settings.json'));
  const projectAllow = partitionProjectAllowRules(
    projectSettings?.permissions?.allow ?? [],
    perms.projectAllowRules,
  );
  if (
    projectAllow.approved.length + projectAllow.pending.length + projectAllow.rejected.length >
    0
  ) {
    console.log('  Project-declared allow rules (require approval):');
    for (const rule of projectAllow.approved) console.log('    [x] ' + rule);
    for (const rule of projectAllow.rejected) console.log('    [-] ' + rule + ' (rejected)');
    for (const rule of projectAllow.pending) console.log('    [!] ' + rule + ' (not in effect)');
    if (projectAllow.pending.length > 0) {
      console.log(
        '    Approve with: book config set permissions.projectAllowRules ' +
          `'${JSON.stringify(
            Object.fromEntries(projectAllow.pending.map((rule) => [rule, 'approved'])),
          )}'`,
      );
    }
  }
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
  const { createSandbox, sandboxPolicySummary } = await import('../sandbox.js');
  const { hasAdjudicationPolicy } = await import('../permissions.js');
  const sandbox = createSandbox(settings.sandbox);
  const policy = sandboxPolicySummary(settings.sandbox, {
    sandboxActive: sandbox !== null,
    adjudicationConfigured: hasAdjudicationPolicy(settings),
  });
  console.log('Sandbox:');
  console.log('  Enabled: ' + settings.sandbox.enabled);
  console.log('  Available: ' + (sandbox !== null));
  if (sandbox) console.log('  Enforcing: ' + sandbox.describe());
  console.log('  Excluded commands: ' + settings.sandbox.excludedCommands.length);
  console.log('  Unsandboxed commands: ' + policy.unsandboxedCommands);
  console.log('  Auto-allow Bash: ' + policy.autoAllowBash);
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
