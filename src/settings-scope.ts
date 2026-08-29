/** Guidance shared by workspace-local settings mutation surfaces. */
export const WORKSPACE_EXPERIMENTAL_SETTINGS_MESSAGE =
  'Experimental capability settings cannot be written to .book/settings.local.json. ' +
  'Set experimental.zeroMem in <BOOK_HOME>/settings.json (normally ~/.book/settings.json), ' +
  'pass an explicit --settings file when starting Book, or use ' +
  'BOOK_EXPERIMENTAL_ZERO_MEM=true.';

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
