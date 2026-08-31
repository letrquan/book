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

/** Guidance shared by workspace-local settings mutation surfaces. */
export const WORKSPACE_EXPERIMENTAL_SETTINGS_MESSAGE =
  'Experimental capability settings cannot be written to a workspace settings file ' +
  '(.book/settings.json or .book/settings.local.json). ' +
  'Set experimental.zeroMem in <BOOK_HOME>/settings.json (normally ~/.book/settings.json), ' +
  'pass an explicit --settings file when starting Book, or use ' +
  'BOOK_EXPERIMENTAL_ZERO_MEM=true.';

/**
 * `book config` refuses experimental flags in *every* scope, including the
 * user-global one it can otherwise write.
 *
 * The capability boundary is that opening a workspace must never opt a user
 * into unstable runtime behavior, and the way that is kept honest is that no
 * ordinary configuration command enables it — only hand-editing the trusted
 * file, an explicit `--settings` document, or a process environment opt-in.
 * Now that `config set` defaults to the user-global layer it *could* write the
 * flag, which is exactly why it still declines to: a gate that the shortest
 * available command satisfies is not a gate.
 */
export const CONFIG_COMMAND_EXPERIMENTAL_SETTINGS_MESSAGE =
  'Experimental capability settings cannot be written by `book config`, in any scope. ' +
  'Set experimental.zeroMem by editing <BOOK_HOME>/settings.json (normally ' +
  '~/.book/settings.json) directly, by passing an explicit --settings file when starting ' +
  'Book, or with BOOK_EXPERIMENTAL_ZERO_MEM=true.';

/** Experimental capabilities may only be selected by an explicitly trusted settings source. */
export function isExperimentalSettingPath(path: string): boolean {
  const normalized = path.trim().toLowerCase();
  return normalized === 'experimental' || normalized.startsWith('experimental.');
}

/** Guidance for auth settings, which no workspace file may supply. */
export const WORKSPACE_AUTH_SETTINGS_MESSAGE =
  'Auth settings cannot be written to .book/settings.local.json, and are ignored when read ' +
  'from any file inside the workspace: every field decides where an account-wide subscription ' +
  'token is obtained or sent, so a repository that could set one could harvest it. ' +
  'Set auth.* in <BOOK_HOME>/settings.json (normally ~/.book/settings.json), pass an explicit ' +
  '--settings file when starting Book, or use BOOK_AUTH_PROFILE / ' +
  'BOOK_AUTH_CLIENT_ID_<PROFILE> in the environment.';

/** Auth configuration may only be selected by an explicitly trusted settings source. */
export function isAuthSettingPath(path: string): boolean {
  const normalized = path.trim().toLowerCase();
  return normalized === 'auth' || normalized.startsWith('auth.');
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
  [isExperimentalSettingPath, WORKSPACE_EXPERIMENTAL_SETTINGS_MESSAGE],
  [isAuthSettingPath, WORKSPACE_AUTH_SETTINGS_MESSAGE],
];

/** The guidance for a path no workspace layer may carry, or undefined if it may. */
export function blockedWorkspaceSettingPath(path: string): string | undefined {
  return WORKSPACE_FORBIDDEN_SCOPES.find(([matches]) => matches(path))?.[1];
}
