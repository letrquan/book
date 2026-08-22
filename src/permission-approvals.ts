/**
 * Trust decisions for permission allow-rules declared by a repository.
 *
 * `permissions.allow` entries accumulate across settings layers, so a rule in a
 * cloned repository's checked-in `.book/settings.json` would otherwise widen the
 * effective allow list — reaching the same outcome as the `bypassPermissions`
 * default mode that project layers are already forbidden to select. Once merged
 * a rule carries no provenance, so nothing downstream can tell a repository's
 * grant from the user's own.
 *
 * Project-declared allow rules therefore require a one-time per-workspace
 * decision, recorded in `.book/settings.local.json` under
 * `permissions.projectAllowRules`. That file is gitignored and the repository
 * layer is forbidden from writing the key, so the gated party cannot self-approve.
 *
 * `ask` and `deny` need no gate: they only ever restrict.
 */
import { join } from 'path';
import { formatSettingsDiagnostics, SettingsRepository } from './settings-repository.js';
import type { ProjectAllowRuleChoice } from './settings.js';

/** Recorded decisions, keyed by the exact rule text. */
export type ProjectAllowRuleStore = Record<string, ProjectAllowRuleChoice>;

export type ProjectAllowRuleState = ProjectAllowRuleChoice | 'unknown';

export function evaluateProjectAllowRule(
  store: ProjectAllowRuleStore | undefined,
  rule: string,
): ProjectAllowRuleState {
  return store?.[rule] ?? 'unknown';
}

export interface ProjectAllowRulePartition {
  /** Approved by the user: these join the resolved allow list. */
  approved: string[];
  /** No decision recorded: withheld until the user makes one. */
  pending: string[];
  /** Explicitly refused: withheld, and not re-offered. */
  rejected: string[];
}

export function partitionProjectAllowRules(
  rules: readonly string[],
  store: ProjectAllowRuleStore | undefined,
): ProjectAllowRulePartition {
  const partition: ProjectAllowRulePartition = { approved: [], pending: [], rejected: [] };
  for (const rule of rules) {
    const state = evaluateProjectAllowRule(store, rule);
    if (state === 'approved') partition.approved.push(rule);
    else if (state === 'rejected') partition.rejected.push(rule);
    else partition.pending.push(rule);
  }
  return partition;
}

/** Record an approve/reject decision in the project-local settings layer. */
export function persistProjectAllowRuleChoice(
  workspace: string,
  rule: string,
  choice: ProjectAllowRuleChoice,
): { ok: boolean; error?: string } {
  const path = join(workspace, '.book', 'settings.local.json');
  const result = new SettingsRepository(path).update((candidate) => {
    const permissions = (candidate.permissions ??= {}) as Record<string, unknown>;
    if (typeof permissions !== 'object' || Array.isArray(permissions)) {
      throw new Error('settings.local.json "permissions" must be an object');
    }
    const store = (permissions.projectAllowRules ??= {}) as Record<string, unknown>;
    store[rule] = choice;
  });
  return result.ok
    ? { ok: true }
    : { ok: false, error: formatSettingsDiagnostics(result.diagnostics) };
}
