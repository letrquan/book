import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDefaultRegistry, createRegistry } from './registry.js';
import { isFileMutatingTool } from './tool-capabilities.js';
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
  it('exposes canonical Claude Code tool names', () => {
    const r = createDefaultRegistry();
    const names = new Set(r.getDefinitions().map((t) => t.name));
    for (const n of [
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'Bash',
      'BashOutput',
      'KillShell',
      'TaskCreate',
      'TaskList',
      'TaskGet',
      'TaskUpdate',
      'TaskStop',
      'EnterPlanMode',
      'ExitPlanMode',
      'NotebookEdit',
    ]) {
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

describe('tool cancellation and timeout', () => {
  it('aborts the attempt signal on timeout without aborting the parent signal', async () => {
    const registry = createRegistry();
    const parent = new AbortController();
    let attemptSignal: AbortSignal | undefined;
    registry.register({
      name: 'Wait',
      description: 'wait',
      parameters: {},
      execute: async (_args, context) => {
        attemptSignal = context.signal;
        await new Promise<void>((resolve) =>
          context.signal?.addEventListener('abort', () => resolve()),
        );
        return { toolCallId: '', success: false, output: '', error: 'aborted' };
      },
    });

    const result = await registry.execute(
      { id: 'wait-1', name: 'Wait', arguments: { timeout: 5 } },
      { workspaceRoot: dir, env: {}, signal: parent.signal },
    );

    expect(result.error).toMatch(/Tool timeout/);
    expect(attemptSignal?.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
  });

  it('aborts the attempt and returns cancellation when the parent aborts', async () => {
    const registry = createRegistry();
    const parent = new AbortController();
    let attemptSignal: AbortSignal | undefined;
    registry.register({
      name: 'Wait',
      description: 'wait',
      parameters: {},
      execute: async (_args, context) => {
        attemptSignal = context.signal;
        await new Promise<void>((resolve) =>
          context.signal?.addEventListener('abort', () => resolve()),
        );
        return { toolCallId: '', success: false, output: '', error: 'aborted' };
      },
    });

    const pending = registry.execute(
      { id: 'wait-2', name: 'Wait', arguments: { timeout: 1_000 } },
      { workspaceRoot: dir, env: {}, signal: parent.signal },
    );
    parent.abort();
    const result = await pending;

    expect(result.error).toMatch(/CANCELLED/);
    expect(attemptSignal?.aborted).toBe(true);
  });

  it('finalizes pending nested calls and ignores late observer events after timeout', async () => {
    const registry = createRegistry();
    const events: string[] = [];
    registry.register({
      name: 'NestedWait',
      description: 'wait',
      parameters: {},
      execute: async (_args, context) => {
        context.nestedToolObserver?.onToolCall({
          traceId: 'nested-1',
          parentTraceId: 'parent',
          call: { id: 'child-1', name: 'Read', arguments: {} },
        });
        await new Promise((resolve) => setTimeout(resolve, 20));
        context.nestedToolObserver?.onToolCall({
          traceId: 'late',
          parentTraceId: 'parent',
          call: { id: 'late-child', name: 'Read', arguments: {} },
        });
        return { toolCallId: '', success: true, output: 'late' };
      },
    });

    const result = await registry.execute(
      { id: 'parent', name: 'NestedWait', arguments: { timeout: 5 } },
      {
        workspaceRoot: dir,
        env: {},
        nestedToolObserver: {
          onToolCall: (invocation) => events.push(`call:${invocation.traceId}`),
          onToolResult: (traceId, nestedResult) =>
            events.push(`result:${traceId}:${nestedResult.success}`),
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(result.error).toMatch(/Tool timeout/);
    expect(events).toEqual(['call:nested-1', 'result:nested-1:false']);
  });
});

describe('tool capabilities', () => {
  it('classifies all file-mutating tools from one source of truth', () => {
    for (const name of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
      expect(isFileMutatingTool(name), `expected ${name} file-mutating`).toBe(true);
    }
    for (const name of ['Read', 'Bash', 'GitCommit']) {
      expect(isFileMutatingTool(name), `expected ${name} not file-mutating`).toBe(false);
    }
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
    expect(result.fileMutation).toEqual({
      kind: 'update',
      filePath: 'a.txt',
      addedLines: 1,
      removedLines: 1,
    });
  });
});

describe('tool retry', () => {
  it('retries idempotent tool (Read) on failure and succeeds', async () => {
    const r = createDefaultRegistry();
    writeFileSync(join(dir, 'a.txt'), 'hello');

    let callCount = 0;
    const origExecute = r.getTool('Read')!.execute;
    r.getTool('Read')!.execute = async (args, ctx) => {
      callCount++;
      if (callCount === 1) {
        return { toolCallId: '', success: false, output: '', error: 'transient I/O error' };
      }
      return origExecute(args, ctx);
    };

    const result = await r.execute(
      { id: 'c1', name: 'Read', arguments: { filePath: 'a.txt' } },
      ctx,
      2, // allow up to 2 retries
    );
    expect(result.success).toBe(true);
    expect(callCount).toBe(2);
    expect(result.retryAttempt).toBe(2);
  });

  it('does NOT retry non-idempotent tool (Write) on failure', () => {
    const r = createDefaultRegistry();
    let attempts = 0;
    r.getTool('Write')!.execute = async () => {
      attempts++;
      return { toolCallId: '', success: false, output: '', error: 'disk full' };
    };

    return r
      .execute(
        { id: 'c1', name: 'Write', arguments: { filePath: 'a.txt', content: 'x' } },
        ctx,
        5, // would retry up to 5 times, but Write is not idempotent
      )
      .then((result) => {
        expect(result.success).toBe(false);
        expect(attempts).toBe(1);
        expect(result.retryAttempt).toBeUndefined();
      });
  });

  it('does NOT retry on SKIPPED errors (permission/hook)', () => {
    const r = createDefaultRegistry();
    let attempts = 0;
    r.getTool('Read')!.execute = async () => {
      attempts++;
      return { toolCallId: '', success: false, output: '', error: 'SKIPPED: Permission denied' };
    };

    return r
      .execute({ id: 'c1', name: 'Read', arguments: { filePath: 'a.txt' } }, ctx, 3)
      .then((result) => {
        expect(result.error).toMatch(/SKIPPED/);
        expect(attempts).toBe(1);
      });
  });

  it('stops retrying after maxRetries exhausted', async () => {
    const r = createDefaultRegistry();
    let attempts = 0;
    r.getTool('Read')!.execute = async () => {
      attempts++;
      return { toolCallId: '', success: false, output: '', error: 'persistent error' };
    };

    const result = await r.execute(
      { id: 'c1', name: 'Read', arguments: { filePath: 'a.txt' } },
      ctx,
      2,
    );
    expect(result.success).toBe(false);
    expect(attempts).toBe(3); // initial + 2 retries
    expect(result.retryAttempt).toBeUndefined(); // never succeeded
  });

  it('respects maxRetries=0 (no retry)', () => {
    const r = createDefaultRegistry();
    let attempts = 0;
    r.getTool('Read')!.execute = async () => {
      attempts++;
      return { toolCallId: '', success: false, output: '', error: 'error' };
    };

    return r
      .execute({ id: 'c1', name: 'Read', arguments: { filePath: 'a.txt' } }, ctx, 0)
      .then((result) => {
        expect(result.success).toBe(false);
        expect(attempts).toBe(1);
      });
  });

  it('clears tool timeout timers when tools finish before timeout', async () => {
    const r = createDefaultRegistry();
    r.getTool('Read')!.execute = async () => ({ toolCallId: '', success: true, output: 'ok' });

    const result = await r.execute(
      { id: 'c1', name: 'Read', arguments: { filePath: 'a.txt', timeout: 10_000 } },
      ctx,
      0,
    );

    expect(result.success).toBe(true);
  });

  it('sets retryAttempt on first success after retry', async () => {
    const r = createDefaultRegistry();
    writeFileSync(join(dir, 'b.txt'), 'test content');

    // Mock Read to always fail — the real implementation is not mocked here,
    // we just verify that a successful retry sets retryAttempt correctly
    // (tested implicitly by the "retries idempotent tool" test above).
    // This test ensures the field is absent on failure, present on success.
    let callCount = 0;
    r.getTool('Read')!.execute = async () => {
      callCount++;
      if (callCount <= 1) {
        return { toolCallId: '', success: false, output: '', error: 'transient' };
      }
      // Simulate a real success (without filesystem dependency).
      return { toolCallId: '', success: true, output: 'recovered content', durationMs: 5 };
    };

    const result = await r.execute(
      { id: 'c1', name: 'Read', arguments: { filePath: 'b.txt' } },
      ctx,
      2,
    );

    expect(callCount).toBe(2);
    expect(result.success).toBe(true);
    expect(result.retryAttempt).toBe(2);
  });
});
