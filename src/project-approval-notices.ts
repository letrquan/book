/**
 * What a non-interactive host says about repository-declared configuration the
 * resolver withheld.
 *
 * Project-declared allow rules and hook entries need a one-time decision from
 * the user. Print and SDK runs cannot ask for one, so they report what they are
 * skipping and continue — otherwise the only symptom is a hook that silently
 * never fires. The two hosts said the same thing in the same twenty lines, and
 * each re-read and re-parsed `.book/settings.json` once per gate; the notice
 * lives here so there is one wording and one read.
 */
import { join } from 'path';
import { collectSkippedInstructionNotices } from './claude-md.js';
import { collectSkippedCommandNotices } from './commands/loader.js';
import { collectDeclaredDirectories, partitionProjectDirectories } from './additional-roots.js';
import { collectDeclaredHooks, partitionProjectHooks } from './hook-approvals.js';
import { partitionProjectAllowRules } from './permission-approvals.js';
import {
  describeApiKeyDeclaration,
  describeDroppedOverride,
  describeOrigin,
  describeReservedProvider,
  describeUnaffectedSelection,
  describeWithheldSelection,
  LEGACY_BASE_URL_ID,
  type WorkspaceProviderGate,
} from './provider-approvals.js';
import { renderUntrustedText } from './hook-approvals.js';
import { collectSkippedReviewNotices } from './review/config.js';
import { providerTrustCommand } from './trust-command.js';
import {
  formatIgnoredWorkspaceSandboxKey,
  ignoredWorkspaceSandboxKeys,
  isUserSettingsFile,
  loadSettingsFile,
  settingsLayerPaths,
  workspaceLayerThatEnabledSandbox,
} from './settings-loader.js';
import { TRUSTED_SETTINGS_LOCATION } from './settings-scope.js';
import type { ResolvedSettings } from './settings.js';

export interface WithheldProjectDeclarations {
  workspace: string;
  settings: ResolvedSettings;
  /** False under `--no-settings`, where no layer was read in the first place. */
  settingsEnabled: boolean;
  /**
   * What the provider gate withheld and dropped (`AgentConfig.workspaceProviderGate`). Omitted
   * by a host that has no config to read it from, which then reports no provider notices.
   */
  providerGate?: WorkspaceProviderGate;
}

/**
 * One warning per provider-gate outcome the user can act on (#418), each naming the command that
 * decides it. A provider the user rejected is not reported again, as a rejected hook is not, and
 * neither is a model selection that fell back because of one: the user already decided.
 */
export function collectWithheldProviderNotices(
  gate: WorkspaceProviderGate,
  workspace: string,
): string[] {
  const notices: string[] = [];
  // Every command a notice suggests is built here: a provider id is repository-authored, and
  // pasting one unquoted would run whatever a hostile id spells.
  const approveCommand = (id: string): string => {
    const { command, note } = providerTrustCommand(workspace, id);
    return `\`${command}\`${note}`;
  };

  for (const dropped of gate.droppedOverrides) {
    notices.push(`⚠  ${describeDroppedOverride(dropped)}`);
  }

  for (const entry of gate.partition.reserved) {
    notices.push(`⚠  ${describeReservedProvider(entry)}`);
  }

  const pendingIds = new Set(gate.partition.pending.map((entry) => entry.id));
  for (const entry of gate.partition.pending) {
    const id = renderUntrustedText(entry.id, 64);
    const origin = entry.declaration.baseURL ?? entry.declaration.baseUrl;
    notices.push(
      `⚠  Ignoring workspace-declared provider "${id}" (${describeOrigin(origin)}, key: ${describeApiKeyDeclaration(
        entry.declaration.apiKey,
        workspace,
      )}) from ` +
        `${entry.layers.map((layer) => renderUntrustedText(layer)).join(', ')}: it requires ` +
        `approval. Run ${approveCommand(entry.id)} to review and approve it.`,
    );
  }

  for (const selection of gate.withheldSelections) {
    if (!pendingIds.has(selection.providerId)) continue;
    notices.push(
      `⚠  ${describeWithheldSelection(selection)} Run ${approveCommand(selection.providerId)} ` +
        'to approve it.',
    );
  }

  // The user's own selections that merely share a prefix with a withheld provider are not
  // changed; saying so once is what tells them the withheld provider is not what they chose.
  for (const selection of gate.unaffectedSelections) {
    if (!pendingIds.has(selection.providerId)) continue;
    notices.push(`⚠  ${describeUnaffectedSelection(selection)}`);
  }

  if (gate.legacyBaseUrl?.state === 'pending') {
    notices.push(
      `⚠  Ignoring baseUrl "${renderUntrustedText(gate.legacyBaseUrl.baseUrl)}" from ` +
        `${LEGACY_BASE_URL_ID}: it would receive BOOK_API_KEY, so it requires approval. Run ` +
        `${approveCommand(LEGACY_BASE_URL_ID)} to review and approve it.`,
    );
  }

  return notices;
}

/**
 * One warning per withheld declaration, in the order a host should print them.
 *
 * Empty under `--no-settings`: nothing was withheld for want of approval there,
 * because no settings layer was read at all. Reporting a pending approval then
 * would send the user after a decision that changes nothing — and, since the
 * decision store is the empty default too, would also announce hooks the user
 * has already approved as if they were awaiting a first decision.
 */
export function collectWithheldProjectNotices(input: WithheldProjectDeclarations): string[] {
  // `--no-settings` reads no layer, so the gate holds nothing but the legacy `.bookrc.json`
  // `baseUrl`, which is ignored until approved whether or not a settings layer was read.
  const providerNotices = input.providerGate
    ? collectWithheldProviderNotices(input.providerGate, input.workspace)
    : [];
  if (!input.settingsEnabled) return providerNotices;

  const projectPath = join(input.workspace, '.book', 'settings.json');
  // At `$HOME` this is the user's own file, which the loader read as the user layer and
  // withheld nothing from (#429).
  const projectSettings = isUserSettingsFile(projectPath) ? null : loadSettingsFile(projectPath);
  const notices: string[] = [];

  const allow = partitionProjectAllowRules(
    projectSettings?.permissions?.allow ?? [],
    input.settings.permissions.projectAllowRules,
  );
  for (const rule of allow.pending) {
    notices.push(
      `⚠  Ignoring project-declared permission rule "${rule}": it requires approval. Run \`book doctor\` to see how to grant it.`,
    );
  }

  const hooks = partitionProjectHooks(
    collectDeclaredHooks(projectSettings),
    input.settings.hooks.projectEntries,
  );
  if (hooks.pending.length > 0) {
    const byEvent = new Map<string, number>();
    for (const hook of hooks.pending) {
      byEvent.set(hook.event, (byEvent.get(hook.event) ?? 0) + 1);
    }
    const summary = [...byEvent].map(([event, count]) => `${event} x${count}`).join(', ');
    notices.push(
      `⚠  Ignoring ${hooks.pending.length} project-declared hook(s) (${summary}):` +
        ' hooks require approval. Run `book doctor` to approve them.',
    );
  }

  // A withheld `additionalDirectories` entry is the one that has no other symptom: the run
  // simply cannot see the directory, and the model reports the file as missing rather than as
  // un-approved. The notice names the real path, because that is what the decision is keyed by.
  const directories = partitionProjectDirectories(
    collectDeclaredDirectories(input.workspace, projectSettings?.additionalDirectories ?? []),
    input.settings.projectDirectories,
  );
  for (const directory of directories.pending) {
    notices.push(
      `⚠  Ignoring project-declared additionalDirectories entry "${directory.declared}"` +
        ` (really ${directory.realPath}): it requires approval. Run \`book doctor\` to see how to grant it.`,
    );
  }

  // A withheld sandbox key is the quietest of the three families, and the most
  // misleading without a word: the session is simply *less* protected than the
  // repository says, so nothing fails and the run looks ordinary. Reported with
  // the values the file wrote — a key named alone does not tell the reader
  // whether the repository was asking for the sandbox or for its absence — and
  // with the file the value has to go in, since the layer it came from is not
  // where Book reads it from.
  //
  // Both workspace layers are read. The loader filters the sandbox keys of the
  // local one exactly as it does the project one — `.gitignore` does not stop a
  // force-added `settings.local.json` from reaching a clone — so a local file
  // asking to widen the sandbox was being stripped in silence, which is the one
  // symptom these notices exist to remove. The file is named because there are
  // now two of them and the reader has to know which to edit.
  const ignoredSandboxKeys = ignoredWorkspaceSandboxKeys(projectSettings ?? {});
  if (ignoredSandboxKeys.length > 0) {
    const listed = ignoredSandboxKeys.map(formatIgnoredWorkspaceSandboxKey).join(', ');
    notices.push(
      `⚠  Ignoring sandbox settings declared by ${projectPath}: ${listed}. ` +
        `A file inside the workspace may turn the sandbox on and add deny entries, but not loosen it. ` +
        TRUSTED_SETTINGS_LOCATION,
    );
  }
  const localPath = join(input.workspace, '.book', 'settings.local.json');
  const localSettings = loadSettingsFile(localPath);
  const ignoredLocalSandboxKeys = ignoredWorkspaceSandboxKeys(localSettings ?? {});
  if (ignoredLocalSandboxKeys.length > 0) {
    const listed = ignoredLocalSandboxKeys.map(formatIgnoredWorkspaceSandboxKey).join(', ');
    notices.push(
      `⚠  Ignoring sandbox settings declared by ${localPath}: ${listed}. ` +
        `A file inside the workspace may turn the sandbox on and add deny entries, but not loosen it. ` +
        TRUSTED_SETTINGS_LOCATION,
    );
  }

  // `sandbox.enabled` is the one key a workspace layer may set, and the loader
  // pairs it with `autoAllowBashIfSandboxed: false` so a repository cannot
  // pre-approve the commands that follow its own sandbox (#373). That is a
  // policy change with no other symptom: every command is still sandboxed and
  // still succeeds, and the user simply stops being asked. Only the layer that
  // actually flipped `enabled` is reported — a repository repeating a key the
  // user already set changed nothing, and saying otherwise on every run is how a
  // notice gets ignored.
  //
  // The user-global layer is the baseline the question needs: whether a
  // workspace layer *turned the sandbox on* depends on what the trusted layers
  // had already decided, and a report that omitted it would name a repository for
  // the user's own decision. Its path comes from the loader, the one place that
  // knows how that file is resolved.
  const userPath = settingsLayerPaths(input.workspace)[0];
  const activation = workspaceLayerThatEnabledSandbox([
    { path: userPath, trust: 'trusted', document: loadSettingsFile(userPath) },
    { path: projectPath, trust: 'repository', document: projectSettings },
    { path: localPath, trust: 'local', document: localSettings },
  ]);
  if (activation) {
    notices.push(
      `⚠  ${activation} declared sandbox.enabled=true, so sandbox.autoAllowBashIfSandboxed is ` +
        `false for this session: no Bash command is auto-approved. ${TRUSTED_SETTINGS_LOCATION}`,
    );
  }

  return [...notices, ...providerNotices];
}

/**
 * One warning per project file the loaders refused because it links out of the repository or to
 * a file that is not Markdown (#539, #543): instruction files, REVIEW.md and project command
 * files. Not tied to `--no-settings`: they are read whatever the settings layers are.
 */
export function collectSkippedProjectFileNotices(workspace: string): string[] {
  return [
    ...collectSkippedInstructionNotices(workspace),
    ...collectSkippedReviewNotices(workspace),
    ...collectSkippedCommandNotices(workspace),
  ];
}
