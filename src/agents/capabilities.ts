import type { ToolCall, ToolDefinition, ToolResult } from '../types.js';
import { canonicalToolName } from '../tools/aliases.js';
import { globToRegex } from '../tools/glob-regex.js';
import { getPrimaryArg } from '../tools/primary-arg.js';
import { createRegistry, type ToolRegistry } from '../tools/registry.js';

export interface CapabilityRule {
  raw: string;
  tool: string;
  pattern?: string;
  wildcard: boolean;
}

const CHILD_LIFECYCLE_TOOLS = new Set([
  'AgentPlan',
  'AgentSpawn',
  'AgentList',
  'AgentGet',
  'AgentSend',
  'AgentWait',
  'AgentStop',
  'AgentApply',
  'Task',
]);

function isImplicitlyExcluded(name: string): boolean {
  return name === 'AskUserQuestion' || name.startsWith('mcp__') || CHILD_LIFECYCLE_TOOLS.has(name);
}

export function parseCapabilityRule(rawRule: string): CapabilityRule {
  const raw = rawRule.trim();
  if (!raw) throw new Error('Capability rules must not be empty');
  if (raw === '*') return { raw, tool: '*', wildcard: true };

  const open = raw.indexOf('(');
  if (open === -1) {
    return { raw, tool: canonicalToolName(raw), wildcard: false };
  }
  if (!raw.endsWith(')') || open === 0) {
    throw new Error(`Invalid capability rule: ${rawRule}`);
  }
  const tool = canonicalToolName(raw.slice(0, open).trim());
  const pattern = raw.slice(open + 1, -1).trim();
  if (!tool || !pattern) throw new Error(`Invalid capability rule: ${rawRule}`);
  return { raw, tool, pattern, wildcard: false };
}

export function parseCapabilityRules(rules: string[]): CapabilityRule[] {
  return rules.map(parseCapabilityRule);
}

export function isToolCallAllowed(rules: CapabilityRule[], call: ToolCall): boolean {
  const canonical = canonicalToolName(call.name);
  const primary = getPrimaryArg(call.arguments).replace(/^\.\//, '');

  return rules.some((rule) => {
    if (rule.wildcard) return !isImplicitlyExcluded(canonical);
    if (rule.tool !== canonical) return false;
    if (rule.pattern === undefined) return true;
    const normalizedPattern = rule.pattern.replace(/^\.\//, '');
    return globToRegex(normalizedPattern).test(primary);
  });
}

function denied(call: ToolCall): ToolResult {
  return {
    toolCallId: call.id,
    success: false,
    output: '',
    error: `Capability denied: ${canonicalToolName(call.name)} is outside this agent's tool policy`,
  };
}

/**
 * Intersect an agent definition with the active parent registry. The returned
 * definitions are filtered for model visibility and re-check every call's
 * canonical name and primary argument at execution time.
 */
export function createCapabilityRegistry(parent: ToolRegistry, rawRules: string[]): ToolRegistry {
  const rules = parseCapabilityRules(rawRules);
  const registry = createRegistry();

  for (const definition of parent.getDefinitions()) {
    const canonical = canonicalToolName(definition.name);
    const explicitlyNamed = rules.some((rule) => !rule.wildcard && rule.tool === canonical);
    const wildcardNamed = rules.some((rule) => rule.wildcard) && !isImplicitlyExcluded(canonical);
    if (!explicitlyNamed && !wildcardNamed) continue;
    if (CHILD_LIFECYCLE_TOOLS.has(canonical)) continue;

    const wrapped: ToolDefinition = {
      ...definition,
      execute: async (args, context) => {
        const call: ToolCall = {
          id: context.currentToolTraceId ?? '',
          name: canonical,
          arguments: args,
        };
        if (!isToolCallAllowed(rules, call)) return denied(call);
        return definition.execute(args, context);
      },
    };
    registry.register(wrapped);
  }

  return registry;
}

export function describeCapabilities(rawRules: string[]): string {
  if (rawRules.length === 0) return '(no tools)';
  return rawRules.join(', ');
}
