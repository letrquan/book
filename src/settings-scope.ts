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

/** Guidance for the shell setting, which no workspace file may supply. */
export const WORKSPACE_SHELL_SETTINGS_MESSAGE =
  'The shell setting cannot be written to .book/settings.local.json, and is ignored when read ' +
  'from any file inside the workspace: it names the program every Bash command is handed to, so ' +
  'a repository that could set it could run a binary it ships on the first command. Set shell ' +
  'in <BOOK_HOME>/settings.json (normally ~/.book/settings.json), pass an explicit --settings ' +
  'file when starting Book, or use BOOK_SHELL in the environment.';

/** The shell may only be selected by an explicitly trusted settings source. */
export function isShellSettingPath(path: string): boolean {
  return path.trim().toLowerCase() === 'shell';
}

/**
 * Every settings path a workspace file may not supply, with the guidance to
 * print when someone tries to write one there.
 *
 * One list because there are three writers - `book config set`, the `/config`
 * slash command, and `persistSettingsLocal` - and a scope added to only some of
 * them writes a value the loader silently strips, which is worse than a
 * refusal: the user believes they configured something that is being ignored.
 */
const WORKSPACE_FORBIDDEN_SCOPES: ReadonlyArray<readonly [(path: string) => boolean, string]> = [
  [isShellSettingPath, WORKSPACE_SHELL_SETTINGS_MESSAGE],
];

/** The guidance for a path no workspace layer may carry, or undefined if it may. */
export function blockedWorkspaceSettingPath(path: string): string | undefined {
  return WORKSPACE_FORBIDDEN_SCOPES.find(([matches]) => matches(path))?.[1];
}

/**
 * The guidance for a path no `<key>=<value>` configuration surface may write,
 * in any scope, or undefined if it may.
 *
 * Distinct from {@link blockedWorkspaceSettingPath} only in wording. Both refuse
 * the same two families, but the workspace messages explain that a *workspace
 * file* may not carry one and send the reader to `<BOOK_HOME>/settings.json` —
 * which, now that these commands default to the user layer, is the file the
 * refused write was already aimed at. Following either message verbatim
 * produced the same refusal a second time. The gate is that no ordinary
 * configuration command writes these, so the refusal has to name every scope,
 * including the one file the value is actually read from.
 */
export function blockedConfigWritePath(path: string): string | undefined {
  return blockedWorkspaceSettingPath(path);
}
