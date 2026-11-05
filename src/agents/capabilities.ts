import type { ToolCall, ToolDefinition, ToolResult } from '../types/tools.js';
import type { AgentIsolation } from './types.js';
import { canonicalToolName } from '../tools/aliases.js';
import { toolFailure } from '../tools/result.js';
import { createRegistry, type ToolRegistry } from '../tools/registry-core.js';
import {
  compoundCommandRefusal,
  COMPOUND_COMMAND_REMEDIATION,
  isCompoundShellCommand,
  isToolCallAllowed,
  isToolDefinitionAllowed,
  parseCapabilityRule,
  parseCapabilityRules,
  type CapabilityRule,
} from '../tools/capability-rules.js';
import type { ScanShell } from '../tools/shell-chaining.js';

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

const NON_WORKING_TOOLS = new Set(['ToolSearch', 'InvokeSkill', 'ReadSkillResource']);

const READONLY_DENIED_TOOLS = new Set([
  'Write',
  'ApplyPatch',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Bash',
  'Check',
  'GitCommit',
]);

/** What a refusal adds for a compound Bash command: why, and what to do instead. */
function compoundSuffix(call: ToolCall, shell?: ScanShell): string {
  return isCompoundShellCommand(call, process.platform, shell)
    ? ` ${compoundCommandRefusal(call, process.platform, shell)} ${COMPOUND_COMMAND_REMEDIATION}`
    : '';
}

function denied(
  call: ToolCall,
  profile?: string,
  isolation?: AgentIsolation,
  shell?: ScanShell,
): ToolResult {
  const canonical = canonicalToolName(call.name);
  if (isolation === 'workspace-readonly') {
    return toolFailure(
      `${canonical} is unavailable to the ${profile ?? 'read-only'} profile because this agent is read-only.\n\nReport the required change to the parent with EvidencePublish. The parent can delegate implementation to a patcher if the user authorized modifications.`,
      { toolCallId: call.id, code: 'capability_denied', status: 'blocked' },
    );
  }
  return toolFailure(
    `Capability denied: ${canonical} is outside this agent's tool policy.${compoundSuffix(call, shell)} Report the blocked step and required capability to the parent.`,
    { toolCallId: call.id, code: 'capability_denied', status: 'blocked' },
  );
}

/** A refusal by the parent's ceiling: the role may run the tool, so isolation is not the reason. */
function deniedByCeiling(call: ToolCall, shell?: ScanShell): ToolResult {
  return toolFailure(
    `Capability denied: this call to ${canonicalToolName(call.name)} is outside the allowed-tools this agent was started under, those of the parent's skill or command.${compoundSuffix(call, shell)} Report the blocked step and required capability to the parent.`,
    { toolCallId: call.id, code: 'capability_denied', status: 'blocked' },
  );
}

/** A ceiling read back from a record: anything but rule sets throws, so nothing runs unnarrowed. */
function parseCeiling(ceiling: string[][]): CapabilityRule[][] {
  try {
    return ceiling.map(parseCapabilityRules);
  } catch {
    throw new Error(`Unreadable tool ceiling: ${JSON.stringify(ceiling)}`);
  }
}

/**
 * Intersect an agent definition with the active parent registry and, when the spawn froze one, the
 * parent's ceiling (#696): rule sets of its own, each of which a tool has to fit. A ceiling's `*`
 * excludes nothing, as on the parent's own surface: it narrows the parent by nothing, so it takes
 * nothing from the role. The returned definitions are filtered for model visibility and re-check
 * every call's canonical name and primary argument at execution time. A ceiling it cannot read
 * throws rather than admitting anything.
 */
export function createCapabilityRegistry(
  parent: ToolRegistry,
  rawRules: string[],
  options: { isolation?: AgentIsolation; profile?: string; ceiling?: string[][] } = {},
): ToolRegistry {
  const rules = parseCapabilityRules(rawRules);
  const ceiling = options.ceiling === undefined ? [] : parseCeiling(options.ceiling);
  const registry = createRegistry();

  for (const definition of parent.getDefinitions()) {
    const canonical = canonicalToolName(definition.name);
    if (options.isolation === 'workspace-readonly' && READONLY_DENIED_TOOLS.has(canonical))
      continue;
    if (
      canonical !== 'ToolSearch' &&
      (!isToolDefinitionAllowed(
        rules,
        definition,
        definition.name.startsWith('mcp__')
          ? new Set([...CHILD_WILDCARD_EXCLUSIONS, definition.name])
          : CHILD_WILDCARD_EXCLUSIONS,
      ) ||
        !ceiling.every((set) => isToolDefinitionAllowed(set, definition)))
    )
      continue;
    if (CHILD_LIFECYCLE_TOOLS.has(canonical)) continue;

    const wrapped: ToolDefinition = {
      ...definition,
      execute: async (args, context) => {
        if (canonical === 'ToolSearch') return definition.execute(args, context);
        const call: ToolCall = {
          id: context.currentToolTraceId ?? '',
          name: canonical,
          arguments: args,
        };
        // The session shell, read as the permission gate reads it (#512).
        const shell = context.shell ?? context.agentConfig?.shell;
        if (!isToolCallAllowed(rules, call, CHILD_WILDCARD_EXCLUSIONS, process.platform, shell))
          return denied(call, options.profile, options.isolation, shell);
        if (
          !ceiling.every((set) => isToolCallAllowed(set, call, undefined, process.platform, shell))
        )
          return deniedByCeiling(call, shell);
        return definition.execute(args, context);
      },
    };
    registry.register(wrapped);
  }

  return registry;
}

/**
 * Whether a child's registry holds a tool that does any work. These three only find tools or read
 * instructions, and every skill's allowed-tools add the skill two, so a registry left with them has
 * nothing to do.
 */
export function hasWorkingTool(registry: ToolRegistry): boolean {
  return registry
    .getDefinitions()
    .some((definition) => !NON_WORKING_TOOLS.has(canonicalToolName(definition.name)));
}

export function describeCapabilities(rawRules: string[]): string {
  if (rawRules.length === 0) return '(no tools)';
  return rawRules.join(', ');
}

/** The system-prompt line that tells a child what its parent's ceiling leaves it (#696). */
export function describeToolCeiling(ceiling: string[][]): string {
  const sets = ceiling.map((set) => describeCapabilities(set)).join('; and also ');
  return `Parent's allowed-tools: ${sets}. These hold you too: a capability above that they leave out is not available, and a call they do not cover is refused. If a step needs one, report it to the parent instead.`;
}
