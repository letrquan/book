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
  /**
   * The model is the user's choice (a profile override in settings, or the session's own), not a
   * repository's agent definition or a model passed at the spawn. A withheld workspace provider's
   * prefix on a trusted model resolves as the plain fallback instead of refusing the child.
   */
  modelTrusted: boolean;
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
  const overrideModel = usableModel(override?.model);
  const definitionModel = explicitlyInherits ? undefined : usableModel(definition.model);
  const resolvedModel =
    requestedModel ?? overrideModel ?? definitionModel ?? config.modelSelection ?? config.model;
  // An `agents.profiles.<name>.model` is a settings selection (the loader has already replaced a
  // withheld workspace one) and the session's model is the user's; the agent definition's `model`
  // and one passed at the spawn are written by a repository or chosen by the model.
  const modelTrusted =
    requestedModel === undefined && (overrideModel !== undefined || definitionModel === undefined);
  const slash = resolvedModel.indexOf('/');
  const chosenEffort = usableAgentEffort(override?.effort) ?? usableAgentEffort(definition.effort);
  return {
    definition,
    requestedModel,
    resolvedModel,
    modelTrusted,
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
  profile: Pick<ResolvedAgentProfile, 'effort' | 'effortExplicit'> &
    Partial<Pick<ResolvedAgentProfile, 'modelTrusted'>>,
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
    config = applyModelDefaults(
      resolveModelProviderConfig(config, resolvedModel, {
        trustedSelection: profile.modelTrusted === true,
      }),
    );
  }
  const effort = clampEffortToCatalog(config, config.effort, { raiseToLowest: chosen });
  return {
    ...config,
    effort,
    effortChosen: chosen,
    effortExplicit: resolveEffortExplicit(config, effort, chosen),
  };
}
