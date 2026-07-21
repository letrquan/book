import type { ToolCall, ToolDefinition, ToolResult } from '../types.js';
import { canonicalToolName } from '../tools/aliases.js';
import { toolFailure } from '../tools/result.js';
import { createRegistry, type ToolRegistry } from '../tools/registry-core.js';
import {
  isToolCallAllowed,
  isToolDefinitionAllowed,
  parseCapabilityRule,
  parseCapabilityRules,
  type CapabilityRule,
} from '../tools/capability-rules.js';

export { isToolCallAllowed, parseCapabilityRule, parseCapabilityRules, type CapabilityRule };

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

const CHILD_WILDCARD_EXCLUSIONS = new Set(['AskUserQuestion', ...CHILD_LIFECYCLE_TOOLS]);

function denied(call: ToolCall): ToolResult {
  return toolFailure(
    `Capability denied: ${canonicalToolName(call.name)} is outside this agent's tool policy`,
    { toolCallId: call.id, code: 'capability_denied', status: 'blocked' },
  );
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
    if (
      canonical !== 'ToolSearch' &&
      !isToolDefinitionAllowed(
        rules,
        definition,
        definition.name.startsWith('mcp__')
          ? new Set([...CHILD_WILDCARD_EXCLUSIONS, definition.name])
          : CHILD_WILDCARD_EXCLUSIONS,
      )
    )
      continue;
    if (CHILD_LIFECYCLE_TOOLS.has(canonical)) continue;

    const wrapped: ToolDefinition = {
      ...definition,
      execute: async (args, context) => {
        const call: ToolCall = {
          id: context.currentToolTraceId ?? '',
          name: canonical,
          arguments: args,
        };
        if (
          canonical !== 'ToolSearch' &&
          !isToolCallAllowed(rules, call, CHILD_WILDCARD_EXCLUSIONS)
        )
          return denied(call);
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
