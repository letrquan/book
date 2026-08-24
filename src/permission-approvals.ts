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
 * decision, keyed by the exact rule text and recorded in the user-global trust
 * store, outside the workspace, where nothing the repository ships can reach it
 * (see `workspace-trust.ts`).
 *
 * `ask` and `deny` need no gate: they only ever restrict.
 */
import type { ProjectAllowRuleChoice } from './settings.js';
import { updateWorkspaceTrust } from './workspace-trust.js';

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

/**
 * Record an approve/reject decision for one rule, leaving every other recorded
 * decision — in this workspace and in every other — untouched.
 */
export function persistProjectAllowRuleChoice(
  workspace: string,
  rule: string,
  choice: ProjectAllowRuleChoice,
  options: { trustStorePath?: string } = {},
): { ok: boolean; error?: string } {
  return updateWorkspaceTrust(
    workspace,
    (trust) => {
      trust.permissionAllowRules[rule] = choice;
    },
    options.trustStorePath,
  );
}
