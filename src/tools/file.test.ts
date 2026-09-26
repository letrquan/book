import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * Wraps the real yield so behaviour is unchanged and only the call becomes
 * observable. The large-read test needs to assert that formatting hands the
 * event loop back, and it cannot do that by racing a timer against it.
 */
vi.mock('../async.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../async.js')>();
  return { ...actual, yieldToEventLoop: vi.fn(actual.yieldToEventLoop) };
});
import { fileTools } from './file.js';
import { boundToolResultOutput, TOOL_RESULT_MAX_BYTES } from './result.js';
import type { ToolContext } from '../types/tools.js';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  rmSync,
} from 'fs';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

let dir: string;
const ctx: ToolContext = { workspaceRoot: '', env: {} };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-file-'));
  ctx.workspaceRoot = dir;
  ctx.fileObservationLedger = new Map();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const read = fileTools.find((t) => t.name === 'Read')!;
const write = fileTools.find((t) => t.name === 'Write')!;
const edit = fileTools.find((t) => t.name === 'Edit')!;
const multiEditTool = fileTools.find((t) => t.name === 'MultiEdit')!;
const glob = fileTools.find((t) => t.name === 'Glob')!;
const grep = fileTools.find((t) => t.name === 'Grep')!;

/** Mutations require a prior observation; tests Read once to satisfy the contract. */
const observeFirst = (name: string) => read.execute({ filePath: name }, ctx);

describe('read_file', () => {
  it('reads a file by workspace-relative path', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const r = await read.execute({ filePath: 'a.txt' }, ctx);
    expect(r.status).toBe('success');
    expect(r.content).toContain('1: hello');
  });

  it('reads a file by absolute in-workspace path', async () => {
    const filePath = join(dir, 'a.txt');
    writeFileSync(filePath, 'hello absolute');
    const r = await read.execute({ filePath }, ctx);
    expect(r.status).toBe('success');
    expect(r.content).toContain('1: hello absolute');
  });

  it('rejects a relative path outside the workspace', async () => {
    const outsidePath = join(dirname(dir), 'outside-relative.txt');
    writeFileSync(outsidePath, 'outside');

    try {
      const r = await read.execute({ filePath: '../outside-relative.txt' }, ctx);
      expect(r.status).toBe('error');
      expect(r.structuredError?.message).toMatch(/outside workspace/);
    } finally {
      rmSync(outsidePath, { force: true });
    }
  });

  it('rejects an absolute path outside the workspace', async () => {
    const outsidePath = join(dirname(dir), 'outside-absolute.txt');
    writeFileSync(outsidePath, 'outside');

    try {
      const r = await read.execute({ filePath: outsidePath }, ctx);
      expect(r.status).toBe('error');
      expect(r.structuredError?.message).toMatch(/outside workspace/);
    } finally {
      rmSync(outsidePath, { force: true });
    }
  });

  /**
   * This used to schedule `setTimeout(..., 0)` and assert it had fired by the
   * time the read finished. `yieldToEventLoop` yields with `setImmediate`, so
   * the two live in different event-loop phases with no defined order between
   * them -- the timer only got through because `readFile`'s own I/O happens to
   * pass the poll phase. Measured over 300 rounds, a bare sequence of yields
   * let the timer fire 1, 4 and 1 times out of 300 after one, two and three
   * yields. On a loaded CI runner that margin is what turned red. (#155)
   *
   * The behaviour worth protecting is that formatting hands the loop back at
   * all, so the test counts the handoffs instead of racing them.
   */
  it('yields while formatting large reads', async () => {
    const lines = 5_000;
    // One-character lines keep all 5 000 under Read's 50 KB stop.
    writeFileSync(join(dir, 'large.txt'), Array.from({ length: lines }, () => 'x').join('\n'));
    const { yieldToEventLoop } = await import('../async.js');
    vi.mocked(yieldToEventLoop).mockClear();

    const result = await read.execute({ filePath: 'large.txt', limit: lines }, ctx);

    expect(result.status).toBe('success');
    // 5 000 lines against a 2 048-line interval: at least two handoffs. Raising
    // LINE_YIELD_INTERVAL past the line count drives this to zero, which is what
    // makes the assertion worth having.
    expect(vi.mocked(yieldToEventLoop).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects offset past the end of file without recording observations', async () => {
    writeFileSync(join(dir, 'three-lines.txt'), 'line 1\nline 2\nline 3');
    const result = await read.execute({ filePath: 'three-lines.txt', offset: 5 }, ctx);

    expect(result.status).toBe('error');
    expect(result.structuredError?.code).toBe('offset_out_of_range');
    expect(result.structuredError?.message).toContain('3 lines');
    expect(result.artifacts?.fileObservations).toBeUndefined();

    const lineThree = await read.execute({ filePath: 'three-lines.txt', offset: 3 }, ctx);
    expect(lineThree.status).toBe('success');
    expect(lineThree.content).toContain('3: line 3');

    const wholeFile = await read.execute({ filePath: 'three-lines.txt', limit: 0 }, ctx);
    expect(wholeFile.status).toBe('success');
    expect(wholeFile.content).toContain('1: line 1');
    expect(wholeFile.content).toContain('2: line 2');
    expect(wholeFile.content).toContain('3: line 3');
  });

  it('returns declaration outlines for survey reads', async () => {
    const fixtureContent = [
      "import { x } from './x.js';",
      '',
      '/** A comment. */',
      'export function alpha(): void {',
      '  const inner = 1;',
      '  if (inner) {',
      '    return;',
      '  }',
      '}',
      '',
      'export class Beta {',
      '  private count = 0;',
      '  constructor() {}',
      '  public method(): number {',
      '    return this.count;',
      '  }',
      '}',
      '',
      'const gamma = 3;',
    ].join('\n');
    const filePath = 'fixture.ts';
    writeFileSync(join(dir, filePath), fixtureContent);

    const outlined = await read.execute({ filePath, outline: true }, ctx);
    expect(outlined.status).toBe('success');

    const firstLine = outlined.content.split('\n')[0];
    expect(firstLine.startsWith('Outline of ')).toBe(true);
    expect(firstLine).toContain('19 lines');

    expect(outlined.content).toContain("1: import { x } from './x.js';");
    expect(outlined.content).toContain('4: export function alpha(): void {');
    expect(outlined.content).toContain('11: export class Beta {');
    expect(outlined.content).toContain('14:   public method(): number {');
    expect(outlined.content).toContain('13:   constructor() {}');
    expect(outlined.content).toContain('19: const gamma = 3;');

    expect(outlined.content).not.toContain('const inner');
    expect(outlined.content).not.toContain('return;');
    expect(outlined.content).not.toContain('A comment');
    expect(outlined.content.split('\n').some((line) => /^\d+:\s*\}$/.test(line))).toBe(false);
    expect(outlined.content.split('\n').some((line) => line.trim() === '}')).toBe(false);

    expect(outlined.artifacts?.fileObservations).toHaveLength(1);
    expect(outlined.artifacts?.fileObservations?.[0]?.operation).toBe('outline');
    expect(outlined.artifacts?.fileObservations?.[0]?.lineEnd).toBeUndefined();

    const full = await read.execute({ filePath }, ctx);
    expect(full.status).toBe('success');
    expect(full.content.split('\n')).toHaveLength(19);

    const falseOutline = await read.execute({ filePath, outline: false }, ctx);
    expect(falseOutline.status).toBe('success');
    expect(falseOutline.content).toBe(full.content);
  });

  it('refuses a Write to an existing file that was only outlined', async () => {
    writeFileSync(join(dir, 'outlined.ts'), 'export const a = 1;\n');
    await read.execute({ filePath: 'outlined.ts', outline: true }, ctx);

    const written = await write.execute({ filePath: 'outlined.ts', content: 'clobber' }, ctx);
    expect(written.status).toBe('error');
    expect(written.structuredError?.code).toBe('file_not_observed');
    expect(written.structuredError?.message).toMatch(/only been outlined/);
    expect(readFileSync(join(dir, 'outlined.ts'), 'utf-8')).toBe('export const a = 1;\n');
  });

  it('refuses an Edit or MultiEdit of a file that was only outlined', async () => {
    writeFileSync(join(dir, 'outlined.ts'), 'export const a = 1;\n');
    await read.execute({ filePath: 'outlined.ts', outline: true }, ctx);

    const edited = await edit.execute(
      { filePath: 'outlined.ts', oldString: 'a = 1', newString: 'a = 2' },
      ctx,
    );
    expect(edited.status).toBe('error');
    expect(edited.structuredError?.code).toBe('file_not_observed');

    const multiEdited = await multiEditTool.execute(
      { filePath: 'outlined.ts', edits: [{ oldString: 'a = 1', newString: 'a = 2' }] },
      ctx,
    );
    expect(multiEdited.structuredError?.code).toBe('file_not_observed');
    expect(readFileSync(join(dir, 'outlined.ts'), 'utf-8')).toBe('export const a = 1;\n');
  });

  it('keeps an earlier Read, and its hash, when the file is outlined afterwards', async () => {
    const path = join(dir, 'kept.ts');
    writeFileSync(path, 'export const a = 1;\n');
    await observeFirst('kept.ts');
    await read.execute({ filePath: 'kept.ts', outline: true }, ctx);
    const edited = await edit.execute(
      { filePath: 'kept.ts', oldString: 'a = 1', newString: 'a = 2' },
      ctx,
    );
    expect(edited.status).toBe('success');

    // A formatter rewrites the file after the Read. The outline shows the new
    // version's declarations, not its content, so the Read's hash must stand.
    await observeFirst('kept.ts');
    writeFileSync(path, 'export const a = 3;\n');
    await read.execute({ filePath: 'kept.ts', outline: true }, ctx);
    const stale = await edit.execute(
      { filePath: 'kept.ts', oldString: 'a = 3', newString: 'a = 4' },
      ctx,
    );
    expect(stale.status).toBe('error');
    expect(stale.structuredError?.code).toBe('stale_file_observation');
    expect(readFileSync(path, 'utf-8')).toBe('export const a = 3;\n');
  });

  it('outlines Markdown by its headings', async () => {
    writeFileSync(
      join(dir, 'README.md'),
      [
        '# Title',
        '',
        'Intro prose that is not a heading.',
        '',
        '## Install',
        '',
        '```bash',
        '# a shell comment, not a heading',
        'npm install',
        '```',
        '',
        'Setext section',
        '--------------',
        '',
        '- a list item',
        '',
        '### Usage',
        'More prose.',
      ].join('\n'),
    );
    const outlined = await read.execute({ filePath: 'README.md', outline: true }, ctx);
    expect(outlined.content.split('\n').slice(1)).toEqual([
      '1: # Title',
      '5: ## Install',
      '12: Setext section',
      '17: ### Usage',
    ]);
  });

  it('keeps preprocessor lines and attributes, and drops # comments only where # starts one', async () => {
    writeFileSync(
      join(dir, 'main.c'),
      '#include <stdio.h>\n#define MAX 3\nint main(void) {\n  return 0;\n}\n',
    );
    writeFileSync(join(dir, 'lib.rs'), '#[derive(Debug)]\npub struct Point {\n    x: i32,\n}\n');
    writeFileSync(join(dir, 'tool.py'), '#!/usr/bin/env python\n# a comment\nimport os\n');
    const outlineOf = async (filePath: string) =>
      (await read.execute({ filePath, outline: true }, ctx)).content.split('\n').slice(1);

    expect(await outlineOf('main.c')).toEqual([
      '1: #include <stdio.h>',
      '2: #define MAX 3',
      '3: int main(void) {',
    ]);
    expect(await outlineOf('lib.rs')).toEqual(['1: #[derive(Debug)]', '2: pub struct Point {']);
    expect(await outlineOf('tool.py')).toEqual(['1: #!/usr/bin/env python', '3: import os']);
  });

  it('keeps wrapped signatures and arrow members, and leaves wrapped calls out', async () => {
    writeFileSync(
      join(dir, 'service.ts'),
      [
        'export class Service {',
        '  private count = 0;',
        '  async send(',
        '    id: string,',
        '    message: string,',
        '  ): Promise<void> {',
        '    await post(id, message);',
        '  }',
        '  handle = (event: string) => {',
        '    this.count += event.length;',
        '  };',
        '  flush = async (): Promise<void> => {',
        '    this.count = 0;',
        '  };',
        '}',
        '',
        'export function run(): void {',
        '  register(',
        "    'service',",
        '    new Service(),',
        '  );',
        '}',
      ].join('\n'),
    );
    const outlined = await read.execute({ filePath: 'service.ts', outline: true }, ctx);
    expect(outlined.content.split('\n').slice(1)).toEqual([
      '1: export class Service {',
      '3:   async send(',
      '9:   handle = (event: string) => {',
      '12:   flush = async (): Promise<void> => {',
      '17: export function run(): void {',
    ]);
  });

  it('leaves closing punctuation lines out of an outline', async () => {
    writeFileSync(
      join(dir, 'suite.ts'),
      [
        "describe('suite', () => {",
        "  it('works', () => {});",
        '});',
        'const list = [',
        '  1,',
        '];',
        'register([',
        '  1,',
        ']);',
        'wrap(() => {',
        '})',
      ].join('\n'),
    );
    const outlined = await read.execute({ filePath: 'suite.ts', outline: true }, ctx);
    expect(outlined.content.split('\n').slice(1)).toEqual([
      "1: describe('suite', () => {",
      "2:   it('works', () => {});",
      '4: const list = [',
      '7: register([',
      '10: wrap(() => {',
    ]);
  });

  it('measures the first line of a file with a byte-order mark from after the mark', async () => {
    const bom = String.fromCharCode(0xfeff);
    writeFileSync(
      join(dir, 'bom.ts'),
      `${bom}import { a } from './a.js';\n\nexport const b = a;\n`,
    );
    const outlined = await read.execute({ filePath: 'bom.ts', outline: true }, ctx);
    expect(outlined.content.split('\n').slice(1)).toEqual([
      "1: import { a } from './a.js';",
      '3: export const b = a;',
    ]);
  });

  it('rejects offset and limit in outline mode instead of ignoring them', async () => {
    writeFileSync(join(dir, 'short.ts'), 'export const a = 1;\nexport const b = 2;\n');
    const past = await read.execute({ filePath: 'short.ts', outline: true, offset: 3000 }, ctx);
    expect(past.status).toBe('error');
    expect(past.structuredError?.code).toBe('invalid_arguments');
    expect(past.structuredError?.message).toMatch(/offset or limit/);

    const limited = await read.execute({ filePath: 'short.ts', outline: true, limit: 1 }, ctx);
    expect(limited.status).toBe('error');
    expect(limited.structuredError?.code).toBe('invalid_arguments');
  });

  it('caps an outline at 2000 entries and says where the rest start', async () => {
    // Short lines, so the 2000-entry cap binds before the 50 KB one.
    const declarations = Array.from({ length: 2005 }, (_, index) => `let v${index};`);
    writeFileSync(join(dir, 'many.ts'), declarations.join('\n'));
    const outlined = await read.execute({ filePath: 'many.ts', outline: true }, ctx);
    const lines = outlined.content.split('\n');
    expect(lines).toHaveLength(2002);
    expect(lines[2000]).toBe('2000: let v1999;');
    expect(lines[2001]).toMatch(/truncated at 2000 of 2005 entries.*line 2001/);
  });

  it('counts lines without the trailing newline when an offset is past the end', async () => {
    writeFileSync(join(dir, 'trailing-newline.txt'), 'a\nb\nc\n');
    const past = await read.execute({ filePath: 'trailing-newline.txt', offset: 4 }, ctx);
    expect(past.status).toBe('error');
    expect(past.structuredError?.code).toBe('offset_out_of_range');
    expect(past.structuredError?.message).toContain('the file has 3 lines');
    expect(past.structuredError?.message).toContain('an offset of at most 3');

    const lastLine = await read.execute({ filePath: 'trailing-newline.txt', offset: 3 }, ctx);
    expect(lastLine.status).toBe('success');
    expect(lastLine.content).toContain('3: c');

    writeFileSync(join(dir, 'empty.txt'), '');
    const emptyWhole = await read.execute({ filePath: 'empty.txt' }, ctx);
    expect(emptyWhole.status).toBe('success');

    const emptyPast = await read.execute({ filePath: 'empty.txt', offset: 2 }, ctx);
    expect(emptyPast.status).toBe('error');
    expect(emptyPast.structuredError?.code).toBe('offset_out_of_range');
    expect(emptyPast.structuredError?.message).toContain('the file has 0 lines');
  });
});

describe('readOnlyRoots', () => {
  let readOnlyDir: string;

  beforeEach(() => {
    readOnlyDir = mkdtempSync(join(tmpdir(), 'book-readonly-root-'));
  });

  afterEach(() => {
    rmSync(readOnlyDir, { recursive: true, force: true });
    delete ctx.readOnlyRoots;
  });

  it('reads a file under a read-only root', async () => {
    const memoryFile = join(readOnlyDir, 'note.md');
    writeFileSync(memoryFile, 'memory note content');
    ctx.readOnlyRoots = [readOnlyDir];

    const r = await read.execute({ filePath: memoryFile }, ctx);
    expect(r.status).toBe('success');
    expect(r.content).toContain('1: memory note content');
  });

  it('refuses Write and Edit to files under read-only roots with Path outside workspace', async () => {
    const memoryFile = join(readOnlyDir, 'note.md');
    writeFileSync(memoryFile, 'initial content');
    ctx.readOnlyRoots = [readOnlyDir];

    const w = await write.execute({ filePath: memoryFile, content: 'new content' }, ctx);
    expect(w.status).toBe('error');
    expect(w.structuredError?.message).toMatch(/outside workspace/i);

    const e = await edit.execute(
      { filePath: memoryFile, oldString: 'initial', newString: 'updated' },
      ctx,
    );
    expect(e.status).toBe('error');
    expect(e.structuredError?.message).toMatch(/outside workspace/i);
  });

  it('refuses traversal outside a read-only root', async () => {
    const outsideFile = join(dirname(readOnlyDir), 'secret.txt');
    writeFileSync(outsideFile, 'secret');
    ctx.readOnlyRoots = [readOnlyDir];

    try {
      const r = await read.execute({ filePath: join(readOnlyDir, '../secret.txt') }, ctx);
      expect(r.status).toBe('error');
      expect(r.structuredError?.message).toMatch(/outside workspace/i);
    } finally {
      rmSync(outsideFile, { force: true });
    }
  });

  it('refuses read outside workspace when readOnlyRoots is empty or undefined', async () => {
    const outsideFile = join(readOnlyDir, 'note.md');
    writeFileSync(outsideFile, 'content');
    ctx.readOnlyRoots = undefined;

    const r1 = await read.execute({ filePath: outsideFile }, ctx);
    expect(r1.status).toBe('error');
    expect(r1.structuredError?.message).toMatch(/outside workspace/i);

    ctx.readOnlyRoots = [];
    const r2 = await read.execute({ filePath: outsideFile }, ctx);
    expect(r2.status).toBe('error');
    expect(r2.structuredError?.message).toMatch(/outside workspace/i);
  });

  it('refuses read of excluded subpaths under a read-only root', async () => {
    ctx.readOnlyRoots = [{ root: readOnlyDir, exclude: ['.inbox'] }];

    const approved = join(readOnlyDir, 'approved.md');
    writeFileSync(approved, 'approved fact');

    const inbox = join(readOnlyDir, '.inbox');
    mkdirSync(join(inbox, 'discarded'), { recursive: true });
    const inboxFile = join(inbox, 'x.md');
    writeFileSync(inboxFile, 'unapproved candidate');
    const discardedFile = join(inbox, 'discarded', 'x.md');
    writeFileSync(discardedFile, 'discarded candidate');

    // Approved file under root succeeds
    const rApproved = await read.execute({ filePath: approved }, ctx);
    expect(rApproved.status).toBe('success');
    expect(rApproved.content).toContain('approved fact');

    // Files in excluded .inbox and .inbox/discarded fail with Path outside workspace
    const rInbox = await read.execute({ filePath: inboxFile }, ctx);
    expect(rInbox.status).toBe('error');
    expect(rInbox.structuredError?.message).toMatch(/outside workspace/i);

    const rDiscarded = await read.execute({ filePath: discardedFile }, ctx);
    expect(rDiscarded.status).toBe('error');
    expect(rDiscarded.structuredError?.message).toMatch(/outside workspace/i);
  });

  it('refuses the inbox when the memory root sits inside the workspace, or through a symlink', async () => {
    // Running Book in $HOME puts ~/.book/projects/<p>/memory inside the workspace.
    const memory = join(ctx.workspaceRoot, '.book', 'memory');
    mkdirSync(join(memory, '.inbox'), { recursive: true });
    const candidate = join(memory, '.inbox', 'x.md');
    writeFileSync(candidate, 'quarantined candidate');
    ctx.readOnlyRoots = [{ root: memory, exclude: ['.inbox'] }];

    const direct = await read.execute({ filePath: candidate }, ctx);
    expect(direct.status, candidate).toBe('error');

    const throughLink = join(memory, 'in');
    try {
      symlinkSync(join(memory, '.inbox'), throughLink);
    } catch {
      // Symlink creation needs a privilege Windows withholds by default; the direct
      // path above is still covered there.
      return;
    }
    const linked = await read.execute({ filePath: join(throughLink, 'x.md') }, ctx);
    expect(linked.status, join(throughLink, 'x.md')).toBe('error');
  });

  it('refuses relative ../x.md path even when readOnlyRoots is configured', async () => {
    ctx.readOnlyRoots = [readOnlyDir];

    const r = await read.execute({ filePath: '../x.md' }, ctx);
    expect(r.status).toBe('error');
    expect(r.structuredError?.message).toMatch(/outside workspace/i);
  });
});

describe('write_file', () => {
  it('returns create metadata for new files', async () => {
    const r = await write.execute({ filePath: 'new.txt', content: 'one\ntwo' }, ctx);

    expect(r.status).toBe('success');
    expect(r.artifacts?.fileMutation).toEqual({
      kind: 'create',
      filePath: 'new.txt',
      addedLines: 2,
      removedLines: 0,
    });
  });

  it('allows legitimate in-workspace directories beginning with two dots', async () => {
    mkdirSync(join(dir, '..data'));
    const r = await write.execute({ filePath: '..data/new.txt', content: 'inside' }, ctx);

    expect(r.status).toBe('success');
    expect(readFileSync(join(dir, '..data', 'new.txt'), 'utf-8')).toBe('inside');
  });

  it('rejects writes through an outside-pointing directory link', async () => {
    const outsideDir = mkdtempSync(join(tmpdir(), 'book-file-outside-'));
    try {
      symlinkSync(
        outsideDir,
        join(dir, 'linked'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const r = await write.execute({ filePath: 'linked/new.txt', content: 'escaped' }, ctx);

      expect(r.status).toBe('error');
      expect(r.structuredError?.message).toMatch(/outside workspace/);
      expect(existsSync(join(outsideDir, 'new.txt'))).toBe(false);
    } finally {
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('allows links whose canonical target remains inside the workspace', async () => {
    const target = join(dir, 'target');
    mkdirSync(target);
    symlinkSync(
      target,
      join(dir, 'linked-inside'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    const r = await write.execute({ filePath: 'linked-inside/new.txt', content: 'inside' }, ctx);

    expect(r.status).toBe('success');
    expect(readFileSync(join(target, 'new.txt'), 'utf-8')).toBe('inside');
  });

  it('returns update metadata for existing files', async () => {
    writeFileSync(join(dir, 'a.txt'), 'old\nkeep');
    await observeFirst('a.txt');
    const r = await write.execute({ filePath: 'a.txt', content: 'new\nkeep\nextra' }, ctx);

    expect(r.status).toBe('success');
    expect(r.artifacts?.fileMutation).toEqual({
      kind: 'update',
      filePath: 'a.txt',
      addedLines: 2,
      removedLines: 1,
    });
  });

  it('normalizes CRLF replacement content before preserving CRLF', async () => {
    const path = join(dir, 'windows.txt');
    writeFileSync(path, 'old\r\ncontent\r\n');
    await observeFirst('windows.txt');

    const result = await write.execute(
      { filePath: 'windows.txt', content: 'new\r\ncontent\r\n' },
      ctx,
    );

    expect(result.status).toBe('success');
    expect(readFileSync(path, 'utf8')).toBe('new\r\ncontent\r\n');
  });

  it.skipIf(process.platform === 'win32')(
    'updates a file symlink target without replacing the symlink',
    async () => {
      const target = join(dir, 'target.txt');
      const link = join(dir, 'link.txt');
      writeFileSync(target, 'old\n');
      symlinkSync(target, link, 'file');
      await observeFirst('link.txt');

      const result = await write.execute({ filePath: 'link.txt', content: 'new\n' }, ctx);

      expect(result.status).toBe('success');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('new\n');
    },
  );

  it('does not write when cancellation arrives during a large diff', async () => {
    const path = join(dir, 'large.txt');
    const before = Array.from({ length: 500 }, (_, index) => `old ${index}`).join('\n');
    const after = Array.from({ length: 500 }, (_, index) => `new ${index}`).join('\n');
    writeFileSync(path, before);
    await observeFirst('large.txt');
    const controller = new AbortController();
    const pending = write.execute(
      { filePath: 'large.txt', content: after },
      { ...ctx, signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error('write cancelled')), 0);

    await expect(pending).rejects.toThrow('write cancelled');
    expect(readFileSync(path, 'utf-8')).toBe(before);
  });

  it('rejects writes outside the workspace', async () => {
    const outsidePath = resolve(dir, '..', 'escape.txt');
    const r = await write.execute({ filePath: '../escape.txt', content: 'escaped' }, ctx);

    expect(r.status).toBe('error');
    expect(r.structuredError?.message).toMatch(/outside workspace/);
    expect(r.artifacts?.fileMutation).toBeUndefined();
    expect(existsSync(outsidePath)).toBe(false);
  });
});

describe('edit_file', () => {
  it.skipIf(process.platform === 'win32')(
    'edits a file symlink target without replacing the symlink',
    async () => {
      const target = join(dir, 'target.txt');
      const link = join(dir, 'link.txt');
      writeFileSync(target, 'old value\n');
      symlinkSync(target, link, 'file');
      await observeFirst('link.txt');

      const result = await edit.execute(
        { filePath: 'link.txt', oldString: 'old', newString: 'new' },
        ctx,
      );

      expect(result.status).toBe('success');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('new value\n');
    },
  );

  it('matches LF model text against CRLF files and preserves CRLF', async () => {
    const path = join(dir, 'windows.txt');
    writeFileSync(path, 'one\r\ntwo\r\nthree\r\n');
    await observeFirst('windows.txt');
    const result = await edit.execute(
      { filePath: 'windows.txt', oldString: 'one\ntwo', newString: 'one\nchanged' },
      ctx,
    );
    expect(result.status).toBe('success');
    expect(readFileSync(path, 'utf8')).toBe('one\r\nchanged\r\nthree\r\n');
  });

  it('preserves a UTF-8 BOM when editing CRLF text', async () => {
    const path = join(dir, 'bom.txt');
    writeFileSync(path, Buffer.from('\ufeffalpha\r\nbeta\r\n', 'utf8'));
    await observeFirst('bom.txt');
    const result = await edit.execute(
      { filePath: 'bom.txt', oldString: 'alpha\nbeta', newString: 'alpha\ngamma' },
      ctx,
    );
    expect(result.status).toBe('success');
    expect(readFileSync(path, 'utf8')).toBe('\ufeffalpha\r\ngamma\r\n');
  });

  it('blocks a stale mutation until an explicit reread refreshes provenance', async () => {
    const path = join(dir, 'stale.txt');
    writeFileSync(path, 'original');
    const observed = await read.execute({ filePath: 'stale.txt' }, ctx);
    expect(observed.artifacts?.fileObservations?.[0].sha256).toMatch(/^[a-f0-9]{64}$/);

    writeFileSync(path, 'changed externally');
    const blocked = await edit.execute(
      { filePath: 'stale.txt', oldString: 'changed', newString: 'updated' },
      ctx,
    );
    expect(blocked.status).toBe('error');
    expect(blocked.structuredError?.message).toMatch(/^SKIPPED:.*Read/);

    await read.execute({ filePath: 'stale.txt' }, ctx);
    const allowed = await edit.execute(
      { filePath: 'stale.txt', oldString: 'changed', newString: 'updated' },
      ctx,
    );
    expect(allowed.status).toBe('success');
    expect(readFileSync(path, 'utf-8')).toBe('updated externally');
  });
  it('replaces the single occurrence when oldString is unique', async () => {
    writeFileSync(join(dir, 'a.txt'), 'foo bar baz');
    await observeFirst('a.txt');
    const r = await edit.execute({ filePath: 'a.txt', oldString: 'bar', newString: 'qux' }, ctx);
    expect(r.status).toBe('success');
    expect(r.artifacts?.fileMutation).toEqual({
      kind: 'update',
      filePath: 'a.txt',
      addedLines: 1,
      removedLines: 1,
    });
    const after = await read.execute({ filePath: 'a.txt' }, ctx);
    expect(after.content).toContain('foo qux baz');
  });

  it('fails when oldString is absent', async () => {
    writeFileSync(join(dir, 'a.txt'), 'hello');
    await observeFirst('a.txt');
    const r = await edit.execute({ filePath: 'a.txt', oldString: 'nope', newString: 'x' }, ctx);
    expect(r.status).toBe('error');
    expect(r.structuredError?.message).toMatch(/not found/);
    expect(r.artifacts?.fileMutation).toBeUndefined();
  });

  it('recovers when the file has trailing whitespace inside a multi-line target', async () => {
    writeFileSync(join(dir, 'a.ts'), 'alpha();  \nbeta();\ngamma();');
    await observeFirst('a.ts');
    const r = await edit.execute(
      { filePath: 'a.ts', oldString: 'alpha();\nbeta();', newString: 'merged();' },
      ctx,
    );
    expect(r.status).toBe('success');
    expect(r.content).toContain('whitespace tolerance (trailing-whitespace)');
    expect(readFileSync(join(dir, 'a.ts'), 'utf-8')).toBe('merged();\ngamma();');
  });

  it('recovers from a uniform indentation mismatch and re-indents newString', async () => {
    writeFileSync(join(dir, 'a.ts'), 'block {\n    inner();\n}');
    await observeFirst('a.ts');
    const r = await edit.execute(
      { filePath: 'a.ts', oldString: '        inner();', newString: '        changed();' },
      ctx,
    );
    expect(r.status).toBe('success');
    expect(r.content).toContain('whitespace tolerance (indent-shift)');
    expect(readFileSync(join(dir, 'a.ts'), 'utf-8')).toBe('block {\n    changed();\n}');
  });

  it('fails as ambiguous when relaxation matches multiple sites', async () => {
    writeFileSync(join(dir, 'a.ts'), '  same();\n  same();');
    await observeFirst('a.ts');
    const r = await edit.execute(
      { filePath: 'a.ts', oldString: 'same();\t', newString: 'other();' },
      ctx,
    );
    expect(r.status).toBe('error');
    expect(r.structuredError?.code).toBe('ambiguous_text_match');
    expect(r.structuredError?.message).toMatch(/whitespace-tolerant/);
  });

  it('does not relax matching for replaceAll edits', async () => {
    writeFileSync(join(dir, 'a.ts'), '  same();\n  same();');
    await observeFirst('a.ts');
    const r = await edit.execute(
      { filePath: 'a.ts', oldString: 'same();\t', newString: 'other();', replaceAll: true },
      ctx,
    );
    expect(r.status).toBe('error');
    expect(r.structuredError?.code).toBe('text_not_found');
  });

  it('inserts $-containing newString literally on the exact path', async () => {
    writeFileSync(join(dir, 'dollar.sh'), 'echo home\nnext line');
    await observeFirst('dollar.sh');
    const r = await edit.execute(
      { filePath: 'dollar.sh', oldString: 'echo home', newString: 'echo "$$HOME" and $& and $`' },
      ctx,
    );
    expect(r.status).toBe('success');
    expect(readFileSync(join(dir, 'dollar.sh'), 'utf-8')).toBe(
      'echo "$$HOME" and $& and $`\nnext line',
    );
  });

  it.skipIf(process.platform !== 'win32')(
    'accepts differently-cased paths to the same observed file on Windows',
    async () => {
      writeFileSync(join(dir, 'CaseFile.txt'), 'original');
      await observeFirst('CaseFile.txt');
      const r = await edit.execute(
        { filePath: 'casefile.txt', oldString: 'original', newString: 'changed' },
        ctx,
      );
      expect(r.status).toBe('success');
      expect(readFileSync(join(dir, 'CaseFile.txt'), 'utf-8')).toBe('changed');
    },
  );

  it('fails a mutation on a file that was never observed', async () => {
    writeFileSync(join(dir, 'unseen.txt'), 'content');
    const editResult = await edit.execute(
      { filePath: 'unseen.txt', oldString: 'content', newString: 'changed' },
      ctx,
    );
    expect(editResult.status).toBe('error');
    expect(editResult.structuredError?.code).toBe('file_not_observed');
    expect(editResult.structuredError?.message).toMatch(/has not been read/);

    const writeResult = await write.execute({ filePath: 'unseen.txt', content: 'clobber' }, ctx);
    expect(writeResult.structuredError?.code).toBe('file_not_observed');
    expect(readFileSync(join(dir, 'unseen.txt'), 'utf-8')).toBe('content');

    await observeFirst('unseen.txt');
    const allowed = await edit.execute(
      { filePath: 'unseen.txt', oldString: 'content', newString: 'changed' },
      ctx,
    );
    expect(allowed.status).toBe('success');
  });

  it('returns aggregate update metadata for MultiEdit', async () => {
    writeFileSync(join(dir, 'a.txt'), 'first\nsecond\nthird');
    await observeFirst('a.txt');
    const r = await multiEditTool.execute(
      {
        filePath: 'a.txt',
        edits: [
          { oldString: 'first', newString: 'FIRST' },
          { oldString: 'third', newString: 'third\nfourth' },
        ],
      },
      ctx,
    );

    expect(r.status).toBe('success');
    expect(r.artifacts?.fileMutation).toEqual({
      kind: 'update',
      filePath: 'a.txt',
      addedLines: 2,
      removedLines: 1,
    });
  });

  it.skipIf(process.platform === 'win32')(
    'applies MultiEdit through a file symlink without replacing it',
    async () => {
      const target = join(dir, 'target.txt');
      const link = join(dir, 'link.txt');
      writeFileSync(target, 'first second\n');
      symlinkSync(target, link, 'file');
      await observeFirst('link.txt');

      const result = await multiEditTool.execute(
        {
          filePath: 'link.txt',
          edits: [
            { oldString: 'first', newString: 'FIRST' },
            { oldString: 'second', newString: 'SECOND' },
          ],
        },
        ctx,
      );

      expect(result.status).toBe('success');
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('FIRST SECOND\n');
    },
  );
});

describe('glob', () => {
  // Steady state on the Windows CI runner is ~1 s — 850 ms on run 33375504718 attempt 2 — so
  // this setup is not routinely expensive, only twice the local cost. The flake was a degraded
  // runner: attempt 1 of that same commit inflated per-op I/O latency across the whole file (the
  // other 45 tests ran ~6x slow), and this test, with 1005 serial syscalls, absorbed the
  // inflation multiplicatively into 22.3 s against the 20 s ceiling. Creating the files
  // concurrently divides that inflation by the libuv threadpool width, and the raised ceiling
  // covers the remainder. The 1005 count is load-bearing — it is what exceeds
  // GLOB_OUTPUT_LIMIT — so it cannot come down without losing what the test checks (#144).
  it('caps broad output and reports truncation', async () => {
    await Promise.all(
      Array.from({ length: 1005 }, (_, i) => writeFile(join(dir, `file-${i}.txt`), String(i))),
    );

    const r = await glob.execute({ pattern: '**/*' }, ctx);

    expect(r.status).toBe('success');
    expect(r.content).toContain('truncated at 1000 files');
    expect(r.content.split('\n')).toHaveLength(1001);
  }, 60_000);

  it('does not return out-of-workspace paths', async () => {
    writeFileSync(join(dir, 'inside.txt'), 'inside');
    const outsidePath = join(dirname(dir), 'outside-glob.txt');
    writeFileSync(outsidePath, 'outside');

    try {
      const r = await glob.execute({ pattern: '../*.txt' }, ctx);
      expect(r.status).toBe('success');
      const output = r.content;
      expect(output).not.toContain('outside-glob.txt');
      output
        .split('\n')
        .filter(Boolean)
        .forEach((line) => expect(line.startsWith('..')).toBe(false));
    } finally {
      rmSync(outsidePath, { force: true });
    }
  });
});

describe('grep', () => {
  it('matches a regex across files', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const x = 1;\nconst y = 2;');
    writeFileSync(join(dir, 'b.ts'), 'let z = 3;');
    const r = await grep.execute({ pattern: 'const', include: '*.ts' }, ctx);
    expect(r.status).toBe('success');
    expect(r.content).toContain('a.ts:1: const x = 1;');
    expect(r.content).not.toContain('b.ts');
  });

  it('returns only match records in structured data, not complete matched files', async () => {
    writeFileSync(join(dir, 'a.ts'), 'unrelated secret\nconst visible = 1;\nanother secret');
    const result = await grep.execute({ pattern: 'const', include: '*.ts' }, ctx);
    const data = result.data as {
      matches: Record<string, { matches: Array<{ line: number; text: string }>; lines?: string[] }>;
    };

    expect(data.matches['a.ts']).toEqual({
      matches: [{ line: 2, text: 'const visible = 1;' }],
    });
    expect(data.matches['a.ts']).not.toHaveProperty('lines');
    expect(JSON.stringify(result.data)).not.toContain('unrelated secret');
  });

  it('skips binary files even when their bytes contain the pattern', async () => {
    writeFileSync(join(dir, 'native.dll'), Buffer.from('prefix\0needle\0suffix'));

    const result = await grep.execute({ pattern: 'needle', include: '**/*' }, ctx);

    expect(result.content).toBe('No matches found');
    expect(JSON.stringify(result.data)).not.toContain('native.dll');
  });

  it('searches supported project files under .book', async () => {
    mkdirSync(join(dir, '.book', 'commands'), { recursive: true });
    writeFileSync(join(dir, '.book', 'commands', 'review.md'), 'project-command-marker');

    const result = await grep.execute(
      { pattern: 'project-command-marker', include: '.book/**/*.md' },
      ctx,
    );

    expect(result.content).toContain('.book/commands/review.md');
  });

  it('caps individual lines and total provider-facing output', async () => {
    for (let index = 0; index < 100; index++) {
      writeFileSync(join(dir, `large-${index}.txt`), `needle ${'x'.repeat(10_000)}`);
    }

    const result = await grep.execute(
      { pattern: 'needle', include: '*.txt', head_limit: 100 },
      ctx,
    );
    const data = result.data as {
      matches: Record<string, { matches: Array<{ line: number; text: string }> }>;
    };

    expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(50 * 1024);
    expect(result.content).toContain('line truncated');
    expect(result.pagination?.truncated).toBe(true);
    for (const file of Object.values(data.matches)) {
      for (const match of file.matches) expect(match.text.length).toBeLessThanOrEqual(2_000);
    }
  });

  it('matches files after workspace path normalization', async () => {
    writeFileSync(join(dir, 'a.ts'), 'const x = 1;');
    const r = await grep.execute({ pattern: 'const', include: '**/*.ts' }, ctx);
    expect(r.status).toBe('success');
    expect(r.content).toContain('a.ts:1: const x = 1;');
  });

  it('reports no matches found', async () => {
    writeFileSync(join(dir, 'a.ts'), 'nothing here');
    const r = await grep.execute({ pattern: 'zzzzz', include: '*.ts' }, ctx);
    expect(r.status).toBe('success');
    expect(r.content).toMatch(/No matches/);
  });

  it('preserves the portable TypeScript fallback backend', async () => {
    writeFileSync(join(dir, 'fallback.txt'), 'portable-backend-marker');

    const result = await grep.execute(
      { pattern: 'portable-backend-marker', include: '*.txt' },
      { ...ctx, env: { BOOK_GREP_BACKEND: 'typescript' } },
    );

    expect(result.content).toContain('fallback.txt:1: portable-backend-marker');
  });

  it('preserves count, files-only, context, multiline, and limit behavior', async () => {
    writeFileSync(join(dir, 'a.ts'), 'before\nconst first = 1;\nafter\nconst second = 2;');
    writeFileSync(join(dir, 'b.ts'), 'const third = 3;');

    const count = await grep.execute(
      { pattern: 'const', include: '*.ts', output_mode: 'count' },
      ctx,
    );
    expect(count.content).toContain('a.ts:2');
    expect(count.content).toContain('b.ts:1');

    const files = await grep.execute(
      { pattern: 'second', include: '*.ts', output_mode: 'files_with_matches' },
      ctx,
    );
    expect(files.content).toBe('a.ts');

    const context = await grep.execute({ pattern: 'first', include: '*.ts', A: 1, B: 1 }, ctx);
    expect(context.content).toContain('a.ts:1- before');
    expect(context.content).toContain('a.ts:2: const first = 1;');
    expect(context.content).toContain('a.ts:3- after');

    const multiline = await grep.execute(
      { pattern: 'before\\nconst', include: '*.ts', multiline: true },
      ctx,
    );
    expect(multiline.content).toContain('a.ts:1: before');

    const limited = await grep.execute({ pattern: 'const', include: '*.ts', head_limit: 1 }, ctx);
    expect(limited.content.split('\n')).toHaveLength(1);
  });

  it('scopes the search to a subdirectory via path on both backends', async () => {
    mkdirSync(join(dir, 'sub', 'inner'), { recursive: true });
    writeFileSync(join(dir, 'root.ts'), 'const marker = 1;');
    writeFileSync(join(dir, 'sub', 'inner', 'scoped.ts'), 'const marker = 2;');

    for (const env of [{}, { BOOK_GREP_BACKEND: 'typescript' }] as Record<string, string>[]) {
      const result = await grep.execute(
        { pattern: 'marker', include: '**/*.ts', path: 'sub' },
        { ...ctx, env },
      );
      expect(result.status).toBe('success');
      expect(result.content).toContain('sub/inner/scoped.ts:1: const marker = 2;');
      expect(result.content).not.toContain('root.ts');
    }
  });

  it('scopes the search to a single file via path', async () => {
    writeFileSync(join(dir, 'one.ts'), 'needle one');
    writeFileSync(join(dir, 'two.ts'), 'needle two');
    const result = await grep.execute({ pattern: 'needle', path: 'one.ts' }, ctx);
    expect(result.status).toBe('success');
    expect(result.content).toContain('one.ts:1: needle one');
    expect(result.content).not.toContain('two.ts');
  });

  it('rejects a path outside the workspace and reports unknown paths', async () => {
    const outside = await grep.execute({ pattern: 'x', path: '..' }, ctx);
    expect(outside.structuredError?.code).toBe('path_outside_workspace');

    const missing = await grep.execute({ pattern: 'x', path: 'nope-dir' }, ctx);
    expect(missing.structuredError?.code).toBe('path_not_found');
  });

  it('keeps root-anchored gitignore patterns effective under a path scope (portable)', async () => {
    mkdirSync(join(dir, 'sub'), { recursive: true });
    writeFileSync(join(dir, 'sub', 'secret.ts'), 'const hidden = 1;');
    writeFileSync(join(dir, 'sub', 'visible.ts'), 'const hidden = 2;');

    const result = await grep.execute(
      { pattern: 'hidden', include: '**/*.ts', path: 'sub' },
      { ...ctx, env: { BOOK_GREP_BACKEND: 'typescript' }, gitignorePatterns: ['sub/secret.ts'] },
    );

    expect(result.content).toContain('sub/visible.ts');
    expect(result.content).not.toContain('secret.ts');
  });

  it('applies C as symmetric context on both backends', async () => {
    writeFileSync(join(dir, 'context.ts'), 'before\ntarget\nafter');
    for (const env of [{}, { BOOK_GREP_BACKEND: 'typescript' }] as Record<string, string>[]) {
      const result = await grep.execute(
        { pattern: 'target', include: '*.ts', C: 1 },
        { ...ctx, env },
      );
      expect(result.content).toContain('context.ts:1- before');
      expect(result.content).toContain('context.ts:2: target');
      expect(result.content).toContain('context.ts:3- after');
    }
  });

  it('keeps timers responsive and observes abort during a broad scan', async () => {
    for (let index = 0; index < 160; index++) {
      writeFileSync(join(dir, `file-${index}.txt`), 'no match here\n'.repeat(10));
    }

    let timerFired = false;
    const timer = setTimeout(() => {
      timerFired = true;
    }, 0);
    try {
      const result = await grep.execute({ pattern: 'missing-token', include: '*.txt' }, ctx);
      expect(result.status).toBe('success');
      expect(timerFired).toBe(true);
    } finally {
      clearTimeout(timer);
    }

    const controller = new AbortController();
    const pending = grep.execute(
      { pattern: 'missing-token', include: '*.txt' },
      { ...ctx, signal: controller.signal },
    );
    setTimeout(() => controller.abort(new Error('grep cancelled')), 0);
    await expect(pending).rejects.toThrow('grep cancelled');
  });
});

/**
 * The outline contract (#247): the shapes each language's outline promises,
 * written as a file's lines and the outline lines they produce. The README's
 * statement of what an outline covers is this table; a shape outside it is not
 * promised either way.
 */
const OUTLINE_CONTRACT: Array<{ shape: string; file: string; lines: string[]; outline: string[] }> =
  [
    {
      shape: 'Java: return-type-first methods, generic methods and constructors',
      file: 'Foo.java',
      lines: [
        'package x;',
        '',
        'import java.util.List;',
        '',
        'public class Foo {',
        '    private final int n;',
        '',
        '    public Foo(int n) {',
        '        this.n = n;',
        '    }',
        '',
        '    public int getN() {',
        '        return n;',
        '    }',
        '',
        '    @Override',
        '    public String toString() {',
        '        return "Foo(" + n + ")";',
        '    }',
        '',
        '    public static <T> List<T> wrap(T item) throws IllegalStateException {',
        '        return List.of(item);',
        '    }',
        '',
        '    private Map<String, List<Integer>> index() {',
        '        return null;',
        '    }',
        '',
        '    public static void main(String[] args) {',
        '        if (args.length > 0) {',
        '            System.out.println(new Foo(1).getN());',
        '        }',
        '    }',
        '}',
      ],
      outline: [
        '1: package x;',
        '3: import java.util.List;',
        '5: public class Foo {',
        '8:     public Foo(int n) {',
        '12:     public int getN() {',
        '17:     public String toString() {',
        '21:     public static <T> List<T> wrap(T item) throws IllegalStateException {',
        '25:     private Map<String, List<Integer>> index() {',
        '29:     public static void main(String[] args) {',
      ],
    },
    {
      shape: 'Java: interface methods without a body',
      file: 'Shape.java',
      lines: [
        'public interface Shape {',
        '    double area();',
        '    String name() throws IOException;',
        '    default String label() {',
        '        return name();',
        '    }',
        '}',
      ],
      outline: [
        '1: public interface Shape {',
        '2:     double area();',
        '3:     String name() throws IOException;',
        '4:     default String label() {',
      ],
    },
    {
      shape: 'Java: a wrapped signature that closes into its body',
      file: 'Factory.java',
      lines: [
        'public class Factory {',
        '    public static Factory create(',
        '        int a,',
        '        int b',
        '    ) {',
        '        return new Factory();',
        '    }',
        '}',
      ],
      outline: ['1: public class Factory {', '2:     public static Factory create('],
    },
    {
      shape: 'Kotlin: fun declarations only; a trailing-lambda call is not one',
      file: 'Foo.kt',
      lines: [
        'package x',
        '',
        'class Foo(private val n: Int) {',
        '    fun getN(): Int {',
        '        return n',
        '    }',
        '',
        '    override fun toString(): String = "Foo($n)"',
        '',
        '    private suspend fun load(',
        '        id: String,',
        '    ): Foo = this',
        '}',
        '',
        'fun main() {',
        '    repeat(3) {',
        '        println(Foo(1).getN())',
        '    }',
        '    when (args.size) {',
        '        0 -> println("none")',
        '    }',
        '}',
      ],
      outline: [
        '1: package x',
        '3: class Foo(private val n: Int) {',
        '4:     fun getN(): Int {',
        '8:     override fun toString(): String = "Foo($n)"',
        '10:     private suspend fun load(',
        '15: fun main() {',
      ],
    },
    {
      shape: 'C#: Allman braces, expression bodies and interface members, file-scoped namespace',
      file: 'Counter.cs',
      lines: [
        'using System;',
        '',
        'namespace Demo;',
        '',
        'public class Counter',
        '{',
        '    private int _n;',
        '',
        '    public Counter(int n)',
        '    {',
        '        _n = n;',
        '    }',
        '',
        '    public int Next()',
        '    {',
        '        return ++_n;',
        '    }',
        '',
        '    public async Task<List<int>> LoadAsync(int id)',
        '    {',
        '        return await Task.FromResult(new List<int>());',
        '    }',
        '',
        '    public int Twice(int x) => x * 2;',
        '',
        '    public int Count { get; set; }',
        '}',
        '',
        'public interface IStore',
        '{',
        '    Task<int> GetAsync(int id);',
        '}',
      ],
      outline: [
        '1: using System;',
        '3: namespace Demo;',
        '5: public class Counter',
        '9:     public Counter(int n)',
        '14:     public int Next()',
        '19:     public async Task<List<int>> LoadAsync(int id)',
        '24:     public int Twice(int x) => x * 2;',
        '29: public interface IStore',
        '31:     Task<int> GetAsync(int id);',
      ],
    },
    {
      shape: 'C#: a block-scoped namespace shifts members one level deeper',
      file: 'Nested.cs',
      lines: [
        'namespace Demo',
        '{',
        '    public class Counter',
        '    {',
        '        public int Next()',
        '        {',
        '            if (_n > 0)',
        '            {',
        '            }',
        '            return ++_n;',
        '        }',
        '    }',
        '}',
      ],
      outline: ['1: namespace Demo', '3:     public class Counter', '5:         public int Next()'],
    },
    {
      shape: 'C#: statements with Allman braces are not declarations',
      file: 'Program.cs',
      lines: [
        'if (args.Length > 0)',
        '{',
        '    foreach (var a in args)',
        '    {',
        '    }',
        '    using (var s = File.OpenRead(args[0]))',
        '    {',
        '    }',
        '    lock (gate)',
        '    {',
        '    }',
        '    try',
        '    {',
        '    }',
        '    catch (IOException e)',
        '    {',
        '    }',
        '    while (busy)',
        '    {',
        '    }',
        '    new Worker(args)',
        '    {',
        '        Name = "x",',
        '    };',
        '}',
      ],
      outline: ['1: if (args.Length > 0)'],
    },
    {
      shape: 'Dart: return-type-first methods; a call taking a callback is not one',
      file: 'counter.dart',
      lines: [
        'class Counter {',
        '  int _n = 0;',
        '',
        '  int next() {',
        '    return ++_n;',
        '  }',
        '',
        '  Future<List<int>> load(String id) async {',
        '    setState(() {',
        '    });',
        '    return [];',
        '  }',
        '',
        "  Widget build(BuildContext context) => Text('$_n');",
        '}',
      ],
      outline: [
        '1: class Counter {',
        '4:   int next() {',
        '8:   Future<List<int>> load(String id) async {',
        "14:   Widget build(BuildContext context) => Text('$_n');",
      ],
    },
    {
      shape:
        'TypeScript: generators, #private, nested generics, destructured and function-typed parameters',
      file: 'store.ts',
      lines: [
        'export class Store {',
        '  #items = new Map<string, number>();',
        '  async *entries(): AsyncGenerator<[string, number]> {',
        '    yield* this.#items;',
        '  }',
        '  #secret(): string {',
        "    return 'x';",
        '  }',
        '  pick<T extends Record<string, Array<number>>>(value: T): T {',
        '    return value;',
        '  }',
        '  async send({',
        '    id,',
        '    message,',
        '  }: SendArgs): Promise<void> {',
        '    await post(id, message);',
        '  }',
        '  on(handler: (event: string) => void): void {',
        '    this.handler = handler;',
        '  }',
        '}',
      ],
      outline: [
        '1: export class Store {',
        '3:   async *entries(): AsyncGenerator<[string, number]> {',
        '6:   #secret(): string {',
        '9:   pick<T extends Record<string, Array<number>>>(value: T): T {',
        '12:   async send({',
        '18:   on(handler: (event: string) => void): void {',
      ],
    },
    {
      shape:
        'TypeScript: control flow, calls, import members, object keys and template text stay out',
      file: 'run.ts',
      lines: [
        'import {',
        '  describe,',
        '  it,',
        '  expect,',
        "} from 'vitest';",
        '',
        'export const schema = {',
        "  type: 'object',",
        "  enum: ['a', 'b'],",
        '  test: true,',
        '  get: () => 1,',
        '};',
        '',
        'export function run(): void {',
        '  if (ready) {',
        '  }',
        '  else if (later) {',
        '  }',
        '  for (const x of xs) {',
        '  }',
        '  while (busy()) {',
        '  }',
        '  switch (mode) {',
        '  }',
        '  try {',
        '  } catch (error) {',
        '  }',
        '  useEffect(() => {',
        '  });',
        '  fetchAll(',
        '    a,',
        '  ).then(() => {',
        '  });',
        '  return new Promise((resolve) => {',
        '  });',
        '}',
        '',
        'const prompt = `',
        'Summary:',
        'Keep it short.',
        '`;',
        'const after = 1;',
      ],
      outline: [
        '1: import {',
        '7: export const schema = {',
        '14: export function run(): void {',
        '38: const prompt = `',
        '42: const after = 1;',
      ],
    },
    {
      shape:
        'TypeScript: methods named like statements, backticks in strings and regexes, callbacks',
      file: 'gate.ts',
      lines: [
        'export class Gate {',
        '  lock(): void {',
        '  }',
        '  match(pattern: RegExp): boolean {',
        "    return pattern.test('`');",
        '  }',
        '  delete(key: string): boolean {',
        '    return /`{3,}/.test(key);',
        '  }',
        '  defer(name: string): void {',
        '  }',
        '  private apply(',
        '    manifest: Manifest,',
        '  ): { ok: true } | { ok: false; error: string } {',
        '    return { ok: true };',
        '  }',
        '}',
        "const quote = (value: string) => `'${value.replace(/'/g, `'\\\\''`)}'`;",
        'export const after = 1;',
        'program.action(',
        '  async (options: {',
        '    json?: boolean;',
        '  }) => {',
        '    await run(options);',
        '  },',
        ');',
      ],
      outline: [
        '1: export class Gate {',
        '2:   lock(): void {',
        '4:   match(pattern: RegExp): boolean {',
        '7:   delete(key: string): boolean {',
        '10:   defer(name: string): void {',
        '12:   private apply(',
        "18: const quote = (value: string) => `'${value.replace(/'/g, `'\\\\''`)}'`;",
        '19: export const after = 1;',
        '20: program.action(',
      ],
    },
    {
      shape: 'Go: go and defer statements are not declarations',
      file: 'main.go',
      lines: [
        'package main',
        '',
        'func main() {',
        '\tgo func() {',
        '\t}()',
        '\tdefer func() {',
        '\t}()',
        '\tfor i := range 3 {',
        '\t}',
        '\tt.Run("x", func(t *testing.T) {',
        '\t})',
        '}',
      ],
      outline: ['1: package main', '3: func main() {'],
    },
    {
      shape: 'Rust: a match on a call is not a declaration',
      file: 'main.rs',
      lines: ['fn main() {', '    match parse(input) {', '        Ok(v) => {}', '    }', '}'],
      outline: ['1: fn main() {'],
    },
    {
      shape: 'C: an Allman-style brace line is left out',
      file: 'main.c',
      lines: ['int main(void)', '{', '    return 0;', '}'],
      outline: ['1: int main(void)'],
    },
    {
      shape: 'Makefile: # starts a comment',
      file: 'Makefile',
      lines: ['# build rules', 'CC = gcc', '', 'all: main', '\t$(CC) -o main main.c'],
      outline: ['2: CC = gcc', '4: all: main'],
    },
    {
      shape: 'Dockerfile: # starts a comment, whatever the suffix',
      file: 'Dockerfile.dev',
      lines: ['# syntax=docker/dockerfile:1', 'FROM node:22', '# install deps', 'RUN npm ci'],
      outline: ['2: FROM node:22', '4: RUN npm ci'],
    },
    {
      shape: 'PowerShell: # starts a comment',
      file: 'build.ps1',
      lines: ['# Build script', 'param([string]$Target)', 'function Build {', '}'],
      outline: ['2: param([string]$Target)', '3: function Build {'],
    },
    {
      shape: 'An extension-less script with a shebang: # starts a comment',
      file: 'deploy',
      lines: ['#!/usr/bin/env bash', '# deploy the site', 'set -e'],
      outline: ['1: #!/usr/bin/env bash', '3: set -e'],
    },
    {
      shape: 'An extension-less file without a shebang is left alone',
      file: 'NOTES',
      lines: ['# not a script', 'plain line'],
      outline: ['1: # not a script', '2: plain line'],
    },
    {
      shape: 'Markdown: a leading --- rule is not front matter',
      file: 'hr.md',
      lines: ['---', '', '# First', '', 'Intro.', '', '---', '', '## Second'],
      outline: ['3: # First', '9: ## Second'],
    },
    {
      shape: 'Markdown: YAML front matter is skipped',
      file: 'guide.md',
      lines: ['---', 'title: Guide', 'tags:', '  - docs', '---', '# Guide'],
      outline: ['6: # Guide'],
    },
    {
      shape: 'Markdown: front matter may hold comments, quoted keys, keys with spaces and $schema',
      file: 'loose.md',
      lines: [
        '---',
        'title: Guide',
        '# draft: true',
        '"quoted key": 1',
        'my key: 2',
        '$schema: https://example.com/schema.json',
        'título: Guía',
        '---',
        '# Guide',
      ],
      outline: ['9: # Guide'],
    },
    {
      shape: 'TSX: a /* in JSX text does not hide the declarations after it',
      file: 'api.tsx',
      lines: [
        'export function A() {',
        '  return (',
        '    <div>',
        '      <p>All requests to /api/* are proxied to the backend.</p>',
        '    </div>',
        '  );',
        '}',
        'export function Next() {',
        '  return 1;',
        '}',
      ],
      outline: ['1: export function A() {', '8: export function Next() {'],
    },
    {
      shape: 'JSX: a node_modules/** in JSX text does not hide the declarations after it',
      file: 'list.jsx',
      lines: [
        'export function A() {',
        '  return (',
        '    <ul>',
        '      <li>Ignores node_modules/** by default</li>',
        '    </ul>',
        '  );',
        '}',
        'export function Next() {',
        '  return 1;',
        '}',
      ],
      outline: ['1: export function A() {', '8: export function Next() {'],
    },
    {
      shape: 'JavaScript: a lone backtick in JSX text does not hide the declarations after it',
      file: 'keys.js',
      lines: [
        'export function A() {',
        '  return (',
        '    <p>',
        '      Press <kbd>`</kbd> to open the console.',
        '    </p>',
        '  );',
        '}',
        'export function Next() {',
        '  return 1;',
        '}',
      ],
      outline: ['1: export function A() {', '8: export function Next() {'],
    },
    {
      shape: 'C#: statements with no space before the parenthesis are not declarations',
      file: 'P.cs',
      lines: [
        'class P {',
        '  static void Main(string[] args)',
        '  {',
        '    foreach(var a in args)',
        '    {',
        '    }',
        '    using(var s = File.OpenRead(x))',
        '    {',
        '    }',
        '    fixed(byte* p = buf)',
        '    {',
        '    }',
        '  }',
        '}',
      ],
      outline: ['1: class P {', '2:   static void Main(string[] args)'],
    },
    {
      shape: 'Java: assert and synchronized statements are not declarations',
      file: 'A.java',
      lines: [
        'class A {',
        '  void run() {',
        '    assert isValid(x);',
        '    synchronized(this) {',
        '    }',
        '  }',
        '}',
      ],
      outline: ['1: class A {', '2:   void run() {'],
    },
    {
      shape: 'A file named makefile.c keeps its preprocessor lines',
      file: 'makefile.c',
      lines: ['#include <stdio.h>', 'int main(void) {', '  return 0;', '}'],
      outline: ['1: #include <stdio.h>', '2: int main(void) {'],
    },
    {
      shape: 'A file named dockerfile.rs keeps its attributes',
      file: 'dockerfile.rs',
      lines: ['#[derive(Debug)]', 'struct S;'],
      outline: ['1: #[derive(Debug)]', '2: struct S;'],
    },
    {
      shape: 'TypeScript: methods named using, checked and fixed are declarations',
      file: 'plugins.ts',
      lines: [
        'export class Plugins {',
        '  using(plugin: Plugin): this {',
        '    return this;',
        '  }',
        '  checked(): boolean {',
        '    return true;',
        '  }',
        '  fixed(n: number): string {',
        '    return n.toFixed(2);',
        '  }',
        '}',
      ],
      outline: [
        '1: export class Plugins {',
        '2:   using(plugin: Plugin): this {',
        '5:   checked(): boolean {',
        '8:   fixed(n: number): string {',
      ],
    },
    {
      shape: 'C#: a lock statement with no space before the parenthesis is not a declaration',
      file: 'Gate.cs',
      lines: [
        'class Gate {',
        '  void Run()',
        '  {',
        '    lock(_gate)',
        '    {',
        '    }',
        '  }',
        '}',
      ],
      outline: ['1: class Gate {', '2:   void Run()'],
    },
    {
      shape: 'TypeScript: a slash after i++ divides, so the template after it closes',
      file: 'count.ts',
      lines: [
        'let i = 0;',
        'const half = i++ / 2 + `a/b`;',
        'export function later() {',
        '  return half;',
        '}',
      ],
      outline: [
        '1: let i = 0;',
        '2: const half = i++ / 2 + `a/b`;',
        '3: export function later() {',
      ],
    },
    {
      shape: 'Markdown: a heading after a blank line inside a --- block is a heading',
      file: 'intro.md',
      lines: ['---', 'Title: something', '', '# Intro', '', '---', '', 'Body text.', '', '## Next'],
      outline: ['4: # Intro', '10: ## Next'],
    },
    {
      shape: 'Java: one-line methods, same-line annotations, inner-class members and records',
      file: 'Outer.java',
      lines: [
        'public class Outer {',
        '    public int get() { return n; }',
        '    @Override public String toString() { return "o"; }',
        '    @Override',
        '    public int hashCode() {',
        '        return 1;',
        '    }',
        '    private static class Inner {',
        '        void run() {',
        '            if (ready) {',
        '            }',
        '        }',
        '        int size() { return 0; }',
        '    }',
        '    record Point(int x, int y) {}',
        '    interface Callback {',
        '        void call(int x);',
        '    }',
        '}',
      ],
      outline: [
        '1: public class Outer {',
        '2:     public int get() { return n; }',
        '3:     @Override public String toString() { return "o"; }',
        '5:     public int hashCode() {',
        '8:     private static class Inner {',
        '9:         void run() {',
        '13:         int size() { return 0; }',
        '15:     record Point(int x, int y) {}',
        '16:     interface Callback {',
        '17:         void call(int x);',
      ],
    },
    {
      shape: 'C#: same-line attributes, one-line bodies and nested-class members',
      file: 'Api.cs',
      lines: [
        'public class Api',
        '{',
        '    [HttpGet] public IActionResult Get() { return Ok(); }',
        '    [Obsolete]',
        '    public void Old()',
        '    {',
        '    }',
        '    public int Twice(int x) { return x * 2; }',
        '    private class Nested',
        '    {',
        '        public void Run()',
        '        {',
        '            foreach (var a in args)',
        '            {',
        '            }',
        '        }',
        '    }',
        '}',
      ],
      outline: [
        '1: public class Api',
        '3:     [HttpGet] public IActionResult Get() { return Ok(); }',
        '5:     public void Old()',
        '8:     public int Twice(int x) { return x * 2; }',
        '9:     private class Nested',
        '11:         public void Run()',
      ],
    },
    {
      shape: 'C++: class members, constructors, destructors, operators and qualified definitions',
      file: 'foo.hpp',
      lines: [
        'class Foo {',
        'public:',
        '    Foo(int n);',
        '    virtual ~Foo();',
        '    int get() const { return n_; }',
        '    void set(int v);',
        '    static std::string name();',
        '    const std::vector<int>& items() const;',
        '    virtual void draw() = 0;',
        '    bool operator==(const Foo& other) const;',
        '    int code() const NOEXCEPT_MACRO {',
        '        return n_;',
        '    }',
        '    void flush() NOEXCEPT_MACRO;',
        'private:',
        '    int n_;',
        '};',
        '',
        'namespace app {',
        '    std::string Foo::name() {',
        '        return "foo";',
        '    }',
        '}',
        '',
        'int main() {',
        '    int x(5);',
        '    Foo f(1);',
        '    std::sort(v.begin(), v.end());',
        '    for (int i = 0; i < x; ++i) {',
        '    }',
        '    return x;',
        '}',
      ],
      outline: [
        '1: class Foo {',
        '2: public:',
        '3:     Foo(int n);',
        '4:     virtual ~Foo();',
        '5:     int get() const { return n_; }',
        '6:     void set(int v);',
        '7:     static std::string name();',
        '8:     const std::vector<int>& items() const;',
        '9:     virtual void draw() = 0;',
        '10:     bool operator==(const Foo& other) const;',
        '11:     int code() const NOEXCEPT_MACRO {',
        '14:     void flush() NOEXCEPT_MACRO;',
        '15: private:',
        '19: namespace app {',
        '20:     std::string Foo::name() {',
        '25: int main() {',
      ],
    },
    {
      shape: 'TypeScript: decorators on the method line, generator methods, parentheses in strings',
      file: 'widget.ts',
      lines: [
        'export class Widget {',
        "  @HostListener('click') onClick(): void {",
        '  }',
        '  *values(): Generator<number> {',
        '    yield 1;',
        '  }',
        '  static *range(n: number) {',
        '  }',
        "  paren(s = '(') {",
        '  }',
        '  quote(s = ")"): string {',
        '    return s;',
        '  }',
        '}',
      ],
      outline: [
        '1: export class Widget {',
        "2:   @HostListener('click') onClick(): void {",
        '4:   *values(): Generator<number> {',
        '7:   static *range(n: number) {',
        "9:   paren(s = '(') {",
        '11:   quote(s = ")"): string {',
      ],
    },
    {
      shape: 'TypeScript: property access on keyword-named objects and two statements on a line',
      file: 'bodies.ts',
      lines: [
        'export function f() {',
        '  set.add(1);',
        '  it.skip;',
        '  get.value;',
        "  it.skip('later', () => {",
        '  });',
        "  describe.only('x', () => {",
        '  });',
        "  it.each<[number, string]>([[1, 'a']])('case %i', (n) => {",
        '  });',
        '  foo(x); if (y) {',
        '  }',
        '}',
      ],
      outline: [
        '1: export function f() {',
        "5:   it.skip('later', () => {",
        "7:   describe.only('x', () => {",
        "9:   it.each<[number, string]>([[1, 'a']])('case %i', (n) => {",
      ],
    },
    {
      shape: 'TypeScript: a regex after a control-flow condition does not open a template',
      file: 'regex.ts',
      lines: [
        'if (a) /`/.test(x);',
        'export function hidden() {',
        '}',
        'while (b) /`/.test(y);',
        'export const after = 1;',
      ],
      outline: [
        '1: if (a) /`/.test(x);',
        '2: export function hidden() {',
        '4: while (b) /`/.test(y);',
        '5: export const after = 1;',
      ],
    },
    {
      shape: 'TypeScript: a string continued with a backslash is text, and opens no template',
      file: 'continued.ts',
      lines: [
        "const s = 'a \\",
        "`';",
        'export function hidden() {',
        '}',
        "const t = 'b \\",
        "`';",
        'export const after = 1;',
      ],
      outline: [
        "1: const s = 'a \\",
        '3: export function hidden() {',
        "5: const t = 'b \\",
        '7: export const after = 1;',
      ],
    },
    {
      shape: 'TypeScript: a scan that ends inside a template masks nothing',
      file: 'unclosed.ts',
      lines: ['const a = 1;', 'const t = `', 'export function later() {', '  return t;', '}'],
      outline: ['1: const a = 1;', '2: const t = `', '3: export function later() {'],
    },
    {
      shape: 'JSON: an object outlines to its top-level keys',
      file: 'package.json',
      lines: [
        '{',
        '  "name": "x",',
        '  "glob": "src/**/{a,b}[0]",',
        '  "scripts": {',
        '    "build": "tsc"',
        '  },',
        '  "private": true',
        '}',
      ],
      outline: [
        '1: {',
        '2:   "name": "x",',
        '3:   "glob": "src/**/{a,b}[0]",',
        '4:   "scripts": {',
        '7:   "private": true',
      ],
    },
    {
      shape: 'JSON: an array of objects outlines to each element by its first key',
      file: 'list.json',
      lines: [
        '[',
        '  {',
        '    "name": "a",',
        '    "v": 1',
        '  },',
        '  { "name": "inline" },',
        '  {',
        '    "name": "b"',
        '  }',
        ']',
      ],
      outline: ['1: [', '3:     "name": "a",', '6:   { "name": "inline" },', '8:     "name": "b"'],
    },
    {
      shape: 'JSON: elements written at column 0 are found by depth, not indentation',
      file: 'flat.json',
      lines: ['[', '{', '"name": "a"', '},', '{', '"name": "b"', '}', ']'],
      outline: ['1: [', '3: "name": "a"', '6: "name": "b"'],
    },
    {
      shape: 'Markdown: front matter that opens with a # comment is skipped',
      file: 'commented.md',
      lines: ['---', '# comment', 'title: x', 'body: y', '---', '# Heading'],
      outline: ['6: # Heading'],
    },
    {
      shape: 'Markdown: a # comment beside keys after a blank line stays in front matter',
      file: 'sections.md',
      lines: ['---', 'title: x', '', '# section', 'key: y', '---', '# Heading'],
      outline: ['7: # Heading'],
    },
  ];

describe('Read outline contract', () => {
  for (const { shape, file, lines, outline } of OUTLINE_CONTRACT) {
    it(shape, async () => {
      writeFileSync(join(dir, file), lines.join('\n'));
      const outlined = await read.execute({ filePath: file, outline: true }, ctx);
      expect(outlined.content.split('\n').slice(1)).toEqual(outline);
    });
  }

  it('counts the lines of a file that ends in a newline without the empty one after it', async () => {
    writeFileSync(join(dir, 'counted.ts'), 'export const a = 1;\nexport const b = 2;\n');
    const outlined = await read.execute({ filePath: 'counted.ts', outline: true }, ctx);
    expect(outlined.content.split('\n')[0]).toMatch(/^Outline of counted\.ts: 2 lines, 2 shown\./);
  });

  it('cuts an oversized entry instead of showing none', async () => {
    writeFileSync(join(dir, 'min.js'), `var a=${'1+'.repeat(30_000)}1;\nfunction b() {}\n`);
    const outlined = await read.execute({ filePath: 'min.js', outline: true }, ctx);
    const lines = outlined.content.split('\n');
    expect(lines[0]).toMatch(/^Outline of min\.js: 2 lines, 2 shown\./);
    expect(lines[1].startsWith('1: var a=1+1+')).toBe(true);
    expect(lines[1].endsWith('…')).toBe(true);
    expect(Buffer.byteLength(lines[1])).toBeLessThanOrEqual(3 + 512);
    expect(lines[2]).toBe('2: function b() {}');
    expect(lines).toHaveLength(3);
  });

  it('keeps the header and the truncation note inside the clip for a long path', async () => {
    const declarations = Array.from(
      { length: 3000 },
      (_, index) => `export const value${index} = '${'x'.repeat(40)}';`,
    );
    writeFileSync(join(dir, 'many.ts'), declarations.join('\n'));
    const filePath = `${'./'.repeat(200)}many.ts`;
    const outlined = await read.execute({ filePath, outline: true }, ctx);
    expect(Buffer.byteLength(outlined.content)).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    expect(outlined.content.split('\n').at(-1)).toMatch(
      /^\[Outline truncated at \d+ of 3000 entries/,
    );
    const bounded = await boundToolResultOutput(outlined, dir, undefined, join(dir, 'tool-output'));
    expect(bounded.content).toBe(outlined.content);
  });
});

describe('Read output budget', () => {
  it('stops under the tool-result clip and names the offset a second Read continues from', async () => {
    // 1885 lines and about 74 KB, the shape of src/agents/manager.ts (#248).
    const lines = Array.from(
      { length: 1885 },
      (_, index) => `export const value${index} = '${'x'.repeat(6)}';`,
    );
    writeFileSync(join(dir, 'big.ts'), `${lines.join('\n')}\n`);

    const first = await read.execute({ filePath: 'big.ts' }, ctx);
    expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    // The shared clip, whose notice names a file Read cannot open, never fires.
    const bounded = await boundToolResultOutput(first, dir, undefined, join(dir, 'tool-output'));
    expect(bounded.pagination?.omittedBytes).toBeUndefined();
    expect(bounded.content).toBe(first.content);

    const shown = first.content.split('\n');
    const notice = shown.at(-1)!;
    const next = Number(/Continue with offset: (\d+)\.\]$/.exec(notice)?.[1]);
    expect(notice).toBe(
      `[Lines 1-${next - 1} of 1885 shown, the most one Read returns (50 KB). Continue with offset: ${next}.]`,
    );
    expect(shown.at(-2)).toBe(`${next - 1}: ${lines[next - 2]}`);
    expect(first.artifacts?.fileObservations?.[0]?.lineEnd).toBe(next - 1);
    // The result says it was truncated, as the shared clip's did, and where it continues.
    expect(first.pagination).toEqual({ truncated: true, nextCursor: String(next) });
    expect(bounded.pagination).toEqual({ truncated: true, nextCursor: String(next) });

    const rest = await read.execute({ filePath: 'big.ts', offset: next }, ctx);
    expect(rest.content).not.toContain('Continue with offset');
    const numbered = [...shown.slice(0, -1), ...rest.content.split('\n')];
    expect(numbered.slice(0, 1885)).toEqual(lines.map((line, index) => `${index + 1}: ${line}`));
  });

  it('says where a Read stopped by its line limit continues', async () => {
    writeFileSync(
      join(dir, 'long.txt'),
      Array.from({ length: 2500 }, (_, index) => `l${index + 1}`).join('\n'),
    );
    const whole = await read.execute({ filePath: 'long.txt' }, ctx);
    const wholeLines = whole.content.split('\n');
    expect(wholeLines).toHaveLength(2001);
    expect(wholeLines[1999]).toBe('2000: l2000');
    expect(wholeLines[2000]).toBe('[Lines 1-2000 of 2500 shown. Continue with offset: 2001.]');
    expect(whole.pagination).toEqual({ truncated: true, nextCursor: '2001' });

    const window = await read.execute({ filePath: 'long.txt', offset: 10, limit: 5 }, ctx);
    expect(window.content.split('\n').at(-1)).toBe(
      '[Lines 10-14 of 2500 shown. Continue with offset: 15.]',
    );

    const tail = await read.execute({ filePath: 'long.txt', offset: 2001 }, ctx);
    expect(tail.content).not.toContain('Continue with offset');
    expect(tail.content.split('\n').at(-1)).toBe('2500: l2500');
    expect(tail.pagination).toBeUndefined();
  });

  it('shows a line longer than the budget cut, and continues after it', async () => {
    writeFileSync(join(dir, 'minified.js'), `${'x'.repeat(60_000)}\nlast`);
    const first = await read.execute({ filePath: 'minified.js' }, ctx);
    expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    const shown = first.content.split('\n');
    expect(shown).toHaveLength(2);
    expect(shown[0].startsWith('1: xxx')).toBe(true);
    expect(shown[1]).toBe(
      '[Lines 1-1 of 2 shown, the most one Read returns (50 KB). Continue with offset: 2. Line 1 (60000 bytes) was cut to fit.]',
    );
    // The cut line fills what the notice leaves of the clip, to the byte.
    expect(Buffer.byteLength(first.content)).toBe(TOOL_RESULT_MAX_BYTES);

    const rest = await read.execute({ filePath: 'minified.js', offset: 2 }, ctx);
    expect(rest.content).toBe('2: last');

    writeFileSync(join(dir, 'only.js'), 'x'.repeat(60_000));
    const only = await read.execute({ filePath: 'only.js' }, ctx);
    expect(only.content.split('\n').at(-1)).toBe(
      '[Line 1 (60000 bytes) was cut to fit one Read (50 KB).]',
    );
    expect(Buffer.byteLength(only.content)).toBe(TOOL_RESULT_MAX_BYTES);
    expect(only.pagination).toEqual({ truncated: true });
  });

  it('returns a line that fits under the clip on its own whole, with no cut notice', async () => {
    // 50,700 bytes: over the page budget, under the clip. Returned whole before the budget too.
    writeFileSync(join(dir, 'one.txt'), 'x'.repeat(50_700));
    const one = await read.execute({ filePath: 'one.txt' }, ctx);
    expect(one.content).toBe(`1: ${'x'.repeat(50_700)}`);

    // A line whose numbered form is exactly the clip.
    const full = 'z'.repeat(TOOL_RESULT_MAX_BYTES - Buffer.byteLength('1: '));
    writeFileSync(join(dir, 'full.txt'), full);
    const whole = await read.execute({ filePath: 'full.txt' }, ctx);
    expect(whole.content).toBe(`1: ${full}`);
  });

  it('does not call a line cut when it and its notice fill the clip exactly', async () => {
    const notice =
      '[Lines 1-1 of 2 shown, the most one Read returns (50 KB). Continue with offset: 2.]';
    const line = 'y'.repeat(TOOL_RESULT_MAX_BYTES - Buffer.byteLength(`1: \n${notice}`));
    writeFileSync(join(dir, 'exact.txt'), `${line}\nnext`);
    const page = await read.execute({ filePath: 'exact.txt' }, ctx);
    expect(page.content).toBe(`1: ${line}\n${notice}`);
    expect(Buffer.byteLength(page.content)).toBe(TOOL_RESULT_MAX_BYTES);

    const rest = await read.execute({ filePath: 'exact.txt', offset: 2 }, ctx);
    expect(rest.content).toBe('2: next');
  });

  it('stops an outline under the clip too, and says where the rest start', async () => {
    const declarations = Array.from(
      { length: 1500 },
      (_, index) => `export const value${index} = '${'x'.repeat(40)}';`,
    );
    writeFileSync(join(dir, 'wide.ts'), declarations.join('\n'));
    const outlined = await read.execute({ filePath: 'wide.ts', outline: true }, ctx);
    expect(Buffer.byteLength(outlined.content)).toBeLessThanOrEqual(TOOL_RESULT_MAX_BYTES);
    const note = outlined.content.split('\n').at(-1)!;
    const shownCount = Number(/^\[Outline truncated at (\d+) of 1500 entries;/.exec(note)?.[1]);
    expect(shownCount).toBeGreaterThan(0);
    expect(note).toContain(`the rest start at line ${shownCount + 1}.`);
  });
});
