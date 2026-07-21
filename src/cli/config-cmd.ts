import { exit } from './exit.js';
import { getNestedValue } from './utils.js';
import { redactSettingValue, redactSettingsForDisplay } from '../settings-redaction.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import {
  formatSettingsDiagnostics,
  SETTINGS_TOP_LEVEL_KEYS,
  SettingsRepository,
} from '../settings-repository.js';

export interface ConfigCommandSettingsOptions {
  settingsOverridePath?: string;
  noSettings?: boolean;
}

export async function runConfigCommand(
  workspace: string,
  action: string | undefined,
  key: string | undefined,
  value: string | undefined,
  settingsOptions: ConfigCommandSettingsOptions = {},
): Promise<void> {
  const { resolveSettings } = await import('../settings-loader.js');
  const settings = settingsOptions.noSettings
    ? structuredClone(DEFAULT_SETTINGS)
    : resolveSettings(workspace, settingsOptions.settingsOverridePath);

  if (!action || action === 'list') {
    console.log('Resolved settings:');
    console.log(JSON.stringify(redactSettingsForDisplay(settings), null, 2));
    return;
  }

  if (action === 'get') {
    if (!key) {
      console.error('Usage: book config get <key>');
      exit(1);
    }
    const val = getNestedValue(settings as Record<string, unknown>, key);
    if (val === undefined) {
      console.log('Key ' + key + ' is not set (no value).');
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
    const topKey = parts[0];
    if (!SETTINGS_TOP_LEVEL_KEYS.includes(topKey)) {
      console.error(
        'Unknown top-level key: ' + topKey + '. Valid keys: ' + SETTINGS_TOP_LEVEL_KEYS.join(', '),
      );
      exit(1);
    }

    const { join } = await import('path');
    const localPath = join(workspace, '.book', 'settings.local.json');

    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(value);
    } catch {
      parsedValue = value;
    }

    const result = new SettingsRepository(localPath).set({ [key]: parsedValue });
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
        result.path,
    );
    return;
  }

  console.error('Unknown action: ' + action + '. Use: get <key>, set <key> <value>, or list');
  exit(1);
}
