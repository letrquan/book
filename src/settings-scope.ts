import { join } from 'node:path';
import { resolveBookHome } from './book-home.js';

/**
 * The three settings layers a user can write, named the way the CLI flags name
 * them. Resolution order is user → project → local, so `local` wins.
 */
export type SettingsScope = 'user' | 'project' | 'local';

export const SETTINGS_SCOPES: readonly SettingsScope[] = Object.freeze([
  'user',
  'project',
  'local',
]);

/** The file a scope writes. `user` is workspace-independent by construction. */
export function settingsScopePath(scope: SettingsScope, workspace: string): string {
  switch (scope) {
    case 'user':
      return join(resolveBookHome(), 'settings.json');
    case 'project':
      return join(workspace, '.book', 'settings.json');
    case 'local':
      return join(workspace, '.book', 'settings.local.json');
  }
}

/** How a scope is described in command output. */
export function settingsScopeLabel(scope: SettingsScope): string {
  switch (scope) {
    case 'user':
      return 'user-global';
    case 'project':
      return 'project (checked in)';
    case 'local':
      return 'project-local';
  }
}

/** Whether a scope is one of the two layers that live inside the working tree. */
export function isWorkspaceScope(scope: SettingsScope): boolean {
  return scope === 'project' || scope === 'local';
}

const WORKSPACE_FORBIDDEN_SCOPES: ReadonlyArray<readonly [(path: string) => boolean, string]> = [];

/** The guidance for a path no workspace layer may carry, or undefined if it may. */
export function blockedWorkspaceSettingPath(path: string): string | undefined {
  return WORKSPACE_FORBIDDEN_SCOPES.find(([matches]) => matches(path))?.[1];
}

/**
 * The guidance for a path no `<key>=<value>` configuration surface may write,
 * in any scope, or undefined if it may.
 */
export function blockedConfigWritePath(path: string): string | undefined {
  return blockedWorkspaceSettingPath(path);
}
