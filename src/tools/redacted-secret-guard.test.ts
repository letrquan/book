import { describe, expect, it } from 'vitest';
import { PROVIDER_KEY_MARKER } from '../provider-secrets.js';
import type { ToolContext } from '../types/tools.js';
import {
  holdsProviderKey,
  redactedSecretCommand,
  redactedSecretDeletion,
  redactedSecretOverwrite,
} from './redacted-secret-guard.js';

const KEY = 'sk-live-0123456789abcdef';

function ctx(providerSecrets?: readonly string[]): ToolContext {
  return { workspaceRoot: '/ws', env: {}, providerSecrets };
}

describe('holdsProviderKey', () => {
  it('is true only when a configured secret appears in the text', () => {
    expect(holdsProviderKey(ctx([KEY]), `K=${KEY}\n`)).toBe(true);
    expect(holdsProviderKey(ctx([KEY]), 'plain')).toBe(false);
    expect(holdsProviderKey(ctx(), KEY)).toBe(false);
    expect(holdsProviderKey(ctx([]), KEY)).toBe(false);
  });
});

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
    expect(refused?.structuredError?.remediation).toMatch(/ask them to delete it themselves/);
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
  const command = `echo "${PROVIDER_KEY_MARKER}" > out.txt`;

  it('refuses a command whose text carries the marker when a key is configured', () => {
    const refused = redactedSecretCommand(ctx([KEY]), command);
    expect(refused?.structuredError?.code).toBe('redacted_secret_command');
    expect(refused?.structuredError?.message).toMatch(/real provider key/);
    expect(refused?.structuredError?.remediation).toMatch(/Edit/);
    expect(refused?.structuredError?.remediation).toMatch(/ask the user/);
    expect(refused?.structuredError?.remediation).toMatch(/brackets/);
    expect(JSON.stringify(refused)).not.toContain(KEY);
  });

  it('does nothing when no provider secrets are configured', () => {
    expect(redactedSecretCommand(ctx(), command)).toBeUndefined();
    expect(redactedSecretCommand(ctx([]), command)).toBeUndefined();
  });

  it('allows an ordinary command, and a missing one', () => {
    expect(redactedSecretCommand(ctx([KEY]), 'echo hello')).toBeUndefined();
    expect(redactedSecretCommand(ctx([KEY]), 'echo [redacted]')).toBeUndefined();
    expect(redactedSecretCommand(ctx([KEY]), undefined)).toBeUndefined();
  });
});
