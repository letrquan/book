import { resolve } from 'path';
import { loadConfig } from '../config.js';
import { getPackageVersion } from '../version-info.js';
import { collectAgentDiagnostics } from '../agents/diagnostics.js';
import { withBuiltInAgents } from '../agents/profiles.js';
import { discoverAgents } from '../subagent-discovery.js';
import { resolveBookHome } from '../book-home.js';
import { readAuthStore } from '../auth/store.js';
import { describeExpiry } from '../auth/resolve.js';
import type { HookEntry } from '../settings.js';
import type { AgentConfig } from '../types/runtime.js';

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

/**
 * One line naming what will actually authenticate the next request.
 *
 * An active auth profile outranks any API key in the environment - the
 * transports replace the key headers entirely - so reporting "resolved"
 * because BOOK_API_KEY happens to be set would name the wrong credential.
 */
function describeCredentials(config: AgentConfig): string {
  if (config.authProfile) {
    const read = readAuthStore();
    // "Nothing is logged in" would be a dead end here: `book auth login` also
    // refuses to write a store it cannot parse, so an unreadable file has to be
    // named as such by the command whose job is diagnosing a broken setup.
    if (read.status === 'unreadable') {
      return `auth profile "${config.authProfile}" selected, but ${read.path} is unreadable (${read.error}) - delete it, then run: book auth login ${config.authProfile}`;
    }
    const credential = read.store.credentials[config.authProfile];
    if (!credential) {
      return `auth profile "${config.authProfile}" selected, but nothing is logged in - run: book auth login ${config.authProfile}`;
    }
    const account = credential.tokens?.account;
    // The same renderer `book auth status` uses, so the two commands cannot
    // disagree about whether a credential is still good.
    const expiry =
      credential.kind === 'oauth' ? describeExpiry(credential.tokens) : 'stored API key';
    return `auth profile "${config.authProfile}"${account ? ` (${account})` : ''} - ${expiry}`;
  }
  return config.apiKey
    ? 'API key resolved'
    : 'not resolved - set BOOK_API_KEY, run `book auth login <profile>`, or set provider.<id>.apiKey in settings';
}

/**
 * A path that cannot exist, used to drop one layer from a probe resolution.
 *
 * `loadSettingsFile` returns null for a missing file, so redirecting a layer at
 * a name nothing can occupy is how a subset of the stack gets resolved without
 * touching the user's files.
 */
const ABSENT_LAYER = '\0absent-settings-layer';

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
 * Which layer a configuration failure first appears in.
 *
 * Some rejections name their own file: malformed JSON and schema violations both
 * carry a path. The ones that do not are precisely the ones about the *merged*
 * value -- `harness.workflow` is validated against the effective `harness.mode`,
 * so no single file is wrong on its own and none of them says so. Finding it
 * meant reading all three by hand.
 *
 * Resolving cumulative prefixes of the stack answers it directly: the first
 * prefix that fails ends at the layer that turned a working configuration into a
 * broken one. Undefined means no prefix loads, so the cause is outside the
 * layers -- an environment variable, or a legacy `.bookrc.json`.
 */
async function attributeFailingLayer(workspace: string): Promise<string | undefined> {
  const layers = await settingsLayers(workspace);

  for (let included = 0; included <= layers.length; included++) {
    const [userSettingsPath, projectSettingsPath, localSettingsPath] = layers.map(
      ([, path], index) => (index < included ? path : ABSENT_LAYER),
    );
    try {
      loadConfig(workspace, {
        allowMissingApiKey: true,
        // A probe must not write: migrations are the real load's business.
        runMigrations: false,
        settingsPaths: { userSettingsPath, projectSettingsPath, localSettingsPath },
      });
    } catch {
      // included === 0 is the no-layer probe; failing there blames nothing.
      return included === 0 ? undefined : layers[included - 1][0];
    }
  }
  return undefined;
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

  const culprit = await attributeFailingLayer(workspace);
  console.log('  Settings layers, in the order they are applied:');
  for (const [label, path] of await settingsLayers(workspace)) {
    const marker = existsSync(path) ? '[x]' : '[ ]';
    const blame = label === culprit ? '  <- the failure appears with this layer' : '';
    console.log('    ' + marker + ' ' + label + ': ' + path + blame);
  }
  console.log();
  if (culprit) {
    console.log(`  The ${culprit} layer is where the configuration stops loading.`);
  } else {
    console.log('  No single layer accounts for it: check the environment and .bookrc.json.');
  }
  console.log('  Run `book doctor --no-settings` to report the rest with every layer skipped.');
}

export async function runDoctorCommand(
  workspace: string,
  options: { noSettings?: boolean } = {},
): Promise<void> {
  // Doctor must diagnose a broken environment, so it cannot require a working one:
  // a missing credential is a finding to report, not a reason to abort, and
  // neither is a settings file that fails to load.
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig(workspace, {
      // --no-settings is the way past a layer doctor cannot otherwise get around;
      // migrations would rewrite settings this run has been told to ignore.
      noSettings: options.noSettings,
      runMigrations: !options.noSettings,
      allowMissingApiKey: true,
    });
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
  // Printed before Credentials on purpose: an unresolved provider prefix makes
  // the credential line read as a missing key, which is the wrong hunt.
  if (config.modelProviderWarning) console.log('  ⚠ ' + config.modelProviderWarning);
  console.log('Credentials:', describeCredentials(config));
  console.log();

  // Settings layers.
  console.log('Settings layers:');
  const { existsSync } = await import('fs');
  const { join } = await import('path');
  for (const [label, path] of await settingsLayers(config.workspace)) {
    const marker = options.noSettings ? '[-]' : existsSync(path) ? '[x]' : '[ ]';
    console.log('  ' + marker + ' ' + label + ': ' + path);
  }
  // Everything below is resolved from defaults in this mode. Saying so once
  // stops the report reading as a description of the user's configuration.
  if (options.noSettings) {
    console.log('  (--no-settings: every layer skipped, defaults reported below)');
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
  const { partitionProjectCommands, describeProjectCommandShell, displayableCommandName } =
    await import('../command-approvals.js');
  const gatedCommands = partitionProjectCommands(discoverCommands(config.workspace), settings);
  if (
    gatedCommands.approved.length + gatedCommands.pending.length + gatedCommands.rejected.length >
    0
  ) {
    console.log('Project commands that run shell (require approval):');
    for (const command of gatedCommands.approved)
      console.log('  [x] /' + displayableCommandName(command.name));
    for (const command of gatedCommands.rejected)
      console.log('  [-] /' + displayableCommandName(command.name) + ' (rejected)');
    // A withheld command is listed with the shell it would run, the way a
    // withheld hook is listed with its command, matcher, and environment:
    // the decision is about that shell, so a name alone cannot inform it.
    for (const command of gatedCommands.pending) {
      console.log('  [!] /' + displayableCommandName(command.name) + ' (refused until approved)');
      for (const line of describeProjectCommandShell(command)) console.log('        ' + line);
    }
    if (gatedCommands.pending.length > 0) {
      console.log(approvalHint('  Approve one:', config.workspace, 'command <name>'));
      console.log(
        approvalHint('  Approve all pending:', config.workspace, 'command --all-pending') +
          ' (add --reject to refuse)',
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
