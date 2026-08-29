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
