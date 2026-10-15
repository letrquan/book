/**
 * `book trust` — record a decision about repository-declared configuration.
 *
 * The gated input is a hook entry, a `permissions.allow` rule, a project
 * command whose body substitutes shell, a directory, or a provider only the
 * workspace declares (its origin and key reference; #418); until a decision
 * exists, the resolver withholds it. Doctor reports what is withheld and prints the command that
 * grants it, so this is the non-interactive half of that flow.
 *
 * Commands are keyed by name rather than by fingerprint. A hook or a rule is
 * anonymous — a fingerprint is the only handle it has — but a command already
 * has one the user typed, and asking them to paste a digest to approve
 * `/deploy` would be ceremony without a gain. The fingerprint still decides
 * *validity*: it is recorded with the choice and re-checked on every
 * invocation, so editing what the body runs re-asks under the same name.
 *
 * It replaces a printed `book config set hooks.projectEntries '<json>'`
 * one-liner, which was wrong in three ways: `config set` *replaces* the value
 * at a path, so pasting a map of newly-pending entries silently discarded every
 * earlier approve/reject; the suggestion omitted `--workspace`, so running it
 * from elsewhere wrote decisions into the wrong project; and its single-quoted
 * JSON does not survive `cmd.exe`, where quotes are literal and the argument
 * reaches validation as a string. Decisions here are recorded one at a time
 * through the per-key persist helpers, and a fingerprint is bare hex, so
 * nothing needs quoting.
 */
import { join } from 'path';
import {
  describeProjectCommandShell,
  displayableCommandName,
  partitionProjectCommands,
  persistProjectCommandChoice,
  projectCommandFingerprint,
} from '../command-approvals.js';
import { discoverCommands } from '../commands/loader.js';
import {
  collectDeclaredHooks,
  describeDeclaredHook,
  hookFingerprint,
  partitionProjectHooks,
  persistProjectHookChoice,
  renderUntrustedText,
} from '../hook-approvals.js';
import {
  collectDeclaredDirectories,
  partitionProjectDirectories,
  persistProjectDirectoryChoice,
  realPathOfDirectory,
  type DeclaredDirectory,
} from '../additional-roots.js';
import {
  partitionProjectAllowRules,
  persistProjectAllowRuleChoice,
} from '../permission-approvals.js';
import { readLegacyBaseUrl } from '../legacy-config.js';
import {
  describeLegacyBaseUrl,
  describeReservedProvider,
  describeWorkspaceProvider,
  environmentModelSelections,
  evaluateLegacyBaseUrl,
  LEGACY_BASE_URL_ID,
  legacyBaseUrlFingerprint,
  persistWorkspaceProviderChoice,
  withEnvironmentSelections,
  type WorkspaceProviderState,
} from '../provider-approvals.js';
import { providerTrustCommand, trustCommandText } from '../trust-command.js';
import {
  isUserSettingsFile,
  loadSettingsFile,
  resolveSettingsWithProviderGate,
} from '../settings-loader.js';
import type { SlashCommand } from '../types/commands.js';
import { exit } from './exit.js';

export type TrustKind = 'hook' | 'rule' | 'command' | 'dir' | 'provider';

export interface TrustCommandOptions {
  workspace: string;
  /** Record a refusal instead of an approval. */
  reject?: boolean;
  /** Apply the decision to everything currently withheld. */
  allPending?: boolean;
}

function fail(message: string): never {
  console.error(message);
  return exit(1);
}

export async function runTrustCommand(
  kind: TrustKind,
  target: string | undefined,
  options: TrustCommandOptions,
): Promise<void> {
  const workspace = options.workspace;
  const choice = options.reject ? 'rejected' : 'approved';
  const verb = options.reject ? 'Rejected' : 'Approved';

  if (options.allPending && target !== undefined) {
    fail(`book trust ${kind}: pass either a target or --all-pending, not both`);
  }
  // `provider` with neither is the listing: what is awaiting a decision, and the command for it.
  const listsProviders = kind === 'provider' && !options.allPending && target === undefined;
  if (!options.allPending && target === undefined && !listsProviders) {
    fail(
      `book trust ${kind}: name what to trust, or pass --all-pending. Run \`book doctor\` to list what is withheld.`,
    );
  }

  let settings;
  let providerGate;
  try {
    ({ settings, providerGate } = resolveSettingsWithProviderGate(workspace));
  } catch (error) {
    return fail(
      `book trust ${kind}: cannot read settings for ${workspace}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Only the checked-in layer is gated, so only its declarations are decidable. At `$HOME`
  // that path is the user's own file, which is trusted and has nothing to decide (#429).
  const projectPath = join(workspace, '.book', 'settings.json');
  const projectSettings = isUserSettingsFile(projectPath) ? null : loadSettingsFile(projectPath);

  // A command decision carries the fingerprint of the shell it was made
  // against, so the body cannot change under an approval already on file.
  const decisions: Array<{ key: string; label: string; fingerprint?: string }> = [];
  // Directories carry their real path as the key (see `additional-roots.ts`), so they get their
  // own list rather than borrowing the `{key, label}` shape whose key is a fingerprint.
  const directoryDecisions: DeclaredDirectory[] = [];

  if (kind === 'command') {
    // Commands are discovered from disk, not declared in settings: the gated
    // artefact is the `.book/commands/*.md` body itself.
    const partition = partitionProjectCommands(discoverCommands(workspace), settings);
    const push = (command: SlashCommand) => {
      // Approving is approving the shell, so the shell is what gets shown —
      // never just the name. The single-command path reaches here from a
      // refusal that already listed it; `--all-pending` has no such prior, and
      // a bulk grant against a list of names is approval without reading.
      if (!options.reject) {
        console.log(`/${displayableCommandName(command.name)} runs:`);
        for (const line of describeProjectCommandShell(command)) console.log(`  ${line}`);
      }
      decisions.push({
        key: command.name,
        label: `/${displayableCommandName(command.name)}`,
        fingerprint: projectCommandFingerprint(command.body),
      });
    };

    if (options.allPending) {
      if (partition.pending.length === 0) {
        console.log(`No project commands are awaiting a decision in ${workspace}.`);
        return;
      }
      for (const command of partition.pending) push(command);
    } else {
      const name = target!.replace(/^\//, '');
      const decidable = [...partition.pending, ...partition.approved, ...partition.rejected];
      const command = decidable.find((candidate) => candidate.name === name);
      if (!command) {
        // Either the command does not exist, or it substitutes no shell and so
        // has nothing to decide. Both mean this decision would change nothing.
        const known = partition.pending
          .map((pending) => `  /${displayableCommandName(pending.name)}`)
          .join('\n');
        return fail(
          `book trust command: ${workspace} has no project command "${name}" that runs shell.` +
            (known ? `\nAwaiting a decision:\n${known}` : '\nNothing is awaiting a decision.'),
        );
      }
      push(command);
    }
  } else if (kind === 'hook') {
    const declared = collectDeclaredHooks(projectSettings);
    const byFingerprint = new Map(
      declared.map((hook) => [hookFingerprint(hook.event, hook.entry), hook]),
    );
    const partition = partitionProjectHooks(declared, settings.hooks.projectEntries);

    if (options.allPending) {
      if (partition.pending.length === 0) {
        console.log(`No project-declared hooks are awaiting a decision in ${workspace}.`);
        return;
      }
      for (const hook of partition.pending) {
        const fingerprint = hookFingerprint(hook.event, hook.entry);
        decisions.push({ key: fingerprint, label: describeDeclaredHook(hook).headline });
      }
    } else {
      const hook = byFingerprint.get(target!);
      if (!hook) {
        // A typo would otherwise record a decision that matches no hook and
        // silently changes nothing.
        const known = partition.pending
          .map(
            (pending) =>
              `  ${hookFingerprint(pending.event, pending.entry)}  ${describeDeclaredHook(pending).headline}`,
          )
          .join('\n');
        return fail(
          `book trust hook: no project-declared hook in ${workspace} has fingerprint "${target}".` +
            (known ? `\nAwaiting a decision:\n${known}` : '\nNothing is awaiting a decision.'),
        );
      }
      decisions.push({ key: target!, label: describeDeclaredHook(hook).headline });
    }
  } else if (kind === 'dir') {
    // A directory is keyed by where it *really* is, not by the text the repository wrote, so the
    // target the user typed is resolved the same way the resolver resolves it and then matched
    // against the real paths: `./shared`, `shared` and the absolute path are one entry. Matching
    // the declared text too means a symlink repointed since approval can no longer be decided
    // under its old name. A path that no longer exists is a different matter: `collectDeclaredDirectories`
    // drops it, so it is simply not offered here — there is nothing left to decide about.
    const declared = collectDeclaredDirectories(
      workspace,
      projectSettings?.additionalDirectories ?? [],
    );
    const partition = partitionProjectDirectories(declared, settings.projectDirectories);
    const targetRealPath = realPathOfDirectory(workspace, target ?? '');
    const entry = declared.find(
      (candidate) => candidate.realPath === targetRealPath || candidate.declared === target,
    );

    if (options.allPending) {
      if (partition.pending.length === 0) {
        console.log(`No project-declared directories are awaiting a decision in ${workspace}.`);
        return;
      }
      for (const pending of partition.pending) {
        console.log(`${pending.declared} is really:`);
        console.log(`  ${pending.realPath}`);
        directoryDecisions.push(pending);
      }
    } else if (!entry) {
      const known = partition.pending.map((pending) => `  ${pending.realPath}`).join('\n');
      return fail(
        `book trust dir: ${workspace} declares no project additionalDirectories entry at "${target}".` +
          (known ? `\nAwaiting a decision:\n${known}` : '\nNothing is awaiting a decision.'),
      );
    } else {
      if (!options.reject) {
        console.log(`${entry.declared} is really:`);
        console.log(`  ${entry.realPath}`);
      }
      directoryDecisions.push(entry);
    }
  } else if (kind === 'provider') {
    // Providers only the workspace declares, plus the legacy `.bookrc.json` `baseUrl` under its
    // own id. A provider a trusted layer defines has nothing to decide: its origin and key are
    // the user's, and a workspace layer's override of them is dropped whatever is recorded here.
    interface ProviderCandidate {
      id: string;
      fingerprint: string;
      state: WorkspaceProviderState;
      /** What approving it would do, first line then detail. */
      lines: string[];
    }
    // The user's own selections that share a prefix with a withheld provider: approving the
    // provider routes them to its origin, so the listing names them.
    const unaffected = withEnvironmentSelections(
      providerGate.unaffectedSelections,
      environmentModelSelections(undefined),
      new Set(providerGate.withheld),
    );
    const candidates: ProviderCandidate[] = (['approved', 'pending', 'rejected'] as const).flatMap(
      (state) =>
        providerGate.partition[state].map((entry) => ({
          id: entry.id,
          fingerprint: entry.fingerprint,
          state,
          lines: describeWorkspaceProvider(
            entry,
            workspace,
            unaffected.filter((selection) => selection.providerId === entry.id),
          ),
        })),
    );
    // Parsed by the loader's own parser, so the fingerprint is the one the loader checks.
    const legacyBaseUrl = readLegacyBaseUrl(workspace);
    if (legacyBaseUrl !== undefined) {
      candidates.push({
        id: LEGACY_BASE_URL_ID,
        fingerprint: legacyBaseUrlFingerprint(legacyBaseUrl),
        state: evaluateLegacyBaseUrl(settings.workspaceProviders, legacyBaseUrl),
        lines: describeLegacyBaseUrl(legacyBaseUrl, { providers: settings.provider, workspace }),
      });
    }
    const pending = candidates.filter((candidate) => candidate.state === 'pending');
    const printCandidate = (candidate: ProviderCandidate, prefix: string) => {
      const [first, ...rest] = candidate.lines;
      console.log(`${prefix}${first}`);
      for (const line of rest) console.log(`      ${line}`);
    };
    const push = (candidate: ProviderCandidate) => {
      // Approving sends the user's requests, and the key a reference names, to the origin shown,
      // so that is what gets shown before the decision is recorded.
      if (!options.reject) printCandidate(candidate, '  ');
      decisions.push({
        key: candidate.id,
        label: candidate.id,
        fingerprint: candidate.fingerprint,
      });
    };
    // A provider named like the legacy decision's key can never be approved (see the partition),
    // so it is reported rather than offered.
    const reserved = providerGate.partition.reserved.map(
      (entry) => `  [!] ${describeReservedProvider(entry)}`,
    );

    if (listsProviders) {
      for (const line of reserved) console.log(line);
      if (pending.length === 0) {
        console.log(`No workspace-declared providers are awaiting a decision in ${workspace}.`);
        return;
      }
      console.log(`Workspace-declared providers awaiting a decision in ${workspace}:`);
      for (const candidate of pending) printCandidate(candidate, '  [!] ');
      // The id is repository-authored: it is quoted for the shell, or left off the line when it
      // cannot be quoted, so a copied command cannot run what a hostile id spells.
      for (const candidate of pending) {
        const { command, note } = providerTrustCommand(workspace, candidate.id);
        console.log(`Approve ${renderUntrustedText(candidate.id, 64)}:`);
        console.log(`  ${command}${note}`);
      }
      const all = trustCommandText(workspace, 'provider --all-pending');
      console.log(`Approve all: ${all.command}${all.note}   (add --reject to refuse)`);
      return;
    }
    if (options.allPending) {
      if (pending.length === 0) {
        console.log(`No workspace-declared providers are awaiting a decision in ${workspace}.`);
        return;
      }
      for (const candidate of pending) push(candidate);
    } else {
      const candidate = candidates.find((known) => known.id === target);
      if (!candidate) {
        // A typo would otherwise record a decision that matches no provider.
        const known = candidates
          .map((entry) => `  ${renderUntrustedText(entry.id, 64)}  (${entry.state})`)
          .join('\n');
        return fail(
          `book trust provider: ${workspace} declares no provider "${target}" that can be decided.` +
            (known ? `\nDeclared by the workspace:\n${known}` : '\nNothing is declared.') +
            (reserved.length > 0 ? `\n${reserved.join('\n')}` : ''),
        );
      }
      push(candidate);
    }
  } else {
    const declared = projectSettings?.permissions?.allow ?? [];
    const partition = partitionProjectAllowRules(declared, settings.permissions.projectAllowRules);

    if (options.allPending) {
      if (partition.pending.length === 0) {
        console.log(`No project-declared allow rules are awaiting a decision in ${workspace}.`);
        return;
      }
      for (const rule of partition.pending) decisions.push({ key: rule, label: rule });
    } else {
      if (!declared.includes(target!)) {
        const known = partition.pending.map((rule) => `  ${rule}`).join('\n');
        return fail(
          `book trust rule: ${workspace} declares no project allow rule "${target}".` +
            (known ? `\nAwaiting a decision:\n${known}` : '\nNothing is awaiting a decision.'),
        );
      }
      decisions.push({ key: target!, label: target! });
    }
  }

  const failures: string[] = [];
  for (const directory of directoryDecisions) {
    const result = persistProjectDirectoryChoice(workspace, directory.realPath, choice);
    if (result.ok) console.log(`${verb} ${directory.realPath}`);
    else failures.push(`${directory.realPath}: ${result.error ?? 'unknown error'}`);
  }
  for (const decision of decisions) {
    const result =
      kind === 'command'
        ? persistProjectCommandChoice(workspace, decision.key, decision.fingerprint!, choice)
        : kind === 'provider'
          ? persistWorkspaceProviderChoice(workspace, decision.key, decision.fingerprint!, choice)
          : kind === 'hook'
            ? persistProjectHookChoice(workspace, decision.key, choice)
            : persistProjectAllowRuleChoice(workspace, decision.key, choice);
    if (result.ok) console.log(`${verb} ${decision.label}`);
    else failures.push(`${decision.label}: ${result.error ?? 'unknown error'}`);
  }

  if (failures.length > 0) {
    fail(
      `Failed to record ${failures.length} decision(s):\n${failures.map((f) => `  ${f}`).join('\n')}`,
    );
  }
}
