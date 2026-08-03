import { discoverCommands } from '../commands/loader.js';
import { discoverSkills, type Skill } from '../skills.js';
import type { SlashCommand } from '../types/commands.js';
import type { AgentConfig } from '../types/runtime.js';
import { listCustomThemes, resolveTheme, type ResolvedTheme } from './theme.js';

export interface InteractiveAssets {
  commands: SlashCommand[];
  skills: Skill[];
  customThemes: string[];
  initialTheme: ResolvedTheme | null;
}

/** Load filesystem-backed UI metadata before React begins rendering. */
export function loadInteractiveAssets(
  config: Pick<AgentConfig, 'workspace' | 'settings'>,
): InteractiveAssets {
  return {
    commands: discoverCommands(config.workspace),
    skills: discoverSkills(config.workspace, config.settings.skills.overrides, {
      executionOverrides: config.settings.skills.execution,
      enabled: config.settings.skills.enabled,
    }),
    customThemes: listCustomThemes(config.workspace),
    initialTheme: resolveTheme(config.workspace, config.settings.theme ?? 'dark'),
  };
}
