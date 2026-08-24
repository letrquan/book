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
import { collectDeclaredHooks, partitionProjectHooks } from './hook-approvals.js';
import { partitionProjectAllowRules } from './permission-approvals.js';
import { loadSettingsFile } from './settings-loader.js';
import type { ResolvedSettings } from './settings.js';

export interface WithheldProjectDeclarations {
  workspace: string;
  settings: ResolvedSettings;
  /** False under `--no-settings`, where no layer was read in the first place. */
  settingsEnabled: boolean;
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
  if (!input.settingsEnabled) return [];

  const projectSettings = loadSettingsFile(join(input.workspace, '.book', 'settings.json'));
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

  return notices;
}
