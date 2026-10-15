import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FileObservation, ToolContext } from './types/tools.js';
import { checkMemoryWrite } from './memory-write-guard.js';
import { fileTools } from './tools/file.js';
import { patchTools } from './tools/patch.js';
import { observeFile } from './tools/file-provenance.js';

const write = fileTools.find((t) => t.name === 'Write')!;
const edit = fileTools.find((t) => t.name === 'Edit')!;
const multiEdit = fileTools.find((t) => t.name === 'MultiEdit')!;
const applyPatch = patchTools[0];

let dirs: string[] = [];
let workspace: string;
let memory: string;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  workspace = tempDir('book-memguard-ws-');
  memory = tempDir('book-memguard-mem-');
});

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function context(
  scope: 'full' | 'learnings' = 'full',
  overrides: Partial<ToolContext> = {},
): ToolContext {
  return {
    workspaceRoot: workspace,
    env: {},
    fileObservationLedger: new Map<string, FileObservation>(),
    memoryWrite: { root: memory, scope, sessionId: 'session-1' },
    ...overrides,
  };
}

const topic = (type: string, extra: string[] = []): string =>
  [
    '---',
    'name: a-fact',
    'description: A fact',
    'metadata:',
    `  type: ${type}`,
    ...extra,
    '---',
    'Body.',
    '',
  ].join('\n');

const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;

function failureCode(result: ReturnType<typeof checkMemoryWrite>): string | undefined {
  return result.ok ? undefined : result.failure.structuredError?.code;
}

describe('checkMemoryWrite', () => {
  it('refuses when the context has no memory write root', () => {
    const ctx = context('full', { memoryWrite: undefined });
    expect(failureCode(checkMemoryWrite(ctx, join(memory, 'a.md'), topic('project'), null))).toBe(
      'memory_write_unavailable',
    );
  });

  it('refuses content the secret detector flags, in a topic file and in the index', () => {
    const ctx = context();
    const secret = `${topic('project').trimEnd()}\napi_key = abcdefghijklmnop123\n`;
    expect(failureCode(checkMemoryWrite(ctx, join(memory, 'a.md'), secret, null))).toBe(
      'memory_secret_rejected',
    );
    expect(
      failureCode(
        checkMemoryWrite(
          ctx,
          join(memory, 'MEMORY.md'),
          '- [x](a.md) — token: abcdefghijklmnop123\n',
          null,
        ),
      ),
    ).toBe('memory_secret_rejected');
  });

  it('does not apply the old body-size limits', () => {
    const big = `${topic('project')}${'A sentence about the build. '.repeat(400)}\n`;
    const result = checkMemoryWrite(context(), join(memory, 'a.md'), big, null);
    expect(result.ok).toBe(true);
  });

  it('only judges what an index write adds for secrets', () => {
    const prior = '- [old](old.md) — token: abcdefghijklmnop123\n';
    const next = `${prior}- [new](new.md) — fine\n`;
    expect(checkMemoryWrite(context(), join(memory, 'MEMORY.md'), next, prior).ok).toBe(true);
  });

  describe('learnings scope', () => {
    const ctx = () => context('learnings');

    it('requires metadata.type of project or reference on a topic file', () => {
      const path = join(memory, 'a.md');
      for (const type of ['user', 'feedback']) {
        expect(failureCode(checkMemoryWrite(ctx(), path, topic(type), null))).toBe(
          'memory_type_not_allowed',
        );
      }
      expect(failureCode(checkMemoryWrite(ctx(), path, 'No frontmatter.\n', null))).toBe(
        'memory_type_not_allowed',
      );
      expect(checkMemoryWrite(ctx(), path, topic('project'), null).ok).toBe(true);
      expect(checkMemoryWrite(ctx(), path, topic('reference'), null).ok).toBe(true);
    });

    it('reads a top-level type for the legacy layout', () => {
      const legacy = '---\ntype: project\ntitle: old\n---\nBody.\n';
      expect(checkMemoryWrite(ctx(), join(memory, 'a.md'), legacy, null).ok).toBe(true);
    });

    it('changes or deletes only a file that says driver: agent', () => {
      const path = join(memory, 'a.md');
      const person = topic('project');
      expect(failureCode(checkMemoryWrite(ctx(), path, topic('project'), person))).toBe(
        'memory_owned_by_person',
      );
      expect(failureCode(checkMemoryWrite(ctx(), path, null, person))).toBe(
        'memory_owned_by_person',
      );
      const own = topic('project', ['  driver: agent']);
      expect(checkMemoryWrite(ctx(), path, topic('project'), own).ok).toBe(true);
      expect(checkMemoryWrite(ctx(), path, null, own).ok).toBe(true);
      // A legacy top-level driver counts as well.
      const legacy = '---\ndriver: agent\ntype: project\n---\nBody.\n';
      expect(checkMemoryWrite(ctx(), path, topic('project'), legacy).ok).toBe(true);
    });

    describe('MEMORY.md', () => {
      const personLine = '- [Person](person.md) — theirs';
      const agentLine = '- [Agent](agent.md) — ours';
      const index = (...lines: string[]) => `${lines.join('\n')}\n`;

      beforeEach(() => {
        writeFileSync(join(memory, 'person.md'), topic('project'));
        writeFileSync(join(memory, 'agent.md'), topic('project', ['  driver: agent']));
      });

      it('refuses to remove or change a line pointing at a person’s file', () => {
        const path = join(memory, 'MEMORY.md');
        const prior = index('# Memory', personLine, agentLine);
        expect(
          failureCode(checkMemoryWrite(ctx(), path, index('# Memory', agentLine), prior)),
        ).toBe('memory_owned_by_person');
        expect(
          failureCode(
            checkMemoryWrite(
              ctx(),
              path,
              index('# Memory', '- [Person](person.md) — reworded', agentLine),
              prior,
            ),
          ),
        ).toBe('memory_owned_by_person');
        expect(failureCode(checkMemoryWrite(ctx(), path, null, prior))).toBe(
          'memory_owned_by_person',
        );
      });

      it('allows adding lines, and changing or removing a line for its own file', () => {
        const path = join(memory, 'MEMORY.md');
        const prior = index('# Memory', personLine, agentLine);
        writeFileSync(join(memory, 'new.md'), topic('project'));
        expect(
          checkMemoryWrite(
            ctx(),
            path,
            index('# Memory', personLine, agentLine, '- [New](new.md) — added'),
            prior,
          ).ok,
        ).toBe(true);
        expect(checkMemoryWrite(ctx(), path, index('# Memory', personLine), prior).ok).toBe(true);
      });

      it('lets a person-driven session rewrite anything', () => {
        const prior = index('# Memory', personLine, agentLine);
        expect(
          checkMemoryWrite(context('full'), join(memory, 'MEMORY.md'), index('# Memory'), prior).ok,
        ).toBe(true);
      });
    });
  });

  describe('provenance stamp', () => {
    const stampOf = (
      text: string,
      scope: 'full' | 'learnings' = 'full',
      prior: string | null = null,
    ): string => {
      const result = checkMemoryWrite(context(scope), join(memory, 'a.md'), text, prior);
      if (!result.ok || result.content === null) throw new Error('expected a stamped write');
      return result.content;
    };

    it('adds a metadata block to a file that has frontmatter but none', () => {
      const input = '---\nname: a\n# a comment\ndescription: d\n---\n\nBody line.\n';
      const out = stampOf(input);
      expect(out.replace(ISO, 'NOW')).toBe(
        '---\nname: a\n# a comment\ndescription: d\nmetadata:\n  originSessionId: session-1\n  modified: NOW\n---\n\nBody line.\n',
      );
    });

    it('keeps every other line and an existing originSessionId, and updates modified', () => {
      const input = [
        '---',
        'name: a',
        'description: d # why',
        'metadata:',
        '  type: project',
        '  originSessionId: original',
        '  modified: 2020-01-01T00:00:00.000Z # old',
        '# trailing comment',
        'other: x',
        '---',
        'Body',
        '',
      ].join('\n');
      const out = stampOf(input);
      expect(out.replace(ISO, 'NOW')).toBe(input.replace('2020-01-01T00:00:00.000Z', 'NOW'));
      expect(out).toContain('  originSessionId: original\n');
    });

    it('fills an empty originSessionId and inserts missing keys after the last child', () => {
      const input =
        '---\nname: a\nmetadata:\n  type: project\n  originSessionId:\nother: x\n---\nBody\n';
      const out = stampOf(input, 'learnings');
      expect(out.replace(ISO, 'NOW')).toBe(
        '---\nname: a\nmetadata:\n  type: project\n  originSessionId: session-1\n  modified: NOW\n  driver: agent\nother: x\n---\nBody\n',
      );
    });

    it('adds driver: agent in learnings scope only', () => {
      const input = topic('project');
      expect(stampOf(input, 'learnings')).toContain('  driver: agent\n');
      expect(stampOf(input, 'full')).not.toContain('driver');
    });

    it('keeps a legacy top-level layout and still adds the metadata block', () => {
      const input = '---\ntype: project\ntitle: Old\nupdated: 2020\n---\nBody\n';
      const out = stampOf(input);
      expect(out.replace(ISO, 'NOW')).toBe(
        '---\ntype: project\ntitle: Old\nupdated: 2020\nmetadata:\n  originSessionId: session-1\n  modified: NOW\n---\nBody\n',
      );
    });

    it('writes a file with no frontmatter as given', () => {
      expect(stampOf('Just a note.\n')).toBe('Just a note.\n');
    });

    it('does not stamp the index', () => {
      const result = checkMemoryWrite(
        context(),
        join(memory, 'MEMORY.md'),
        '---\nname: x\n---\n',
        null,
      );
      expect(result.ok && result.content).toBe('---\nname: x\n---\n');
    });

    it('omits originSessionId when the session is unknown', () => {
      const ctx = context('full', { memoryWrite: { root: memory, scope: 'full' } });
      const result = checkMemoryWrite(ctx, join(memory, 'a.md'), topic('project'), null);
      expect(result.ok && result.content).not.toContain('originSessionId');
    });
  });

  describe('warnings', () => {
    it('warns about a topic file over 4,096 bytes, without refusing', () => {
      const big = `${topic('project')}${'x '.repeat(2100)}\n`;
      const result = checkMemoryWrite(context(), join(memory, 'a.md'), big, null);
      expect(result.ok && result.warnings.join(' ')).toContain('4096');
    });

    it('warns about an index over 200 lines', () => {
      writeFileSync(join(memory, 'a.md'), topic('project'));
      const lines = Array.from({ length: 201 }, () => '- [A](a.md) — hook');
      const result = checkMemoryWrite(
        context(),
        join(memory, 'MEMORY.md'),
        `${lines.join('\n')}\n`,
        null,
      );
      expect(result.ok && result.warnings.join(' ')).toContain('201 lines');
    });

    it('warns about an index over 25,000 bytes', () => {
      writeFileSync(join(memory, 'a.md'), topic('project'));
      const line = `- [A](a.md) — ${'word '.repeat(40).trim()}`;
      const text = `${Array.from({ length: 150 }, () => line).join('\n')}\n`;
      expect(Buffer.byteLength(text)).toBeGreaterThan(25_000);
      const result = checkMemoryWrite(context(), join(memory, 'MEMORY.md'), text, null);
      expect(result.ok && result.warnings.join(' ')).toContain('bytes');
    });

    it('warns about an entry whose file is missing, and stays quiet when it exists', () => {
      writeFileSync(join(memory, 'here.md'), topic('project'));
      const result = checkMemoryWrite(
        context(),
        join(memory, 'MEMORY.md'),
        '- [Here](here.md) — ok\n- [Gone](gone.md) — missing\n',
        null,
      );
      expect(result.ok && result.warnings).toHaveLength(1);
      expect(result.ok && result.warnings[0]).toContain('gone.md');
      expect(result.ok && result.warnings[0]).not.toContain('here.md');
    });
  });
});

const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('memory writes through the file tools', () => {
  it('creates a memory file, edits it on the stamped bytes, and deletes it with ApplyPatch', async () => {
    const ctx = context();
    const path = join(memory, 'build-cmd.md');
    const created = await write.execute({ filePath: path, content: topic('project') }, ctx);
    expect(created.status).toBe('success');
    const stamped = readFileSync(path, 'utf8');
    expect(stamped).toContain('  originSessionId: session-1\n');
    expect(stamped).toMatch(/\n {2}modified: \d{4}-/);
    expect(stamped.startsWith('---\nname: a-fact\n')).toBe(true);

    // The ledger holds the stamped bytes, not the ones the model sent.
    const ledgerHashes = [...ctx.fileObservationLedger!.values()].map((o) => o.sha256);
    expect(ledgerHashes).toContain(sha(path));

    const edited = await edit.execute(
      { filePath: path, oldString: 'Body.', newString: 'Changed body.' },
      ctx,
    );
    expect(edited.status).toBe('success');
    expect(readFileSync(path, 'utf8')).toContain('Changed body.');
    expect(readFileSync(path, 'utf8')).toContain('  originSessionId: session-1\n');

    const multi = await multiEdit.execute(
      {
        filePath: path,
        edits: [
          { oldString: 'Changed body.', newString: 'Second body.' },
          { oldString: 'A fact', newString: 'A better fact' },
        ],
      },
      ctx,
    );
    expect(multi.status).toBe('success');
    expect(readFileSync(path, 'utf8')).toContain('description: A better fact');

    const deleted = await applyPatch.execute(
      { patch: `*** Begin Patch\n*** Delete File: ${path}\n*** End Patch` },
      ctx,
    );
    expect(deleted.status).toBe('success');
    expect(existsSync(path)).toBe(false);
  });

  it('creates and updates memory files with ApplyPatch', async () => {
    const ctx = context();
    const path = join(memory, 'patched.md');
    const added = await applyPatch.execute(
      {
        patch: `*** Begin Patch\n*** Add File: ${path}\n+---\n+name: p\n+description: d\n+---\n+Body\n*** End Patch`,
      },
      ctx,
    );
    expect(added.status).toBe('success');
    expect(readFileSync(path, 'utf8')).toContain('metadata:\n  originSessionId: session-1');
    const updated = await applyPatch.execute(
      {
        patch: `*** Begin Patch\n*** Update File: ${path}\n@@\n-Body\n+New body\n*** End Patch`,
      },
      ctx,
    );
    expect(updated.status).toBe('success');
    expect(readFileSync(path, 'utf8')).toContain('New body');
    expect(readFileSync(path, 'utf8').match(/originSessionId/g)).toHaveLength(1);
  });

  it('refuses a secret and writes nothing', async () => {
    const ctx = context();
    const path = join(memory, 'leak.md');
    const result = await write.execute(
      { filePath: path, content: `${topic('project')}password = hunter2hunter2\n` },
      ctx,
    );
    expect(result.status).not.toBe('success');
    expect(result.structuredError?.code).toBe('memory_secret_rejected');
    expect(existsSync(path)).toBe(false);
  });

  it('refuses a write for a context with no memory root, as outside the workspace', async () => {
    const ctx = context('full', { memoryWrite: undefined });
    const result = await write.execute(
      { filePath: join(memory, 'a.md'), content: topic('project') },
      ctx,
    );
    expect(result.structuredError?.code).toBe('path_outside_workspace');
    expect(existsSync(join(memory, 'a.md'))).toBe(false);
  });

  it('leaves a workspace file with the same name outside the guard', async () => {
    const ctx = context('learnings');
    const result = await write.execute(
      { filePath: join(workspace, 'plain.md'), content: 'No frontmatter, any type.\n' },
      ctx,
    );
    expect(result.status).toBe('success');
    expect(readFileSync(join(workspace, 'plain.md'), 'utf8')).toBe('No frontmatter, any type.\n');
  });

  it('appends the guard’s warnings to the result', async () => {
    const ctx = context();
    const path = join(memory, 'MEMORY.md');
    const result = await write.execute({ filePath: path, content: '- [Gone](gone.md) — x\n' }, ctx);
    expect(result.status).toBe('success');
    expect(result.maskedPlaceholder ?? result.content).toContain('gone.md');
  });

  it('edits a seeded MEMORY.md without a Read, and a file never observed needs one', async () => {
    const ctx = context();
    const index = join(memory, 'MEMORY.md');
    writeFileSync(index, '# Memory\n');
    writeFileSync(join(memory, 'other.md'), topic('project'));

    // What the agent loop does for an index that loaded whole.
    await observeFile(ctx, index, 'read');
    const seeded = await edit.execute(
      {
        filePath: index,
        oldString: '# Memory',
        newString: '# Memory\n- [Other](other.md) — a pointer',
      },
      ctx,
    );
    expect(seeded.status).toBe('success');

    const unseeded = await edit.execute(
      { filePath: join(memory, 'other.md'), oldString: 'Body.', newString: 'Changed.' },
      ctx,
    );
    expect(unseeded.structuredError?.code).toBe('file_not_observed');
  });

  it('serves a learnings session only its own files', async () => {
    const ctx = context('learnings');
    const person = join(memory, 'person.md');
    writeFileSync(person, topic('project'));
    await observeFile(ctx, person, 'read');
    const result = await edit.execute(
      { filePath: person, oldString: 'Body.', newString: 'Mine now.' },
      ctx,
    );
    expect(result.structuredError?.code).toBe('memory_owned_by_person');
    expect(readFileSync(person, 'utf8')).toContain('Body.');

    const own = join(memory, 'own.md');
    expect((await write.execute({ filePath: own, content: topic('reference') }, ctx)).status).toBe(
      'success',
    );
    expect(readFileSync(own, 'utf8')).toContain('  driver: agent\n');
    expect(
      (await write.execute({ filePath: join(memory, 'pref.md'), content: topic('user') }, ctx))
        .structuredError?.code,
    ).toBe('memory_type_not_allowed');
  });

  it('leaves the memory directory unwritten by a mixed ApplyPatch failure', async () => {
    const ctx = context('learnings');
    const person = join(memory, 'person.md');
    writeFileSync(person, topic('project'));
    await observeFile(ctx, person, 'read');
    writeFileSync(join(workspace, 'a.txt'), 'one\n');
    const result = await applyPatch.execute(
      {
        patch: `*** Begin Patch\n*** Update File: ${join(workspace, 'a.txt')}\n@@\n-one\n+two\n*** Update File: ${person}\n@@\n-Body.\n+X\n*** End Patch`,
      },
      ctx,
    );
    expect(result.structuredError?.code).toBe('memory_owned_by_person');
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('one\n');
  });
});
