import type { AgentConfig } from '../types/runtime.js';
import type { ManagedAgentDef } from './profiles.js';

export interface ResolvedAgentProfile {
  definition: ManagedAgentDef;
  requestedModel?: string;
  resolvedModel: string;
  provider?: string;
  effort?: AgentConfig['effort'];
  maxTurns?: number;
  color?: string;
}

const EFFORT_LEVELS = new Set<NonNullable<AgentConfig['effort']>>([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

function usableModel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return !trimmed || trimmed === 'inherit' ? undefined : trimmed;
}

export function usableAgentEffort(value: string | undefined): AgentConfig['effort'] {
  return EFFORT_LEVELS.has(value as NonNullable<AgentConfig['effort']>)
    ? (value as AgentConfig['effort'])
    : undefined;
}

export function resolveAgentProfile(
  definition: ManagedAgentDef,
  config: AgentConfig,
  invocationModel?: string,
): ResolvedAgentProfile {
  const override = config.settings.agents.profiles[definition.name];
  const requestedModel = usableModel(invocationModel);
  const resolvedModel =
    requestedModel ??
    usableModel(override?.model) ??
    usableModel(definition.model) ??
    config.modelSelection ??
    config.model;
  const slash = resolvedModel.indexOf('/');
  return {
    definition,
    requestedModel,
    resolvedModel,
    provider: slash > 0 ? resolvedModel.slice(0, slash) : config.provider,
    effort:
      usableAgentEffort(override?.effort) ?? usableAgentEffort(definition.effort) ?? config.effort,
    maxTurns: override?.maxTurns ?? definition.maxTurns ?? config.maxTurns,
    color: override?.color ?? definition.color,
  };
}
