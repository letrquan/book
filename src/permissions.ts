import type { ResolvedSettings } from './settings.js';
import { getPrimaryArg } from './tools/primary-arg.js';
import { globToRegex } from './tools/glob-regex.js';
import { parsePatch, type PatchOperation } from './tools/patch.js';

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
  source?: 'allow' | 'deny' | 'ask' | 'default';
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
function ruleMatches(rule: ParsedRule, toolName: string, primaryArg: string): boolean {
  if (rule.toolName !== toolName) return false;
  if (rule.pattern === null) return true; // match-all
  const normalizedArg = normalizePathArg(primaryArg);
  const normalizedPattern = rule.pattern.startsWith('./') ? rule.pattern.slice(2) : rule.pattern;
  return globToRegex(normalizedPattern).test(normalizedArg);
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
 * Evaluate permission rules against a tool call. Rules are evaluated in
 * CC's order: deny → ask → allow. First match wins.
 *
 * Returns 'allow', 'deny', or 'ask' (the default when no rule matches).
 */
export function evaluatePermission(
  toolName: string,
  args: Record<string, unknown>,
  settings: ResolvedSettings,
): 'allow' | 'deny' | 'ask' {
  return evaluatePermissionDetail(toolName, args, settings).decision;
}

export function evaluatePermissionDetail(
  toolName: string,
  args: Record<string, unknown>,
  settings: ResolvedSettings,
): PermissionVerdict {
  const primaryArg = primaryArgForRule(toolName, args);
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

  // Deny rules first.
  for (const ruleStr of deny) {
    const rule = parseRule(ruleStr);
    if (ruleMatches(rule, toolName, primaryArg)) {
      return { decision: 'deny', matchedRule: ruleStr, source: 'deny' };
    }
  }

  // Ask rules second.
  for (const ruleStr of ask) {
    const rule = parseRule(ruleStr);
    if (ruleMatches(rule, toolName, primaryArg)) {
      return { decision: 'ask', matchedRule: ruleStr, source: 'ask' };
    }
  }

  // Allow rules third.
  for (const ruleStr of allow) {
    const rule = parseRule(ruleStr);
    if (ruleMatches(rule, toolName, primaryArg)) {
      return { decision: 'allow', matchedRule: ruleStr, source: 'allow' };
    }
  }

  // No rule matched — default to asking.
  return { decision: 'ask', source: 'default' };
}
