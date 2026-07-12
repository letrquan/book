import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import type { ToolContext } from '../types.js';
import { notebookTools } from './notebook.js';

let dir: string;
const ctx: ToolContext = { workspaceRoot: '', env: {} };
const edit = notebookTools.find((tool) => tool.name === 'NotebookEdit')!;

function notebook(cells: Array<Record<string, unknown>> = []): Record<string, unknown> {
  return {
    cells,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

function codeCell(id: string, source: string | string[] = ['print(1)']): Record<string, unknown> {
  return {
    cell_type: 'code',
    execution_count: 7,
    id,
    metadata: { trusted: true },
    outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }],
    source,
  };
}

function markdownCell(
  id: string,
  source: string | string[] = ['# Heading'],
): Record<string, unknown> {
  return { cell_type: 'markdown', id, metadata: { tags: ['intro'] }, source };
}

function writeNotebook(value: Record<string, unknown>, name = 'test.ipynb'): string {
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(value, null, 1)}\n`, 'utf-8');
  return path;
}

function readNotebook(name = 'test.ipynb'): Record<string, unknown> & {
  cells: Array<Record<string, unknown>>;
} {
  return JSON.parse(readFileSync(join(dir, name), 'utf-8'));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-notebook-'));
  ctx.workspaceRoot = dir;
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('NotebookEdit', () => {
  it('replaces a cell source while preserving unrelated data', async () => {
    const original = notebook([codeCell('code-1'), markdownCell('md-1')]);
    writeNotebook(original);

    const result = await edit.execute(
      {
        notebook_path: 'test.ipynb',
        cell_id: 'md-1',
        new_source: '# Updated\nMore text',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toMatch(/^-    "# Heading"$/m);
    expect(result.output).toMatch(/^\+    "# Updated\\n",$/m);
    expect(result.fileMutation).toMatchObject({ kind: 'update', filePath: 'test.ipynb' });

    const updated = readNotebook();
    expect(updated.cells[0]).toEqual((original.cells as unknown[])[0]);
    expect(updated.cells[1]).toMatchObject({
      cell_type: 'markdown',
      id: 'md-1',
      metadata: { tags: ['intro'] },
      source: ['# Updated\n', 'More text'],
    });
    expect(updated.metadata).toEqual(original.metadata);
    expect(updated.nbformat).toBe(4);
    expect(updated.nbformat_minor).toBe(5);
  });

  it('allows clearing a cell and preserves string source representation', async () => {
    writeNotebook(notebook([markdownCell('md-1', 'single string')]));

    const result = await edit.execute(
      { notebook_path: 'test.ipynb', cell_id: 'md-1', new_source: '' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(readNotebook().cells[0].source).toBe('');
  });

  it('normalizes CRLF source without dropping cell content', async () => {
    writeNotebook(notebook([markdownCell('md-1', ['old'])]));

    const result = await edit.execute(
      {
        notebook_path: 'test.ipynb',
        cell_id: 'md-1',
        new_source: 'first line\r\nsecond line\r\n',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(readNotebook().cells[0].source).toEqual(['first line\n', 'second line\n']);
  });

  it('inserts a code cell at the beginning with a unique id', async () => {
    writeNotebook(notebook([codeCell('existing')]));

    const result = await edit.execute(
      { notebook_path: 'test.ipynb', new_source: 'x = 1', edit_mode: 'insert' },
      ctx,
    );

    expect(result.success).toBe(true);
    const cells = readNotebook().cells;
    expect(cells).toHaveLength(2);
    expect(cells[0]).toMatchObject({
      cell_type: 'code',
      metadata: {},
      source: ['x = 1'],
      outputs: [],
      execution_count: null,
    });
    expect(cells[0].id).toEqual(expect.any(String));
    expect(cells[0].id).not.toBe('existing');
    expect(cells[1].id).toBe('existing');
  });

  it('inserts a markdown cell after a target cell', async () => {
    writeNotebook(notebook([codeCell('first'), codeCell('second')]));

    const result = await edit.execute(
      {
        notebook_path: 'test.ipynb',
        cell_id: 'first',
        new_source: '## Notes',
        cell_type: 'markdown',
        edit_mode: 'insert',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const cells = readNotebook().cells;
    expect(cells.map((cell) => cell.id)).toEqual(['first', expect.any(String), 'second']);
    expect(cells[1]).toMatchObject({
      cell_type: 'markdown',
      metadata: {},
      source: ['## Notes'],
    });
    expect(cells[1]).not.toHaveProperty('outputs');
    expect(cells[1]).not.toHaveProperty('execution_count');
  });

  it('deletes only the target cell', async () => {
    writeNotebook(notebook([codeCell('first'), markdownCell('remove'), codeCell('last')]));

    const result = await edit.execute(
      {
        notebook_path: 'test.ipynb',
        cell_id: 'remove',
        new_source: '',
        edit_mode: 'delete',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(readNotebook().cells.map((cell) => cell.id)).toEqual(['first', 'last']);
  });

  it('converts cell types and normalizes type-specific fields', async () => {
    writeNotebook(notebook([codeCell('cell')]));

    await edit.execute(
      {
        notebook_path: 'test.ipynb',
        cell_id: 'cell',
        new_source: 'Documentation',
        cell_type: 'markdown',
      },
      ctx,
    );
    let cell = readNotebook().cells[0];
    expect(cell.cell_type).toBe('markdown');
    expect(cell).not.toHaveProperty('outputs');
    expect(cell).not.toHaveProperty('execution_count');

    await edit.execute(
      {
        notebook_path: 'test.ipynb',
        cell_id: 'cell',
        new_source: 'print("again")',
        cell_type: 'code',
      },
      ctx,
    );
    cell = readNotebook().cells[0];
    expect(cell).toMatchObject({ cell_type: 'code', outputs: [], execution_count: null });

    const withAttachment = notebook([
      { ...markdownCell('attached'), attachments: { 'image.png': { 'image/png': 'abc' } } },
    ]);
    writeNotebook(withAttachment);
    await edit.execute(
      {
        notebook_path: 'test.ipynb',
        cell_id: 'attached',
        new_source: 'print(1)',
        cell_type: 'code',
      },
      ctx,
    );
    expect(readNotebook().cells[0]).not.toHaveProperty('attachments');
  });

  it('preserves indentation, newline style, trailing newline, and source fragments', async () => {
    const value = notebook([codeCell('cell', ['print(1)\n'])]);
    const original = `${JSON.stringify(value, null, 2).replace(/\n/g, '\r\n')}\r\n`;
    writeFileSync(join(dir, 'styled.ipynb'), original, 'utf-8');

    const result = await edit.execute(
      {
        notebook_path: 'styled.ipynb',
        cell_id: 'cell',
        new_source: 'print(2)\n',
      },
      ctx,
    );

    expect(result.success).toBe(true);
    const raw = readFileSync(join(dir, 'styled.ipynb'), 'utf-8');
    expect(raw).toContain('\r\n  "cells"');
    expect(raw).not.toContain('\n "cells"');
    expect(raw.endsWith('\r\n')).toBe(true);
    expect(JSON.parse(raw).cells[0].source).toEqual(['print(2)\n']);
  });

  it('preserves compact JSON without adding formatting', async () => {
    writeFileSync(
      join(dir, 'compact.ipynb'),
      JSON.stringify(notebook([codeCell('cell')])),
      'utf-8',
    );

    await edit.execute(
      { notebook_path: 'compact.ipynb', cell_id: 'cell', new_source: 'print(2)' },
      ctx,
    );

    const raw = readFileSync(join(dir, 'compact.ipynb'), 'utf-8');
    expect(raw).not.toContain('\n');
  });

  it.each([
    {
      name: 'missing cell id',
      args: { notebook_path: 'test.ipynb', new_source: 'x' },
      error: /cell_id is required/,
    },
    {
      name: 'unknown cell id',
      args: { notebook_path: 'test.ipynb', cell_id: 'missing', new_source: 'x' },
      error: /Cell not found/,
    },
    {
      name: 'invalid edit mode',
      args: { notebook_path: 'test.ipynb', new_source: 'x', edit_mode: 'move' },
      error: /edit_mode/,
    },
    {
      name: 'invalid cell type',
      args: {
        notebook_path: 'test.ipynb',
        new_source: 'x',
        edit_mode: 'insert',
        cell_type: 'raw',
      },
      error: /cell_type/,
    },
    {
      name: 'non-string source',
      args: { notebook_path: 'test.ipynb', cell_id: 'one', new_source: ['x'] },
      error: /new_source must be a string/,
    },
    {
      name: 'non-notebook extension',
      args: { notebook_path: 'test.json', cell_id: 'one', new_source: 'x' },
      error: /\.ipynb/,
    },
  ])('does not write for $name', async ({ args, error }) => {
    const path = writeNotebook(notebook([codeCell('one')]));
    const before = readFileSync(path, 'utf-8');

    const result = await edit.execute(args, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(error);
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('rejects duplicate target ids without writing', async () => {
    const path = writeNotebook(notebook([codeCell('duplicate'), markdownCell('duplicate')]));
    const before = readFileSync(path, 'utf-8');

    const result = await edit.execute(
      { notebook_path: 'test.ipynb', cell_id: 'duplicate', new_source: 'x' },
      ctx,
    );

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not unique/);
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('rejects a path outside the workspace', async () => {
    const outside = join(dirname(dir), `outside-${Date.now()}.ipynb`);
    writeFileSync(outside, JSON.stringify(notebook()), 'utf-8');

    try {
      const result = await edit.execute(
        { notebook_path: outside, new_source: 'x', edit_mode: 'insert' },
        ctx,
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/outside workspace/);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('rejects missing, malformed, and invalid notebook files', async () => {
    const missing = await edit.execute(
      { notebook_path: 'missing.ipynb', new_source: 'x', edit_mode: 'insert' },
      ctx,
    );
    expect(missing.success).toBe(false);
    expect(missing.error).toMatch(/not found/);

    writeFileSync(join(dir, 'bad.ipynb'), '{ nope', 'utf-8');
    const malformed = await edit.execute(
      { notebook_path: 'bad.ipynb', new_source: 'x', edit_mode: 'insert' },
      ctx,
    );
    expect(malformed.success).toBe(false);
    expect(malformed.error).toMatch(/Invalid notebook JSON/);

    writeFileSync(join(dir, 'shape.ipynb'), JSON.stringify({ metadata: {} }), 'utf-8');
    const invalid = await edit.execute(
      { notebook_path: 'shape.ipynb', new_source: 'x', edit_mode: 'insert' },
      ctx,
    );
    expect(invalid.success).toBe(false);
    expect(invalid.error).toMatch(/nbformat/);
  });
});
