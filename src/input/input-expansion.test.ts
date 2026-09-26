import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectAtMentionObservations,
  expandAtMentions,
  expandShellCommands,
} from './input-expansion.js';

let dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-at-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe('expandAtMentions', () => {
  it('expands a basic workspace-relative file mention', () => {
    const ws = workspace();
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src', 'app.ts'), 'export const value = 1;');

    const result = expandAtMentions('Explain @src/app.ts', ws);

    expect(result).toContain('Contents of src/app.ts:');
    expect(result).toContain('export const value = 1;');
  });

  it('expands a quoted path containing spaces', () => {
    const ws = workspace();
    writeFileSync(join(ws, 'my file.md'), '# Notes');

    const result = expandAtMentions('Read @"my file.md" please', ws);

    expect(result).toContain('Contents of my file.md:');
    expect(result).toContain('# Notes');
  });

  it("leaves a missing file's mention as written", () => {
    const ws = workspace();

    const result = expandAtMentions('Read @missing.ts', ws);

    expect(result).toBe('Read @missing.ts');
  });

  it('reports directories', () => {
    const ws = workspace();
    mkdirSync(join(ws, 'src'));

    const result = expandAtMentions('Read @src', ws);

    expect(result).toContain('path is a directory');
  });

  it('leaves a missing path outside the workspace as written', () => {
    const ws = workspace();

    const result = expandAtMentions('Read @../secret.txt', ws);

    expect(result).toBe('Read @../secret.txt');
  });

  it('adds an explicit truncation notice for large files', () => {
    const ws = workspace();
    writeFileSync(join(ws, 'large.txt'), 'x'.repeat(20_100));

    const result = expandAtMentions('Read @large.txt', ws);

    expect(result).toContain('File truncated at 20000 characters');
  });

  it('does not rewrite emails or incidental @ text', () => {
    const ws = workspace();

    const result = expandAtMentions('Email dev@example.com and say @ hello', ws);

    expect(result).toBe('Email dev@example.com and say @ hello');
  });
});

describe('expandAtMentions — only real paths outside code (#261)', () => {
  function codeWorkspace(): string {
    const dir = workspace();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const value = 1;');
    return dir;
  }

  it('leaves a mention of a path that does not exist as written', () => {
    const ws = codeWorkspace();
    expect(expandAtMentions('Read @missing.ts please', ws)).toBe('Read @missing.ts please');
  });

  it('leaves JSDoc tags, decorators and npm scopes as written', () => {
    const ws = codeWorkspace();
    const input =
      'Add {@link AgentSpawnRequest.resumeAfterRestart}, keep @Injectable() and install @types/node.';
    expect(expandAtMentions(input, ws)).toBe(input);
  });

  it('does not expand a mention inside a fenced code block', () => {
    const ws = codeWorkspace();
    const input = 'Spec:\n```ts\n/** See @src/app.ts */\n```\n';
    expect(expandAtMentions(input, ws)).toBe(input);
  });

  it('does not expand a mention inside a tilde fence, or an unclosed fence', () => {
    const ws = codeWorkspace();
    const tilde = '~~~\n@src/app.ts\n~~~';
    expect(expandAtMentions(tilde, ws)).toBe(tilde);
    const unclosed = 'Code:\n```\n@src/app.ts\nstill code';
    expect(expandAtMentions(unclosed, ws)).toBe(unclosed);
  });

  it('does not expand a mention inside an inline code span', () => {
    const ws = codeWorkspace();
    const single = 'Call it as `read @src/app.ts now` in the prompt.';
    expect(expandAtMentions(single, ws)).toBe(single);
    const double = 'Or ``x @src/app.ts ` y`` there.';
    expect(expandAtMentions(double, ws)).toBe(double);
  });

  it('still expands a real mention after a closed fence and beside a lone backtick', () => {
    const ws = codeWorkspace();
    const afterFence = expandAtMentions('```\ncode\n```\nExplain @src/app.ts', ws);
    expect(afterFence).toContain('Contents of src/app.ts:');
    const loneTick = expandAtMentions('a ` b @src/app.ts', ws);
    expect(loneTick).toContain('Contents of src/app.ts:');
  });

  it('still reports an existing file outside the workspace', () => {
    const ws = codeWorkspace();
    const outside = join(dirname(ws), `${basename(ws)}-secret.txt`);
    writeFileSync(outside, 'secret');
    dirs.push(outside);
    const result = expandAtMentions(`Read @../${basename(outside)}`, ws);
    expect(result).toContain('path is outside the workspace');
    expect(result).not.toContain('secret\n');
  });

  it('leaves a mention outside the workspace that does not exist as written', () => {
    const ws = codeWorkspace();
    expect(expandAtMentions('Read @../nope-not-here.txt', ws)).toBe('Read @../nope-not-here.txt');
  });

  it('records no observation for a mention inside code', () => {
    const ws = codeWorkspace();
    expect(collectAtMentionObservations('See `read @src/app.ts now`', ws, 'ref')).toEqual([]);
    expect(collectAtMentionObservations('See @src/app.ts', ws, 'ref')).toHaveLength(1);
  });
});

describe('expandShellCommands', () => {
  it('runs without blocking the event loop', async () => {
    let timerFired = false;
    const command = `!"${process.execPath}" -e "setTimeout(() => console.log('done'), 30)"`;
    const pending = expandShellCommands(command, process.cwd());
    setTimeout(() => {
      timerFired = true;
    }, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(timerFired).toBe(true);
    await expect(pending).resolves.toBe('done');
  });

  it('cancels owned shell expansion work', async () => {
    const controller = new AbortController();
    const command = `!"${process.execPath}" -e "setTimeout(() => console.log('late'), 10000)"`;
    const pending = expandShellCommands(command, process.cwd(), controller.signal);

    controller.abort();

    await expect(pending).resolves.toMatch(/failed:.*abort/i);
  });
});
