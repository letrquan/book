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
