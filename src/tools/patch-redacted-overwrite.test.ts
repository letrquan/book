import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROVIDER_KEY_MARKER } from '../provider-secrets.js';
import type { ToolContext, ToolResult } from '../types/tools.js';
import { fileTools } from './file.js';
import { patchTools } from './patch.js';

/**
 * #519: ApplyPatch is the other way a rewrite loses a provider key. Book never sees the real value,
 * so a delete of a key-holding file can never be undone, and an added marker line replaces the key
 * just as it does under Edit (#411).
 */

const KEY = 'sk-live-0123456789abcdef';
const roots: string[] = [];
const execute = patchTools[0].execute;
const read = fileTools.find((tool) => tool.name === 'Read')!;

async function fixture(
  providerSecrets: readonly string[] | null = [KEY],
): Promise<{ root: string; context: ToolContext }> {
  const root = await mkdtemp(join(tmpdir(), 'book-patch-redacted-'));
  roots.push(root);
  return {
    root,
    context: {
      workspaceRoot: root,
      env: {},
      fileObservationLedger: new Map(),
      providerSecrets: providerSecrets ?? undefined,
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const patch = (...operations: string[]): string =>
  ['*** Begin Patch', ...operations, '*** End Patch'].join('\n');

function expectRefused(result: ToolResult): void {
  expect(result.status).not.toBe('success');
  expect(result.structuredError?.code).toBe('redacted_secret_overwrite');
  expect(result.structuredError?.message).toContain(PROVIDER_KEY_MARKER);
  expect(result.structuredError?.message).toMatch(/provider key/);
  expect(result.structuredError?.remediation).toMatch(/Edit/);
  expect(JSON.stringify(result)).not.toContain(KEY);
}

describe('ApplyPatch delete of a file that holds a provider key', () => {
  it('refuses Delete File, then the Add File that would follow, leaving the file as it was', async () => {
    const { root, context } = await fixture();
    const original = `{"apiKey": "${KEY}"}\n`;
    const file = join(root, 'key.json');
    await writeFile(file, original);
    await read.execute({ filePath: 'key.json' }, context);

    const deleted = await execute({ patch: patch('*** Delete File: key.json') }, context);
    expectRefused(deleted);
    expect(deleted.structuredError?.message).toContain('key.json');
    expect(await readFile(file, 'utf8')).toBe(original);

    const added = await execute(
      {
        patch: patch('*** Add File: key.json', `+{"apiKey": "${PROVIDER_KEY_MARKER}"}`),
      },
      context,
    );
    expect(added.status).not.toBe('success');
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('refuses Delete + Add of one key file in one envelope as a secret overwrite', async () => {
    const { root, context } = await fixture();
    const original = `{"apiKey": "${KEY}"}\n`;
    const file = join(root, 'key.json');
    await writeFile(file, original);
    await read.execute({ filePath: 'key.json' }, context);

    const result = await execute(
      {
        patch: patch(
          '*** Delete File: key.json',
          '*** Add File: key.json',
          `+{"apiKey": "${PROVIDER_KEY_MARKER}"}`,
        ),
      },
      context,
    );

    expectRefused(result);
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('writes nothing to an ordinary file patched alongside a refused delete', async () => {
    const { root, context } = await fixture();
    const keyText = `{"apiKey": "${KEY}"}\n`;
    await writeFile(join(root, 'key.json'), keyText);
    await writeFile(join(root, 'notes.txt'), 'one\ntwo\n');
    await writeFile(join(root, 'gone.txt'), 'bye\n');

    const result = await execute(
      {
        patch: patch(
          '*** Update File: notes.txt',
          '@@',
          ' one',
          '-two',
          '+three',
          '*** Add File: fresh.txt',
          '+new',
          '*** Delete File: key.json',
        ),
      },
      context,
    );

    expectRefused(result);
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(await readFile(join(root, 'key.json'), 'utf8')).toBe(keyText);
    expect(existsSync(join(root, 'fresh.txt'))).toBe(false);
  });

  it('still deletes a file that holds no secret', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'plain.txt');
    await writeFile(file, 'nothing secret\n');
    await read.execute({ filePath: 'plain.txt' }, context);

    const result = await execute({ patch: patch('*** Delete File: plain.txt') }, context);

    expect(result.status).toBe('success');
    expect(existsSync(file)).toBe(false);
  });

  it('deletes a key file when no provider secrets are configured', async () => {
    const { root, context } = await fixture(null);
    const file = join(root, 'key.json');
    await writeFile(file, `{"apiKey": "${KEY}"}\n`);
    await read.execute({ filePath: 'key.json' }, context);

    const result = await execute({ patch: patch('*** Delete File: key.json') }, context);

    expect(result.status).toBe('success');
    expect(existsSync(file)).toBe(false);
  });

  it('deletes a key file when the secret list is empty', async () => {
    const { root, context } = await fixture([]);
    const file = join(root, 'key.json');
    await writeFile(file, `{"apiKey": "${KEY}"}\n`);
    await read.execute({ filePath: 'key.json' }, context);

    const result = await execute({ patch: patch('*** Delete File: key.json') }, context);

    expect(result.status).toBe('success');
    expect(existsSync(file)).toBe(false);
  });
});

describe('ApplyPatch update of a file that holds a provider key', () => {
  const original = `{\n  "name": "demo",\n  "apiKey": "${KEY}",\n  "mode": "dev"\n}\n`;

  it('refuses a hunk that avoids the key line but adds the marker', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'key.json');
    await writeFile(file, original);
    await read.execute({ filePath: 'key.json' }, context);

    const result = await execute(
      {
        patch: patch(
          '*** Update File: key.json',
          '@@',
          '   "name": "demo",',
          `+  "copy": "${PROVIDER_KEY_MARKER}",`,
        ),
      },
      context,
    );

    expectRefused(result);
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('writes nothing to an ordinary file patched alongside a refused update', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'key.json');
    await writeFile(file, original);
    await writeFile(join(root, 'notes.txt'), 'one\ntwo\n');

    const result = await execute(
      {
        patch: patch(
          '*** Update File: notes.txt',
          '@@',
          ' one',
          '-two',
          '+three',
          '*** Update File: key.json',
          '@@',
          '   "name": "demo",',
          `+  "copy": "${PROVIDER_KEY_MARKER}",`,
        ),
      },
      context,
    );

    expectRefused(result);
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('still applies a hunk on a key file that adds no marker', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'key.json');
    await writeFile(file, original);
    await read.execute({ filePath: 'key.json' }, context);

    const result = await execute(
      {
        patch: patch(
          '*** Update File: key.json',
          '@@',
          `   "apiKey": "${KEY}",`,
          '-  "mode": "dev"',
          '+  "mode": "prod"',
        ),
      },
      context,
    );

    expect(result.status).toBe('success');
    expect(await readFile(file, 'utf8')).toBe(original.replace('"dev"', '"prod"'));
  });

  it('still adds the marker to a file that holds no key', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'notes.md');
    await writeFile(file, 'one\n');
    await read.execute({ filePath: 'notes.md' }, context);

    const result = await execute(
      {
        patch: patch('*** Update File: notes.md', '@@', ' one', `+shows as ${PROVIDER_KEY_MARKER}`),
      },
      context,
    );

    expect(result.status).toBe('success');
    expect(await readFile(file, 'utf8')).toBe(`one\nshows as ${PROVIDER_KEY_MARKER}\n`);
  });

  it('adds the marker to a key file when no provider secrets are configured', async () => {
    const { root, context } = await fixture([]);
    const file = join(root, 'key.json');
    await writeFile(file, original);
    await read.execute({ filePath: 'key.json' }, context);

    const result = await execute(
      {
        patch: patch(
          '*** Update File: key.json',
          '@@',
          '   "name": "demo",',
          `+  "copy": "${PROVIDER_KEY_MARKER}",`,
        ),
      },
      context,
    );

    expect(result.status).toBe('success');
    expect(await readFile(file, 'utf8')).toContain(`"copy": "${PROVIDER_KEY_MARKER}"`);
  });
});
