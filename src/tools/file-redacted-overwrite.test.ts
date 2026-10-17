import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileTools } from './file.js';
import { PROVIDER_KEY_MARKER } from '../provider-secrets.js';
import type { ToolContext, ToolResult } from '../types/tools.js';

/**
 * #411: the model only ever sees the marker where a provider key is. Reading such a file and
 * writing it back whole would replace the credential on disk with the marker, so a mutation that
 * puts the marker into a file that holds a key is refused.
 *
 * #535: a marker written to any other file can be moved over the key file afterwards, so while a
 * key is configured no write may add a marker occurrence anywhere.
 */

const KEY = 'sk-live-0123456789abcdef';
const read = fileTools.find((t) => t.name === 'Read')!;
const write = fileTools.find((t) => t.name === 'Write')!;
const edit = fileTools.find((t) => t.name === 'Edit')!;
const multiEdit = fileTools.find((t) => t.name === 'MultiEdit')!;

let dir: string;
let ctx: ToolContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-file-redacted-'));
  ctx = {
    workspaceRoot: dir,
    env: {},
    fileObservationLedger: new Map(),
    providerSecrets: [KEY],
  };
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function put(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content, 'utf-8');
  return path;
}
const observe = (name: string) => read.execute({ filePath: name }, ctx);

function expectWriteRefused(result: ToolResult): void {
  expect(result.status).not.toBe('success');
  expect(result.structuredError?.code).toBe('redacted_secret_write');
  expect(result.structuredError?.message).toContain(PROVIDER_KEY_MARKER);
  expect(result.structuredError?.message).toMatch(/real provider key/);
  expect(JSON.stringify(result)).not.toContain(KEY);
}

describe('Write onto a file that holds a provider key', () => {
  it('refuses to write the marker over the key, and leaves the file unchanged', async () => {
    const original = `API_KEY=${KEY}\nMODE=dev\n`;
    const path = put('.env', original);
    await observe('.env');

    const result = await write.execute(
      { filePath: '.env', content: `API_KEY=${PROVIDER_KEY_MARKER}\nMODE=prod\n` },
      ctx,
    );

    expect(result.status).not.toBe('success');
    expect(result.structuredError?.code).toBe('redacted_secret_overwrite');
    expect(result.structuredError?.message).toMatch(/provider key/);
    expect(result.structuredError?.message).toContain(PROVIDER_KEY_MARKER);
    expect(result.structuredError?.remediation).toMatch(/Edit/);
    expect(result.content).not.toContain(KEY);
    expect(readFileSync(path, 'utf-8')).toBe(original);
  });

  it('allows a write that carries no marker', async () => {
    const path = put('.env', `API_KEY=${KEY}\n`);
    await observe('.env');

    const result = await write.execute({ filePath: '.env', content: 'MODE=prod\n' }, ctx);

    expect(result.status).toBe('success');
    expect(readFileSync(path, 'utf-8')).toBe('MODE=prod\n');
  });

  it('refuses writing the marker to a file that holds no key (#535)', async () => {
    const path = put('notes.md', 'nothing secret\n');
    await observe('notes.md');

    const result = await write.execute(
      { filePath: 'notes.md', content: `the key shows as ${PROVIDER_KEY_MARKER}\n` },
      ctx,
    );

    expectWriteRefused(result);
    expect(readFileSync(path, 'utf-8')).toBe('nothing secret\n');
  });

  it('refuses writing the marker to a new file, and creates nothing (#535)', async () => {
    const result = await write.execute(
      { filePath: 'new.md', content: `the key shows as ${PROVIDER_KEY_MARKER}\n` },
      ctx,
    );

    expectWriteRefused(result);
    expect(result.structuredError?.message).toContain('new.md');
    expect(existsSync(join(dir, 'new.md'))).toBe(false);
  });

  it('allows a Write that keeps the one marker a file already quotes', async () => {
    const path = put('notes.md', `shows as ${PROVIDER_KEY_MARKER}\n`);
    await observe('notes.md');

    const result = await write.execute(
      { filePath: 'notes.md', content: `key shows as ${PROVIDER_KEY_MARKER}\nmore\n` },
      ctx,
    );

    expect(result.status).toBe('success');
    expect(readFileSync(path, 'utf-8')).toBe(`key shows as ${PROVIDER_KEY_MARKER}\nmore\n`);
  });

  it('allows a Write that removes a marker', async () => {
    const path = put('notes.md', `shows as ${PROVIDER_KEY_MARKER}\n`);
    await observe('notes.md');

    const result = await write.execute({ filePath: 'notes.md', content: 'gone\n' }, ctx);

    expect(result.status).toBe('success');
    expect(readFileSync(path, 'utf-8')).toBe('gone\n');
  });

  it('writes the marker to a new or keyless file when no key is configured', async () => {
    ctx.providerSecrets = undefined;
    const path = put('notes.md', 'one\n');
    await observe('notes.md');

    const created = await write.execute(
      { filePath: 'new.md', content: `${PROVIDER_KEY_MARKER}\n` },
      ctx,
    );
    const updated = await write.execute(
      { filePath: 'notes.md', content: `${PROVIDER_KEY_MARKER}\n` },
      ctx,
    );

    expect(created.status).toBe('success');
    expect(updated.status).toBe('success');
    expect(readFileSync(path, 'utf-8')).toBe(`${PROVIDER_KEY_MARKER}\n`);
  });

  it('does nothing when no provider secrets are configured', async () => {
    ctx.providerSecrets = undefined;
    put('.env', `API_KEY=${KEY}\n`);
    await observe('.env');

    const result = await write.execute(
      { filePath: '.env', content: `API_KEY=${PROVIDER_KEY_MARKER}\n` },
      ctx,
    );

    expect(result.status).toBe('success');
  });
});

describe('Edit and MultiEdit on a file that holds a provider key', () => {
  it('refuses an Edit whose new_string carries the marker', async () => {
    const original = `API_KEY=${KEY}\nMODE=dev\n`;
    const path = put('.env', original);
    await observe('.env');

    const result = await edit.execute(
      {
        filePath: '.env',
        oldString: 'MODE=dev',
        newString: `MODE=prod\nCOPY=${PROVIDER_KEY_MARKER}`,
      },
      ctx,
    );

    expect(result.status).not.toBe('success');
    expect(result.structuredError?.code).toBe('redacted_secret_overwrite');
    expect(readFileSync(path, 'utf-8')).toBe(original);
  });

  it('allows an Edit on the other lines', async () => {
    const path = put('.env', `API_KEY=${KEY}\nMODE=dev\n`);
    await observe('.env');

    const result = await edit.execute(
      { filePath: '.env', oldString: 'MODE=dev', newString: 'MODE=prod' },
      ctx,
    );

    expect(result.status).toBe('success');
    expect(readFileSync(path, 'utf-8')).toBe(`API_KEY=${KEY}\nMODE=prod\n`);
  });

  it('refuses an Edit that adds the marker to a file that holds no key (#535)', async () => {
    const path = put('notes.md', 'one\n');
    await observe('notes.md');

    const result = await edit.execute(
      { filePath: 'notes.md', oldString: 'one', newString: `one ${PROVIDER_KEY_MARKER}` },
      ctx,
    );

    expectWriteRefused(result);
    expect(readFileSync(path, 'utf-8')).toBe('one\n');
  });

  it('refuses a MultiEdit when any edit carries the marker, applying none of them', async () => {
    const original = `API_KEY=${KEY}\nMODE=dev\n`;
    const path = put('.env', original);
    await observe('.env');

    const result = await multiEdit.execute(
      {
        filePath: '.env',
        edits: [
          { oldString: 'MODE=dev', newString: 'MODE=prod' },
          { oldString: `API_KEY=${KEY}`, newString: `API_KEY=${PROVIDER_KEY_MARKER}` },
        ],
      },
      ctx,
    );

    expect(result.status).not.toBe('success');
    expect(result.structuredError?.code).toBe('redacted_secret_overwrite');
    expect(readFileSync(path, 'utf-8')).toBe(original);
  });

  it('allows a MultiEdit without the marker', async () => {
    const path = put('.env', `API_KEY=${KEY}\nMODE=dev\n`);
    await observe('.env');

    const result = await multiEdit.execute(
      { filePath: '.env', edits: [{ oldString: 'MODE=dev', newString: 'MODE=prod' }] },
      ctx,
    );

    expect(result.status).toBe('success');
    expect(readFileSync(path, 'utf-8')).toBe(`API_KEY=${KEY}\nMODE=prod\n`);
  });
});

describe('adding the marker to a file that holds no key (#535)', () => {
  const half = PROVIDER_KEY_MARKER.slice(0, -5);
  const rest = PROVIDER_KEY_MARKER.slice(-5);

  it('refuses the first step of the read, write-elsewhere, move route', async () => {
    const original = `{"apiKey": "${KEY}"}`;
    const keyPath = put('key2.json', original);
    await observe('key2.json');

    const result = await write.execute(
      { filePath: 'tmp.json', content: `{"apiKey": "${PROVIDER_KEY_MARKER}"}` },
      ctx,
    );

    expectWriteRefused(result);
    expect(existsSync(join(dir, 'tmp.json'))).toBe(false);
    expect(readFileSync(keyPath, 'utf-8')).toBe(original);
  });

  it('refuses an Edit that completes a marker across the old_string boundary', async () => {
    const path = put('notes.md', `${half}X\n`);
    await observe('notes.md');

    const result = await edit.execute(
      { filePath: 'notes.md', oldString: 'X', newString: rest },
      ctx,
    );

    expectWriteRefused(result);
    expect(readFileSync(path, 'utf-8')).toBe(`${half}X\n`);
  });

  it('refuses a replaceAll Edit that adds markers', async () => {
    const original = `${half}X\n${half}X\n`;
    const path = put('notes.md', original);
    await observe('notes.md');

    const result = await edit.execute(
      { filePath: 'notes.md', oldString: 'X', newString: rest, replaceAll: true },
      ctx,
    );

    expectWriteRefused(result);
    expect(readFileSync(path, 'utf-8')).toBe(original);
  });

  it('allows Edits that keep the one marker a file already quotes', async () => {
    const path = put('notes.md', `A=${PROVIDER_KEY_MARKER}\nB=1\n`);
    await observe('notes.md');

    const other = await edit.execute(
      { filePath: 'notes.md', oldString: 'B=1', newString: 'B=2' },
      ctx,
    );
    expect(other.status).toBe('success');

    const same = await edit.execute(
      {
        filePath: 'notes.md',
        oldString: `A=${PROVIDER_KEY_MARKER}`,
        newString: `C=${PROVIDER_KEY_MARKER}`,
      },
      ctx,
    );
    expect(same.status).toBe('success');
    expect(readFileSync(path, 'utf-8')).toBe(`C=${PROVIDER_KEY_MARKER}\nB=2\n`);
  });

  it('allows an Edit that removes a marker', async () => {
    const path = put('notes.md', `A=${PROVIDER_KEY_MARKER}\n`);
    await observe('notes.md');

    const result = await edit.execute(
      { filePath: 'notes.md', oldString: `A=${PROVIDER_KEY_MARKER}`, newString: 'A=<key>' },
      ctx,
    );

    expect(result.status).toBe('success');
    expect(readFileSync(path, 'utf-8')).toBe('A=<key>\n');
  });

  it('refuses a MultiEdit that adds the marker, applying none of its edits', async () => {
    const path = put('notes.md', 'one\ntwo\n');
    await observe('notes.md');

    const result = await multiEdit.execute(
      {
        filePath: 'notes.md',
        edits: [
          { oldString: 'one', newString: 'uno' },
          { oldString: 'two', newString: `two ${PROVIDER_KEY_MARKER}` },
        ],
      },
      ctx,
    );

    expectWriteRefused(result);
    expect(readFileSync(path, 'utf-8')).toBe('one\ntwo\n');
  });

  it('refuses a MultiEdit whose edits assemble a marker that no new_string holds', async () => {
    const path = put('notes.md', 'aX\n');
    await observe('notes.md');

    const result = await multiEdit.execute(
      {
        filePath: 'notes.md',
        edits: [
          { oldString: 'a', newString: half },
          { oldString: 'X', newString: rest },
        ],
      },
      ctx,
    );

    expectWriteRefused(result);
    expect(readFileSync(path, 'utf-8')).toBe('aX\n');
  });

  it('allows a MultiEdit that keeps an existing marker', async () => {
    const path = put('notes.md', `A=${PROVIDER_KEY_MARKER}\nB=1\n`);
    await observe('notes.md');

    const result = await multiEdit.execute(
      { filePath: 'notes.md', edits: [{ oldString: 'B=1', newString: 'B=2' }] },
      ctx,
    );

    expect(result.status).toBe('success');
    expect(readFileSync(path, 'utf-8')).toBe(`A=${PROVIDER_KEY_MARKER}\nB=2\n`);
  });

  it('allows Edit and MultiEdit to add the marker when no key is configured', async () => {
    ctx.providerSecrets = undefined;
    const path = put('notes.md', `${half}X\nY\n`);
    await observe('notes.md');

    const edited = await edit.execute(
      { filePath: 'notes.md', oldString: 'X', newString: rest },
      ctx,
    );
    expect(edited.status).toBe('success');
    const multi = await multiEdit.execute(
      { filePath: 'notes.md', edits: [{ oldString: 'Y', newString: PROVIDER_KEY_MARKER }] },
      ctx,
    );
    expect(multi.status).toBe('success');
    expect(readFileSync(path, 'utf-8')).toBe(`${PROVIDER_KEY_MARKER}\n${PROVIDER_KEY_MARKER}\n`);
  });
});
