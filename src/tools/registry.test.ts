import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDefaultRegistry } from './registry.js';
import type { ToolContext } from '../types.js';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dir: string;
const ctx: ToolContext = { workspaceRoot: '', env: {} };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-reg-'));
  ctx.workspaceRoot = dir;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('createDefaultRegistry — canonical CC tool names', () => {
  it('exposes Read, Write, Edit, MultiEdit, Glob, Grep, Bash', () => {
    const r = createDefaultRegistry();
    const names = new Set(r.getDefinitions().map((t) => t.name));
    for (const n of ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash']) {
      expect(names.has(n), `expected ${n} in registry`).toBe(true);
    }
  });

  it('does NOT expose legacy snake_case names as separate tools', () => {
    const r = createDefaultRegistry();
    const names = r.getDefinitions().map((t) => t.name);
    // Legacy names must not appear as model-facing tools (they're aliases only).
    for (const legacy of ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash']) {
      expect(names, `legacy ${legacy} should be alias-only`).not.toContain(legacy);
    }
  });

  it('resolves legacy aliases for execution', () => {
    const r = createDefaultRegistry();
    writeFileSync(join(dir, 'a.txt'), 'hello');
    // Legacy name 'read_file' should resolve to the Read tool.
    const result = r.execute(
      { id: 'c1', name: 'read_file', arguments: { filePath: 'a.txt' } },
      ctx,
    );
    return expect(result).resolves.toMatchObject({ success: true });
  });
});

describe('Edit replace_all', () => {
  it('replaces the single occurrence when oldString is unique', async () => {
    const r = createDefaultRegistry();
    writeFileSync(join(dir, 'a.txt'), 'foo bar baz');
    await r.execute(
      {
        id: 'c1',
        name: 'Edit',
        arguments: { filePath: 'a.txt', oldString: 'bar', newString: 'qux' },
      },
      ctx,
    );
    expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('foo qux baz');
  });

  it('replaces all occurrences when replaceAll is true', async () => {
    const r = createDefaultRegistry();
    writeFileSync(join(dir, 'a.txt'), 'foo foo bar');
    await r.execute(
      {
        id: 'c1',
        name: 'Edit',
        arguments: {
          filePath: 'a.txt',
          oldString: 'foo',
          newString: 'qux',
          replaceAll: true,
        },
      },
      ctx,
    );
    expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('qux qux bar');
  });

  it('fails when oldString is absent', async () => {
    const r = createDefaultRegistry();
    writeFileSync(join(dir, 'a.txt'), 'hello');
    const result = await r.execute(
      {
        id: 'c1',
        name: 'Edit',
        arguments: { filePath: 'a.txt', oldString: 'nope', newString: 'x' },
      },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it('fails when oldString matches multiple times but replaceAll is not set', async () => {
    const r = createDefaultRegistry();
    writeFileSync(join(dir, 'a.txt'), 'foo foo bar');
    const result = await r.execute(
      {
        id: 'c1',
        name: 'Edit',
        arguments: { filePath: 'a.txt', oldString: 'foo', newString: 'qux' },
      },
      ctx,
    );
    // CC's Edit rejects ambiguous single edits; require replaceAll for multi-match.
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/multiple|replaceAll|ambiguous/i);
  });
});

describe('Edit/Write return a diff', () => {
  it('Edit result output contains a unified diff', async () => {
    const r = createDefaultRegistry();
    writeFileSync(join(dir, 'a.txt'), 'line1\nline2\nline3');
    const result = await r.execute(
      {
        id: 'c1',
        name: 'Edit',
        arguments: {
          filePath: 'a.txt',
          oldString: 'line2',
          newString: 'LINE TWO',
        },
      },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toMatch(/^-line2$/m);
    expect(result.output).toMatch(/^\+LINE TWO$/m);
  });
});
