import { join } from 'node:path';
import { resolveBookHome } from './book-home.js';
import {
  formatIgnoredWorkspaceSandboxKey,
  ignoredWorkspaceSandboxKeys,
  type IgnoredWorkspaceSandboxKey,
  type WorkspaceLayerSandboxView,
} from './settings-loader.js';

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

/** Where a setting takes effect, for a refusal that has to say where. */
export const TRUSTED_SETTINGS_LOCATION =
  'Set it in <BOOK_HOME>/settings.json (normally ~/.book/settings.json), or pass an explicit ' +
  '--settings file when starting Book.';

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

/**
 * The guidance for a path no workspace layer may carry, whatever its value, or
 * undefined if it may.
 */
export function blockedWorkspaceSettingPath(path: string): string | undefined {
  return WORKSPACE_FORBIDDEN_SCOPES.find(([matches]) => matches(path))?.[1];
}

/** A refused write as a writer reports it: which keys, and why it would not apply. */
function sandboxRefusalMessage(ignored: IgnoredWorkspaceSandboxKey[]): string {
  // A refusal with no value in hand names the keys alone. There is no value to
  // quote, and `sandbox.excludedCommands=undefined` would report a value the
  // layer never wrote.
  const keys = ignored.map((entry) =>
    entry.value === undefined ? entry.key : formatIgnoredWorkspaceSandboxKey(entry),
  );
  return (
    `These sandbox settings are ignored when read from any file inside the workspace, because\n` +
    `each one loosens the sandbox itself: ${keys.join(', ')}.\n` +
    `A workspace file may still turn the sandbox on and add deny entries. ${TRUSTED_SETTINGS_LOCATION}`
  );
}

/**
 * The value at a dotted path inside a value a writer is about to store, as the
 * loader would read it out of the resulting document.
 *
 * A write of `sandbox.filesystem` stores an object where the loader expects one
 * at `sandbox.filesystem`, so the path prefix has to be grafted onto the value
 * rather than looked up inside it — and a whole-`sandbox` write is the prefix
 * with nothing left.
 */
function sandboxValueView(path: string, value: unknown): WorkspaceLayerSandboxView | undefined {
  if (path !== 'sandbox' && !path.startsWith('sandbox.')) return undefined;
  const parts = path === 'sandbox' ? [] : path.slice('sandbox.'.length).split('.');
  let nested: unknown = value;
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    // The last segment is the leaf, whatever shape the caller wrote it in; any
    // step above it has to be an object, or the document the write produces has
    // no `sandbox.filesystem` to hold what is below.
    if (i < parts.length - 1 && !isPlainObject(nested)) return undefined;
    nested = { [parts[i]]: nested };
  }
  return { sandbox: nested as WorkspaceLayerSandboxView['sandbox'] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The guidance for a sandbox write a workspace layer would have ignored, given
 * the value being written, or undefined if the loader would honour it.
 *
 * The same function the loader uses to decide, so a refusal and a silent strip
 * cannot disagree about which values are the tightening ones. Nothing is decided
 * by path alone: `sandbox.enabled` is refused for `false` and written for
 * `true`, and the deny lists are written at every value.
 */
export function blockedWorkspaceSandboxSetting(path: string, value: unknown): string | undefined {
  const view = sandboxValueView(path, value);
  if (!view) return undefined;
  const ignored = ignoredWorkspaceSandboxKeys(view);
  return ignored.length > 0 ? sandboxRefusalMessage(ignored) : undefined;
}

/**
 * The guidance for a write to a workspace layer that the loader would ignore, or
 * undefined if it may be written.
 *
 * `value` is part of the question, because for the sandbox it is what decides:
 * the layer may turn the sandbox on and add deny entries, and may not loosen it.
 * A caller that has no value to offer is refused the keys that are never
 * allowed, and nothing else — a refusal is the safe answer, but not one that
 * blocks the tightening half of the surface on a guess.
 */
export function blockedWorkspaceSettingWrite(path: string, value?: unknown): string | undefined {
  const blocked = blockedWorkspaceSettingPath(path);
  if (blocked) return blocked;
  if (value === undefined) return alwaysRefusedWorkspaceSandboxPath(path);
  return blockedWorkspaceSandboxSetting(path, value);
}

/**
 * The sandbox keys a workspace layer may not supply at any value, for a caller
 * that has to judge a path with no value in hand.
 *
 * The probe declares a value for each key the workspace may not set at all, and
 * the loader reports those back — which keys they are comes from its table rather
 * than from a list here, and the keys it does not report (`enabled`,
 * `failIfUnavailable`, `allowUnsandboxedCommands`, `autoAllowBashIfSandboxed`)
 * are exactly the ones whose value decides and a path alone cannot judge.
 */
function alwaysRefusedWorkspaceSandboxPath(path: string): string | undefined {
  const prefix = path === 'sandbox' ? 'sandbox' : `${path}.`;
  const neverAllowed = ignoredWorkspaceSandboxKeys({
    sandbox: {
      excludedCommands: [],
      filesystem: { allowWrite: [] },
      network: { allowedDomains: [] },
    },
  }).map((entry) => entry.key);
  const refused = neverAllowed.filter(
    (key) => key === prefix || key.startsWith(prefix) || prefix.startsWith(`${key}.`),
  );
  return refused.length > 0
    ? sandboxRefusalMessage(refused.map((key) => ({ key, value: undefined })))
    : undefined;
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
export function blockedConfigWritePath(path: string, value?: unknown): string | undefined {
  return blockedWorkspaceSettingWrite(path, value);
}
