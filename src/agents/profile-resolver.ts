import type { AgentConfig } from '../types/runtime.js';
import type { ManagedAgentDef } from './profiles.js';
import {
  applyModelDefaults,
  clampEffortToCatalog,
  isEffortChosen,
  resolveEffortExplicit,
  resolveModelProviderConfig,
} from '../config.js';

export interface ResolvedAgentProfile {
  definition: ManagedAgentDef;
  requestedModel?: string;
  resolvedModel: string;
  provider?: string;
  effort?: AgentConfig['effort'];
  /**
   * A level was chosen for this agent -- by its profile override or definition,
   * or for the session -- rather than defaulted. The session's default `high`
   * is not a choice.
   */
  effortExplicit: boolean;
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
  const explicitlyInherits = override?.model?.trim() === 'inherit';
  const resolvedModel =
    requestedModel ??
    usableModel(override?.model) ??
    (explicitlyInherits ? undefined : usableModel(definition.model)) ??
    config.modelSelection ??
    config.model;
  const slash = resolvedModel.indexOf('/');
  const chosenEffort = usableAgentEffort(override?.effort) ?? usableAgentEffort(definition.effort);
  return {
    definition,
    requestedModel,
    resolvedModel,
    provider: slash > 0 ? resolvedModel.slice(0, slash) : config.provider,
    effort: chosenEffort ?? config.effort,
    effortExplicit: chosenEffort !== undefined || isEffortChosen(config),
    maxTurns: override?.maxTurns ?? definition.maxTurns ?? config.maxTurns,
    color: override?.color ?? definition.color,
  };
}

/**
 * A managed child's config for its model and effort, from its resolved profile.
 *
 * - The model resolves through `settings.provider`, and its catalog `default` applies when no
 *   level was chosen: the session's defaulted `high` is not a choice.
 * - The effort is clamped to the child model's catalog. A chosen level below every listed level
 *   is raised to the lowest one rather than dropped; a defaulted one is dropped, as the reducer's
 *   is.
 * - It is sent (`effortExplicit`) when it was chosen or the catalog lists it, and
 *   `effortChosen` keeps the difference, so the child's own compaction does not count a level
 *   its catalog merely listed as chosen.
 */
export function resolveChildAgentConfig(
  base: AgentConfig,
  profile: Pick<ResolvedAgentProfile, 'effort' | 'effortExplicit'>,
  resolvedModel: string | undefined,
): AgentConfig {
  const chosen = profile.effortExplicit;
  let config: AgentConfig = {
    ...base,
    effort: profile.effort,
    effortExplicit: chosen,
    effortChosen: chosen,
  };
  if (resolvedModel && resolvedModel !== 'unknown') {
    config = applyModelDefaults(resolveModelProviderConfig(config, resolvedModel));
  }
  const effort = clampEffortToCatalog(config, config.effort, { raiseToLowest: chosen });
  return {
    ...config,
    effort,
    effortChosen: chosen,
    effortExplicit: resolveEffortExplicit(config, effort, chosen),
  };
}
