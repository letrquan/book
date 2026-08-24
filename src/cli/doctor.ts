import { resolve } from 'path';
import { loadConfig } from '../config.js';
import { getPackageVersion } from '../version-info.js';
import { collectAgentDiagnostics } from '../agents/diagnostics.js';
import { withBuiltInAgents } from '../agents/profiles.js';
import { discoverAgents } from '../subagent-discovery.js';
import { resolveBookHome } from '../book-home.js';
import type { HookEntry } from '../settings.js';

/** Characters every supported shell passes through without quoting. */
const SHELL_SAFE_BARE = /^[A-Za-z0-9_@%+=:,./\\-]+$/;

/**
 * Render one argument for a command the user will paste into their own shell.
 *
 * It has to survive both a POSIX shell and `cmd.exe`, where single quotes are
 * literal — the reason the old `book config set … '<json>'` suggestion reached
 * validation as a string on Windows and failed. Double quotes are the one form
 * both accept, so anything needing quotes gets those; a value carrying a
 * character neither can quote verbatim gets no one-liner at all.
 */
function shellArgument(value: string): string | null {
  if (SHELL_SAFE_BARE.test(value)) return value;
  if (/["`$\n\r]/.test(value) || value.endsWith('\\')) return null;
  return `"${value}"`;
}

/**
 * A `book trust …` command targeting the workspace doctor actually diagnosed.
 *
 * `book trust` defaults to `process.cwd()`, so a suggestion printed by
 * `book doctor --workspace <repo>` run from elsewhere would otherwise record
 * the decision in the wrong project. Returns null when the path cannot be
 * quoted safely; the caller then tells the user where to run it instead.
 */
function trustCommandLine(workspace: string, rest: string): string | null {
  if (resolve(workspace) === resolve(process.cwd())) return `book trust ${rest}`;
  const quoted = shellArgument(workspace);
  return quoted === null ? null : `book trust ${rest} --workspace ${quoted}`;
}

/** One "here is how to grant it" line, or a fallback when the path defeats quoting. */
function approvalHint(label: string, workspace: string, rest: string): string {
  const command = trustCommandLine(workspace, rest);
  return command === null
    ? `${label} book trust ${rest} (run it from ${workspace})`
    : `${label} ${command}`;
}

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
      console.log(approvalHint('    Approve one:', config.workspace, 'rule <rule>'));
      console.log(
        approvalHint('    Approve all pending:', config.workspace, 'rule --all-pending') +
          ' (add --reject to refuse)',
      );
    }
  }

  console.log();

  // A command body that substitutes shell runs it outside the permission
  // system, so a repository-declared one is withheld until the user decides.
  // Its own section: these are not permission rules, and printing them inside
  // the permissions block reads as if they were a rule category.
  const { discoverCommands } = await import('../commands/loader.js');
  const { partitionProjectCommands, projectCommandFingerprint } =
    await import('../command-approvals.js');
  const gatedCommands = partitionProjectCommands(discoverCommands(config.workspace), settings);
  if (
    gatedCommands.approved.length + gatedCommands.pending.length + gatedCommands.rejected.length >
    0
  ) {
    console.log('Project commands that run shell (require approval):');
    for (const command of gatedCommands.approved) console.log('  [x] /' + command.name);
    for (const command of gatedCommands.rejected)
      console.log('  [-] /' + command.name + ' (rejected)');
    for (const command of gatedCommands.pending)
      console.log('  [!] /' + command.name + ' (refused until approved)');
    if (gatedCommands.pending.length > 0) {
      // `config set` replaces the whole record, so the printed line has to
      // carry the decisions already on file or running it revokes them.
      const decisions = {
        ...settings.commands.projectCommands,
        ...Object.fromEntries(
          gatedCommands.pending.map((command) => [
            command.name,
            { fingerprint: projectCommandFingerprint(command.body), choice: 'approved' },
          ]),
        ),
      };
      console.log(
        '  Approve with: book config set commands.projectCommands ' +
          `'${JSON.stringify(decisions)}'`,
      );
    }
    console.log();
  }

  // Hooks.
  const hooks = settings.hooks;
  // `hooks.projectEntries` records trust decisions, not hook entries.
  const hookLists = Object.entries(hooks).filter((pair): pair is [string, HookEntry[]] =>
    Array.isArray(pair[1]),
  );
  let hookTotal = 0;
  for (const [, entries] of hookLists) hookTotal += entries.length;
  console.log('Hooks:');
  for (const [event, entries] of hookLists) {
    if (entries.length > 0) console.log('  ' + event + ': ' + entries.length);
  }
  if (hookTotal === 0) console.log('  (none)');

  // Hook entries a repository declared are withheld until the user decides on
  // them, so doctor is where an unexplained "my project hook does nothing" is
  // meant to be answered.
  const { collectDeclaredHooks, describeDeclaredHook, partitionProjectHooks } =
    await import('../hook-approvals.js');
  const declaredProjectHooks = collectDeclaredHooks(projectSettings);
  if (declaredProjectHooks.length > 0) {
    const hookPartition = partitionProjectHooks(
      declaredProjectHooks,
      settings.hooks.projectEntries,
    );
    console.log('  Project-declared hooks (require approval):');
    // Approval is keyed by a fingerprint covering event, matcher, command and
    // env, so all four are disclosed. A hook rendered as its command alone hides
    // exactly the fields behaviour can be smuggled in: `npm test` carrying
    // `NODE_OPTIONS=--require ./payload.js` reads as harmless and is not.
    const groups = [
      { mark: '[x]', suffix: '', hooks: hookPartition.approved },
      { mark: '[-]', suffix: ' (rejected)', hooks: hookPartition.rejected },
      { mark: '[!]', suffix: ' (not in effect)', hooks: hookPartition.pending },
    ];
    for (const group of groups) {
      for (const hook of group.hooks) {
        const described = describeDeclaredHook(hook);
        console.log('    ' + group.mark + ' ' + described.headline + group.suffix);
        for (const detail of described.details) console.log('          ' + detail);
      }
    }
    if (hookPartition.pending.length > 0) {
      console.log(approvalHint('    Approve one:', config.workspace, 'hook <fingerprint>'));
      console.log(
        approvalHint('    Approve all pending:', config.workspace, 'hook --all-pending') +
          ' (add --reject to refuse)',
      );
    }
  }
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
