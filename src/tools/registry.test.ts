import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDefaultRegistry, createRegistry } from './registry.js';
import { isFileMutatingTool } from './tool-capabilities.js';
import { SessionRuntime } from '../session/runtime.js';
import type { ToolContext } from '../types/tools.js';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { toolFailure, toolResultModelContent, toolSuccess } from './result.js';
import { MAX_SAFE_TIMEOUT_MS } from './timeouts.js';

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

describe('invalid JSON tool-call arguments', () => {
  // The provider clients wrap arguments that are not valid JSON as `{ __raw: <text> }`.
  const backslash = String.fromCharCode(92);
  const badEscape = `{"filePath":"src/a.ts","oldString":"const re = /${backslash}d+/;","newString":"x"}`;

  function editLikeRegistry() {
    const execute = vi.fn(async () => toolSuccess('ok'));
    const registry = createRegistry();
    registry.register({
      name: 'Edit',
      description: 'edit a file',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          oldString: { type: 'string' },
          newString: { type: 'string' },
        },
        required: ['filePath', 'oldString', 'newString'],
      },
      execute,
    });
    return { registry, execute };
  }

  it('names the parse error and its position instead of the schema errors', async () => {
    const { registry, execute } = editLikeRegistry();
    let parseError = '';
    try {
      JSON.parse(badEscape);
    } catch (error) {
      parseError = (error as Error).message;
    }

    const result = await registry.execute(
      { id: 'raw-1', name: 'Edit', arguments: { __raw: badEscape } },
      ctx,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.status).toBe('error');
    expect(result.structuredError?.code).toBe('invalid_json_arguments');
    expect(result.structuredError?.retryable).toBe(false);
    const message = result.structuredError?.message ?? '';
    expect(message).toContain('Invalid JSON arguments for Edit: ');
    expect(parseError).not.toBe('');
    expect(message).toContain(parseError);
    expect(message).toMatch(/position \d+/);
    const modelText = toolResultModelContent(result);
    expect(modelText).toContain('ERROR [invalid_json_arguments]');
    expect(modelText).toContain('Resend the whole call with valid JSON');
    expect(modelText).toContain('escape backslashes and newlines inside strings');
    for (const schemaText of ['is required', 'is not allowed', 'Allowed arguments', '__raw']) {
      expect(modelText).not.toContain(schemaText);
    }
  });

  it('gives the offset when the text stops mid-value', async () => {
    const { registry } = editLikeRegistry();
    const truncated = '{"filePath":"src/a.ts","oldString":';

    const result = await registry.execute(
      { id: 'raw-2', name: 'Edit', arguments: { __raw: truncated } },
      ctx,
    );

    expect(result.structuredError?.code).toBe('invalid_json_arguments');
    expect(result.structuredError?.message).toContain(`at position ${truncated.length}`);
  });

  it('folds control characters and whitespace in the quoted text to single spaces', async () => {
    const { registry } = editLikeRegistry();
    const tab = String.fromCharCode(9);

    const result = await registry.execute(
      {
        id: 'raw-3',
        name: 'Edit',
        arguments: { __raw: `{"filePath":${tab}src/a.ts,\n"oldString": 1}` },
      },
      ctx,
    );

    expect(result.structuredError?.code).toBe('invalid_json_arguments');
    expect(result.structuredError?.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('leaves a literal __raw argument to the schema', async () => {
    const { registry } = editLikeRegistry();

    const parsed = await registry.execute(
      { id: 'raw-4', name: 'Edit', arguments: { __raw: '{"filePath":"a.ts"}' } },
      ctx,
    );
    const withSiblings = await registry.execute(
      { id: 'raw-5', name: 'Edit', arguments: { __raw: 'not json', filePath: 'a.ts' } },
      ctx,
    );

    expect(parsed.structuredError?.code).toBe('invalid_arguments');
    expect(withSiblings.structuredError?.code).toBe('invalid_arguments');
  });

  it('escalates an identical resend of the same malformed text', async () => {
    const { registry } = editLikeRegistry();
    const runtime = new SessionRuntime();
    const context: ToolContext = { workspaceRoot: dir, env: {}, runtime };

    await registry.execute({ id: 'raw-6', name: 'Edit', arguments: { __raw: badEscape } }, context);
    const second = await registry.execute(
      { id: 'raw-7', name: 'Edit', arguments: { __raw: badEscape } },
      context,
    );

    expect(second.structuredError?.code).toBe('invalid_json_arguments');
    expect(second.structuredError?.remediation).toMatch(/Resend the whole call/);
    expect(second.structuredError?.remediation).toMatch(/Do not retry it unchanged/);
    runtime.dispose();
  });

  it('works with a discovery object that has no isActive, keeping its refusals', async () => {
    const { registry } = editLikeRegistry();
    // An SDK caller's own discovery object, written before `isActive` existed.
    const legacyDiscovery = (allowed: boolean): ToolContext['toolDiscovery'] => ({
      search: () => [],
      activate: () => [],
      restrict: () => {},
      pushRestriction: () => () => {},
      previewRestriction: () => [],
      canExecute: () => allowed,
      activeDefinitions: () => [],
      catalogSummary: () => '',
    });

    const allowed = await registry.execute(
      { id: 'legacy-1', name: 'Edit', arguments: { __raw: badEscape } },
      { ...ctx, toolDiscovery: legacyDiscovery(true) },
    );
    const refused = await registry.execute(
      { id: 'legacy-2', name: 'Edit', arguments: { __raw: badEscape } },
      { ...ctx, toolDiscovery: legacyDiscovery(false) },
    );

    expect(allowed.structuredError?.code).toBe('invalid_json_arguments');
    expect(refused.status).toBe('blocked');
    expect(refused.structuredError?.code).toBe('tool_not_active');
  });

  it('tells a call whose first fragment never arrived to resend unchanged', async () => {
    // 9router's cmc/stealth route drops the opening `{"filePath": ` on the wire
    // (#260). The model's JSON was fine, so "escape backslashes" is the wrong
    // advice and only makes it resend a mangled call again.
    const { registry, execute } = editLikeRegistry();
    const dropped = '/tools/file.ts", "oldString": "a", "newString": "b"}';

    const result = await registry.execute(
      { id: 'cut-start', name: 'Edit', arguments: { __raw: dropped } },
      ctx,
    );

    expect(execute).not.toHaveBeenCalled();
    expect(result.structuredError?.code).toBe('invalid_json_arguments');
    const message = result.structuredError?.message ?? '';
    expect(message).toContain('truncated at the start');
    expect(message).toContain('"/tools/file.ts');
    expect(result.structuredError?.details?.shape).toBe('truncated_start');
    const remediation = result.structuredError?.remediation ?? '';
    expect(remediation).toContain('dropped the first fragment');
    expect(remediation).toContain('Resend the whole call');
    expect(remediation).not.toContain('escape backslashes');
  });

  it('reads leading whitespace before the object as cut off at the end, not the start', async () => {
    const { registry } = editLikeRegistry();

    const result = await registry.execute(
      { id: 'ws-start', name: 'Edit', arguments: { __raw: '  {"filePath": "a"' } },
      ctx,
    );

    expect(result.structuredError?.details?.shape).toBe('truncated_end');
    expect(result.structuredError?.message).toContain('The text ends');
  });

  it('names two objects concatenated into one call', async () => {
    const { registry } = editLikeRegistry();

    const result = await registry.execute(
      {
        id: 'two-objects',
        name: 'Edit',
        arguments: { __raw: '{"filePath":"a"}{"oldString":"b"}' },
      },
      ctx,
    );

    expect(result.structuredError?.details?.shape).toBe('concatenated');
    expect(result.structuredError?.remediation).toContain('one JSON object per call');
  });

  it('names single-quoted keys, which JSON does not have', async () => {
    const { registry } = editLikeRegistry();

    const result = await registry.execute(
      { id: 'single-quotes', name: 'Edit', arguments: { __raw: "{'filePath': 'a'}" } },
      ctx,
    );

    expect(result.structuredError?.details?.shape).toBe('single_quoted');
    expect(result.structuredError?.remediation).toContain('double quotes');
  });

  it('quotes the text on both sides of the position, which the model cannot otherwise find', async () => {
    const { registry } = editLikeRegistry();

    const result = await registry.execute(
      { id: 'around', name: 'Edit', arguments: { __raw: badEscape } },
      ctx,
    );

    const message = result.structuredError?.message ?? '';
    expect(message).toContain('The text before position');
    expect(message).toContain('and the text from it starts');
    // The raw text is never shown to the model again as such — its replayed call is
    // `JSON.stringify({__raw})` — so the position only means something with the text
    // quoted around it. The model's own backslash is JSON-escaped, not folded away.
    const position = Number(/at position (\d+)/.exec(message)?.[1]);
    expect(position).toBeGreaterThan(0);
    expect(message).toContain(
      JSON.stringify(badEscape.slice(Math.max(0, position - 30), position)),
    );
    expect(message).toContain(JSON.stringify(badEscape.slice(position, position + 30)));
    expect(message).toContain(backslash + backslash);
    expect(message).toContain('d+/');
  });

  it('shows an invisible offending character as an escape rather than folding it away', async () => {
    const { registry } = editLikeRegistry();
    const nul = String.fromCharCode(0);

    const result = await registry.execute(
      { id: 'nul', name: 'Edit', arguments: { __raw: `{"filePath": "a", ${nul}}` } },
      ctx,
    );

    const message = result.structuredError?.message ?? '';
    // V8 reports `Expected double-quoted property name … at position 18` and shows no
    // character, so the quoted text around the position is the only place the NUL is
    // visible — folded to a space it would read as ordinary JSON.
    expect(message).toContain([backslash, 'u0000'].join(''));
    expect(message).not.toContain(nul);
  });
});

describe('rejectUnparsedArguments', () => {
  function editLikeRegistry() {
    const execute = vi.fn(async () => toolSuccess('ok'));
    const registry = createRegistry();
    registry.register({
      name: 'Edit',
      description: 'edit a file',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          oldString: { type: 'string' },
          newString: { type: 'string' },
        },
        required: ['filePath', 'oldString', 'newString'],
      },
      execute,
    });
    return { registry, execute };
  }

  const badEscape = `{"filePath":"src/a.ts","oldString":"const re = /${String.fromCharCode(92)}d+/;","newString":"x"}`;

  it('says nothing for arguments that parsed or for a tool it does not know', () => {
    const { registry } = editLikeRegistry();

    expect(
      registry.rejectUnparsedArguments(
        { id: 'ok-1', name: 'Edit', arguments: { filePath: 'a.ts' } },
        ctx,
      ),
    ).toBeUndefined();
    expect(
      registry.rejectUnparsedArguments(
        { id: 'ok-2', name: 'Edit', arguments: { __raw: '{"filePath":"a.ts"}' } },
        ctx,
      ),
    ).toBeUndefined();
    expect(
      registry.rejectUnparsedArguments(
        { id: 'ok-3', name: 'NoSuchTool', arguments: { __raw: badEscape } },
        ctx,
      ),
    ).toBeUndefined();
  });

  it('returns the invalid-JSON rejection the registry would have produced', () => {
    const { registry, execute } = editLikeRegistry();

    const result = registry.rejectUnparsedArguments(
      { id: 'unparsed-1', name: 'Edit', arguments: { __raw: badEscape } },
      ctx,
    );

    expect(result?.structuredError?.code).toBe('invalid_json_arguments');
    expect(result?.structuredError?.details?.shape).toBe('syntax');
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses an inactive tool as inactive, before the JSON verdict', () => {
    const { registry } = editLikeRegistry();
    const inactiveDiscovery: ToolContext['toolDiscovery'] = {
      search: () => [],
      activate: () => [],
      restrict: () => {},
      pushRestriction: () => () => {},
      previewRestriction: () => [],
      isActive: () => false,
      canExecute: () => true,
      activeDefinitions: () => [],
      catalogSummary: () => '',
    };

    const result = registry.rejectUnparsedArguments(
      { id: 'unparsed-2', name: 'Edit', arguments: { __raw: badEscape } },
      { ...ctx, toolDiscovery: inactiveDiscovery },
    );

    expect(result?.status).toBe('blocked');
    expect(result?.structuredError?.code).toBe('tool_not_active');
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

  it('escalates a repeated identical refusal from the tool itself', async () => {
    // A refusal the tool returns, such as the web network policy's, is final: the registry never
    // retries it. A model that re-issues it unchanged must still be told so, as for an error.
    const registry = createRegistry();
    registry.register({
      name: 'Refuser',
      description: 'always refused by policy',
      parameters: { type: 'object', properties: { url: { type: 'string' } } },
      execute: async () =>
        toolFailure('Web fetch blocked for private or special-use address: 10.0.0.1', {
          code: 'private_network_forbidden',
          status: 'blocked',
          retryable: false,
        }),
    });
    const runtime = new SessionRuntime();
    const context: ToolContext = { workspaceRoot: dir, env: {}, runtime };
    const args = { url: 'https://10.0.0.1/' };

    const first = await registry.execute({ id: 'b1', name: 'Refuser', arguments: args }, context);
    const second = await registry.execute({ id: 'b2', name: 'Refuser', arguments: args }, context);

    expect(first.status).toBe('blocked');
    expect(first.structuredError?.remediation).toBeUndefined();
    expect(second.status).toBe('blocked');
    expect(second.structuredError?.remediation).toMatch(/Do not retry it unchanged/);
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

    // The deadline comes from the operator override rather than a `timeout`
    // argument: only a tool that publishes `timeout` lets a caller set the
    // budget that way, and this double does not.
    const result = await registry.execute(
      { id: 'wait-1', name: 'Wait', arguments: {} },
      {
        workspaceRoot: dir,
        env: { BOOK_TOOL_TIMEOUT_MS: '5' },
        signal: parent.signal,
      },
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
      { id: 'parent', name: 'NestedWait', arguments: {} },
      {
        workspaceRoot: dir,
        env: { BOOK_TOOL_TIMEOUT_MS: '5' },
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

describe('timeout backstop', () => {
  it('never schedules a backstop past the timer limit', () => {
    const registry = createDefaultRegistry();
    for (const context of [
      { workspaceRoot: process.cwd(), env: { BOOK_TOOL_TIMEOUT_MS: '3000000000' } },
      {
        workspaceRoot: process.cwd(),
        env: {},
        agentConfig: { settings: { agents: { taskTimeoutMs: 3_000_000_000 } } },
      },
    ]) {
      const prepared = registry.prepare(
        { id: 'task-1', name: 'Task', arguments: { agent: 'explorer', prompt: 'x' } },
        context as unknown as ToolContext,
      );
      expect(prepared.status).toBe('ready');
      if (prepared.status === 'ready') {
        expect(prepared.prepared.timeoutMs).toBeLessThanOrEqual(MAX_SAFE_TIMEOUT_MS);
      }
    }
  });
});
