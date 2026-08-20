import type { ResolvedSettings } from './settings.js';
import type { ToolCall } from './types/tools.js';
import { canonicalToolName } from './tools/aliases.js';
import { getPrimaryArg } from './tools/primary-arg.js';
import { globToRegex } from './tools/glob-regex.js';
import { parsePatch, type PatchOperation } from './tools/patch.js';
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
  source?: 'allow' | 'deny' | 'ask' | 'default' | 'sandbox';
}

/**
 * Seams for permission evaluation. `sandboxBackendAvailable` exists so tests can
 * exercise the missing-bwrap branch on a host that has bwrap installed; nothing
 * in production passes it.
 */
export interface PermissionEvaluationOptions {
  sandboxBackendAvailable?: () => boolean;
}

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

function ruleMatchesPatch(rule: ParsedRule, path: string): boolean {
  return ruleMatches(rule, rule.toolName, path);
}

function patchRuleSupportsOperation(rule: ParsedRule, operation: PatchOperation): boolean {
  if (rule.toolName === 'ApplyPatch') return true;
  if (rule.toolName === 'Edit') return operation.kind === 'update';
  if (rule.toolName === 'Write') return operation.kind === 'update' || operation.kind === 'add';
  return false;
}

function compatiblePatchRuleMatches(rule: ParsedRule, operations: PatchOperation[]): boolean {
  if (!['ApplyPatch', 'Edit', 'Write'].includes(rule.toolName)) return false;
  if (rule.toolName === 'ApplyPatch' && rule.pattern === null) return true;
  return operations.some(
    (operation) =>
      patchRuleSupportsOperation(rule, operation) &&
      (rule.pattern === null || ruleMatchesPatch(rule, operation.path)),
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
    const compatible = (ruleStr: string) => {
      const rule = parseRule(ruleStr);
      return (
        rule.toolName === 'ApplyPatch' || rule.toolName === 'Edit' || rule.toolName === 'Write'
      );
    };
    for (const ruleStr of deny) {
      if (!compatible(ruleStr)) continue;
      const rule = parseRule(ruleStr);
      if (compatiblePatchRuleMatches(rule, operations))
        return { decision: 'deny', matchedRule: ruleStr, source: 'deny' };
    }
    for (const ruleStr of ask) {
      if (!compatible(ruleStr)) continue;
      const rule = parseRule(ruleStr);
      if (compatiblePatchRuleMatches(rule, operations))
        return { decision: 'ask', matchedRule: ruleStr, source: 'ask' };
    }
    const allowRules = allow.filter(compatible).map(parseRule);
    if (
      operations.length > 0 &&
      operations.every((operation) =>
        allowRules.some(
          (rule) =>
            patchRuleSupportsOperation(rule, operation) &&
            (rule.pattern === null || ruleMatchesPatch(rule, operation.path)),
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

  const call: ToolCall = { id: 'permission-evaluation', name: toolName, arguments: args };

  // Deny rules first.
  for (const ruleStr of deny) {
    if (permissionRuleMatchesCall(ruleStr, call)) {
      return { decision: 'deny', matchedRule: ruleStr, source: 'deny' };
    }
  }

  // Ask rules second.
  for (const ruleStr of ask) {
    if (permissionRuleMatchesCall(ruleStr, call)) {
      return { decision: 'ask', matchedRule: ruleStr, source: 'ask' };
    }
  }

  // Allow rules third.
  for (const ruleStr of allow) {
    if (permissionRuleMatchesCall(ruleStr, call)) {
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

  // No rule matched — default to asking.
  return { decision: 'ask', source: 'default' };
}
