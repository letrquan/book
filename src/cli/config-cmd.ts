import { exit } from './exit.js';
import { getNestedValue } from './utils.js';
import { redactSettingValue, redactSettingsForDisplay } from '../settings-redaction.js';
import { DEFAULT_SETTINGS, type ResolvedSettings } from '../settings.js';
import { formatSettingsDiagnostics, SettingsRepository } from '../settings-repository.js';
import { resolveSettings } from '../settings-loader.js';
import { settingsScopeLabel, type SettingsScope } from '../settings-scope.js';
import { applySettingWrite, describeSettingShadow, readScopeDocument } from '../settings-write.js';

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

export async function runConfigCommand(
  workspace: string,
  action: string | undefined,
  key: string | undefined,
  value: string | undefined,
  settingsOptions: ConfigCommandSettingsOptions = {},
): Promise<void> {
  // *Calling* this is deferred because it throws on a malformed layer, and the
  // paths that do not need it are exactly the ones a user reaches for when a
  // layer *is* malformed: a scoped read to find the broken file, and a write to
  // replace the bad value. Resolving eagerly made `config` the one tool that
  // stopped working precisely when the config was wrong. The import itself is
  // static — `settings-write.js` pulls the loader in regardless, so a dynamic
  // one deferred nothing while reading as though it did.
  const resolveMergedSettings = (): ResolvedSettings =>
    settingsOptions.noSettings
      ? structuredClone(DEFAULT_SETTINGS)
      : resolveSettings(workspace, settingsOptions.settingsOverridePath);

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
    console.log(JSON.stringify(redactSettingsForDisplay(resolveMergedSettings()), null, 2));
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
      : (resolveMergedSettings() as unknown as Record<string, unknown>);
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
    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(value);
    } catch {
      parsedValue = value;
    }

    const scope = settingsOptions.scope ?? 'user';
    const result = applySettingWrite({
      workspace,
      key,
      value: parsedValue,
      scope,
      settingsOverridePath: settingsOptions.settingsOverridePath,
      noSettings: settingsOptions.noSettings,
    });
    if (!result.ok) {
      console.error(result.error);
      exit(1);
      return;
    }
    console.log(
      'Set ' +
        key +
        ' = ' +
        JSON.stringify(redactSettingValue(key, result.value)) +
        ' in ' +
        settingsScopeLabel(result.scope) +
        ' settings (' +
        result.path +
        ')',
    );
    // A user-global write is the one that silently loses: the local layer is
    // resolved last, so a value left there from before this command defaulted
    // to `user` keeps winning. Say so rather than letting the write look inert.
    for (const shadow of result.shadowedBy) {
      console.warn(`⚠  ${describeSettingShadow(shadow, key)}`);
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
