import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileTools } from './file.js';
import { PROVIDER_KEY_MARKER } from '../provider-secrets.js';
import type { ToolContext } from '../types/tools.js';

/**
 * #411: the model only ever sees the marker where a provider key is. Reading such a file and
 * writing it back whole would replace the credential on disk with the marker, so a mutation that
 * puts the marker into a file that holds a key is refused.
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

  it('allows writing the marker to a file that holds no key', async () => {
    const path = put('notes.md', 'nothing secret\n');
    await observe('notes.md');

    const result = await write.execute(
      { filePath: 'notes.md', content: `the key shows as ${PROVIDER_KEY_MARKER}\n` },
      ctx,
    );

    expect(result.status).toBe('success');
    expect(readFileSync(path, 'utf-8')).toContain(PROVIDER_KEY_MARKER);
  });

  it('allows writing the marker to a new file', async () => {
    const result = await write.execute(
      { filePath: 'new.md', content: `the key shows as ${PROVIDER_KEY_MARKER}\n` },
      ctx,
    );

    expect(result.status).toBe('success');
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

  it('allows an Edit that adds the marker to a file that holds no key', async () => {
    const path = put('notes.md', 'one\n');
    await observe('notes.md');

    const result = await edit.execute(
      { filePath: 'notes.md', oldString: 'one', newString: `one ${PROVIDER_KEY_MARKER}` },
      ctx,
    );

    expect(result.status).toBe('success');
    expect(readFileSync(path, 'utf-8')).toBe(`one ${PROVIDER_KEY_MARKER}\n`);
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
