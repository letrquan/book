import { exit } from './exit.js';
import { getNestedValue } from './utils.js';
import { redactSettingValue, redactSettingsForDisplay } from '../settings-redaction.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import {
  formatSettingsDiagnostics,
  SETTINGS_TOP_LEVEL_KEYS,
  SettingsRepository,
} from '../settings-repository.js';
import {
  isExperimentalSettingPath,
  WORKSPACE_EXPERIMENTAL_SETTINGS_MESSAGE,
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
    if (isExperimentalSettingPath(key)) {
      console.error(WORKSPACE_EXPERIMENTAL_SETTINGS_MESSAGE);
      exit(1);
    }
    const topKey = parts[0];
    if (!SETTINGS_TOP_LEVEL_KEYS.includes(topKey)) {
      console.error(
        'Unknown top-level key: ' + topKey + '. Valid keys: ' + SETTINGS_TOP_LEVEL_KEYS.join(', '),
      );
      exit(1);
    }

    // `config set` writes the workspace-local layer, which is stripped of every
    // key recording a decision *about* this repository. Writing one there would
    // report success and change nothing on the next load, so it is refused with
    // the command that does record it.
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

    const { join } = await import('path');
    const localPath = join(workspace, '.book', 'settings.local.json');

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
