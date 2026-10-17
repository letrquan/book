import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_KEY_MARKER } from '../provider-secrets.js';
import type { ToolContext, ToolResult } from '../types/tools.js';
import { fileTools } from './file.js';
import { notebookTools } from './notebook.js';

/**
 * #519: a notebook cell that holds the user's key reaches the model with the marker, so writing the
 * marker into such a notebook, or deleting the cell, would lose the real key.
 */

const KEY = 'sk-live-0123456789abcdef';
const edit = notebookTools.find((tool) => tool.name === 'NotebookEdit')!;
const read = fileTools.find((tool) => tool.name === 'Read')!;

let dir: string;
let ctx: ToolContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-notebook-redacted-'));
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

function writeNotebook(keySource: string, name = 'nb.ipynb'): { path: string; raw: string } {
  const cell = (id: string, source: string[]) => ({
    cell_type: 'code',
    execution_count: null,
    id,
    metadata: {},
    outputs: [],
    source,
  });
  const raw = `${JSON.stringify(
    {
      cells: [cell('keycell', [keySource]), cell('plain', ['print(1)'])],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  )}\n`;
  const path = join(dir, name);
  writeFileSync(path, raw, 'utf-8');
  return { path, raw };
}

function expectRefused(result: ToolResult): void {
  expect(result.status).not.toBe('success');
  expect(result.structuredError?.code).toBe('redacted_secret_overwrite');
  expect(result.structuredError?.message).toMatch(/provider key/);
  expect(JSON.stringify(result)).not.toContain(KEY);
}

describe('NotebookEdit on a notebook that holds a provider key', () => {
  const keyLine = `openai.api_key = "${KEY}"`;

  it('refuses a replace whose new_source carries the marker, leaving the file unchanged', async () => {
    const { path, raw } = writeNotebook(keyLine);
    await read.execute({ filePath: 'nb.ipynb' }, ctx);

    const result = await edit.execute(
      {
        notebook_path: 'nb.ipynb',
        cell_id: 'plain',
        new_source: `copy = "${PROVIDER_KEY_MARKER}"`,
      },
      ctx,
    );

    expectRefused(result);
    expect(readFileSync(path, 'utf-8')).toBe(raw);
  });

  it('refuses an insert whose new_source carries the marker', async () => {
    const { path, raw } = writeNotebook(keyLine);
    await read.execute({ filePath: 'nb.ipynb' }, ctx);

    const result = await edit.execute(
      {
        notebook_path: 'nb.ipynb',
        edit_mode: 'insert',
        new_source: `openai.api_key = "${PROVIDER_KEY_MARKER}"`,
      },
      ctx,
    );

    expectRefused(result);
    expect(readFileSync(path, 'utf-8')).toBe(raw);
  });

  it('refuses deleting the cell that holds the key, leaving the file unchanged', async () => {
    const { path, raw } = writeNotebook(keyLine);
    await read.execute({ filePath: 'nb.ipynb' }, ctx);

    const result = await edit.execute(
      { notebook_path: 'nb.ipynb', cell_id: 'keycell', edit_mode: 'delete', new_source: '' },
      ctx,
    );

    expectRefused(result);
    expect(result.structuredError?.remediation).toMatch(/ask them to delete it themselves/);
    expect(readFileSync(path, 'utf-8')).toBe(raw);
  });

  it('refuses a delete of a cell whose source holds a key that JSON escapes', async () => {
    const escaped = 'sk-live-"quoted"\\0123456789';
    ctx.providerSecrets = [escaped];
    const { path, raw } = writeNotebook(`k = ${escaped}`);
    await read.execute({ filePath: 'nb.ipynb' }, ctx);

    const result = await edit.execute(
      { notebook_path: 'nb.ipynb', cell_id: 'keycell', edit_mode: 'delete', new_source: '' },
      ctx,
    );

    expect(result.structuredError?.code).toBe('redacted_secret_overwrite');
    expect(readFileSync(path, 'utf-8')).toBe(raw);
  });

  it('still deletes a cell that holds no key', async () => {
    const { path } = writeNotebook(keyLine);
    await read.execute({ filePath: 'nb.ipynb' }, ctx);

    const result = await edit.execute(
      { notebook_path: 'nb.ipynb', cell_id: 'plain', edit_mode: 'delete', new_source: '' },
      ctx,
    );

    expect(result.status).toBe('success');
    expect(readFileSync(path, 'utf-8')).not.toContain('print(1)');
    expect(readFileSync(path, 'utf-8')).toContain(KEY);
  });

  it('still replaces a cell with text that has no marker', async () => {
    const { path } = writeNotebook(keyLine);
    await read.execute({ filePath: 'nb.ipynb' }, ctx);

    const result = await edit.execute(
      { notebook_path: 'nb.ipynb', cell_id: 'plain', new_source: 'print(2)' },
      ctx,
    );

    expect(result.status).toBe('success');
    expect(readFileSync(path, 'utf-8')).toContain('print(2)');
  });
});

describe('NotebookEdit on a notebook without a provider key', () => {
  function expectWriteRefused(result: ToolResult): void {
    expect(result.status).not.toBe('success');
    expect(result.structuredError?.code).toBe('redacted_secret_write');
    expect(result.structuredError?.message).toContain(PROVIDER_KEY_MARKER);
    expect(result.structuredError?.message).toMatch(/real provider key/);
    expect(JSON.stringify(result)).not.toContain(KEY);
  }

  it('refuses a replace or an insert that adds the marker, leaving the file unchanged (#535)', async () => {
    const { path, raw } = writeNotebook('x = 1');
    await read.execute({ filePath: 'nb.ipynb' }, ctx);

    const replaced = await edit.execute(
      { notebook_path: 'nb.ipynb', cell_id: 'plain', new_source: `# ${PROVIDER_KEY_MARKER}` },
      ctx,
    );
    expectWriteRefused(replaced);

    const inserted = await edit.execute(
      {
        notebook_path: 'nb.ipynb',
        edit_mode: 'insert',
        new_source: `# ${PROVIDER_KEY_MARKER}`,
      },
      ctx,
    );
    expectWriteRefused(inserted);
    expect(readFileSync(path, 'utf-8')).toBe(raw);
  });

  it('still replaces a cell that keeps the one marker it quotes, and deletes it', async () => {
    const { path } = writeNotebook(`# ${PROVIDER_KEY_MARKER}`);
    await read.execute({ filePath: 'nb.ipynb' }, ctx);

    const replaced = await edit.execute(
      { notebook_path: 'nb.ipynb', cell_id: 'keycell', new_source: `## ${PROVIDER_KEY_MARKER}` },
      ctx,
    );
    expect(replaced.status).toBe('success');

    const deleted = await edit.execute(
      { notebook_path: 'nb.ipynb', cell_id: 'keycell', edit_mode: 'delete', new_source: '' },
      ctx,
    );
    expect(deleted.status).toBe('success');
    expect(readFileSync(path, 'utf-8')).not.toContain(PROVIDER_KEY_MARKER);
  });

  it('replaces and inserts the marker when no provider secrets are configured', async () => {
    ctx.providerSecrets = undefined;
    const { path } = writeNotebook('x = 1');
    await read.execute({ filePath: 'nb.ipynb' }, ctx);

    const replaced = await edit.execute(
      { notebook_path: 'nb.ipynb', cell_id: 'plain', new_source: `# ${PROVIDER_KEY_MARKER}` },
      ctx,
    );
    expect(replaced.status).toBe('success');
    const inserted = await edit.execute(
      { notebook_path: 'nb.ipynb', edit_mode: 'insert', new_source: `# ${PROVIDER_KEY_MARKER}` },
      ctx,
    );
    expect(inserted.status).toBe('success');
    expect(readFileSync(path, 'utf-8').split(PROVIDER_KEY_MARKER)).toHaveLength(3);
  });

  it('is not guarded when no provider secrets are configured', async () => {
    ctx.providerSecrets = undefined;
    writeNotebook(`k = "${KEY}"`);
    await read.execute({ filePath: 'nb.ipynb' }, ctx);

    const result = await edit.execute(
      { notebook_path: 'nb.ipynb', cell_id: 'keycell', edit_mode: 'delete', new_source: '' },
      ctx,
    );

    expect(result.status).toBe('success');
  });
});
