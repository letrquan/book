import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../types/tools.js';
import { patchTools, parsePatch } from './patch.js';

const roots: string[] = [];

async function fixture(): Promise<{ root: string; context: ToolContext }> {
  const root = await mkdtemp(join(tmpdir(), 'book-apply-patch-'));
  roots.push(root);
  return { root, context: { workspaceRoot: root, env: {}, fileObservationLedger: new Map() } };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const execute = patchTools[0].execute;

describe('ApplyPatch', () => {
  it('parses update, add, and delete operations', () => {
    const parsed = parsePatch(
      '*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** Add File: b.txt\n+hello\n*** Delete File: c.txt\n*** End Patch',
    );
    expect('operations' in parsed && parsed.operations.map((operation) => operation.kind)).toEqual([
      'update',
      'add',
      'delete',
    ]);
  });

  it('applies an LF patch to CRLF text while preserving CRLF and BOM', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'sample.txt');
    await writeFile(file, Buffer.from('\ufeffone\r\ntwo\r\nthree\r\n', 'utf8'));
    const result = await execute(
      {
        patch:
          '*** Begin Patch\n*** Update File: sample.txt\n@@\n one\n-two\n+changed\n three\n*** End Patch',
      },
      context,
    );
    expect(result.status).toBe('success');
    expect(await readFile(file, 'utf8')).toBe('\ufeffone\r\nchanged\r\nthree\r\n');
    expect(result.artifacts?.fileMutation?.filePath).toBe('sample.txt');
  });

  it('preserves LF text when the patch uses CRLF separators', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'sample.txt');
    await writeFile(file, 'one\ntwo\n');
    const result = await execute(
      {
        patch:
          '*** Begin Patch\r\n*** Update File: sample.txt\r\n@@\r\n one\r\n-two\r\n+changed\r\n*** End Patch',
      },
      context,
    );
    expect(result.status).toBe('success');
    expect(await readFile(file, 'utf8')).toBe('one\nchanged\n');
  });

  it('supports multi-file add and delete and returns per-file artifacts', async () => {
    const { root, context } = await fixture();
    await writeFile(join(root, 'remove.txt'), 'gone\n');
    const result = await execute(
      {
        patch:
          '*** Begin Patch\n*** Add File: created.txt\n+hello\n*** Delete File: remove.txt\n*** End Patch',
      },
      context,
    );
    expect(result.status).toBe('success');
    expect(result.artifacts?.fileMutations?.map((mutation) => mutation.kind)).toEqual([
      'create',
      'delete',
    ]);
    await expect(readFile(join(root, 'created.txt'), 'utf8')).resolves.toBe('hello\n');
    await expect(readFile(join(root, 'remove.txt'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('applies several hunks and preserves a missing trailing newline', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'multi.txt');
    await writeFile(file, 'first\nmiddle\nlast');
    const result = await execute(
      {
        patch:
          '*** Begin Patch\n*** Update File: multi.txt\n@@\n-first\n+FIRST\n@@\n-last\n+LAST\n*** End Patch',
      },
      context,
    );
    expect(result.status).toBe('success');
    expect(await readFile(file, 'utf8')).toBe('FIRST\nmiddle\nLAST');
  });

  it('honors a marker that removes the final newline', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'sample.txt');
    await writeFile(file, 'old\n');

    const result = await execute(
      {
        patch:
          '*** Begin Patch\n*** Update File: sample.txt\n@@\n-old\n+new\n\\ No newline at end of file\n*** End Patch',
      },
      context,
    );

    expect(result.status).toBe('success');
    expect(await readFile(file, 'utf8')).toBe('new');
  });

  it('honors a marker that adds the final newline', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'sample.txt');
    await writeFile(file, 'old');

    const result = await execute(
      {
        patch:
          '*** Begin Patch\n*** Update File: sample.txt\n@@\n-old\n\\ No newline at end of file\n+new\n*** End Patch',
      },
      context,
    );

    expect(result.status).toBe('success');
    expect(await readFile(file, 'utf8')).toBe('new\n');
  });

  it('rejects path aliases that resolve to the same file', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'a.txt');
    await writeFile(file, 'old\n');

    const result = await execute(
      {
        patch:
          '*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+first\n*** Update File: ./a.txt\n@@\n-old\n+second\n*** End Patch',
      },
      context,
    );

    expect(result.structuredError?.code).toBe('patch_conflict');
    expect(await readFile(file, 'utf8')).toBe('old\n');
  });

  it.skipIf(process.platform === 'win32')(
    'updates a file symlink target without replacing the symlink',
    async () => {
      const { root, context } = await fixture();
      const target = join(root, 'target.txt');
      const link = join(root, 'link.txt');
      await writeFile(target, 'old\n');
      await symlink(target, link, 'file');

      const result = await execute(
        { patch: '*** Begin Patch\n*** Update File: link.txt\n@@\n-old\n+new\n*** End Patch' },
        context,
      );

      expect(result.status).toBe('success');
      expect((await lstat(link)).isSymbolicLink()).toBe(true);
      expect(await readFile(target, 'utf8')).toBe('new\n');
    },
  );

  it('supports Unicode paths and source text', async () => {
    const { root, context } = await fixture();
    await mkdir(join(root, 'src'));
    const file = join(root, 'src', '数据.ts');
    await writeFile(file, 'const 名称 = "旧";\n');
    const result = await execute(
      {
        patch:
          '*** Begin Patch\n*** Update File: src/数据.ts\n@@\n-const 名称 = "旧";\n+const 名称 = "新";\n*** End Patch',
      },
      context,
    );
    expect(result.status).toBe('success');
    expect(await readFile(file, 'utf8')).toBe('const 名称 = "新";\n');
  });

  it('rejects binary files', async () => {
    const { root, context } = await fixture();
    await writeFile(join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
    const result = await execute(
      {
        patch: '*** Begin Patch\n*** Update File: binary.dat\n@@\n-old\n+new\n*** End Patch',
      },
      context,
    );
    expect(result.structuredError?.code).toBe('binary_file_unsupported');
  });

  it('rejects an ambiguous context without changing the file', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'repeat.txt');
    await writeFile(file, 'same\nother\nsame\n');
    const result = await execute(
      { patch: '*** Begin Patch\n*** Update File: repeat.txt\n@@\n-same\n+changed\n*** End Patch' },
      context,
    );
    expect(result.structuredError?.code).toBe('ambiguous_patch_context');
    expect(await readFile(file, 'utf8')).toBe('same\nother\nsame\n');
  });

  it('rejects stale observations and asks for a reread', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'stale.txt');
    await writeFile(file, 'old\n');
    await execute(
      { patch: '*** Begin Patch\n*** Update File: stale.txt\n@@\n-old\n+new\n*** End Patch' },
      context,
    );
    await writeFile(file, 'changed externally\n');
    const result = await execute(
      { patch: '*** Begin Patch\n*** Update File: stale.txt\n@@\n-new\n+newer\n*** End Patch' },
      context,
    );
    expect(result.structuredError?.code).toBe('stale_file_observation');
  });

  it('rejects malformed patches before touching files', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'safe.txt');
    await writeFile(file, 'safe\n');
    const result = await execute(
      { patch: '*** Begin Patch\n*** Update File: safe.txt\nnot a hunk\n*** End Patch' },
      context,
    );
    expect(result.structuredError?.code).toBe('invalid_patch_syntax');
    expect(await readFile(file, 'utf8')).toBe('safe\n');
  });

  it('reports mixed line endings instead of silently rewriting them', async () => {
    const { root, context } = await fixture();
    await writeFile(join(root, 'mixed.txt'), 'one\r\ntwo\nthree\r\n');
    const result = await execute(
      { patch: '*** Begin Patch\n*** Update File: mixed.txt\n@@\n-one\n+ONE\n*** End Patch' },
      context,
    );
    expect(result.structuredError?.code).toBe('patch_conflict');
    expect(result.structuredError?.details).toMatchObject({ lineEnding: 'mixed' });
  });

  it('rejects traversal and absolute paths before mutation', async () => {
    const { context } = await fixture();
    const result = await execute(
      {
        patch: '*** Begin Patch\n*** Add File: ../outside.txt\n+secret\n*** End Patch',
      },
      context,
    );
    expect(result.structuredError?.code).toBe('path_outside_workspace');
  });

  it('serializes concurrent patches so only one old-context mutation commits', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'shared.txt');
    await writeFile(file, 'old\n');
    const first = execute(
      { patch: '*** Begin Patch\n*** Update File: shared.txt\n@@\n-old\n+first\n*** End Patch' },
      context,
    );
    const second = execute(
      { patch: '*** Begin Patch\n*** Update File: shared.txt\n@@\n-old\n+second\n*** End Patch' },
      context,
    );
    const results = await Promise.all([first, second]);
    expect(results.filter((result) => result.status === 'success')).toHaveLength(1);
    expect(results.find((result) => result.status !== 'success')?.structuredError?.code).toBe(
      'patch_context_not_found',
    );
    expect(['first\n', 'second\n']).toContain(await readFile(file, 'utf8'));
  });

  it.skipIf(process.platform === 'win32')('preserves existing file mode bits', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'script.sh');
    await writeFile(file, 'echo old\n');
    await chmod(file, 0o755);
    const result = await execute(
      {
        patch:
          '*** Begin Patch\n*** Update File: script.sh\n@@\n-echo old\n+echo new\n*** End Patch',
      },
      context,
    );
    expect(result.status).toBe('success');
    expect((await stat(file)).mode & 0o777).toBe(0o755);
  });
});
