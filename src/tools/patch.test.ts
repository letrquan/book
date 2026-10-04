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
import { toolResultModelContent } from './result.js';

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

  it('applies a patch to an honored directory, and refuses it without one', async () => {
    const { context } = await fixture();
    const extra = await mkdtemp(join(tmpdir(), 'book-apply-patch-extra-'));
    roots.push(extra);
    const target = join(extra, 'shared.txt');
    await writeFile(target, 'before\n');
    context.additionalRoots = [extra];

    const patch = `*** Begin Patch\n*** Update File: ${target}\n@@\n-before\n+after\n*** End Patch`;
    const applied = await execute({ patch }, context);
    expect(applied.status).toBe('success');
    expect(await readFile(target, 'utf8')).toBe('after\n');

    // The same absolute path is outside every root once the directory is not honored, so honoring
    // it is the only thing that made the call legal.
    context.additionalRoots = [];
    const refused = await execute(
      { patch: `*** Begin Patch\n*** Update File: ${target}\n@@\n-after\n+again\n*** End Patch` },
      context,
    );
    expect(refused.structuredError?.code).toBe('path_outside_workspace');
    expect(await readFile(target, 'utf8')).toBe('after\n');
  });

  it('keeps a relative patch path anchored to the workspace', async () => {
    const { root, context } = await fixture();
    const extra = await mkdtemp(join(tmpdir(), 'book-apply-patch-extra-'));
    roots.push(extra);
    // The same name in both: a bare filename is the workspace's, never the honored root's.
    await writeFile(join(root, 'dup.txt'), 'workspace\n');
    await writeFile(join(extra, 'dup.txt'), 'extra\n');
    context.additionalRoots = [extra];

    const result = await execute(
      {
        patch: '*** Begin Patch\n*** Update File: dup.txt\n@@\n-workspace\n+edited\n*** End Patch',
      },
      context,
    );

    expect(result.status).toBe('success');
    expect(await readFile(join(root, 'dup.txt'), 'utf8')).toBe('edited\n');
    expect(await readFile(join(extra, 'dup.txt'), 'utf8')).toBe('extra\n');
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

describe('ApplyPatch hunk matching', () => {
  it('applies a later hunk whose context repeats earlier in the file when it is unique after the previous hunk', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'tails.txt');
    await writeFile(file, 'a\nend\nb\nend\n');
    const result = await execute(
      {
        patch:
          '*** Begin Patch\n*** Update File: tails.txt\n@@\n-b\n+B\n@@\n-end\n+END\n*** End Patch',
      },
      context,
    );
    expect(result.structuredError).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('a\nend\nB\nEND\n');
  });

  it('applies the Go function-tail shape that real sessions failed on', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'store.go');
    const tail = '\tif err := s.flush(); err != nil {\n\t\treturn err\n\t}\n\treturn nil\n}\n';
    await writeFile(
      file,
      `func (s *Store) Save() error {\n${tail}\n// Sync flushes.\nfunc (s *Store) Sync() error {\n\treturn nil\n}\n\nfunc (s *Store) Close() error {\n\tdefer s.file.Close()\n${tail}`,
    );
    const result = await execute(
      {
        patch: [
          '*** Begin Patch',
          '*** Update File: store.go',
          '@@',
          '-// Sync flushes.',
          '+// Sync flushes pending writes.',
          '@@',
          ' \tif err := s.flush(); err != nil {',
          ' \t\treturn err',
          ' \t}',
          '+\ts.file = nil',
          ' \treturn nil',
          ' }',
          '*** End Patch',
        ].join('\n'),
      },
      context,
    );
    expect(result.structuredError).toBeUndefined();
    const text = await readFile(file, 'utf8');
    expect(text.split('s.file = nil').length).toBe(2);
    expect(text.indexOf('s.file = nil')).toBeGreaterThan(text.indexOf('func (s *Store) Close'));
  });

  it('still rejects a hunk that repeats after the previous hunk, without changing the file', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'tails.txt');
    await writeFile(file, 'a\nend\nb\nend\nc\nend\n');
    const result = await execute(
      {
        patch:
          '*** Begin Patch\n*** Update File: tails.txt\n@@\n-a\n+A\n@@\n-end\n+END\n*** End Patch',
      },
      context,
    );
    expect(result.structuredError?.code).toBe('ambiguous_patch_context');
    expect(result.structuredError?.details).toMatchObject({
      hunkIndex: 2,
      matches: 3,
      matchesAfterPreviousHunk: 3,
    });
    expect(await readFile(file, 'utf8')).toBe('a\nend\nb\nend\nc\nend\n');
  });

  it('applies a globally unique hunk that precedes the previous hunk', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'order.txt');
    await writeFile(file, 'x\ny\nz\n');
    const result = await execute(
      {
        patch: '*** Begin Patch\n*** Update File: order.txt\n@@\n-z\n+Z\n@@\n-x\n+X\n*** End Patch',
      },
      context,
    );
    expect(result.structuredError).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('X\ny\nZ\n');
  });

  it('accepts an envelope whose Begin or End marker is repeated', async () => {
    const { root, context } = await fixture();
    const file = join(root, 'twice.txt');
    await writeFile(file, 'old\n');
    const result = await execute(
      {
        patch:
          '*** Begin Patch\n*** Begin Patch\n*** Update File: twice.txt\n@@\n-old\n+new\n*** End Patch\n*** End Patch',
      },
      context,
    );
    expect(result.structuredError).toBeUndefined();
    expect(await readFile(file, 'utf8')).toBe('new\n');
  });

  it('sends the model one line per created file when every mutation is a create (#378)', async () => {
    // GPT/Codex-family models are steered to ApplyPatch, so an Add File echoed
    // back as an all-plus diff is a second copy of every byte the model just
    // wrote (#378). The diffs stay on the result for the TUI and the record.
    const { root, context } = await fixture();
    const result = await execute(
      {
        patch: [
          '*** Begin Patch',
          '*** Add File: a.ts',
          '+one',
          '+two',
          '+three',
          '*** Add File: b.ts',
          '+x',
          '+y',
          '+z',
          '*** End Patch',
        ].join('\n'),
      },
      context,
    );

    expect(result.status).toBe('success');
    expect(result.maskedPlaceholder).toBe(
      'Created a.ts (3 lines, 14 bytes); created b.ts (3 lines, 6 bytes).',
    );
    const modelContent = toolResultModelContent(result);
    expect(modelContent).toBe(result.maskedPlaceholder);
    expect(modelContent).not.toContain('+one');
    expect(modelContent).not.toContain('+x');
    // The transcript's own input is unchanged: a diff the TUI can render.
    expect(result.content).toContain('+one');
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('one\ntwo\nthree\n');
  });

  it('sends the model the diffs when a patch also updates or deletes a file (#378)', async () => {
    const { root, context } = await fixture();
    await writeFile(join(root, 'existing.txt'), 'old\n');
    const mixed = await execute(
      {
        patch:
          '*** Begin Patch\n*** Add File: added.txt\n+fresh\n*** Update File: existing.txt\n@@\n-old\n+new\n*** End Patch',
      },
      context,
    );

    expect(mixed.status).toBe('success');
    expect(mixed.maskedPlaceholder).toBeUndefined();
    expect(toolResultModelContent(mixed)).toBe(mixed.content);

    await execute(
      { patch: '*** Begin Patch\n*** Delete File: existing.txt\n*** End Patch' },
      context,
    );
    const withDelete = await execute(
      {
        patch:
          '*** Begin Patch\n*** Add File: another.txt\n+fresh\n*** Delete File: added.txt\n*** End Patch',
      },
      context,
    );

    expect(withDelete.status).toBe('success');
    expect(withDelete.maskedPlaceholder).toBeUndefined();
  });
});
