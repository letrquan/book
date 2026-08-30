import { exit } from './exit.js';
import { getNestedValue } from './utils.js';
import { redactSettingValue, redactSettingsForDisplay } from '../settings-redaction.js';
import { DEFAULT_SETTINGS, type ResolvedSettings } from '../settings.js';
import {
  formatSettingsDiagnostics,
  readSettingsDocument,
  SETTINGS_TOP_LEVEL_KEYS,
  SettingsRepository,
} from '../settings-repository.js';
import {
  CONFIG_COMMAND_EXPERIMENTAL_SETTINGS_MESSAGE,
  isExperimentalSettingPath,
  settingsScopeLabel,
  settingsScopePath,
  type SettingsScope,
} from '../settings-scope.js';

/**
 * Settings paths held in `<BOOK_HOME>/trust.json` rather than in either
 * workspace layer, mapped to the `book trust` subcommand that records them.
 * `mcp.projectServers` has no subcommand yet; it is listed so the refusal
 * explains the silence instead of writing a key nothing reads.
 */
const TRUST_OWNED_KEYS: Record<string, string> = {
  'commands.projectCommands': 'Record it with: book trust command <name>',
  'hooks.projectEntries': 'Record it with: book trust hook <fingerprint>',
  'permissions.projectAllowRules': 'Record it with: book trust rule <rule>',
  'mcp.projectServers': 'Approve the server when Book prompts for it.',
};

export interface ConfigCommandSettingsOptions {
  settingsOverridePath?: string;
  noSettings?: boolean;
  /**
   * Which layer to act on. Writes default to `user`, so a setting follows the
   * person rather than the directory they happened to run the command in.
   * Reads default to the resolved merge of every layer; a scope narrows them to
   * that one file, which is how a user finds the stray value overriding them.
   */
  scope?: SettingsScope;
}

/**
 * Read one layer's file verbatim, without merging or defaults.
 *
 * `resolveSettings` deliberately cannot answer "what is in this file", because
 * it returns the merge. A scoped read has to bypass it. A missing file is an
 * ordinary answer here; an unreadable one is *not* reported as an empty one,
 * because that would let a malformed layer look like it holds nothing while it
 * is still the file the user has to fix.
 */
interface ScopeDocument {
  scope: SettingsScope;
  path: string;
  /** `absent` and `unreadable` both yield an empty `document`, and mean different things. */
  status: 'present' | 'absent' | 'unreadable';
  error?: string;
  document: Record<string, unknown>;
}

function readScopeDocument(scope: SettingsScope, workspace: string): ScopeDocument {
  const path = settingsScopePath(scope, workspace);
  const result = readSettingsDocument(path);
  if (result.status === 'valid') {
    return { scope, path, status: 'present', document: result.document };
  }
  if (result.status === 'absent') {
    return { scope, path, status: 'absent', document: {} };
  }
  return { scope, path, status: 'unreadable', error: result.error, document: {} };
}

/**
 * The scopes that define `key` and are resolved *after* the user layer.
 *
 * A user-global write is the one that can look like it did nothing: project and
 * local are merged over it, so a value left behind in either still decides the
 * session. Reporting it is the difference between a config that is global and
 * one that merely claims to be. An unreadable layer is reported too — it cannot
 * be shown to hold the key, and it cannot be shown not to.
 */
function shadowingScopes(workspace: string, key: string): ScopeDocument[] {
  const shadowing: ScopeDocument[] = [];
  for (const scope of ['project', 'local'] as const) {
    const layer = readScopeDocument(scope, workspace);
    if (layer.status === 'unreadable') {
      shadowing.push(layer);
      continue;
    }
    if (layer.status === 'absent') continue;
    if (getNestedValue(layer.document, key) === undefined) continue;
    shadowing.push(layer);
  }
  return shadowing;
}

export async function runConfigCommand(
  workspace: string,
  action: string | undefined,
  key: string | undefined,
  value: string | undefined,
  settingsOptions: ConfigCommandSettingsOptions = {},
): Promise<void> {
  // Resolving the merge is deferred because it throws on a malformed layer, and
  // the paths that do not need it are exactly the ones a user reaches for when a
  // layer *is* malformed: a scoped read to find the broken file, and a write to
  // replace the bad value. Loading it eagerly made `config` the one tool that
  // stopped working precisely when the config was wrong.
  const resolveMergedSettings = async (): Promise<ResolvedSettings> => {
    const { resolveSettings } = await import('../settings-loader.js');
    return settingsOptions.noSettings
      ? structuredClone(DEFAULT_SETTINGS)
      : resolveSettings(workspace, settingsOptions.settingsOverridePath);
  };

  // A scope narrows a read to one file. Without it a read reports the merge,
  // which is the right default but cannot answer "why is this not what I set" —
  // for that the user needs to see the layer the value actually came from.
  const scopeRead = settingsOptions.scope
    ? readScopeDocument(settingsOptions.scope, workspace)
    : undefined;

  if (!action || action === 'list') {
    if (scopeRead) {
      console.log(`${settingsScopeLabel(scopeRead.scope)} settings (${scopeRead.path}):`);
      if (scopeRead.status === 'unreadable') {
        console.error(`Could not read it: ${scopeRead.error ?? 'unknown error'}`);
        exit(1);
      }
      console.log(
        scopeRead.status === 'present'
          ? JSON.stringify(redactSettingsForDisplay(scopeRead.document), null, 2)
          : 'No settings file at this scope yet.',
      );
      return;
    }
    console.log('Resolved settings:');
    console.log(JSON.stringify(redactSettingsForDisplay(await resolveMergedSettings()), null, 2));
    return;
  }

  if (action === 'get') {
    if (!key) {
      console.error('Usage: book config get <key>');
      exit(1);
    }
    if (scopeRead?.status === 'unreadable') {
      console.error(
        `Could not read ${settingsScopeLabel(scopeRead.scope)} settings (${scopeRead.path}): ` +
          `${scopeRead.error ?? 'unknown error'}`,
      );
      exit(1);
    }
    const source = scopeRead
      ? scopeRead.document
      : ((await resolveMergedSettings()) as unknown as Record<string, unknown>);
    const val = getNestedValue(source, key);
    if (val === undefined) {
      console.log(
        scopeRead
          ? `Key ${key} is not set in ${settingsScopeLabel(scopeRead.scope)} settings (${scopeRead.path}).`
          : 'Key ' + key + ' is not set (no value).',
      );
    } else {
      console.log(JSON.stringify(redactSettingValue(key, val), null, 2));
    }
    return;
  }

  if (action === 'set') {
    if (!key || value === undefined) {
      console.error('Usage: book config set <key> <value>');
      exit(1);
    }
    const parts = key.split('.').filter(Boolean);
    if (parts.length === 0) {
      console.error('Invalid key. Use dot-separated path: e.g. permissions.deny');
      exit(1);
    }
    if (isExperimentalSettingPath(key)) {
      console.error(CONFIG_COMMAND_EXPERIMENTAL_SETTINGS_MESSAGE);
      exit(1);
    }
    const topKey = parts[0];
    if (!SETTINGS_TOP_LEVEL_KEYS.includes(topKey)) {
      console.error(
        'Unknown top-level key: ' + topKey + '. Valid keys: ' + SETTINGS_TOP_LEVEL_KEYS.join(', '),
      );
      exit(1);
    }

    // Every key recording a decision *about* a repository is read from
    // `<BOOK_HOME>/trust.json`, never from a settings file — the workspace
    // layers are stripped of them, and no loader consults the user-global one
    // for them either. Writing one through `config set` would report success
    // and change nothing on the next load in *any* scope, so it is refused
    // everywhere, naming the command that does record it.
    //
    // Matching has to run in both directions. A deeper path reaches the key
    // (`commands.projectCommands.deploy`), and so does a shallower one: `config
    // set commands '{"projectCommands":…}'` replaces the whole section, which
    // is the same write with the same silent outcome. Comparing only the first
    // two segments would have caught the first and missed the second.
    const trustPath = Object.keys(TRUST_OWNED_KEYS).find(
      (owned) => key === owned || key.startsWith(`${owned}.`) || owned.startsWith(`${key}.`),
    );
    if (trustPath) {
      console.error(
        `${trustPath} records a decision about repository-declared configuration, so it is\n` +
          `not read from any file inside the workspace. Writing it here would change nothing.\n` +
          `  ${TRUST_OWNED_KEYS[trustPath]}`,
      );
      exit(1);
    }

    const scope = settingsOptions.scope ?? 'user';
    const targetPath = settingsScopePath(scope, workspace);

    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(value);
    } catch {
      parsedValue = value;
    }

    if (
      key.trim().toLowerCase() === 'compactstrategy' &&
      typeof parsedValue === 'string' &&
      parsedValue.trim().toLowerCase() === 'zero-mem'
    ) {
      console.error(
        'compactStrategy "zero-mem" is no longer supported. Set ' +
          'experimental.zeroMem=true in <BOOK_HOME>/settings.json, pass an explicit ' +
          '--settings file, or use BOOK_EXPERIMENTAL_ZERO_MEM=true.',
      );
      exit(1);
    }

    const result = new SettingsRepository(targetPath).set({ [key]: parsedValue });
    if (!result.ok) {
      console.error(formatSettingsDiagnostics(result.diagnostics));
      exit(1);
    }
    console.log(
      'Set ' +
        key +
        ' = ' +
        JSON.stringify(redactSettingValue(key, parsedValue)) +
        ' in ' +
        settingsScopeLabel(scope) +
        ' settings (' +
        result.path +
        ')',
    );
    // A user-global write is the one that silently loses: the local layer is
    // resolved last, so a value left there from before this command defaulted
    // to `user` keeps winning. Say so rather than letting the write look inert.
    if (scope === 'user') {
      for (const shadow of shadowingScopes(workspace, key)) {
        const flag = shadow.scope === 'local' ? '--local' : '--project';
        console.warn(
          shadow.status === 'unreadable'
            ? `⚠  ${settingsScopeLabel(shadow.scope)} settings (${shadow.path}) could not be ` +
                `read (${shadow.error ?? 'unknown error'}), so whether it overrides ${key} here ` +
                `is unknown.`
            : `⚠  ${key} is also set in ${settingsScopeLabel(shadow.scope)} settings ` +
                `(${shadow.path}), which is resolved after the user layer and still wins here. ` +
                `Clear it with: book config unset ${flag} ${key}`,
        );
      }
    }
    return;
  }

  if (action === 'unset') {
    if (!key) {
      console.error('Usage: book config unset <key>');
      exit(1);
    }
    // Unset needs no scope default of its own beyond `set`'s: the reason to
    // reach for it is almost always a stray value in a layer that outranks the
    // global one, and that layer has to be named explicitly anyway.
    const scope = settingsOptions.scope ?? 'user';
    const layer = readScopeDocument(scope, workspace);
    if (layer.status === 'unreadable') {
      console.error(
        `Could not read ${settingsScopeLabel(scope)} settings (${layer.path}): ` +
          `${layer.error ?? 'unknown error'}`,
      );
      exit(1);
    }
    if (layer.status === 'absent' || getNestedValue(layer.document, key) === undefined) {
      console.log(
        `${key} is not set in ${settingsScopeLabel(scope)} settings (${layer.path}); nothing to remove.`,
      );
      return;
    }
    const result = new SettingsRepository(layer.path).remove([key]);
    if (!result.ok) {
      console.error(formatSettingsDiagnostics(result.diagnostics));
      exit(1);
    }
    console.log(`Removed ${key} from ${settingsScopeLabel(scope)} settings (${result.path})`);
    return;
  }

  console.error(
    'Unknown action: ' + action + '. Use: get <key>, set <key> <value>, unset <key>, or list',
  );
  exit(1);
}
