import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../types/tools.js';
import { createRegistry } from './registry.js';
import { fileTools } from './file.js';
import {
  normalizeToolResult,
  readLineMetadata,
  readResultMetadata,
  boundToolResultOutput,
  replaceToolResult,
  toolFailure,
  toolResultModelContent,
  toolSuccess,
} from './result.js';

const context: ToolContext = { workspaceRoot: process.cwd(), env: {} };
const readRowWorkspaces: string[] = [];

afterEach(() => {
  for (const workspace of readRowWorkspaces.splice(0)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

describe('ToolResult V2', () => {
  it('returns a V2 envelope from registered tools', async () => {
    const registry = createRegistry();
    registry.register({
      name: 'LegacyEcho',
      description: 'Echo text',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string', description: 'Text to echo' } },
        required: ['value'],
      },
      execute: async (args) => toolSuccess(String(args.value)),
    });

    const result = await registry.execute(
      { id: 'call-1', name: 'LegacyEcho', arguments: { value: 'hello' } },
      context,
    );
    expect(result).toMatchObject({
      version: 2,
      status: 'success',
      content: 'hello',
    });
    expect(result.presentation?.details).toBe('hello');
  });

  it('serializes structured failures into actionable model context', () => {
    const result = toolFailure('Bad input', {
      code: 'invalid_arguments',
      remediation: 'Pass a non-empty query.',
    });
    expect(result.structuredError).toMatchObject({
      code: 'invalid_arguments',
      message: 'Bad input',
      retryable: false,
      remediation: 'Pass a non-empty query.',
    });
    expect(toolResultModelContent(result)).toContain('ERROR [invalid_arguments]: Bad input');
    expect(toolResultModelContent(result)).toContain('Fix: Pass a non-empty query.');
  });

  it('preserves the Fix line when clipping oversized error messages', async () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), 'book-fix-reserve-'));
    try {
      const huge = toolFailure('x'.repeat(80_000), {
        code: 'tool_error',
        remediation: 'Re-read the target and adjust.',
      });
      const bounded = await boundToolResultOutput(huge, process.cwd(), undefined, artifactRoot);
      const content = toolResultModelContent(bounded);
      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(50 * 1024);
      expect(content).toContain('Fix: Re-read the target and adjust.');
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  // A killed command is judged on the step it was on when the deadline hit.
  // Head-clipping hands back install and compile noise and drops exactly the
  // progress a timeout report exists to deliver.
  //
  // Asserted through `boundToolResultOutput`, which is what the agent loop
  // applies to every tool result and where the clipping actually happens. An
  // earlier version of this test called the renderer directly and passed while
  // production still head-clipped, because bounding empties `content` and folds
  // the output into the message before the renderer ever sees it.
  const killedResult = () => {
    const output = `START-OF-BUILD\n${'filler line\n'.repeat(6_000)}suite 41 of 42 passed\n`;
    expect(Buffer.byteLength(output)).toBeGreaterThan(50 * 1024);
    return toolFailure('Command was killed after 300000ms; it did not fail.', {
      status: 'timed_out',
      code: 'tool_timeout',
      remediation: 'Re-run with a larger timeout.',
      content: output,
      presentation: { details: output },
    });
  };

  // A failure is judged on both ends: the head carries the error line and
  // whatever framed the output (a `Partial result …` caveat, the first
  // diagnostics), and the tail carries the verdict a runner prints last. A
  // clip that kept only one of the two lost whichever end the model needed.
  const expectHeadAndTailKept = (content: string) => {
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(50 * 1024);
    expect(content).toContain('START-OF-BUILD');
    expect(content).toContain('suite 41 of 42 passed');
    // The gap is named, with the file holding the rest where there is one.
    expect(content).toMatch(/\[\.\.\. \d+ bytes omitted\. Full output( unavailable\.|: )/);
  };

  it('keeps the head and the tail of a timed-out result through the bounding step', async () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), 'book-timeout-tail-'));
    try {
      const bounded = await boundToolResultOutput(
        killedResult(),
        process.cwd(),
        undefined,
        artifactRoot,
      );
      const content = toolResultModelContent(bounded);

      expectHeadAndTailKept(content);
      expect(content).toContain('ERROR [tool_timeout]: Command was killed after 300000ms');
      expect(content).toContain('Fix: Re-run with a larger timeout.');
      // The transcript row reads the same way the model does.
      expectHeadAndTailKept(bounded.presentation!.details!);
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it('keeps the head and the tail for a caller that renders without bounding', () => {
    const content = toolResultModelContent(killedResult());

    expectHeadAndTailKept(content);
    expect(content).toContain('ERROR [tool_timeout]: Command was killed after 300000ms');
  });

  it('still bounds a timed-out result whose message alone exceeds the budget', () => {
    const huge = toolFailure('x'.repeat(80_000), {
      status: 'timed_out',
      code: 'tool_timeout',
      content: 'tail content',
    });

    const content = toolResultModelContent(huge);

    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(50 * 1024);
    // The message overflows on its own, so the tail is all there is to keep.
    expect(content).toContain('tail content');
  });

  // #308, the Bash shape: a non-zero exit puts all of stderr in the message
  // and stdout in the content (`fail(stderr || …, stdout)`). A tail-only clip
  // head-clipped the oversized stderr, dropped stdout entirely — and stdout is
  // where vitest prints `Tests  2 failed | 10 passed`.
  it('keeps both the stderr head and the stdout tail of a failed command', async () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), 'book-bash-failure-'));
    const stderr = 'Warning: An update to Root inside a test was not wrapped in act(...).\n'.repeat(
      1_100,
    );
    const stdout = `  ✓ renders the page\n`.repeat(420) + 'Tests  2 failed | 10 passed\n';
    expect(Buffer.byteLength(stderr)).toBeGreaterThan(50 * 1024);
    try {
      const bounded = await boundToolResultOutput(
        toolFailure(stderr, {
          code: 'command_failed',
          remediation: 'Fix the two failing tests, then re-run.',
          content: stdout,
        }),
        process.cwd(),
        undefined,
        artifactRoot,
      );
      const content = toolResultModelContent(bounded);

      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(50 * 1024);
      expect(content).toContain('ERROR [command_failed]');
      // The first diagnostics, so the model can see what the run was doing.
      expect(content).toContain('not wrapped in act(...)');
      // The verdict, which lives in stdout and which a tail-of-the-message
      // clip threw away.
      expect(content).toContain('Tests  2 failed | 10 passed');
      expect(content).toMatch(/\[\.\.\. \d+ bytes omitted\. Full output: /);
      expect(content).toContain('Fix: Fix the two failing tests, then re-run.');
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  // #308, the framed shape: the Task tool's `subagent_timeout` result opens
  // with a caveat that everything below is unfinished. A tail-only clip cut
  // the caveat off, so the model read a partial result as final.
  it('keeps the caveat a failed result opens with', async () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), 'book-partial-result-'));
    const caveat = 'Partial result (the child was stopped; nothing below is final):';
    const body =
      'working through the migration step by step\n'.repeat(6_000) + 'unfinished: step 6 of 11\n';
    expect(Buffer.byteLength(body)).toBeGreaterThan(50 * 1024);
    try {
      const bounded = await boundToolResultOutput(
        toolFailure(caveat, {
          code: 'subagent_timeout',
          status: 'timed_out',
          remediation: 'Re-run the subagent with a larger budget.',
          content: body,
        }),
        process.cwd(),
        undefined,
        artifactRoot,
      );
      const content = toolResultModelContent(bounded);

      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(50 * 1024);
      expect(content).toContain(caveat);
      expect(content).toContain('unfinished: step 6 of 11');
      expect(content).toMatch(/\[\.\.\. \d+ bytes omitted\. Full output: /);
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  // #308: the notice said how much was left out, and counted the tail that was
  // kept as left out. So a 200 KB failure whose last 40 KB survived read as if
  // 190 KB had gone, and a model budgeting a `Read` of the full output from
  // that number read it wrong. What was actually dropped is what sits between
  // the head and the tail.
  const omittedNotice = /\[\.\.\. (\d+) bytes omitted\. Full output(?: unavailable\.|: [^\]]+)\]/;
  const parseClipped = (clipped: string) => {
    const notice = omittedNotice.exec(clipped);
    expect(notice).not.toBeNull();
    // The three parts are joined by one newline each, which belong to the
    // clipping rather than to the text, so the arithmetic below leaves them out.
    const head = clipped.slice(0, notice!.index);
    const tail = clipped.slice(notice!.index + notice![0].length);
    return {
      omitted: Number(notice![1]),
      head: head.endsWith('\n') ? head.slice(0, -1) : head,
      tail: tail.startsWith('\n') ? tail.slice(1) : tail,
    };
  };

  it.each([
    {
      name: 'a tail cut at a line break',
      // Many short lines, so the tail window holds many whole lines and starts
      // part-way into one.
      body: 'a line of build output\n'.repeat(9_000) + 'done\n',
    },
    {
      name: 'a tail with no line break in it',
      // One line longer than the tail window, so the window cannot be aligned
      // to a line and every byte of it is kept.
      body: 'a line of build output\n'.repeat(4_000) + 'z'.repeat(60_000),
    },
  ])('counts only the bytes it dropped, for $name (#308)', async ({ body }) => {
    const artifactRoot = mkdtempSync(join(tmpdir(), 'book-omitted-count-'));
    const original = `Command failed\n${body}`;
    const originalBytes = Buffer.byteLength(original);
    expect(originalBytes).toBeGreaterThan(50 * 1024);
    try {
      const bounded = await boundToolResultOutput(
        toolFailure('Command failed', { code: 'command_failed', content: body }),
        process.cwd(),
        undefined,
        artifactRoot,
      );
      // The clipped text of the message and the output, before the `ERROR`
      // prefix and the `Fix:` line that wrap it for the model.
      const clipped = bounded.structuredError!.message;
      const { omitted, head, tail } = parseClipped(clipped);

      expect(Buffer.byteLength(clipped)).toBeLessThanOrEqual(50 * 1024);
      // The head and the tail are kept, so the notice may not count either.
      expect(omitted).toBeLessThan(originalBytes);
      expect(Buffer.byteLength(head) + Buffer.byteLength(tail) + omitted).toBe(originalBytes);
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it('keeps model content independent from structured data', () => {
    const result = toolSuccess('2 matches', { data: { matches: ['a', 'b'] } });
    expect(toolResultModelContent(result)).toBe('2 matches');
    expect(result.data).toEqual({ matches: ['a', 'b'] });
  });

  it('replaces empty successful content with (no output) for the model', () => {
    expect(toolResultModelContent(toolSuccess(''))).toBe('(no output)');
    expect(toolResultModelContent(toolSuccess('x'))).toBe('x');
  });

  it('bounds oversized output and preserves the complete text as an artifact', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-tool-result-'));
    const artifactRoot = mkdtempSync(join(tmpdir(), 'book-tool-output-'));
    const fullOutput = 'large output\n' + 'x'.repeat(80_000);
    try {
      const result = await boundToolResultOutput(
        toolSuccess(fullOutput, { presentation: { details: fullOutput } }),
        workspace,
        undefined,
        artifactRoot,
      );

      expect(Buffer.byteLength(result.content)).toBeLessThanOrEqual(50 * 1024);
      expect(result.content).toContain('Full output:');
      expect(result.presentation?.details).toContain('Full output:');
      expect(result.artifacts?.outputPath).toContain(artifactRoot.replace(/\\/g, '/'));
      const outputPath = result.artifacts!.outputPath!;
      expect(existsSync(outputPath)).toBe(true);
      expect(readFileSync(outputPath, 'utf8')).toBe(fullOutput);
      expect(outputPath.startsWith(workspace)).toBe(false);
      expect(existsSync(join(workspace, '.book', 'tool-output'))).toBe(false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it('bounds a large structured error before model serialization', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-tool-error-'));
    const message = 'stderr: ' + 'e'.repeat(80_000);
    try {
      const result = await boundToolResultOutput(
        toolFailure(message, { code: 'command_failed' }),
        workspace,
        undefined,
        join(workspace, 'local-tool-output'),
      );

      expect(Buffer.byteLength(toolResultModelContent(result))).toBeLessThanOrEqual(50 * 1024);
      // A failure keeps its head and its tail, so its notice names the gap.
      expect(result.structuredError?.message).toMatch(/\[\.\.\. \d+ bytes omitted\./);
      expect(result.artifacts?.outputPath).toBeTruthy();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('still clips output when local artifact persistence is unavailable', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-tool-readonly-'));
    const blocker = join(workspace, 'not-a-directory');
    writeFileSync(blocker, 'blocker');
    try {
      const result = await boundToolResultOutput(
        toolSuccess('x'.repeat(80_000)),
        workspace,
        undefined,
        blocker,
      );

      expect(Buffer.byteLength(toolResultModelContent(result))).toBeLessThanOrEqual(50 * 1024);
      expect(result.content).toContain('Full output unavailable');
      expect(result.artifacts?.outputPath).toBeUndefined();
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('keeps machine-readable data on failure envelopes', () => {
    const result = toolFailure('No candidates fit', {
      code: 'budget_exceeded',
      data: { rejected: ['HugeTool'] },
    });
    expect(result.data).toEqual({ rejected: ['HugeTool'] });
  });

  it('preserves explicit presentation fields during registry enrichment', async () => {
    const registry = createRegistry();
    registry.register({
      name: 'Read',
      description: 'Render custom content',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
      },
      execute: async () =>
        toolSuccess('raw content', {
          presentation: {
            kind: 'markdown',
            summary: 'Custom summary',
            details: 'Custom details',
            metadata: ['custom metadata'],
            target: 'custom target',
          },
        }),
    });

    const result = await registry.execute(
      { id: 'presentation', name: 'Read', arguments: { filePath: 'ignored.md' } },
      context,
    );
    expect(result.presentation).toEqual({
      kind: 'markdown',
      summary: 'Custom summary',
      details: 'Custom details',
      metadata: ['custom metadata'],
      target: 'custom target',
    });
  });

  it.each([
    {
      name: 'a page that stops early',
      args: { filePath: 'src/a.ts', offset: 3 },
      content: '3: c\n4: d\n5: e\n6: f\n[Lines 3-6 of 20 shown. Continue with offset: 7.]',
      metadata: ['4 lines', '3-6'],
    },
    {
      name: 'a line cut to fit',
      args: { filePath: 'src/a.ts' },
      content: '1: aaaa\n[Line 1 (60000 bytes) was cut to fit one Read (50 KB).]',
      metadata: ['1 line'],
    },
    {
      name: 'a whole file',
      args: { filePath: 'src/a.ts' },
      content: '1: a\n2: b',
      metadata: ['2 lines'],
    },
    { name: 'an empty file', args: { filePath: 'src/a.ts' }, content: '', metadata: ['empty'] },
  ])(
    'counts $name by its file lines, not its notice (#247)',
    async ({ args, content, metadata }) => {
      const registry = createRegistry();
      registry.register({
        name: 'Read',
        description: 'Read a page',
        parameters: {
          type: 'object',
          properties: { filePath: { type: 'string' }, offset: { type: 'number' } },
          required: ['filePath'],
        },
        execute: async () => toolSuccess(content),
      });

      const result = await registry.execute({ id: 'page', name: 'Read', arguments: args }, context);

      expect(result.presentation?.metadata).toEqual(metadata);
    },
  );

  it.each([
    { name: 'a file that ends in a newline', file: 'a\nb\n', args: {}, metadata: ['2 lines'] },
    { name: 'an empty file', file: '', args: {}, metadata: ['empty'] },
    {
      name: 'the end of a file from an offset',
      file: 'a\nb\n',
      args: { offset: 2 },
      metadata: ['1 line', '2-2'],
    },
    {
      name: 'a page that stops early',
      file: 'a\nb\nc\nd\ne\nf\n',
      args: { offset: 3, limit: 2 },
      metadata: ['2 lines', '3-4'],
    },
    {
      name: 'a blank last line, read to the end of the file',
      file: 'a\n\n',
      args: { offset: 2, limit: 1 },
      metadata: ['1 line', '2-2'],
    },
    {
      name: 'a file whose last line is blank',
      file: 'a\n\n',
      args: {},
      metadata: ['2 lines'],
    },
    {
      name: 'a page whose last line is blank',
      file: 'a\nb\n\nd\n',
      args: { limit: 3 },
      metadata: ['3 lines'],
    },
    {
      name: 'an outline',
      file: 'export function a() {}\n\nexport function b() {}\n',
      args: { outline: true },
      metadata: ['outline', '2 entries'],
    },
  ])('describes a real Read of $name (#247)', async ({ file, args, metadata }) => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-read-row-'));
    readRowWorkspaces.push(workspace);
    writeFileSync(join(workspace, 'a.ts'), file);
    const registry = createRegistry();
    registry.register(fileTools.find((tool) => tool.name === 'Read')!);

    const result = await registry.execute(
      { id: 'read', name: 'Read', arguments: { filePath: 'a.ts', ...args } },
      { workspaceRoot: workspace, env: {} },
    );

    expect(result.status).toBe('success');
    expect(result.presentation?.metadata).toEqual(metadata);
  });

  // #311, E1: a failed Grep has no matches to count. An invalid regex showed
  // `Found 0 matches` beside the error, which reads as a search that ran and
  // found nothing rather than one that never ran.
  it('counts nothing for a failed Grep, the way the Read branch does (#311)', async () => {
    const registry = createRegistry();
    registry.register({
      name: 'Grep',
      description: 'Search file contents',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
      },
      execute: async () => toolFailure('Invalid regex: [unclosed', { code: 'invalid_regex' }),
    });

    const result = await registry.execute(
      { id: 'grep', name: 'Grep', arguments: { pattern: '[unclosed' } },
      context,
    );

    expect(result.status).toBe('error');
    expect(result.presentation?.metadata).toEqual([]);
    expect(result.presentation?.summary).not.toMatch(/^Found \d+ matches/);
  });

  // #311, E2: an exact count from Grep's own data beats re-parsing the page.
  // The enricher must keep it rather than re-deriving one.
  it('keeps an explicit Grep count instead of re-deriving one (#311)', async () => {
    const registry = createRegistry();
    registry.register({
      name: 'Grep',
      description: 'Search file contents',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
      },
      execute: async () =>
        toolSuccess('src/a.ts:9:\n  at 10:12:30\n', {
          presentation: { metadata: ['1 match'], summary: 'Found 1 match' },
        }),
    });

    const result = await registry.execute(
      { id: 'grep', name: 'Grep', arguments: { pattern: 'needle' } },
      context,
    );

    expect(result.presentation?.metadata).toEqual(['1 match']);
    expect(result.presentation?.summary).toBe('Found 1 match');
  });

  it('keeps Read row counts whole for a fractional offset', () => {
    expect(readLineMetadata(2.5, 3.5)).toEqual(['3 lines', '2-4']);
    expect(readLineMetadata(1, 0.5)).toEqual(['empty']);
  });

  // #311: the row counted `/:\d+:/` lines whatever `output_mode` asked for, so
  // a `count` page of two files holding 57 matches read as `2 matches`, and
  // three files read as `3 matches` rather than `3 files`.
  it.each([
    {
      name: 'content',
      args: { pattern: 'needle', output_mode: 'content' },
      content: 'src/a.ts:12: const needle = 1;\nsrc/b.ts:45: const needle = 2;\n',
      metadata: ['2 matches'],
      summary: 'Found 2 matches',
    },
    {
      name: 'count',
      args: { pattern: 'needle', output_mode: 'count' },
      content: 'src/a.ts:30\nsrc/b.ts:27\n',
      metadata: ['57 matches'],
      summary: 'Found 57 matches',
    },
    {
      name: 'files_with_matches',
      args: { pattern: 'needle', output_mode: 'files_with_matches' },
      content: 'src/a.ts\nsrc/b.ts\nsrc/c.ts\n',
      metadata: ['3 files'],
      summary: 'Found 3 files',
    },
    {
      name: 'a search with no matches',
      args: { pattern: 'needle' },
      content: 'No matches found',
      metadata: ['0 matches'],
      summary: 'Found 0 matches',
    },
  ])(
    'counts a Grep row in the units of $name (#311)',
    async ({ args, content, metadata, summary }) => {
      const registry = createRegistry();
      registry.register({
        name: 'Grep',
        description: 'Search file contents',
        parameters: {
          type: 'object',
          properties: { pattern: { type: 'string' }, output_mode: { type: 'string' } },
          required: ['pattern'],
        },
        execute: async () => toolSuccess(content),
      });

      const result = await registry.execute({ id: 'grep', name: 'Grep', arguments: args }, context);

      expect(result.presentation?.metadata).toEqual(metadata);
      expect(result.presentation?.summary).toBe(summary);
    },
  );

  // A result persisted by a build that numbered the empty element `split`
  // leaves after a final newline still carries it, so the reconstruction keeps
  // reading past a trailing `N: `.
  it('still reads a legacy Read row past the phantom line a final newline left (#309)', () => {
    expect(readResultMetadata({ filePath: 'a.ts' }, '1: a\n2: b\n3: ')).toEqual(['2 lines']);
  });

  // #308: only a killed command kept its tail. A failed run was head-clipped, so
  // the model read the act() warnings at the top and never the summary that
  // says which tests failed, which every test runner prints last.
  const failedRun = () => {
    const output = `START-OF-TEST-RUN\n${'act() call-order warning\n'.repeat(9_000)}Tests  2 failed | 10 passed\n`;
    expect(Buffer.byteLength(output)).toBeGreaterThan(50 * 1024);
    return toolFailure('Command failed with exit code 1', {
      code: 'command_failed',
      remediation: 'Read the failing test names and fix them.',
      content: output,
      presentation: { details: output },
    });
  };

  it('keeps the tail of a failed result through the bounding step (#308)', async () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), 'book-failed-tail-'));
    try {
      const bounded = await boundToolResultOutput(
        failedRun(),
        process.cwd(),
        undefined,
        artifactRoot,
      );
      const content = toolResultModelContent(bounded);

      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(50 * 1024);
      expect(content).toContain('ERROR [command_failed]: Command failed with exit code 1');
      // The verdict every test runner prints last, after the act() warnings.
      expect(content).toContain('Tests  2 failed | 10 passed');
      expect(content).toMatch(/\[\.\.\. \d+ bytes omitted\. Full output: /);
      expect(content).toContain('Fix: Read the failing test names and fix them.');
      // The transcript row reads the same way the model does.
      const details = bounded.presentation!.details!;
      expect(Buffer.byteLength(details)).toBeLessThanOrEqual(50 * 1024);
      expect(details).toContain('Tests  2 failed | 10 passed');
      expect(details).toMatch(/\[\.\.\. \d+ bytes omitted\. Full output: /);
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it('keeps the tail of a failed result for a caller that renders without bounding (#308)', () => {
    const content = toolResultModelContent(failedRun());

    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(50 * 1024);
    expect(content).toContain('ERROR [command_failed]: Command failed with exit code 1');
    expect(content).toContain('Tests  2 failed | 10 passed');
  });

  it('still head-clips a successful result (#308)', async () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), 'book-success-head-'));
    const output = `HEAD-OF-OUTPUT\n${'x'.repeat(200_000)}`;
    try {
      const bounded = await boundToolResultOutput(
        toolSuccess(output, { presentation: { details: output } }),
        process.cwd(),
        undefined,
        artifactRoot,
      );
      const content = toolResultModelContent(bounded);

      expect(Buffer.byteLength(content)).toBeLessThanOrEqual(50 * 1024);
      expect(content).toContain('HEAD-OF-OUTPUT');
      expect(content).toContain('Output truncated');
    } finally {
      rmSync(artifactRoot, { recursive: true, force: true });
    }
  });

  it('upgrades persisted legacy results without retaining legacy projections', () => {
    const result = normalizeToolResult({
      toolCallId: 'legacy-call',
      success: false,
      output: 'command output',
      error: 'Tool timeout after 1000ms',
      durationMs: 1_000,
      fileMutation: {
        kind: 'update',
        filePath: 'src/a.ts',
        addedLines: 1,
        removedLines: 2,
      },
    });

    expect(result).toMatchObject({
      version: 2,
      status: 'timed_out',
      content: 'command output',
      structuredError: {
        code: 'timed_out',
        message: 'Tool timeout after 1000ms',
        retryable: true,
      },
      metrics: { durationMs: 1_000 },
      artifacts: {
        fileMutation: {
          kind: 'update',
          filePath: 'src/a.ts',
          addedLines: 1,
          removedLines: 2,
        },
      },
    });
    expect(result).not.toHaveProperty('success');
    expect(result).not.toHaveProperty('output');
    expect(result).not.toHaveProperty('error');
    expect(result).not.toHaveProperty('durationMs');
    expect(result).not.toHaveProperty('fileMutation');
  });

  it('replaces structured errors without adding a legacy error projection', () => {
    const result = replaceToolResult(toolSuccess('submitted'), {
      status: 'blocked',
      content: '',
      error: {
        code: 'plan_not_approved',
        message: 'Plan was not approved.',
        retryable: false,
      },
    });

    expect(result).toMatchObject({
      status: 'blocked',
      content: '',
      structuredError: {
        code: 'plan_not_approved',
        message: 'Plan was not approved.',
        retryable: false,
      },
    });
    expect(result).not.toHaveProperty('error');
    expect(normalizeToolResult(result).structuredError?.message).toBe('Plan was not approved.');
  });

  it('sends a rewritten result’s own content to the model (#378)', () => {
    // `Write` of a new file returns a one-line placeholder in place of the diff
    // (#378). A PostToolUse hook that rewrites `toolOutput` goes through
    // `replaceToolResult`, and its text is what the model must read: keeping
    // the placeholder here would silently discard the hook's output while the
    // diff the hook rewrote is still on the record.
    const rewritten = replaceToolResult(
      {
        ...toolSuccess('@@ -1 +1 @@\n+one\n+two'),
        maskedPlaceholder: 'Created a.ts (2 lines, 8 bytes).',
      },
      { content: 'hook rewrote this output' },
    );

    expect(rewritten.maskedPlaceholder).toBeUndefined();
    expect(toolResultModelContent(rewritten)).toBe('hook rewrote this output');
    expect(normalizeToolResult(rewritten).maskedPlaceholder).toBeUndefined();
  });

  it('keeps the placeholder when the replacement changes only status or presentation (#378)', () => {
    const masked = {
      ...toolSuccess('@@ -1 +1 @@\n+one'),
      maskedPlaceholder: 'Created a.ts (1 line, 4 bytes).',
    };

    const blocked = replaceToolResult(masked, { status: 'blocked' });
    expect(blocked.maskedPlaceholder).toBe('Created a.ts (1 line, 4 bytes).');
    expect(toolResultModelContent(blocked)).toBe('Created a.ts (1 line, 4 bytes).');

    const relabelled = replaceToolResult(masked, { presentation: { summary: 'Wrote a.ts' } });
    expect(relabelled.maskedPlaceholder).toBe('Created a.ts (1 line, 4 bytes).');
    expect(toolResultModelContent(relabelled)).toBe('Created a.ts (1 line, 4 bytes).');
  });
});
