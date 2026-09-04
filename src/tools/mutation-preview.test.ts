import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isPreviewableMutation, previewMutation } from './mutation-preview.js';
import type { ToolCall } from '../types/tools.js';

let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-mutation-preview-'));
  writeFileSync(join(workspace, 'notes.txt'), 'alpha\nbeta\ngamma\n');
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `tc-${name}`, name, arguments: args };
}

describe('isPreviewableMutation', () => {
  it('names the tools whose change can be shown before it happens', () => {
    expect(isPreviewableMutation(call('Edit', {}))).toBe(true);
    expect(isPreviewableMutation(call('MultiEdit', {}))).toBe(true);
    expect(isPreviewableMutation(call('Write', {}))).toBe(true);
    expect(isPreviewableMutation(call('ApplyPatch', {}))).toBe(true);
    expect(isPreviewableMutation(call('apply_patch', {}))).toBe(true);
    expect(isPreviewableMutation(call('Read', {}))).toBe(false);
    expect(isPreviewableMutation(call('Bash', {}))).toBe(false);
  });
});

describe('previewMutation', () => {
  it('returns null for a tool it does not understand', async () => {
    expect(await previewMutation(call('Bash', { command: 'ls' }), workspace)).toBeNull();
  });

  it('shows the diff an Edit would make without writing it', async () => {
    const preview = await previewMutation(
      call('Edit', { filePath: 'notes.txt', oldString: 'beta', newString: 'delta' }),
      workspace,
    );
    expect(preview?.error).toBeUndefined();
    expect(preview?.files).toHaveLength(1);
    const [file] = preview!.files;
    expect(file.filePath).toBe('notes.txt');
    expect(file.kind).toBe('update');
    expect(file.stats).toEqual({ addedLines: 1, removedLines: 1 });
    expect(file.diff).toContain('-beta');
    expect(file.diff).toContain('+delta');
    expect(readFileSync(join(workspace, 'notes.txt'), 'utf8')).toBe('alpha\nbeta\ngamma\n');
  });

  // The prompt is raised before the registry normalizes argument names, so the
  // model-facing spellings must preview exactly like the canonical ones.
  it('accepts the model-facing argument aliases', async () => {
    const preview = await previewMutation(
      call('Edit', {
        file_path: 'notes.txt',
        old_string: 'a',
        new_string: 'A',
        replace_all: true,
      }),
      workspace,
    );
    expect(preview?.error).toBeUndefined();
    expect(preview?.files[0].diff).toContain('+AlphA');
    expect(preview?.files[0].diff).toContain('+gAmmA');
  });

  it('reports the failure the tool would report instead of a diff', async () => {
    const missing = await previewMutation(
      call('Edit', { filePath: 'notes.txt', oldString: 'zeta', newString: 'eta' }),
      workspace,
    );
    expect(missing?.files).toEqual([]);
    expect(missing?.error).toContain('oldString not found');

    const ambiguous = await previewMutation(
      call('Edit', { filePath: 'notes.txt', oldString: 'a', newString: 'A' }),
      workspace,
    );
    expect(ambiguous?.error).toContain('matches');

    const outside = await previewMutation(
      call('Edit', { filePath: '../elsewhere.txt', oldString: 'a', newString: 'b' }),
      workspace,
    );
    expect(outside?.error).toContain('outside workspace');

    const absent = await previewMutation(
      call('Edit', { filePath: 'nope.txt', oldString: 'a', newString: 'b' }),
      workspace,
    );
    expect(absent?.error).toContain('File not found');
  });

  it('applies MultiEdit entries in order and labels the failing one', async () => {
    const preview = await previewMutation(
      call('MultiEdit', {
        filePath: 'notes.txt',
        edits: [
          { oldString: 'alpha', newString: 'one' },
          { old_string: 'gamma', new_string: 'three' },
        ],
      }),
      workspace,
    );
    expect(preview?.error).toBeUndefined();
    expect(preview?.files[0].stats).toEqual({ addedLines: 2, removedLines: 2 });

    const failing = await previewMutation(
      call('MultiEdit', {
        filePath: 'notes.txt',
        edits: [
          { oldString: 'alpha', newString: 'one' },
          { oldString: 'omega', newString: 'last' },
        ],
      }),
      workspace,
    );
    expect(failing?.error).toContain('Edit 2:');
  });

  it('shows a Write as an update of an existing file or a create of a new one', async () => {
    const update = await previewMutation(
      call('Write', { file_path: 'notes.txt', content: 'alpha\nomega\n' }),
      workspace,
    );
    expect(update?.files[0].kind).toBe('update');
    expect(update?.files[0].stats).toEqual({ addedLines: 1, removedLines: 2 });

    mkdirSync(join(workspace, 'src'));
    const create = await previewMutation(
      call('Write', { filePath: 'src/new.txt', content: 'one\ntwo\n' }),
      workspace,
    );
    expect(create?.files[0]).toMatchObject({
      filePath: 'src/new.txt',
      kind: 'create',
      stats: { addedLines: 2, removedLines: 0 },
    });
    expect(create?.files[0].diff).toContain('+one');
  });

  it('marks a Write that changes nothing as an empty diff rather than an error', async () => {
    const preview = await previewMutation(
      call('Write', { filePath: 'notes.txt', content: 'alpha\nbeta\ngamma\n' }),
      workspace,
    );
    expect(preview?.error).toBeUndefined();
    expect(preview?.files[0].diff).toBe('');
    expect(preview?.files[0].stats).toEqual({ addedLines: 0, removedLines: 0 });
  });

  it('previews every file operation in an ApplyPatch envelope', async () => {
    writeFileSync(join(workspace, 'gone.txt'), 'bye\n');
    const patch = [
      '*** Begin Patch',
      '*** Update File: notes.txt',
      '@@',
      ' alpha',
      '-beta',
      '+BETA',
      ' gamma',
      '*** Add File: fresh.txt',
      '+hello',
      '*** Delete File: gone.txt',
      '*** End Patch',
    ].join('\n');
    const preview = await previewMutation(call('ApplyPatch', { patch }), workspace);
    expect(preview?.error).toBeUndefined();
    expect(preview?.files.map((file) => [file.filePath, file.kind])).toEqual([
      ['notes.txt', 'update'],
      ['fresh.txt', 'create'],
      ['gone.txt', 'delete'],
    ]);
    expect(preview?.files[0].diff).toContain('+BETA');
    expect(preview?.files[1].diff).toContain('+hello');
    expect(preview?.files[2].diff).toContain('-bye');
    expect(readFileSync(join(workspace, 'gone.txt'), 'utf8')).toBe('bye\n');
  });

  it('surfaces a patch whose context does not match', async () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: notes.txt',
      '@@',
      ' nothing like this',
      '-beta',
      '+BETA',
      '*** End Patch',
    ].join('\n');
    const preview = await previewMutation(call('ApplyPatch', { patch }), workspace);
    expect(preview?.files).toEqual([]);
    expect(preview?.error).toContain('notes.txt');
    expect(preview?.error).toContain('context not found');

    const malformed = await previewMutation(call('ApplyPatch', { patch: 'nope' }), workspace);
    expect(malformed?.error).toContain('Begin Patch');
  });

  it('never throws for missing or malformed arguments', async () => {
    expect((await previewMutation(call('Edit', {}), workspace))?.error).toBe('No edit given');
    expect((await previewMutation(call('Write', { filePath: 'x' }), workspace))?.error).toBe(
      'No content given',
    );
    expect(
      (await previewMutation(call('MultiEdit', { filePath: 'notes.txt', edits: 'x' }), workspace))
        ?.error,
    ).toBe('No edits provided');
  });
});
