import { exit } from './exit.js';
import { getNestedValue, setNestedValue } from './utils.js';

export async function runConfigCommand(
  workspace: string,
  action: string | undefined,
  key: string | undefined,
  value: string | undefined,
): Promise<void> {
  const { resolveSettings } = await import('../settings-loader.js');
  const settings = resolveSettings(workspace);

  if (!action || action === 'list') {
    console.log('Resolved settings:');
    console.log(JSON.stringify(settings, null, 2));
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
      console.log(JSON.stringify(val, null, 2));
    }
    return;
  }

  if (action === 'set') {
    if (!key || value === undefined) {
      console.error('Usage: book config set <key> <value>');
      exit(1);
    }
    const parts = key.split('.');
    if (parts.length === 0) {
      console.error('Invalid key. Use dot-separated path: e.g. permissions.deny');
      exit(1);
    }
    const topKey = parts[0];
    const validKeys = [
      'model',
      'maxTurns',
      'maxTokens',
      'autoCompactEnabled',
      'defaultMode',
      'effort',
      'provider',
      'permissions',
      'sandbox',
      'hooks',
      'additionalDirectories',
      'env',
    ];
    if (!validKeys.includes(topKey)) {
      console.error('Unknown top-level key: ' + topKey + '. Valid keys: ' + validKeys.join(', '));
      exit(1);
    }

    const { writeFileSync, existsSync, readFileSync, mkdirSync } = await import('fs');
    const { join } = await import('path');
    const localDir = join(workspace, '.book');
    const localPath = join(localDir, 'settings.local.json');
    mkdirSync(localDir, { recursive: true });

    let existing: Record<string, unknown> = {};
    if (existsSync(localPath)) {
      try {
        existing = JSON.parse(readFileSync(localPath, 'utf-8'));
      } catch {
        existing = {};
      }
    }

    let parsedValue: unknown;
    try {
      parsedValue = JSON.parse(value);
    } catch {
      parsedValue = value;
    }

    setNestedValue(existing, key, parsedValue);
    writeFileSync(localPath, JSON.stringify(existing, null, 2) + '\n', 'utf-8');
    console.log('Set ' + key + ' = ' + JSON.stringify(parsedValue) + ' in ' + localPath);
    return;
  }

  console.error('Unknown action: ' + action + '. Use: get <key>, set <key> <value>, or list');
  exit(1);
}
