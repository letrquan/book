import type { ToolCall, ToolDefinition } from '../types/tools.js';
import { canonicalToolName } from './aliases.js';
import { globToRegex } from './glob-regex.js';
import { getPrimaryArg } from './primary-arg.js';

export interface CapabilityRule {
  raw: string;
  tool: string;
  pattern?: string;
  wildcard: boolean;
}

export function parseCapabilityRule(rawRule: string): CapabilityRule {
  const raw = rawRule.trim();
  if (!raw) throw new Error('Capability rules must not be empty');
  if (raw === '*') return { raw, tool: '*', wildcard: true };

  const open = raw.indexOf('(');
  if (open === -1) return { raw, tool: canonicalToolName(raw), wildcard: false };
  if (!raw.endsWith(')') || open === 0) throw new Error(`Invalid capability rule: ${rawRule}`);

  const tool = canonicalToolName(raw.slice(0, open).trim());
  const pattern = raw.slice(open + 1, -1).trim();
  if (!tool || !pattern) throw new Error(`Invalid capability rule: ${rawRule}`);
  return { raw, tool, pattern, wildcard: false };
}

export function parseCapabilityRules(rules: string[]): CapabilityRule[] {
  return rules.map(parseCapabilityRule);
}

export function isToolDefinitionAllowed(
  rules: CapabilityRule[],
  definition: Pick<ToolDefinition, 'name'>,
  wildcardExclusions: ReadonlySet<string> = new Set(),
): boolean {
  const canonical = canonicalToolName(definition.name);
  return rules.some(
    (rule) =>
      (!rule.wildcard && rule.tool === canonical) ||
      (rule.wildcard && !wildcardExclusions.has(canonical)),
  );
}

export function isToolCallAllowed(
  rules: CapabilityRule[],
  call: ToolCall,
  wildcardExclusions: ReadonlySet<string> = new Set(),
): boolean {
  const canonical = canonicalToolName(call.name);
  const primary = getPrimaryArg(call.arguments).replace(/^\.\//, '');

  return rules.some((rule) => {
    if (rule.wildcard) return !wildcardExclusions.has(canonical);
    if (rule.tool !== canonical) return false;
    if (rule.pattern === undefined) return true;
    const normalizedPattern = rule.pattern.replace(/^\.\//, '');
    return globToRegex(normalizedPattern).test(primary);
  });
}
