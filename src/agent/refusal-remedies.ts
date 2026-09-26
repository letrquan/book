import type { ToolResult } from '../types/tools.js';
import { NETWORK_POLICY_REMEDIES, networkPolicyRefusal } from '../tools/web-policy.js';

/**
 * Why a call was refused (`status: 'blocked'`), grouped by what lifts it. Each kind has its own
 * remedy, because a streak of refusals that stops an unattended run is only actionable if the stop
 * message names the right one: "grant the permission" does nothing for a hook or a tool policy.
 */
export type RefusalKind =
  'permission' | 'hook' | 'inactive' | 'capability' | 'redirect' | 'fetch' | 'search';

/** The order remedies are listed in when a streak mixes kinds. */
export const REFUSAL_KIND_ORDER: readonly RefusalKind[] = [
  'permission',
  'hook',
  'inactive',
  'capability',
  'redirect',
  'fetch',
  'search',
];

/** Which kind of refusal a blocked tool result is. Anything unrecognised counts as a permission. */
export function refusalKind(
  result: Pick<ToolResult, 'status' | 'structuredError'> | undefined,
): RefusalKind {
  const network = networkPolicyRefusal(result);
  if (network) return network;
  switch (result?.structuredError?.code) {
    case 'hook_blocked':
      return 'hook';
    case 'tool_not_active':
      return 'inactive';
    case 'capability_denied':
      return 'capability';
    case 'cross_origin_redirect':
      return 'redirect';
    default:
      return 'permission';
  }
}

/** What lifts each kind of refusal, worded to follow "Nothing can proceed: ". */
export const REFUSAL_REMEDIES: Readonly<Record<RefusalKind, string>> = {
  permission:
    'grant the permission, add an allow rule, or change the permission mode (a permissions.deny rule is lifted only by changing that rule)',
  hook: 'a PreToolUse hook refused the calls, which no permission rule or mode lifts; change or remove that hook',
  inactive:
    "the calls named tools that were not active for the turn, which no permission rule or mode changes; the model has to activate them with ToolSearch first, and the run's allowed tools (--allowedTools, or a skill's or command's allowed-tools) must include them",
  capability:
    "the calls are outside this agent's tool policy (its profile or definition), which no permission rule or mode lifts; give the step to an agent whose policy allows it",
  redirect:
    'WebFetch stopped at redirects to another origin, which it never follows on its own; the model has to call WebFetch again with the redirect target it was given',
  ...NETWORK_POLICY_REMEDIES,
};
