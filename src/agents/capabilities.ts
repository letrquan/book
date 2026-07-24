import type { ToolCall, ToolDefinition, ToolResult } from '../types/tools.js';
import type { AgentIsolation } from './types.js';
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
  'AgentRead',
  'AgentSend',
  'AgentWait',
  'AgentStop',
  'AgentApply',
  'Task',
]);

const CHILD_WILDCARD_EXCLUSIONS = new Set(['AskUserQuestion', ...CHILD_LIFECYCLE_TOOLS]);

const READONLY_DENIED_TOOLS = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'Check',
  'GitCommit',
]);

function denied(call: ToolCall, profile?: string, isolation?: AgentIsolation): ToolResult {
  const canonical = canonicalToolName(call.name);
  if (isolation === 'workspace-readonly') {
    return toolFailure(
      `${canonical} is unavailable to the ${profile ?? 'read-only'} profile because this agent is read-only.\n\nReport the required change to the parent with EvidencePublish. The parent can delegate implementation to a patcher if the user authorized modifications.`,
      { toolCallId: call.id, code: 'capability_denied', status: 'blocked' },
    );
  }
  return toolFailure(
    `Capability denied: ${canonical} is outside this agent's tool policy. Report the blocked step and required capability to the parent.`,
    { toolCallId: call.id, code: 'capability_denied', status: 'blocked' },
  );
}

/**
 * Intersect an agent definition with the active parent registry. The returned
 * definitions are filtered for model visibility and re-check every call's
 * canonical name and primary argument at execution time.
 */
export function createCapabilityRegistry(
  parent: ToolRegistry,
  rawRules: string[],
  options: { isolation?: AgentIsolation; profile?: string } = {},
): ToolRegistry {
  const rules = parseCapabilityRules(rawRules);
  const registry = createRegistry();

  for (const definition of parent.getDefinitions()) {
    const canonical = canonicalToolName(definition.name);
    if (options.isolation === 'workspace-readonly' && READONLY_DENIED_TOOLS.has(canonical))
      continue;
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
          return denied(call, options.profile, options.isolation);
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
