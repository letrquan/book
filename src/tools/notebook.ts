import { readFile, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { extname } from 'path';
import type { ToolContext, ToolDefinition, ToolResult } from '../types/tools.js';
import { throwIfAborted, yieldToEventLoop } from '../async.js';
import { renderDiffWithStatsAsync } from './diff.js';
import { pathOutsideWorkspaceResult, resolveWorkspacePath } from './path-utils.js';
import {
  observeFile,
  requireFreshObservation,
  requireObservationForMutation,
} from './file-provenance.js';
import { toolFailure, toolSuccess } from './result.js';

type CellType = 'code' | 'markdown';
type EditMode = 'replace' | 'insert' | 'delete';
type NotebookCell = Record<string, unknown> & {
  id?: string;
  cell_type: CellType;
  source: string | string[];
};
type Notebook = Record<string, unknown> & {
  cells: NotebookCell[];
  metadata: Record<string, unknown>;
  nbformat: 4;
  nbformat_minor: number;
};

interface JsonStyle {
  indent: string | number | undefined;
  newline: '\n' | '\r\n';
  trailingNewline: boolean;
}

function fail(error: string): ToolResult {
  return toolFailure(error);
}

function sourceLines(source: string): string[] {
  if (source === '') return [''];
  const normalized = source.replace(/\r\n?/g, '\n');
  const matches = normalized.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? [];
  return matches;
}

function sourceForCell(source: string, existingSource: string | string[]): string | string[] {
  return typeof existingSource === 'string' ? source : sourceLines(source);
}

function isCellType(value: unknown): value is CellType {
  return value === 'code' || value === 'markdown';
}

function isEditMode(value: unknown): value is EditMode {
  return value === 'replace' || value === 'insert' || value === 'delete';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isSource(value: unknown): value is string | string[] {
  return (
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((line) => typeof line === 'string'))
  );
}

function parseNotebook(raw: string): { notebook: Notebook } | { result: ToolResult } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      result: fail(
        `Invalid notebook JSON: ${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }

  if (!isRecord(parsed))
    return { result: fail('Not a valid Jupyter notebook: expected an object') };
  if (parsed.nbformat !== 4) {
    return { result: fail('Not a supported Jupyter notebook: nbformat must be 4') };
  }
  if (!Number.isInteger(parsed.nbformat_minor) || (parsed.nbformat_minor as number) < 0) {
    return {
      result: fail('Not a valid Jupyter notebook: nbformat_minor must be a non-negative integer'),
    };
  }
  if (!isRecord(parsed.metadata)) {
    return { result: fail('Not a valid Jupyter notebook: metadata must be an object') };
  }
  if (!Array.isArray(parsed.cells)) {
    return { result: fail("Not a valid Jupyter notebook: missing 'cells' array") };
  }

  for (const cell of parsed.cells) {
    if (!isRecord(cell) || !isCellType(cell.cell_type) || !isSource(cell.source)) {
      return {
        result: fail(
          'Not a valid Jupyter notebook: every cell must be a code or markdown cell with string source content',
        ),
      };
    }
  }
  return { notebook: parsed as Notebook };
}

function detectJsonStyle(raw: string): JsonStyle {
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = raw.endsWith('\n');
  if (!raw.includes('\n')) return { indent: undefined, newline, trailingNewline };

  const indentMatch = raw.match(/\r?\n([\t ]+)"/);
  return { indent: indentMatch?.[1] ?? 1, newline, trailingNewline };
}

function serializeNotebook(notebook: Notebook, style: JsonStyle): string {
  let output = JSON.stringify(notebook, null, style.indent);
  if (style.newline === '\r\n') output = output.replace(/\n/g, '\r\n');
  return style.trailingNewline ? `${output}${style.newline}` : output;
}

function findTargetIndex(cells: NotebookCell[], cellId: string): number | ToolResult {
  const matches: number[] = [];
  for (let index = 0; index < cells.length; index++) {
    if (cells[index].id === cellId) matches.push(index);
  }
  if (matches.length === 0) return fail(`Cell not found: ${cellId}`);
  if (matches.length > 1) return fail(`Cell ID is not unique: ${cellId}`);
  return matches[0];
}

function setCellType(cell: NotebookCell, cellType: CellType): void {
  cell.cell_type = cellType;
  if (cellType === 'code') {
    delete cell.attachments;
    if (!Array.isArray(cell.outputs)) cell.outputs = [];
    if (!('execution_count' in cell)) cell.execution_count = null;
  } else {
    delete cell.outputs;
    delete cell.execution_count;
  }
}

function createCell(cellType: CellType, source: string, existingIds: Set<string>): NotebookCell {
  let id = randomUUID();
  while (existingIds.has(id)) id = randomUUID();

  const cell: NotebookCell = {
    id,
    cell_type: cellType,
    metadata: {},
    source: sourceLines(source),
  };
  setCellType(cell, cellType);
  return cell;
}

async function notebookEdit(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const notebookPath = args.notebook_path;
  if (typeof notebookPath !== 'string' || notebookPath.trim() === '') {
    return fail('notebook_path must be a non-empty string');
  }
  if (extname(notebookPath).toLowerCase() !== '.ipynb') {
    return fail('notebook_path must point to a .ipynb file');
  }
  if (typeof args.new_source !== 'string') return fail('new_source must be a string');

  const mode = args.edit_mode ?? 'replace';
  if (!isEditMode(mode)) return fail("edit_mode must be 'replace', 'insert', or 'delete'");

  const requestedCellType = args.cell_type;
  if (requestedCellType !== undefined && !isCellType(requestedCellType)) {
    return fail("cell_type must be 'code' or 'markdown'");
  }

  const cellId = args.cell_id;
  if (cellId !== undefined && (typeof cellId !== 'string' || cellId.trim() === '')) {
    return fail('cell_id must be a non-empty string when provided');
  }
  if ((mode === 'replace' || mode === 'delete') && typeof cellId !== 'string') {
    return fail(`cell_id is required for ${mode} mode`);
  }

  const resolved = resolveWorkspacePath(ctx.workspaceRoot, notebookPath);
  if (!resolved) return pathOutsideWorkspaceResult(notebookPath);
  const { filePath, relativePath } = resolved;
  const stale = await requireFreshObservation(ctx, filePath, relativePath);
  if (stale) return fail(stale);
  const unobserved = requireObservationForMutation(ctx, relativePath, 'notebook edit');
  if (unobserved) return unobserved;

  let original: string;
  try {
    original = await readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      return fail(`Notebook not found: ${notebookPath}`);
    }
    return fail(
      `Failed to read notebook: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  throwIfAborted(ctx.signal);

  const parsed = parseNotebook(original);
  if ('result' in parsed) return parsed.result;
  const { notebook } = parsed;
  await yieldToEventLoop(ctx.signal);

  if (mode === 'replace') {
    const target = findTargetIndex(notebook.cells, cellId as string);
    if (typeof target !== 'number') return target;
    const cell = notebook.cells[target];
    cell.source = sourceForCell(args.new_source, cell.source);
    if (requestedCellType !== undefined) setCellType(cell, requestedCellType);
  } else if (mode === 'delete') {
    const target = findTargetIndex(notebook.cells, cellId as string);
    if (typeof target !== 'number') return target;
    notebook.cells.splice(target, 1);
  } else {
    let insertionIndex = 0;
    if (typeof cellId === 'string') {
      const target = findTargetIndex(notebook.cells, cellId);
      if (typeof target !== 'number') return target;
      insertionIndex = target + 1;
    }
    const existingIds = new Set(
      notebook.cells.map((cell) => cell.id).filter((id): id is string => typeof id === 'string'),
    );
    notebook.cells.splice(
      insertionIndex,
      0,
      createCell(requestedCellType ?? 'code', args.new_source, existingIds),
    );
  }

  const updated = serializeNotebook(notebook, detectJsonStyle(original));
  const { diff, stats } = await renderDiffWithStatsAsync(original, updated, 3, ctx.signal);
  throwIfAborted(ctx.signal);
  try {
    await writeFile(filePath, updated, 'utf-8');
  } catch (error) {
    return fail(
      `Failed to write notebook: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const observation = await observeFile(ctx, filePath, 'edit');
  return toolSuccess(diff || 'Notebook edited successfully (no textual change)', {
    artifacts: {
      fileMutation: {
        kind: 'update',
        filePath: relativePath,
        addedLines: stats.addedLines,
        removedLines: stats.removedLines,
      },
      fileObservations: [observation],
    },
  });
}

export const notebookTools: ToolDefinition[] = [
  {
    name: 'NotebookEdit',
    description:
      'Modify a Jupyter notebook cell. Replace or delete a cell by ID, or insert a code or markdown cell at the beginning or after a target cell.',
    parameters: {
      type: 'object',
      properties: {
        notebook_path: {
          type: 'string',
          description:
            'Path to the .ipynb notebook relative to the workspace; absolute paths inside the workspace are also accepted',
        },
        cell_id: {
          type: 'string',
          description:
            'Target cell ID. Required for replace/delete; in insert mode, the new cell is added after it. Omit in insert mode to add at the beginning.',
        },
        new_source: {
          type: 'string',
          description: 'New cell source. Pass an empty string when deleting a cell.',
        },
        cell_type: {
          type: 'string',
          enum: ['code', 'markdown'],
          description: 'Cell type for insert or optional type conversion during replace',
        },
        edit_mode: {
          type: 'string',
          enum: ['replace', 'insert', 'delete'],
          default: 'replace',
          description: 'Operation to perform; defaults to replace',
        },
      },
      required: ['notebook_path', 'new_source'],
    },
    execute: notebookEdit,
  },
];
