import type { ToolResult } from '../types/tools.js';
import { NETWORK_POLICY_REMEDIES, networkPolicyRefusal } from '../tools/web-policy.js';

/**
 * Why a call was refused (`status: 'blocked'`), grouped by what lifts it. Each kind has its own
 * remedy, because a streak of refusals that stops an unattended run is only actionable if the stop
 * message names the right one: "grant the permission" does nothing for a hook, a tool policy or a
 * call that never parsed.
 */
export type RefusalKind =
  | 'permission'
  | 'hook'
  | 'inactive'
  | 'capability'
  | 'skill'
  | 'question'
  | 'malformed'
  | 'fetch'
  | 'search'
  | 'other';

/**
 * A blocked result that is not a refusal: WebFetch stopping at a cross-origin redirect hands the
 * model the next URL, so a model following a redirect chain one hop per turn is making progress
 * and must not feed the refusal brake.
 */
export function isRefusal(
  result: Pick<ToolResult, 'status' | 'structuredError'> | undefined,
): boolean {
  return result?.status === 'blocked' && result.structuredError?.code !== 'cross_origin_redirect';
}

/** Which kind of refusal a blocked tool result is. Anything unrecognised counts as `other`. */
export function refusalKind(
  result: Pick<ToolResult, 'status' | 'structuredError'> | undefined,
): RefusalKind {
  const network = networkPolicyRefusal(result);
  if (network) return network;
  switch (result?.structuredError?.code) {
    case 'permission_denied':
      return 'permission';
    case 'hook_blocked':
      return 'hook';
    case 'tool_not_active':
      return 'inactive';
    case 'capability_denied':
    case 'child_agent_unavailable':
      return 'capability';
    case 'skill_execution_denied':
    case 'skill_tool_intersection_empty':
      return 'skill';
    case 'user_questions_disabled':
    case 'user_declined':
      return 'question';
    case 'invalid_json_arguments':
      return 'malformed';
    default:
      return 'other';
  }
}

/** What lifts each kind of refusal, worded to follow "Nothing can proceed: ". Listed in this order. */
export const REFUSAL_REMEDIES: Readonly<Record<RefusalKind, string>> = {
  permission:
    'grant the permission, add an allow rule, or change the permission mode (a permissions.deny rule is lifted only by changing that rule)',
  hook: 'a PreToolUse hook refused the calls, which no permission rule or mode lifts; change or remove that hook',
  inactive:
    "the calls named tools that were not active for the turn, which no permission rule or mode changes; the model has to activate them with ToolSearch first, and the run's allowed tools (--allowedTools, or a skill's or command's allowed-tools) must include them",
  capability:
    "the calls are outside this agent's tool policy (its profile or definition), which no permission rule or mode lifts; give the step to an agent whose policy allows it",
  skill:
    "a skill's activation policy or allowed-tools refused the calls, which no permission rule or mode lifts; change that skill's override under skills.overrides or its allowed-tools",
  question:
    'the model asked the user questions this run cannot put to anyone (dontAsk mode, or a declined question); it has to proceed without asking',
  malformed:
    "the calls' arguments never parsed as JSON, which no permission rule or mode lifts; the model has to resend them whole, and if `book tool-stats` shows invalid_json_arguments:truncated_start the provider route is dropping the first fragment of calls",
  ...NETWORK_POLICY_REMEDIES,
  other:
    "the calls were refused for a reason no permission rule or mode lifts; each refused call's own message names the cause",
};

/** The order remedies are listed in when a streak mixes kinds: the order of REFUSAL_REMEDIES. */
export const REFUSAL_KIND_ORDER = Object.keys(REFUSAL_REMEDIES) as RefusalKind[];
