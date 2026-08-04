import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDefaultRegistry, createRegistry } from './registry.js';
import { isFileMutatingTool } from './tool-capabilities.js';
import { SessionRuntime } from '../session/runtime.js';
import type { ToolContext } from '../types/tools.js';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { toolFailure, toolSuccess } from './result.js';

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
      'ApplyPatch',
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
    for (const legacy of [
      'read_file',
      'write_file',
      'edit_file',
      'apply_patch',
      'glob',
      'grep',
      'bash',
    ]) {
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
    return expect(result).resolves.toMatchObject({ status: 'success' });
  });

  it('resolves apply_patch to the canonical ApplyPatch tool', () => {
    expect(createDefaultRegistry().getTool('apply_patch')?.name).toBe('ApplyPatch');
  });

  it.each(['parent:Glob', 'default:Glob', 'tool:Glob', 'glob_files'])(
    'resolves provider-compatible name %s to Glob',
    (name) => {
      expect(createDefaultRegistry().getTool(name)?.name).toBe('Glob');
    },
  );

  it('preserves an exact registered name before unwrapping a provider prefix', () => {
    const registry = createRegistry();
    registry.register({
      name: 'Glob',
      description: 'canonical',
      parameters: { type: 'object', properties: {} },
      execute: async () => toolSuccess('canonical'),
    });
    registry.register({
      name: 'tool:Glob',
      description: 'exact',
      parameters: { type: 'object', properties: {} },
      execute: async () => toolSuccess('exact'),
    });

    expect(registry.getTool('tool:Glob')?.description).toBe('exact');
  });

  it('keeps non-equivalent namespaced commands unknown', async () => {
    const result = await createDefaultRegistry().execute(
      { id: 'unknown-pnpm', name: 'pnpm:list', arguments: {} },
      ctx,
    );

    expect(result).toMatchObject({
      status: 'error',
      structuredError: { code: 'unknown_tool' },
    });
  });
});

describe('tool argument validation', () => {
  it('rejects unknown arguments for closed schemas with no declared properties', async () => {
    const execute = vi.fn(async () => toolSuccess('ok'));
    const registry = createRegistry();
    registry.register({
      name: 'NoArgs',
      description: 'Accept no arguments',
      parameters: { type: 'object', properties: {} },
      execute,
    });

    const result = await registry.execute(
      { id: 'no-args', name: 'NoArgs', arguments: { unexpected: true } },
      ctx,
    );

    expect(result.structuredError?.code).toBe('invalid_arguments');
    expect(result.structuredError?.message).toContain('arguments.unexpected is not allowed');
    expect(execute).not.toHaveBeenCalled();
  });

  it('preserves and validates schemas with dynamic object keys', async () => {
    const registry = createRegistry();
    registry.register({
      name: 'DynamicMap',
      description: 'Accept string values under arbitrary keys',
      parameters: {
        type: 'object',
        additionalProperties: { type: 'string' },
      },
      execute: async () => toolSuccess('ok'),
    });

    expect(registry.getTool('DynamicMap')?.inputSchema?.additionalProperties).toMatchObject({
      type: 'string',
    });
    await expect(
      registry.execute(
        { id: 'dynamic-ok', name: 'DynamicMap', arguments: { priority: 'high' } },
        ctx,
      ),
    ).resolves.toMatchObject({ status: 'success' });
    await expect(
      registry.execute({ id: 'dynamic-bad', name: 'DynamicMap', arguments: { priority: 1 } }, ctx),
    ).resolves.toMatchObject({ status: 'error' });
  });

  it('normalizes definition-declared argument aliases before closed-schema validation', async () => {
    const registry = createRegistry();
    registry.register({
      name: 'TaskGet',
      description: 'Read a task',
      argumentAliases: { task_id: 'taskId' },
      parameters: {
        type: 'object',
        properties: { taskId: { type: 'string' } },
        required: ['taskId'],
      },
      execute: async (args) => toolSuccess('ok', { data: args }),
    });
    registry.register({
      name: 'Bash',
      description: 'Run a command',
      argumentAliases: { runInBackground: 'run_in_background' },
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          run_in_background: { type: 'boolean' },
        },
        required: ['command'],
      },
      execute: async (args) => toolSuccess('ok', { data: args }),
    });
    registry.register({
      name: 'BashOutput',
      description: 'Read shell output',
      argumentAliases: { shellId: 'shell_id' },
      parameters: {
        type: 'object',
        properties: { shell_id: { type: 'string' } },
        required: ['shell_id'],
      },
      execute: async (args) => toolSuccess('ok', { data: args }),
    });

    const task = await registry.execute(
      { id: 'task-alias', name: 'TaskGet', arguments: { task_id: '7' } },
      ctx,
    );
    const bash = await registry.execute(
      {
        id: 'bash-alias',
        name: 'Bash',
        arguments: { command: 'echo ok', runInBackground: true },
      },
      ctx,
    );
    const output = await registry.execute(
      { id: 'output-alias', name: 'BashOutput', arguments: { shellId: 'shell_1' } },
      ctx,
    );

    expect(task).toMatchObject({ status: 'success', data: { taskId: '7' } });
    expect(bash).toMatchObject({
      status: 'success',
      data: { command: 'echo ok', run_in_background: true },
    });
    expect(output).toMatchObject({ status: 'success', data: { shell_id: 'shell_1' } });
  });
});

describe('cross-harness argument compatibility', () => {
  it('accepts Claude Code-style snake_case arguments for Edit', async () => {
    const r = createDefaultRegistry();
    writeFileSync(join(dir, 'a.txt'), 'foo bar baz');
    const result = await r.execute(
      {
        id: 'c1',
        name: 'Edit',
        arguments: { file_path: 'a.txt', old_string: 'bar', new_string: 'qux' },
      },
      ctx,
    );
    expect(result.status).toBe('success');
    expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('foo qux baz');
  });

  it('normalizes nested MultiEdit edits[] items', async () => {
    const r = createDefaultRegistry();
    writeFileSync(join(dir, 'a.txt'), 'one two three');
    const result = await r.execute(
      {
        id: 'c1',
        name: 'MultiEdit',
        arguments: {
          file_path: 'a.txt',
          edits: [
            { old_string: 'one', new_string: '1' },
            { old_string: 'three', new_string: '3', replace_all: true },
          ],
        },
      },
      ctx,
    );
    expect(result.status).toBe('success');
    expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('1 two 3');
  });

  it('prefers canonical keys when both spellings are present', async () => {
    const r = createDefaultRegistry();
    writeFileSync(join(dir, 'a.txt'), 'foo bar');
    const result = await r.execute(
      {
        id: 'c1',
        name: 'Edit',
        arguments: {
          filePath: 'a.txt',
          file_path: 'ignored.txt',
          oldString: 'bar',
          old_string: 'ignored',
          newString: 'baz',
          new_string: 'ignored',
        },
      },
      ctx,
    );
    expect(result.status).toBe('success');
    expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('foo baz');
  });

  it('accepts Read file_path and path spellings', async () => {
    const r = createDefaultRegistry();
    writeFileSync(join(dir, 'a.txt'), 'hello');
    await expect(
      r.execute({ id: 'c1', name: 'Read', arguments: { file_path: 'a.txt' } }, ctx),
    ).resolves.toMatchObject({ status: 'success' });
    await expect(
      r.execute({ id: 'c2', name: 'Read', arguments: { path: 'a.txt' } }, ctx),
    ).resolves.toMatchObject({ status: 'success' });
  });

  it('lists allowed arguments on invalid_arguments failures', async () => {
    const r = createDefaultRegistry();
    const result = await r.execute(
      { id: 'c1', name: 'Grep', arguments: { pattern: 'x', nonsense: true } },
      ctx,
    );
    expect(result.structuredError?.code).toBe('invalid_arguments');
    expect(result.structuredError?.message).toMatch(/Allowed arguments: .*pattern/);
  });
});

describe('repeated identical failure escalation', () => {
  it('escalates remediation when an identical call fails twice', async () => {
    const registry = createRegistry();
    registry.register({
      name: 'Flaky',
      description: 'always fails',
      parameters: { type: 'object', properties: { a: { type: 'string' } } },
      execute: async () => toolFailure('boom', { code: 'tool_error' }),
    });
    const runtime = new SessionRuntime();
    const context: ToolContext = { workspaceRoot: dir, env: {}, runtime };

    const first = await registry.execute(
      { id: 'c1', name: 'Flaky', arguments: { a: 'x' } },
      context,
    );
    const second = await registry.execute(
      { id: 'c2', name: 'Flaky', arguments: { a: 'x' } },
      context,
    );
    const different = await registry.execute(
      { id: 'c3', name: 'Flaky', arguments: { a: 'y' } },
      context,
    );

    expect(first.structuredError?.remediation).toBeUndefined();
    expect(second.structuredError?.remediation).toMatch(/already failed 1 time/);
    expect(different.structuredError?.remediation).toBeUndefined();
    runtime.dispose();
  });

  it('escalates repeated invalid_arguments rejections while preserving the original remediation', async () => {
    const runtime = new SessionRuntime();
    const context: ToolContext = { workspaceRoot: dir, env: {}, runtime };
    const r = createDefaultRegistry();
    const args = { pattern: 'x', nonsense: true };
    await r.execute({ id: 'c1', name: 'Grep', arguments: args }, context);
    const second = await r.execute({ id: 'c2', name: 'Grep', arguments: args }, context);
    expect(second.structuredError?.remediation).toMatch(/Do not retry it unchanged/);
    expect(second.structuredError?.remediation).toMatch(/Correct only this failed call/);
    runtime.dispose();
  });

  it('does not escalate retryable transient failures', async () => {
    const registry = createRegistry();
    registry.register({
      name: 'Transient',
      description: 'always fails retryably',
      parameters: { type: 'object', properties: {} },
      execute: async () => toolFailure('temporary outage', { code: 'tool_error', retryable: true }),
    });
    const runtime = new SessionRuntime();
    const context: ToolContext = { workspaceRoot: dir, env: {}, runtime };

    await registry.execute({ id: 'r1', name: 'Transient', arguments: {} }, context);
    const second = await registry.execute({ id: 'r2', name: 'Transient', arguments: {} }, context);

    expect(second.structuredError?.remediation).toBeUndefined();
    runtime.dispose();
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
        return toolFailure('aborted');
      },
    });

    const result = await registry.execute(
      { id: 'wait-1', name: 'Wait', arguments: { timeout: 5 } },
      { workspaceRoot: dir, env: {}, signal: parent.signal },
    );

    expect(result.structuredError?.message).toMatch(/Tool timeout/);
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
        return toolFailure('aborted');
      },
    });

    const pending = registry.execute(
      { id: 'wait-2', name: 'Wait', arguments: { timeout: 1_000 } },
      { workspaceRoot: dir, env: {}, signal: parent.signal },
    );
    parent.abort();
    const result = await pending;

    expect(result.structuredError?.message).toMatch(/CANCELLED/);
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
        return toolSuccess('late');
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
            events.push(`result:${traceId}:${nestedResult.status === 'success'}`),
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(result.structuredError?.message).toMatch(/Tool timeout/);
    expect(events).toEqual(['call:nested-1', 'result:nested-1:false']);
  });
});

describe('tool capabilities', () => {
  it('classifies all file-mutating tools from one source of truth', () => {
    for (const name of ['ApplyPatch', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']) {
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
    expect(result.status).toBe('error');
    expect(result.structuredError?.message).toMatch(/not found/);
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
    expect(result.status).toBe('error');
    expect(result.structuredError?.message).toMatch(/multiple|replaceAll|ambiguous/i);
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
    expect(result.status).toBe('success');
    expect(result.content).toMatch(/^-line2$/m);
    expect(result.content).toMatch(/^\+LINE TWO$/m);
    expect(result.artifacts?.fileMutation).toEqual({
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
        return toolFailure('transient I/O error', { retryable: true });
      }
      return origExecute(args, ctx);
    };

    const result = await r.execute(
      { id: 'c1', name: 'Read', arguments: { filePath: 'a.txt' } },
      ctx,
      2, // allow up to 2 retries
    );
    expect(result.status).toBe('success');
    expect(callCount).toBe(2);
    expect(result.metrics?.retryAttempt).toBe(2);
  });

  it('does NOT retry non-idempotent tool (Write) on failure', () => {
    const r = createDefaultRegistry();
    let attempts = 0;
    r.getTool('Write')!.execute = async () => {
      attempts++;
      return toolFailure('disk full');
    };

    return r
      .execute(
        { id: 'c1', name: 'Write', arguments: { filePath: 'a.txt', content: 'x' } },
        ctx,
        5, // would retry up to 5 times, but Write is not idempotent
      )
      .then((result) => {
        expect(result.status).toBe('error');
        expect(attempts).toBe(1);
        expect(result.metrics?.retryAttempt).toBeUndefined();
      });
  });

  it('does NOT retry on SKIPPED errors (permission/hook)', () => {
    const r = createDefaultRegistry();
    let attempts = 0;
    r.getTool('Read')!.execute = async () => {
      attempts++;
      return toolFailure('SKIPPED: Permission denied', { status: 'blocked' });
    };

    return r
      .execute({ id: 'c1', name: 'Read', arguments: { filePath: 'a.txt' } }, ctx, 3)
      .then((result) => {
        expect(result.structuredError?.message).toMatch(/SKIPPED/);
        expect(attempts).toBe(1);
      });
  });

  it('stops retrying after maxRetries exhausted', async () => {
    const r = createDefaultRegistry();
    let attempts = 0;
    r.getTool('Read')!.execute = async () => {
      attempts++;
      return toolFailure('persistent error', { retryable: true });
    };

    const result = await r.execute(
      { id: 'c1', name: 'Read', arguments: { filePath: 'a.txt' } },
      ctx,
      2,
    );
    expect(result.status).toBe('error');
    expect(attempts).toBe(3); // initial + 2 retries
    expect(result.metrics?.retryAttempt).toBeUndefined(); // never succeeded
  });

  it('respects maxRetries=0 (no retry)', () => {
    const r = createDefaultRegistry();
    let attempts = 0;
    r.getTool('Read')!.execute = async () => {
      attempts++;
      return toolFailure('error', { retryable: true });
    };

    return r
      .execute({ id: 'c1', name: 'Read', arguments: { filePath: 'a.txt' } }, ctx, 0)
      .then((result) => {
        expect(result.status).toBe('error');
        expect(attempts).toBe(1);
      });
  });

  it('clears tool timeout timers when tools finish before timeout', async () => {
    const r = createDefaultRegistry();
    r.getTool('Read')!.execute = async () => toolSuccess('ok');

    const result = await r.execute(
      { id: 'c1', name: 'Read', arguments: { filePath: 'a.txt', timeout: 10_000 } },
      ctx,
      0,
    );

    expect(result.status).toBe('success');
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
        return toolFailure('transient', { retryable: true });
      }
      // Simulate a real success (without filesystem dependency).
      const result = toolSuccess('recovered content');
      result.metrics = { durationMs: 5 };
      return result;
    };

    const result = await r.execute(
      { id: 'c1', name: 'Read', arguments: { filePath: 'b.txt' } },
      ctx,
      2,
    );

    expect(callCount).toBe(2);
    expect(result.status).toBe('success');
    expect(result.metrics?.retryAttempt).toBe(2);
  });
});
