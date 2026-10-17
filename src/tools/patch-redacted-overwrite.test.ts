import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROVIDER_KEY_MARKER } from '../provider-secrets.js';
import { expectWriteRefused } from '../test/redacted-secret.js';
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

  it('refuses adding the marker to a file that holds no key (#535)', async () => {
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

    expectWriteRefused(result, KEY);
    expect(await readFile(file, 'utf8')).toBe('one\n');
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

describe('ApplyPatch adding the marker to a file that holds no key (#535)', () => {
  it('refuses an Add File that holds the marker, creating nothing', async () => {
    const { root, context } = await fixture();

    const result = await execute(
      { patch: patch('*** Add File: tmp.json', `+{"apiKey": "${PROVIDER_KEY_MARKER}"}`) },
      context,
    );

    expectWriteRefused(result, KEY);
    expect(result.structuredError?.message).toContain('tmp.json');
    expect(existsSync(join(root, 'tmp.json'))).toBe(false);
  });

  it('applies no part of a multi-file patch whose Add File holds the marker', async () => {
    const { root, context } = await fixture();
    await writeFile(join(root, 'notes.txt'), 'one\ntwo\n');
    await read.execute({ filePath: 'notes.txt' }, context);

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
          '*** Add File: tmp.json',
          `+${PROVIDER_KEY_MARKER}`,
        ),
      },
      context,
    );

    expectWriteRefused(result, KEY);
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('one\ntwo\n');
    expect(existsSync(join(root, 'fresh.txt'))).toBe(false);
    expect(existsSync(join(root, 'tmp.json'))).toBe(false);
  });

  it('counts the whole file: moving a quoted marker is allowed, duplicating it is not', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'notes.md');
    await writeFile(file, `one ${PROVIDER_KEY_MARKER}\ntwo\n`);
    await read.execute({ filePath: 'notes.md' }, context);

    const duplicated = await execute(
      {
        patch: patch(
          '*** Update File: notes.md',
          '@@',
          ` one ${PROVIDER_KEY_MARKER}`,
          '-two',
          `+two ${PROVIDER_KEY_MARKER}`,
        ),
      },
      context,
    );
    expectWriteRefused(duplicated, KEY);
    expect(await readFile(file, 'utf8')).toBe(`one ${PROVIDER_KEY_MARKER}\ntwo\n`);

    const moved = await execute(
      {
        patch: patch(
          '*** Update File: notes.md',
          '@@',
          `-one ${PROVIDER_KEY_MARKER}`,
          '-two',
          '+one',
          `+two ${PROVIDER_KEY_MARKER}`,
        ),
      },
      context,
    );
    expect(moved.status).toBe('success');
    expect(await readFile(file, 'utf8')).toBe(`one\ntwo ${PROVIDER_KEY_MARKER}\n`);
  });

  it('allows an Update that keeps or removes a marker the file already quotes', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'notes.md');
    await writeFile(file, `A=${PROVIDER_KEY_MARKER}\nB=1\n`);
    await read.execute({ filePath: 'notes.md' }, context);

    const kept = await execute(
      {
        patch: patch(
          '*** Update File: notes.md',
          '@@',
          ` A=${PROVIDER_KEY_MARKER}`,
          '-B=1',
          '+B=2',
        ),
      },
      context,
    );
    expect(kept.status).toBe('success');

    const removed = await execute(
      { patch: patch('*** Update File: notes.md', '@@', `-A=${PROVIDER_KEY_MARKER}`, ' B=2') },
      context,
    );
    expect(removed.status).toBe('success');
    expect(await readFile(file, 'utf8')).toBe('B=2\n');
  });

  it('adds and updates with the marker when no key is configured', async () => {
    const { root, context } = await fixture(null);
    await writeFile(join(root, 'notes.md'), 'one\n');
    await read.execute({ filePath: 'notes.md' }, context);

    const result = await execute(
      {
        patch: patch(
          '*** Add File: new.md',
          `+${PROVIDER_KEY_MARKER}`,
          '*** Update File: notes.md',
          '@@',
          ' one',
          `+${PROVIDER_KEY_MARKER}`,
        ),
      },
      context,
    );

    expect(result.status).toBe('success');
    expect(await readFile(join(root, 'new.md'), 'utf8')).toBe(`${PROVIDER_KEY_MARKER}\n`);
  });

  it('refuses an Update with Move to onto a key file, leaving both files as they were', async () => {
    // ApplyPatch has no rename: `*** Move to:` is refused as invalid syntax, so a patch cannot move
    // a marker file over a key file the way `mv` can.
    const { root, context } = await fixture();
    const keyText = `{"apiKey": "${KEY}"}\n`;
    await writeFile(join(root, 'key.json'), keyText);
    await writeFile(join(root, 'tmp.json'), '{"apiKey": "x"}\n');
    await read.execute({ filePath: 'tmp.json' }, context);
    await read.execute({ filePath: 'key.json' }, context);

    const result = await execute(
      {
        patch: patch(
          '*** Update File: tmp.json',
          '*** Move to: key.json',
          '@@',
          '-{"apiKey": "x"}',
          '+{"apiKey": "y"}',
        ),
      },
      context,
    );

    expect(result.status).not.toBe('success');
    expect(result.structuredError?.code).toBe('invalid_patch_syntax');
    expect(await readFile(join(root, 'key.json'), 'utf8')).toBe(keyText);
    expect(await readFile(join(root, 'tmp.json'), 'utf8')).toBe('{"apiKey": "x"}\n');
  });
});
