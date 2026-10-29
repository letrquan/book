import { loadConfig } from '../config.js';
import { renderUntrustedText } from '../hook-approvals.js';
import { providerTrustCommand, trustCommandText } from '../trust-command.js';
import { getPackageVersion } from '../version-info.js';
import { collectNodeSecurityNotices } from '../node-advisory.js';
import { collectAgentDiagnostics } from '../agents/diagnostics.js';
import { withBuiltInAgents } from '../agents/profiles.js';
import { discoverAgents } from '../subagent-discovery.js';
import { resolveBookHome } from '../book-home.js';
import type { HookEntry } from '../settings.js';
import type { AgentConfig } from '../types/runtime.js';
import type { InboundLayer, InboundResolution } from '../messaging/receive-policy.js';

/**
 * How much a settings layer named by `settingsLayers` is trusted, in the terms
 * `workspaceLayerThatEnabledSandbox` uses. The label is what `settingsLayers`
 * prints; an unrecognised one falls back to `local`, the least-trusted
 * workspace position there is, so a renamed label cannot quietly promote a file
 * to the trusted baseline the activation question is measured against.
 */
const WORKSPACE_LAYER_TRUST: Record<string, 'trusted' | 'repository' | 'local'> = {
  User: 'trusted',
  Project: 'repository',
  Local: 'local',
};

/**
 * One "here is how to grant it" line, naming the workspace doctor actually diagnosed (see
 * `trustCommandText`), or a fallback when the path defeats quoting.
 */
function approvalHint(label: string, workspace: string, rest: string): string {
  const { command, note } = trustCommandText(workspace, rest);
  return `${label} ${command}${note}`;
}

function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const elapsedMs = Math.max(0, now - timestamp);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * One line naming what will actually authenticate the next request.
 */
function describeCredentials(config: AgentConfig): string {
  if (config.providerAuth === 'chatgpt') return 'Sign in with ChatGPT (experimental; see below)';
  return config.apiKey
    ? 'API key resolved'
    : 'not resolved - set BOOK_API_KEY or set provider.<id>.apiKey in settings';
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
 * carry a path. Resolving cumulative prefixes of the stack answers which layer
 * turned a working configuration into a broken one. Undefined means no prefix loads,
 * so the cause is outside the layers -- an environment variable, or a legacy `.bookrc.json`.
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
 * other rejection - malformed JSON, a schema violation - used to escape
 * loadConfig as an unhandled stack trace. A broken settings file is precisely
 * what doctor exists to diagnose, so it is a finding to render, not a reason to die.
 */
/**
 * The header both reports open with. The `Node:` line carries any security notice for the
 * running Node.js, the same one every launch shows.
 */
function printHeader(): void {
  console.log('Book Doctor');
  console.log('===========');
  console.log();
  console.log('Version:', getPackageVersion());
  console.log('Node:', process.version);
  for (const notice of collectNodeSecurityNotices(process.versions.node)) {
    console.log('  ' + notice);
  }
  console.log('Platform:', process.platform, process.arch);
}

async function reportUnloadableConfig(workspace: string, error: unknown): Promise<void> {
  const { existsSync } = await import('fs');
  const { resolve } = await import('path');

  printHeader();
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

/** The registry directory's state and how many sessions in it are live, as one line. */
async function describeLiveSessions(): Promise<string> {
  const {
    describeLiveSessionsDirState,
    inspectLiveSessionsDir,
    listLiveSessions,
    liveSessionsDir,
  } = await import('../messaging/registry.js');
  const { createLivenessProbe } = await import('../messaging/liveness.js');
  const dir = liveSessionsDir();
  try {
    const state = await inspectLiveSessionsDir(dir);
    if (state === 'missing') return `none (${dir} ${describeLiveSessionsDirState(state)})`;
    if (state !== 'ok' && state !== 'loose-mode') {
      return `[!] ${dir} ${describeLiveSessionsDirState(state)}; the TUI does not register there`;
    }
    const live = await listLiveSessions({ dir, probe: createLivenessProbe(), sweep: false });
    const count = `${live.length} live in ${dir}`;
    // The TUI tightens a directory of the user's own to 0700 the next time it starts.
    return state === 'ok' ? count : `${count} [!] ${describeLiveSessionsDirState(state)}`;
  } catch (error) {
    return `[!] ${dir} cannot be read: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Cross-session messaging (#620): whether it is on, where this machine's inbox would bind and
 * whether that directory passes the checks, and any workspace layer that tried to turn it on.
 * Nothing is created: a directory that does not exist yet is reported as such.
 */
async function describeMessaging(
  enabled: boolean,
  workspace: string,
  noSettings: boolean | undefined,
): Promise<string[]> {
  const lines: string[] = [];
  if (process.platform === 'win32') {
    lines.push('Messaging: not supported on Windows yet');
  } else if (!enabled) {
    lines.push(
      'Messaging: off (experimental; set messaging.enabled in ~/.book/settings.json to turn it on)',
    );
  } else {
    lines.push('Messaging: on (experimental)');
    const { resolveSocketDir } = await import('../messaging/socket-dir.js');
    try {
      const resolution = await resolveSocketDir({ create: false });
      const passedOver = resolution.skipped.map(
        (skip) => `; fell back from ${skip.dir}: ${skip.message}`,
      );
      if (!resolution.ok) {
        lines.push(
          `  Socket directory: [!] none usable${passedOver.join('')}; the TUI opens no inbox`,
        );
      } else {
        const state = resolution.missing
          ? 'not created yet; the TUI creates it 0700'
          : resolution.loose
            ? '[!] readable by other users; the TUI tightens it to 0700'
            : 'vetted';
        lines.push(`  Socket directory: ${resolution.dir} (${state})${passedOver.join('')}`);
      }
    } catch (error) {
      lines.push(
        `  Socket directory: [!] cannot be checked: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!noSettings) {
    const {
      formatIgnoredWorkspaceSandboxKey,
      ignoredWorkspaceUserOnlyKeys,
      isUserSettingsFile,
      loadSettingsFile,
    } = await import('../settings-loader.js');
    const { resolveInboundSetting } = await import('../messaging/receive-policy.js');
    const inboundLayers: InboundLayer[] = [];
    for (const [label, path] of await settingsLayers(workspace)) {
      const user = label === 'User' || isUserSettingsFile(path);
      let document: unknown;
      try {
        document = loadSettingsFile(path);
      } catch {
        continue;
      }
      inboundLayers.push({
        label: user ? 'user' : label === 'Project' ? 'project' : 'local',
        path,
        trusted: user,
        value: (document as { messaging?: { inbound?: unknown } } | null)?.messaging?.inbound,
      });
      if (user) continue;
      for (const entry of ignoredWorkspaceUserOnlyKeys(document)) {
        lines.push(
          `  Ignored from ${path}: ${formatIgnoredWorkspaceSandboxKey(entry)} — read only from ~/.book/settings.json or --settings`,
        );
      }
    }
    // The same resolution the loader applies, so what is reported is what is enforced.
    const inbound = resolveInboundSetting(inboundLayers);
    if (enabled) lines.push(`  Inbound: ${describeInbound(inbound)}`);
    for (const entry of inbound.ignored) {
      lines.push(
        `  Ignored from ${entry.path}: messaging.inbound=${JSON.stringify(entry.value)} — a workspace layer may only make it stricter`,
      );
    }
  }
  return lines;
}

/** `messaging.inbound` as doctor reports it: the value, and the layer it came from. */
function describeInbound(inbound: InboundResolution): string {
  if (inbound.value === undefined || !inbound.source) {
    return 'unset (mode parity decides: a message from the other permission class is held)';
  }
  const origin = inbound.tightened
    ? `tightened by ${inbound.source.path}`
    : `from ${inbound.source.path}`;
  const invalid = inbound.invalid ? '; the value set is not accept, hold or refuse' : '';
  return `${inbound.value} (${origin}${invalid})`;
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

  printHeader();
  console.log('Workspace:', config.workspace);
  console.log('Model:', config.model, '(' + config.baseUrl + ')');
  // Printed before Credentials on purpose: an unresolved provider prefix makes
  // the credential line read as a missing key, which is the wrong hunt.
  if (config.modelProviderWarning) console.log('  ⚠ ' + config.modelProviderWarning);
  console.log('Credentials:', describeCredentials(config));
  // Sign in with ChatGPT is opt-in: reported only when this machine uses or configured it.
  {
    const { chatGptSigninStatus } = await import('../auth/chatgpt-oauth.js');
    const { describeStatus } = await import('./auth-cmd.js');
    const status = chatGptSigninStatus();
    const configured = Object.values(settings.provider).some((entry) => entry.type === 'chatgpt');
    if (
      config.providerAuth === 'chatgpt' ||
      configured ||
      status.state !== 'signed-out' ||
      status.clientId
    ) {
      console.log('Sign in with ChatGPT (experimental):', describeStatus(status));
    }
  }
  // Configuration for a feature that no longer exists is invisible otherwise:
  // validation discards unknown blocks silently, so a user whose subscription
  // login stopped working has nothing to read. The orphaned credential file
  // matters most — it holds a refresh token nothing revokes.
  const {
    collectRemovedSettingNotices,
    collectRemovedEnvNotices,
    removedAuthStoreNotice,
    readSettingsDocumentForNotices,
  } = await import('../settings-removed.js');
  const { settingsLayerPaths } = await import('../settings-loader.js');
  const { join: joinPath } = await import('path');
  const { existsSync: fileExists } = await import('fs');
  const removedNotices = [
    ...settingsLayerPaths(workspace, undefined, {}).flatMap((path) =>
      collectRemovedSettingNotices(readSettingsDocumentForNotices(path)).map(
        (notice) => `${notice.key} in ${path}: ${notice.message}`,
      ),
    ),
    ...collectRemovedEnvNotices(process.env).map(
      (notice) => `${notice.key} is set: ${notice.message}`,
    ),
  ];
  const authStorePath = joinPath(resolveBookHome(), 'auth.json');
  if (fileExists(authStorePath)) removedNotices.push(removedAuthStoreNotice(authStorePath));
  if (removedNotices.length > 0) {
    console.log();
    console.log('Removed features still configured on this machine:');
    for (const notice of removedNotices) console.log(`  [!] ${notice}`);
  }
  console.log();

  // Settings layers.
  console.log('Settings layers:');
  const { existsSync } = await import('fs');
  const { join } = await import('path');
  const { isShippedUserSettingsFile, isUserSettingsFile } = await import('../settings-loader.js');
  const userShipped = isShippedUserSettingsFile(config.workspace);
  for (const [label, path] of await settingsLayers(config.workspace)) {
    const marker = options.noSettings ? '[-]' : existsSync(path) ? '[x]' : '[ ]';
    // At `$HOME` the project file is the user file, and the loader reads it once (#429), as User
    // unless the workspace's repository tracks it; it is then read as Project.
    const note =
      label === 'User' && userShipped
        ? ' (tracked by the workspace repository; not read as User)'
        : label === 'Project' && isUserSettingsFile(path, config.workspace)
          ? ' (the User file; read once, as User)'
          : '';
    console.log('  ' + marker + ' ' + label + ': ' + path + note);
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
  const projectPath = join(config.workspace, '.book', 'settings.json');
  const projectSettings = isUserSettingsFile(projectPath, config.workspace)
    ? null
    : loadSettingsFile(projectPath);
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

  // A declared `additionalDirectories` entry widens the roots Read, Glob and Grep may cross, so
  // a checked-in one is withheld the same way a project allow rule is. The line shows the real
  // path next to the declared text: the decision is keyed by, and granted over, where the path
  // really goes, because the text is the repository's to write and a link can point anywhere.
  //
  // A rejected entry is not listed. It is not in effect, nothing is awaiting a decision, and
  // there is no command to print — re-reporting it on every run would be noise that trains the
  // reader to skim past the `[!]` lines that do matter.
  const { collectDeclaredDirectories, partitionProjectDirectories, resolveAdditionalRoots } =
    await import('../additional-roots.js');
  const projectDirectories = partitionProjectDirectories(
    collectDeclaredDirectories(config.workspace, projectSettings?.additionalDirectories ?? []),
    settings.projectDirectories,
  );
  const honoredAdditionalRoots = resolveAdditionalRoots(
    config.workspace,
    settings.additionalDirectories,
  );
  if (honoredAdditionalRoots.length > 0 || projectDirectories.pending.length > 0) {
    console.log('Additional directories (Read, Glob and Grep may reach these):');
    for (const root of honoredAdditionalRoots) console.log('    [x] ' + root);
    for (const directory of projectDirectories.pending) {
      console.log(
        '    [!] ' +
          directory.realPath +
          ' (not in effect; declared as ' +
          directory.declared +
          ')',
      );
    }
    if (projectDirectories.pending.length > 0) {
      console.log(approvalHint('    Approve one:', config.workspace, 'dir <path>'));
      console.log(
        approvalHint('    Approve all pending:', config.workspace, 'dir --all-pending') +
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

  // A provider names where a request goes and which credential rides along, so one only the
  // workspace declares is withheld until the user decides on that exact declaration (#418).
  // Listed in every state. The origin is the parsed protocol, host and port, in full; a key
  // reference is shown as the variable it names or the normalised file it opens, never resolved,
  // and a literal is not echoed at all. Every command printed is quoted for the user's shell.
  const providerGate = config.workspaceProviderGate;
  if (providerGate) {
    const {
      describeDroppedOverride,
      describeLegacyBaseUrl,
      describeReservedProvider,
      describeUnaffectedSelection,
      describeWithheldSelection,
      describeWorkspaceProvider,
    } = await import('../provider-approvals.js');
    const STATE_MARKS = {
      approved: { mark: '[x]', suffix: '' },
      rejected: { mark: '[-]', suffix: ' (rejected)' },
      pending: { mark: '[!]', suffix: ' (not in effect)' },
    } as const;
    const providerGroups = (['approved', 'rejected', 'pending'] as const).map((state) => ({
      ...STATE_MARKS[state],
      state,
      entries: providerGate.partition[state],
    }));
    const legacy = providerGate.legacyBaseUrl;
    const anyPending = providerGate.partition.pending.length > 0 || legacy?.state === 'pending';
    if (providerGate.declared.length > 0 || legacy) {
      console.log('Workspace-declared providers (require approval):');
      for (const group of providerGroups) {
        for (const entry of group.entries) {
          const routed =
            group.state === 'pending'
              ? providerGate.unaffectedSelections.filter((s) => s.providerId === entry.id)
              : [];
          const [first, ...rest] = describeWorkspaceProvider(entry, config.workspace, routed);
          console.log(`  ${group.mark} ${first}${group.suffix}`);
          for (const line of rest) console.log(`        ${line}`);
          console.log(`        declared in: ${entry.layers.join(', ')}`);
        }
      }
      for (const entry of providerGate.partition.reserved) {
        console.log(`  [!] ${describeReservedProvider(entry)}`);
      }
      if (legacy) {
        const { mark, suffix } = STATE_MARKS[legacy.state];
        const [first, ...rest] = describeLegacyBaseUrl(legacy.baseUrl, {
          providers: settings.provider,
          workspace: config.workspace,
        });
        console.log(`  ${mark} ${first}${suffix}`);
        for (const line of rest) console.log(`      ${line}`);
      }
      for (const entry of providerGate.partition.pending) {
        // The command is on a line of its own: the id is repository-authored, and a line copied
        // whole must not carry it into the shell beside the command.
        const { command, note } = providerTrustCommand(config.workspace, entry.id);
        console.log(`  Approve ${renderUntrustedText(entry.id, 64)}:`);
        console.log(`    ${command}${note}`);
      }
      if (legacy?.state === 'pending') {
        console.log(
          approvalHint('  Approve the legacy baseUrl:', config.workspace, 'provider .bookrc.json'),
        );
      }
      if (anyPending) {
        console.log(
          approvalHint('  Approve all pending:', config.workspace, 'provider --all-pending') +
            ' (add --reject to refuse)',
        );
      }
      console.log();
    }
    if (providerGate.droppedOverrides.length > 0) {
      console.log('Workspace overrides of your providers (dropped):');
      for (const dropped of providerGate.droppedOverrides) {
        console.log(`  [!] ${describeDroppedOverride(dropped)}`);
      }
      console.log();
    }
    if (providerGate.withheldSelections.length > 0) {
      console.log('Withheld model selections:');
      for (const selection of providerGate.withheldSelections) {
        console.log(`  [!] ${describeWithheldSelection(selection)}`);
      }
      console.log();
    }
    if (providerGate.unaffectedSelections.length > 0) {
      console.log('Your model selections that share a prefix with a withheld provider:');
      for (const selection of providerGate.unaffectedSelections) {
        console.log(`  [x] ${describeUnaffectedSelection(selection)}`);
      }
      console.log();
    }
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
  const { createSandbox, describeSandboxBackend, sandboxPolicySummary } =
    await import('../sandbox.js');
  const { hasAdjudicationPolicy } = await import('../permissions.js');
  const sandbox = createSandbox(settings.sandbox);
  const policy = sandboxPolicySummary(settings.sandbox, {
    sandboxActive: sandbox !== null,
    adjudicationConfigured: hasAdjudicationPolicy(settings),
  });
  console.log('Sandbox:');
  console.log('  Enabled: ' + settings.sandbox.enabled);
  console.log('  Backend: ' + describeSandboxBackend());
  console.log('  Available: ' + (sandbox !== null));
  if (sandbox) console.log('  Enforcing: ' + sandbox.describe());
  console.log('  Excluded commands: ' + settings.sandbox.excludedCommands.length);
  console.log('  Unsandboxed commands: ' + policy.unsandboxedCommands);
  console.log('  Auto-allow Bash: ' + policy.autoAllowBash);
  console.log('  Git directories: ' + policy.gitDirectories);
  // The loader drops every `sandbox.*` key a workspace layer supplied in order
  // to *loosen* the policy (#373), and a silently dropped key is
  // indistinguishable from a setting that does nothing. The list is computed
  // from the raw layer files by the same function the loader applies, so what
  // is reported here is exactly what was dropped.
  //
  // The layers come from `settingsLayers`, which is the one place that knows how
  // the paths are resolved — this section used to rebuild the two workspace ones
  // by hand, and printed the workspace-relative name rather than the file it
  // read, so a report about a file the user could not find was the whole output.
  if (!options.noSettings) {
    const {
      formatIgnoredWorkspaceSandboxKey,
      ignoredWorkspaceSandboxKeys,
      loadSettingsFile,
      workspaceLayerThatEnabledSandbox,
    } = await import('../settings-loader.js');
    const layers = (await settingsLayers(config.workspace)).map(([label, path]) => ({
      label,
      path,
      document:
        (label === 'Project' && isUserSettingsFile(path, config.workspace)) ||
        (label === 'User' && userShipped)
          ? null
          : loadSettingsFile(path),
    }));
    // The user-global layer is read here even though nothing about it is
    // reported: it is the baseline for what a workspace layer turned *on*, and
    // a repository repeating `enabled: true` after the user already set it
    // changed nothing, which is not a decision to attribute to that repository.
    const activation = workspaceLayerThatEnabledSandbox(
      layers.map((layer) => ({
        path: layer.path,
        trust: WORKSPACE_LAYER_TRUST[layer.label] ?? 'local',
        document: layer.document,
      })),
    );
    for (const { label, path, document } of layers) {
      // The user-global layer is where these values are read from, so a key it
      // writes is never ignored and there is nothing to report for it.
      if (label === 'User') continue;
      for (const entry of ignoredWorkspaceSandboxKeys(document ?? {})) {
        console.log(
          `  Ignored from ${path}: ${formatIgnoredWorkspaceSandboxKey(entry)} — workspace settings may only tighten the sandbox; set it in ~/.book/settings.json or pass --settings`,
        );
      }
      // The one *honoured* sandbox key that still changes something else.
      // `enabled` is the only key a workspace layer may set, and the loader pairs
      // it with `autoAllowBashIfSandboxed: false` so the repository cannot
      // pre-approve the commands that follow its own sandbox. That is a policy
      // change with no symptom of its own, which is what the block above exists
      // to make visible — reported for the layer that actually flipped the key
      // on, and only for that one.
      if (path === activation) {
        console.log(
          `  From ${path}: sandbox.enabled=true — a workspace file turned the sandbox on, so ` +
            `sandbox.autoAllowBashIfSandboxed=false with it; set autoAllowBashIfSandboxed in ` +
            `~/.book/settings.json to have it back.`,
        );
      }
    }
  }
  console.log();

  // Shell: the program every Bash command is handed to, and why it was chosen.
  const { describeShell, resolveShell } = await import('../shell-selection.js');
  const shell = config.shell ?? resolveShell({ requested: settings.shell });
  console.log('Shell:');
  console.log('  Bash tool runs: ' + describeShell(shell));
  console.log('  Selected by: ' + shell.source);
  // The MSYS-runtime flag decides whether `'` is read as on Linux under a Windows bash or sh (#566).
  if (process.platform === 'win32' && (shell.kind === 'bash' || shell.kind === 'sh')) {
    console.log('  msys: ' + (shell.msys ? 'yes' : 'no'));
  }
  if (shell.warning) console.log(`  [!] ${shell.warning}`);
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

  // Learned context windows.
  const { createModelWindowStore } = await import('../model-window-store.js');
  const windowStore = createModelWindowStore();
  const allLearned = windowStore.all();
  const learnedModels = Object.keys(allLearned);
  console.log('Learned context windows:');
  if (learnedModels.length === 0) {
    console.log('  (none)');
  } else {
    for (const modelName of learnedModels) {
      const entry = windowStore.getEntry(modelName) ?? allLearned[modelName];
      console.log(
        `  ${modelName}: ${entry.contextWindow.toLocaleString()} tokens (${formatRelativeTime(entry.learnedAt)})`,
      );
    }
  }
  console.log();

  // Memory.
  const {
    DEFAULT_MAX_INDEX_LINES,
    MAX_INDEX_BYTES,
    findLegacyMemoryBackup,
    getMemoryHealth,
    legacyBackupNotice,
    loadMemoryContext,
  } = await import('../memory-store.js');
  // Loaded first so a directory keyed the old way is moved (and migrated) before it is counted,
  // as at session start.
  const memoryContext = loadMemoryContext(config.workspace);
  const memoryHealth = getMemoryHealth(memoryContext);
  const memoryBackup = findLegacyMemoryBackup(memoryContext.dir);
  const lastWrite = memoryHealth.lastWrite ? memoryHealth.lastWrite.toISOString() : 'never';
  console.log('Memory:');
  console.log('  Memories:          ' + memoryHealth.fileCount);
  if (memoryHealth.legacySupersededCount > 0) {
    console.log(
      `  Legacy superseded: ${memoryHealth.legacySupersededCount} (retired by the old save tool; they load like any other)`,
    );
  }
  console.log(`  Index lines:       ${memoryHealth.indexLineCount} / ${DEFAULT_MAX_INDEX_LINES}`);
  console.log(
    `  Index bytes:       ${memoryHealth.indexByteCount.toLocaleString('en-US')} / ${MAX_INDEX_BYTES.toLocaleString('en-US')}`,
  );
  if (memoryHealth.wasLineTruncated || memoryHealth.wasByteTruncated) {
    const limits = [
      memoryHealth.wasLineTruncated ? `${DEFAULT_MAX_INDEX_LINES} lines` : '',
      memoryHealth.wasByteTruncated ? `${MAX_INDEX_BYTES.toLocaleString('en-US')} bytes` : '',
    ].filter(Boolean);
    console.log(
      `  Index cut:         MEMORY.md is over the ${limits.join(' and ')} limit; a session loads only part of it. Consolidate it.`,
    );
  }
  console.log('  Last write:        ' + lastWrite);
  if (memoryBackup) console.log('  ' + legacyBackupNotice(memoryBackup));
  console.log();

  // The live-session registry the TUI writes (#620). Doctor only reports it: the directory is not
  // created, and records whose process is gone are not swept.
  console.log('Live sessions: ' + (await describeLiveSessions()));
  for (const line of await describeMessaging(
    settings.messaging.enabled,
    config.workspace,
    options.noSettings,
  )) {
    console.log(line);
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
