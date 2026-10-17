import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { removeWhenReleased } from '../test/remove-when-released.js';
import { PROVIDER_KEY_MARKER } from '../provider-secrets.js';
import type { ResolvedShell } from '../types/runtime.js';
import type { ToolContext } from '../types/tools.js';
import { shellTools } from './shell.js';

/**
 * #519: a command that carries the marker would write it over the provider key it stands for.
 * The guard sits ahead of every branch of Bash, so the foreground and background paths both refuse.
 */

const TEST_SHELL: ResolvedShell =
  process.platform === 'win32'
    ? { kind: 'cmd', label: 'cmd.exe', source: 'fallback' }
    : { kind: 'sh', label: '/bin/sh', source: 'detected' };

const KEY = 'sk-live-0123456789abcdef';
const bash = shellTools.find((tool) => tool.name === 'Bash')!;

let dir: string;
let context: ToolContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-shell-redacted-'));
  context = { workspaceRoot: dir, env: {}, shell: TEST_SHELL, providerSecrets: [KEY] };
});
// Nothing is spawned by a refused command, and the control runs in the foreground to completion.
afterEach(async () => {
  await removeWhenReleased(dir);
});

describe('Bash and the redaction marker', () => {
  const command = `echo "${PROVIDER_KEY_MARKER}" > out.txt`;

  for (const background of [false, true]) {
    it(`refuses a command carrying the marker (run_in_background: ${background})`, async () => {
      const result = await bash.execute(
        { command, ...(background ? { run_in_background: true } : {}) },
        context,
      );

      expect(result.status).not.toBe('success');
      expect(result.structuredError?.code).toBe('redacted_secret_command');
      expect(result.structuredError?.message).toMatch(/real provider key/);
      expect(result.structuredError?.remediation).toMatch(/Edit/);
      expect(existsSync(join(dir, 'out.txt'))).toBe(false);
    });
  }

  it('still runs an ordinary command', async () => {
    const result = await bash.execute({ command: 'echo hello' }, context);

    expect(result.status).toBe('success');
    expect(result.content).toContain('hello');
  });
});
