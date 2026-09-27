import type { ToolResult } from '../types/tools.js';
import { foldControlCharacters } from '../control-characters.js';
import { toolFailure } from '../tools/result.js';
import { networkPolicyRefusal, type NetworkPolicyRefusal } from '../tools/web-policy.js';

/**
 * Why a call was refused (`status: 'blocked'`), grouped by what lifts it. Each kind has its own
 * remedy, because a streak of refusals that stops an unattended run is only actionable if the stop
 * message names the right one: "grant the permission" does nothing for a hook, a tool policy or a
 * call that never parsed. The web network policy's kinds (`fetch`, `search`, `redirect`) are
 * classified by `networkPolicyRefusal`, whose remedies name the destinations they refused.
 */
export type RefusalKind = LocalRefusalKind | NetworkPolicyRefusal;

/** The kinds whose remedy is fixed text, listed in {@link REFUSAL_REMEDIES}. */
export type LocalRefusalKind =
  | 'permission'
  | 'outside'
  | 'excluded'
  | 'hook'
  | 'inactive'
  | 'capability'
  | 'skill'
  | 'question'
  | 'malformed'
  | 'other';

/**
 * The `structuredError.code` a read the file tools cannot serve is refused with.
 *
 * The refusal is classified from this code, never from the message text: the message is written
 * for the model, and a streak of them must not have its stop message depend on how it is worded.
 */
export const OUTSIDE_WORKSPACE_REFUSAL_CODE = 'path_outside_workspace';

/**
 * The code a read the file tools *exclude* is refused with — a path under a read-only root's
 * `exclude` list, which is how Book's own memory inbox is kept closed.
 *
 * A code of its own, not the outside one: the two are refused for different reasons and have
 * different remedies. `additionalDirectories` would not lift an exclusion, so a streak of them
 * answered with the outside remedy would name a directory the user could add and still be refused
 * (#305 item 3).
 */
export const EXCLUDED_PATH_REFUSAL_CODE = 'path_excluded';

/** Whether a tool result is a refusal: the call was blocked, not run. */
export function isRefusal(
  result: Pick<ToolResult, 'status' | 'structuredError'> | undefined,
): boolean {
  return result?.status === 'blocked';
}

/**
 * Which kind of refusal a tool result is: a blocked result, or a call refused before it ran.
 * Anything unrecognised counts as `other`.
 */
export function refusalKind(
  result: Pick<ToolResult, 'status' | 'structuredError'> | undefined,
): RefusalKind {
  const network = networkPolicyRefusal(result);
  if (network) return network;
  switch (result?.structuredError?.code) {
    case 'permission_denied':
      return 'permission';
    case OUTSIDE_WORKSPACE_REFUSAL_CODE:
      return 'outside';
    case EXCLUDED_PATH_REFUSAL_CODE:
      return 'excluded';
    case 'hook_blocked':
      return 'hook';
    case 'tool_not_active':
    case 'arguments_not_allowed':
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
    case 'invalid_arguments':
    case 'unknown_tool':
      return 'malformed';
    default:
      return 'other';
  }
}

/** What lifts each kind of refusal, worded to follow "Nothing can proceed: ". Listed in this order. */
export const REFUSAL_REMEDIES: Readonly<Record<LocalRefusalKind, string>> = {
  permission:
    'grant the permission, add an allow rule, or change the permission mode (a permissions.deny rule is lifted only by changing that rule)',
  outside:
    'the path is outside the workspace and every directory in additionalDirectories, and no permission rule or mode lets Read, Glob or Grep serve it; add its directory to additionalDirectories (a project-declared one also needs `book trust dir <path>`), or start Book in a directory that contains it',
  excluded:
    "the path is under a subpath the file tools exclude (Book's memory inbox), which no permission rule, no directory in additionalDirectories and no permission mode reaches; work from what is outside that subpath",
  hook: 'a PreToolUse hook refused the calls, which no permission rule or mode lifts; change or remove that hook',
  inactive:
    "the calls named tools, or arguments, that this turn's tool surface does not allow, which no permission rule or mode changes; a deferred tool has to be activated with ToolSearch first, and the run's allowed tools (--allowedTools, or a skill's or command's allowed-tools) must cover the tool and its arguments",
  capability:
    "the calls are outside this agent's tool policy (its profile or definition), which no permission rule or mode lifts; give the step to an agent whose policy allows it",
  skill:
    "a skill's activation policy or allowed-tools refused the calls, which no permission rule or mode lifts; change that skill's override under skills.overrides or its allowed-tools",
  question:
    'the model asked the user questions this run cannot put to anyone (dontAsk mode, or a declined question); it has to proceed without asking',
  malformed:
    "the calls could not run as sent (arguments that never parsed as JSON or failed the tool's schema, or a tool that does not exist), which no permission rule or mode lifts; the model has to correct them, and if `book tool-stats` shows invalid_json_arguments:truncated_start the provider route is dropping the first fragment of calls",
  other:
    "the calls were refused for a reason no permission rule or mode lifts; each refused call's own message names the cause",
};

/** The order the fixed remedies are listed in when a streak mixes kinds: that of REFUSAL_REMEDIES. */
export const REFUSAL_KIND_ORDER = Object.keys(REFUSAL_REMEDIES) as LocalRefusalKind[];

/**
 * The target a read tool call names, quoted back to the model: the path for `Read`, the pattern
 * for `Glob`, the scope for `Grep`. Folded to a single line before it is named, so a model-chosen
 * path cannot put an escape sequence or a bidi override in front of the operator's terminal —
 * the refusal is pushed to them verbatim as a child's `agent_notice` in print mode, which is the
 * same sink the tool rows fold for (#283).
 */
function readTargetOf(toolName: string, args: Record<string, unknown>): string {
  // Every branch tolerates a missing argument. The refusal is built for a call that never ran,
  // so the arguments it reads are whatever the model wrote, and a Read with no `filePath` must
  // still produce a refusal rather than a crash inside the remedy.
  const value =
    toolName === 'Glob'
      ? args.pattern
      : toolName === 'Grep'
        ? (args.path ?? args.pattern)
        : args.filePath;
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return toolName;
  // Folded, not quoted: a path is read at a glance, and a `\u201c` around it would only make the
  // model look for a name with quotes in it. The refusal names the tool when there is no target,
  // so the same fold leaves that untouched.
  return foldControlCharacters(text).trim();
}

export interface OutsideWorkspaceRefusalOptions {
  toolCallId?: string;
  /** The honored roots, named in the message so the model can see what it could have used. */
  additionalRoots?: readonly string[];
  /** Set for a managed child, so the operator notice names the child that hit it. */
  agentLabel?: string;
}

/**
 * The blocked result for a Read, Glob or Grep whose target no root serves.
 *
 * This is not a permission denial and is not phrased as one: the call was never a question the
 * user could answer, so a prompt and an "Always allow" rule would both be lies. The message
 * names the path, the directories already honored, and the two ways through — add the directory
 * to `additionalDirectories` (a project-declared one also needs `book trust dir`), or start Book
 * somewhere that contains it.
 */
export function outsideWorkspaceRefusal(
  toolName: string,
  call: { arguments: Record<string, unknown> },
  options: OutsideWorkspaceRefusalOptions = {},
): ToolResult {
  const target = readTargetOf(toolName, call.arguments);
  const roots = options.additionalRoots ?? [];
  const honored = roots.length > 0 ? roots.join(', ') : '(none)';
  const message =
    `Refused: ${toolName} cannot open ${target}. It is outside the workspace, ` +
    `and outside every directory in additionalDirectories (currently: ${honored}). ` +
    'No permission rule and no permission mode can change this: the file tools only serve the ' +
    'workspace and the directories in additionalDirectories. To read it, add its directory to ' +
    'additionalDirectories (a project-declared one also needs `book trust dir <path>`), or start ' +
    'Book in a directory that contains it.';
  return toolFailure('SKIPPED: ' + message, {
    toolCallId: options.toolCallId,
    code: OUTSIDE_WORKSPACE_REFUSAL_CODE,
    status: 'blocked',
    // The model reads `content`; without it the refusal would be a silent empty turn and the
    // loop would retry the same path until the `all_tools_blocked` brake stopped it.
    content: message,
    details: { tool: toolName, target, honoredRoots: [...roots] },
  });
}

/**
 * The blocked result for a read of a path a root *excludes* — the `exclude` list of a read-only
 * root, which is how Book's memory inbox stays closed while the rest of the memory directory
 * stays readable.
 *
 * Not a permission question either, and not the outside refusal: the directory is served, this
 * subpath under it is not, and the reason a prompt could not have satisfied the call is different
 * from the outside one. The message says so, and says what is left: the rest of the directory.
 */
export function excludedPathRefusal(
  toolName: string,
  call: { arguments: Record<string, unknown> },
  options: Pick<OutsideWorkspaceRefusalOptions, 'toolCallId'> = {},
): ToolResult {
  const target = readTargetOf(toolName, call.arguments);
  const message =
    `Refused: ${toolName} cannot open ${target}. It is excluded: a directory Book serves hides ` +
    'this subpath from its file tools, and no permission rule, no directory in additionalDirectories ' +
    'and no permission mode reaches inside an exclusion. Read what is outside the excluded subpath ' +
    'instead.';
  return toolFailure('SKIPPED: ' + message, {
    toolCallId: options.toolCallId,
    code: EXCLUDED_PATH_REFUSAL_CODE,
    status: 'blocked',
    content: message,
    details: { tool: toolName, target },
  });
}
