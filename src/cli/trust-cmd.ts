/**
 * `book trust` — record a decision about repository-declared configuration.
 *
 * The gated input is a hook entry, a `permissions.allow` rule, or a project
 * command whose body substitutes shell; until a decision exists, the resolver
 * withholds it. Doctor reports what is withheld and prints the command that
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
} from '../hook-approvals.js';
import {
  partitionProjectAllowRules,
  persistProjectAllowRuleChoice,
} from '../permission-approvals.js';
import { loadSettingsFile, resolveSettings } from '../settings-loader.js';
import type { SlashCommand } from '../types/commands.js';
import { exit } from './exit.js';

export type TrustKind = 'hook' | 'rule' | 'command';

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
  if (!options.allPending && target === undefined) {
    fail(
      `book trust ${kind}: name what to trust, or pass --all-pending. Run \`book doctor\` to list what is withheld.`,
    );
  }

  let settings;
  try {
    settings = resolveSettings(workspace);
  } catch (error) {
    return fail(
      `book trust ${kind}: cannot read settings for ${workspace}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Only the checked-in layer is gated, so only its declarations are decidable.
  const projectSettings = loadSettingsFile(join(workspace, '.book', 'settings.json'));

  // A command decision carries the fingerprint of the shell it was made
  // against, so the body cannot change under an approval already on file.
  const decisions: Array<{ key: string; label: string; fingerprint?: string }> = [];

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
  for (const decision of decisions) {
    const result =
      kind === 'command'
        ? persistProjectCommandChoice(workspace, decision.key, decision.fingerprint!, choice)
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
