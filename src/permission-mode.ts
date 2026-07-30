import type { ResolvedSettings } from './settings.js';
import type { PermissionMode } from './types/runtime.js';

/** The mode used when neither the invocation nor settings select one. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'default';

/** Convert settings/CLI spellings to the runtime permission-mode spelling. */
export function normalizePermissionMode(value: unknown): PermissionMode | undefined {
  switch (value) {
    case 'default':
    case 'auto':
    case 'plan':
    case 'dontAsk':
    case 'bypassPermissions':
      return value;
    case 'acceptEdits':
    case 'accept-edits':
      return 'accept-edits';
    default:
      return undefined;
  }
}

/** Resolve invocation mode first, then the layered settings default. */
export function resolvePermissionMode(
  settings: Pick<ResolvedSettings, 'defaultMode'> &
    Partial<Pick<ResolvedSettings, 'disableBypassPermissionsMode'>>,
  requested?: unknown,
): PermissionMode {
  // An explicitly supplied but invalid mode must fail closed instead of
  // inheriting a potentially permissive configured default.
  const selected =
    requested !== undefined
      ? (normalizePermissionMode(requested) ?? DEFAULT_PERMISSION_MODE)
      : (normalizePermissionMode(settings.defaultMode) ?? DEFAULT_PERMISSION_MODE);
  return selected === 'bypassPermissions' && settings.disableBypassPermissionsMode
    ? DEFAULT_PERMISSION_MODE
    : selected;
}
