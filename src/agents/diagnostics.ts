import type { AgentConfig } from '../types/runtime.js';
import { canonicalToolName } from '../tools/aliases.js';
import type { ManagedAgentDef } from './profiles.js';

export interface AgentDiagnostic {
  code:
    | 'duplicate-profile'
    | 'invalid-model'
    | 'literal-inherit'
    | 'missing-profile'
    | 'readonly-mutation'
    | 'unknown-tool';
  message: string;
}

const MUTATION_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'Check']);

function validateModel(
  profile: string,
  model: string | undefined,
  config: AgentConfig,
): AgentDiagnostic | undefined {
  if (!model || model === 'inherit') return undefined;
  const slash = model.indexOf('/');
  if (slash === 0 || slash === model.length - 1) {
    return {
      code: 'invalid-model',
      message: `${profile} uses invalid model "${model}"; expected a model or provider/model reference.`,
    };
  }
  if (slash > 0) {
    const providerId = model.slice(0, slash);
    const modelId = model.slice(slash + 1);
    const provider = config.settings.provider[providerId];
    if (provider && Object.keys(provider.models).length > 0 && !provider.models[modelId]) {
      return {
        code: 'invalid-model',
        message: `${profile} references ${model}, which is not in provider ${providerId}'s model catalog.`,
      };
    }
  }
  return undefined;
}

export function collectAgentDiagnostics(
  config: AgentConfig,
  profiles: ManagedAgentDef[],
): AgentDiagnostic[] {
  const diagnostics: AgentDiagnostic[] = [];
  const counts = new Map<string, number>();
  for (const profile of profiles) counts.set(profile.name, (counts.get(profile.name) ?? 0) + 1);
  for (const [name, count] of counts) {
    if (count > 1) {
      diagnostics.push({
        code: 'duplicate-profile',
        message: `${name} is defined ${count} times; keep one profile definition per name.`,
      });
    }
  }

  const profileNames = new Set(profiles.map((profile) => profile.name));
  for (const [name, override] of Object.entries(config.settings.agents.profiles)) {
    if (!profileNames.has(name)) {
      diagnostics.push({
        code: 'missing-profile',
        message: `agents.profiles.${name} has settings but no matching agent definition.`,
      });
    }
    if (override.model?.trim() === 'inherit') {
      diagnostics.push({
        code: 'literal-inherit',
        message: `agents.profiles.${name}.model stores literal "inherit"; remove the key to inherit cleanly.`,
      });
    }
    const modelDiagnostic = validateModel(name, override.model, config);
    if (modelDiagnostic) diagnostics.push(modelDiagnostic);
  }

  for (const profile of profiles) {
    for (const tool of profile.unknownTools ?? []) {
      diagnostics.push({
        code: 'unknown-tool',
        message: `${profile.name} declares unsupported tool ${tool}; import or edit the definition.`,
      });
    }
    if (profile.isolation === 'workspace-readonly') {
      const mutations = profile.allowedTools.filter((tool) =>
        MUTATION_TOOLS.has(canonicalToolName(tool.split('(')[0].trim())),
      );
      if (mutations.length > 0) {
        diagnostics.push({
          code: 'readonly-mutation',
          message: `${profile.name} is read-only but declares mutation tools: ${mutations.join(', ')}. They will be hard-filtered.`,
        });
      }
    }
    if (!config.settings.agents.profiles[profile.name]?.model) {
      const modelDiagnostic = validateModel(profile.name, profile.model, config);
      if (modelDiagnostic) diagnostics.push(modelDiagnostic);
    }
  }
  return diagnostics;
}
