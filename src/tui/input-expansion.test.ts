import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it } from 'vitest';
import { expandAtMentions, expandAtMentionsWithObservations } from './input-expansion.js';

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

  it('reports missing files instead of silently leaving raw mentions', () => {
    const ws = workspace();

    const result = expandAtMentions('Read @missing.ts', ws);

    expect(result).toContain('[Could not include @missing.ts: file not found]');
  });

  it('reports directories', () => {
    const ws = workspace();
    mkdirSync(join(ws, 'src'));

    const result = expandAtMentions('Read @src', ws);

    expect(result).toContain('path is a directory');
  });

  it('rejects paths outside the workspace', () => {
    const ws = workspace();

    const result = expandAtMentions('Read @../secret.txt', ws);

    expect(result).toContain('path is outside the workspace');
  });

  it('adds an explicit truncation notice for large files', () => {
    const ws = workspace();
    writeFileSync(join(ws, 'large.txt'), 'x'.repeat(20_100));

    const result = expandAtMentions('Read @large.txt', ws);

    expect(result).toContain('File truncated at 20000 characters');
  });

  it('returns observations and hashes full content for truncated mentions', () => {
    const ws = workspace();
    writeFileSync(join(ws, 'large.txt'), 'x'.repeat(20_100));

    const result = expandAtMentionsWithObservations(
      'Read @large.txt',
      ws,
      'session://current/event/user-1',
    );

    expect(result.text).toContain('File truncated at 20000 characters');
    expect(result.fileObservations).toHaveLength(1);
    expect(result.fileObservations[0]).toMatchObject({
      path: 'large.txt',
      sizeBytes: 20_100,
      operation: 'mention',
      sourceRef: 'session://current/event/user-1',
      coverage: { kind: 'bytes', startByte: 0, endByte: 20_000, totalBytes: 20_100 },
    });
    expect(result.fileObservations[0].sha256).toHaveLength(64);
  });

  it('does not rewrite emails or incidental @ text', () => {
    const ws = workspace();

    const result = expandAtMentions('Email dev@example.com and say @ hello', ws);

    expect(result).toBe('Email dev@example.com and say @ hello');
  });
});
