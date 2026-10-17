import { describe, expect, it } from 'vitest';
import { PROVIDER_KEY_MARKER } from '../provider-secrets.js';
import type { ToolContext } from '../types/tools.js';
import {
  redactedSecretCommand,
  redactedSecretDeletion,
  redactedSecretOverwrite,
} from './redacted-secret-guard.js';

const KEY = 'sk-live-0123456789abcdef';

function ctx(providerSecrets?: readonly string[]): ToolContext {
  return { workspaceRoot: '/ws', env: {}, providerSecrets };
}

describe('redactedSecretOverwrite', () => {
  it('refuses marker text going into a file that holds a key', () => {
    const refused = redactedSecretOverwrite(ctx([KEY]), 'a.env', `K=${KEY}\n`, [
      `K=${PROVIDER_KEY_MARKER}`,
    ]);
    expect(refused?.structuredError?.code).toBe('redacted_secret_overwrite');
    expect(refused?.structuredError?.message).toContain('a.env');
  });

  it('allows it with no marker, no key in the file, or no secrets', () => {
    expect(redactedSecretOverwrite(ctx([KEY]), 'a', `K=${KEY}`, ['K=other'])).toBeUndefined();
    expect(
      redactedSecretOverwrite(ctx([KEY]), 'a', 'plain', [PROVIDER_KEY_MARKER]),
    ).toBeUndefined();
    expect(redactedSecretOverwrite(ctx(), 'a', `K=${KEY}`, [PROVIDER_KEY_MARKER])).toBeUndefined();
    expect(
      redactedSecretOverwrite(ctx([]), 'a', `K=${KEY}`, [PROVIDER_KEY_MARKER]),
    ).toBeUndefined();
  });
});

describe('redactedSecretDeletion', () => {
  it('refuses deleting a file that holds a key, naming the path', () => {
    const refused = redactedSecretDeletion(ctx([KEY]), 'dir/key.json', `{"k":"${KEY}"}`);
    expect(refused?.structuredError?.code).toBe('redacted_secret_overwrite');
    expect(refused?.structuredError?.message).toContain('dir/key.json');
    expect(refused?.structuredError?.message).toContain(PROVIDER_KEY_MARKER);
    expect(refused?.structuredError?.remediation).toMatch(/Edit/);
    expect(JSON.stringify(refused)).not.toContain(KEY);
  });

  it('allows deleting a file with no key, or with no secrets configured', () => {
    expect(redactedSecretDeletion(ctx([KEY]), 'a', 'plain')).toBeUndefined();
    expect(redactedSecretDeletion(ctx(), 'a', KEY)).toBeUndefined();
    expect(redactedSecretDeletion(ctx([]), 'a', KEY)).toBeUndefined();
  });
});

describe('redactedSecretCommand', () => {
  it('refuses a command whose text carries the marker', () => {
    const refused = redactedSecretCommand(`echo "${PROVIDER_KEY_MARKER}" > out.txt`);
    expect(refused?.structuredError?.code).toBe('redacted_secret_command');
    expect(refused?.structuredError?.message).toMatch(/real provider key/);
    expect(refused?.structuredError?.remediation).toMatch(/Edit/);
  });

  it('allows an ordinary command, and a missing one', () => {
    expect(redactedSecretCommand('echo hello')).toBeUndefined();
    expect(redactedSecretCommand('echo [redacted]')).toBeUndefined();
    expect(redactedSecretCommand(undefined)).toBeUndefined();
  });
});
