import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileTools } from './file.js';
import { notebookTools } from './notebook.js';
import { patchTools } from './patch.js';
import type { ToolContext } from '../types/tools.js';

// #674: a file the model read and then deleted outside the file tools (`rm` through Bash).
const tool = (name: string) => fileTools.find((t) => t.name === name)!;
const read = tool('Read');
const write = tool('Write');
const edit = tool('Edit');
const multiEdit = tool('MultiEdit');
const notebookEdit = notebookTools.find((t) => t.name === 'NotebookEdit')!;
const applyPatch = patchTools[0];

// A Windows account without the symlink privilege cannot make the link the dangling-link cases need.
const canSymlink = (() => {
  const probe = mkdtempSync(join(tmpdir(), 'book-symlink-probe-'));
  try {
    symlinkSync(join(probe, 'missing'), join(probe, 'link'), 'file');
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();

let dir: string;
let ctx: ToolContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-deleted-'));
  ctx = { workspaceRoot: dir, env: {}, fileObservationLedger: new Map() };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function observe(name: string, content = 'old\n'): Promise<void> {
  writeFileSync(join(dir, name), content);
  const result = await read.execute({ filePath: name }, ctx);
  expect(result.status).toBe('success');
}

describe('a file deleted after the model observed it', () => {
  it('can be created again by Write, and a Read then shows the new content', async () => {
    await observe('gen.py');
    unlinkSync(join(dir, 'gen.py'));

    const written = await write.execute({ filePath: 'gen.py', content: 'new\n' }, ctx);
    expect(written.status).toBe('success');
    expect(readFileSync(join(dir, 'gen.py'), 'utf-8')).toBe('new\n');

    const shown = await read.execute({ filePath: 'gen.py' }, ctx);
    expect(shown.status).toBe('success');
    expect(shown.content).toContain('new');

    // The create recorded a fresh observation: the next overwrite is an ordinary one.
    const again = await write.execute({ filePath: 'gen.py', content: 'newer\n' }, ctx);
    expect(again.status).toBe('success');
  });

  it('can be created again when a parent directory went with it', async () => {
    mkdirSync(join(dir, 'sub'));
    await observe('sub/gen.py');
    rmSync(join(dir, 'sub'), { recursive: true });
    mkdirSync(join(dir, 'sub'));

    const written = await write.execute({ filePath: 'sub/gen.py', content: 'new\n' }, ctx);
    expect(written.status).toBe('success');
  });

  it('is told "not found" by Edit and MultiEdit, not to Read it', async () => {
    await observe('gone.txt');
    unlinkSync(join(dir, 'gone.txt'));

    const edited = await edit.execute(
      { filePath: 'gone.txt', oldString: 'old', newString: 'new' },
      ctx,
    );
    expect(edited.status).toBe('error');
    expect(edited.structuredError?.code).not.toBe('stale_file_observation');
    expect(edited.structuredError?.message).toContain('File not found');
    expect(edited.structuredError?.message).not.toContain('Call Read');

    const multi = await multiEdit.execute(
      { filePath: 'gone.txt', edits: [{ oldString: 'old', newString: 'new' }] },
      ctx,
    );
    expect(multi.status).toBe('error');
    expect(multi.structuredError?.code).not.toBe('stale_file_observation');
    expect(multi.structuredError?.message).toContain('File not found');
    expect(existsSync(join(dir, 'gone.txt'))).toBe(false);
  });
});

describe('a path that still has something at it keeps the stale refusal', () => {
  it('refuses a Write over a file that changed since the Read', async () => {
    await observe('changed.txt');
    writeFileSync(join(dir, 'changed.txt'), 'someone else\n');
    const result = await write.execute({ filePath: 'changed.txt', content: 'mine\n' }, ctx);
    expect(result.status).toBe('error');
    expect(result.structuredError?.code).toBe('stale_file_observation');
    expect(readFileSync(join(dir, 'changed.txt'), 'utf-8')).toBe('someone else\n');
  });

  it('refuses a Write over a file that was replaced', async () => {
    await observe('replaced.txt');
    writeFileSync(join(dir, 'other.txt'), 'replacement\n');
    renameSync(join(dir, 'other.txt'), join(dir, 'replaced.txt'));
    const result = await write.execute({ filePath: 'replaced.txt', content: 'mine\n' }, ctx);
    expect(result.status).toBe('error');
    expect(result.structuredError?.code).toBe('stale_file_observation');
    expect(readFileSync(join(dir, 'replaced.txt'), 'utf-8')).toBe('replacement\n');
  });

  it('refuses a Write over a directory that took the file’s place', async () => {
    await observe('dir.txt');
    unlinkSync(join(dir, 'dir.txt'));
    mkdirSync(join(dir, 'dir.txt'));
    const result = await write.execute({ filePath: 'dir.txt', content: 'mine\n' }, ctx);
    expect(result.status).toBe('error');
    expect(result.structuredError?.code).toBe('stale_file_observation');
  });

  it.skipIf(!canSymlink)(
    'refuses a Write through a dangling symlink and creates nothing at its target',
    async () => {
      await observe('link.txt');
      unlinkSync(join(dir, 'link.txt'));
      const target = join(dir, 'target-that-does-not-exist.txt');
      symlinkSync(target, join(dir, 'link.txt'), 'file');
      const result = await write.execute({ filePath: 'link.txt', content: 'mine\n' }, ctx);
      expect(result.status).toBe('error');
      expect(result.structuredError?.code).toBe('stale_file_observation');
      expect(existsSync(target)).toBe(false);
      // A refused Write leaves what the model saw as it was.
      expect(ctx.fileObservationLedger?.size).toBe(1);
    },
  );
});

describe('the other mutation tools on a file that was deleted', () => {
  it('ApplyPatch reports Update File and Delete File as not found, not stale', async () => {
    await observe('patched.txt');
    unlinkSync(join(dir, 'patched.txt'));

    const updated = await applyPatch.execute(
      {
        patch: '*** Begin Patch\n*** Update File: patched.txt\n@@\n-old\n+new\n*** End Patch',
      },
      ctx,
    );
    expect(updated.status).toBe('error');
    expect(updated.structuredError?.code).not.toBe('stale_file_observation');
    expect(updated.structuredError?.message).toContain('File not found');

    const deleted = await applyPatch.execute(
      { patch: '*** Begin Patch\n*** Delete File: patched.txt\n*** End Patch' },
      ctx,
    );
    expect(deleted.status).toBe('error');
    expect(deleted.structuredError?.code).not.toBe('stale_file_observation');
    expect(deleted.structuredError?.message).toContain('File not found');
  });

  it('NotebookEdit reports a deleted notebook as not found, not stale', async () => {
    await observe(
      'nb.ipynb',
      JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }),
    );
    unlinkSync(join(dir, 'nb.ipynb'));
    const result = await notebookEdit.execute(
      { notebook_path: 'nb.ipynb', new_source: 'print(1)', cell_type: 'code', edit_mode: 'insert' },
      ctx,
    );
    expect(result.status).toBe('error');
    expect(result.structuredError?.code).not.toBe('stale_file_observation');
    expect(result.structuredError?.message).toContain('Notebook not found');
  });

  it.skipIf(!canSymlink)(
    'Edit and MultiEdit report a dangling symlink as not found, not stale',
    async () => {
      await observe('dangling.txt');
      unlinkSync(join(dir, 'dangling.txt'));
      symlinkSync(join(dir, 'nowhere.txt'), join(dir, 'dangling.txt'), 'file');

      const edited = await edit.execute(
        { filePath: 'dangling.txt', oldString: 'old', newString: 'new' },
        ctx,
      );
      expect(edited.status).toBe('error');
      expect(edited.structuredError?.code).not.toBe('stale_file_observation');
      expect(edited.structuredError?.message).toContain('File not found');

      const multi = await multiEdit.execute(
        { filePath: 'dangling.txt', edits: [{ oldString: 'old', newString: 'new' }] },
        ctx,
      );
      expect(multi.structuredError?.code).not.toBe('stale_file_observation');
      expect(multi.structuredError?.message).toContain('File not found');
      expect(existsSync(join(dir, 'nowhere.txt'))).toBe(false);
    },
  );
});
