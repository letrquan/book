import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { runAgentLoop } from './loop.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { defaultConfig } from '../test/fixtures.js';
import { isolateBookHome } from '../test/isolated-book-home.js';
import { SessionRuntime } from '../session/runtime.js';
import type { AgentConfig } from '../types/runtime.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type { PermissionDecision, ToolResult } from '../types/tools.js';
import type { Provider } from '../provider/index.js';
import type { LoadedMemoryContext } from '../memory-store.js';
import { memoryConsolidateTools } from '../commands/builtins-prompts.js';

function noopCallbacks(overrides: Partial<AgentLoopCallbacks> = {}): AgentLoopCallbacks {
  return {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onError: () => {},
    onTurnStart: () => {},
    onDone: () => {},
    onPermissionRequired: async () => 'allow' as const,
    ...overrides,
  };
}

const noApprover = async (): Promise<PermissionDecision> => ({
  result: 'deny',
  reason: 'no_approver',
});

type ScriptedCall = { id: string; name: string; arguments: Record<string, unknown> };

function writeLoopSkill(workspace: string, name: string): void {
  const root = join(workspace, '.book', 'skills', name);
  mkdirSync(root, { recursive: true });
  writeFileSync(
    join(root, 'SKILL.md'),
    ['---', `name: ${name}`, `description: Use the ${name} workflow`, '---', 'Follow it.'].join(
      '\n',
    ),
  );
}

/** Turn 1 makes the given tool calls; every later turn answers with text. */
function toolsThenText(calls: ScriptedCall[]): Provider {
  let turn = 0;
  return {
    id: 'scripted',
    stream: async function* () {
      turn++;
      if (turn === 1) {
        for (const toolCall of calls) yield { type: 'tool_call' as const, toolCall };
      } else {
        yield { type: 'text' as const, content: 'done' };
      }
      yield { type: 'done' as const };
    },
  };
}

let dirs: string[] = [];
let workspace: string;
let outside: string;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

// The loop reads and writes user-global state under BOOK_HOME; keep it off the real one.
isolateBookHome('book-loop-perm-home-');

beforeEach(() => {
  workspace = tempDir('book-loop-reads-');
  outside = tempDir('book-loop-reads-out-');
  writeFileSync(join(workspace, 'notes.txt'), 'hello from notes\n');
  writeFileSync(join(outside, 'secret.txt'), 'secret\n');
});

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function byId(results: ToolResult[], id: string): ToolResult | undefined {
  return results.find((result) => result.toolCallId === id);
}

/** The loop turns a memory context into a read-only root and a Glob/Grep search root. */
function loadedMemory(dir: string): LoadedMemoryContext {
  return {
    dir,
    indexFile: join(dir, 'MEMORY.md'),
    indexLoaded: false,
    indexLineCount: 0,
    loadedLineCount: 0,
    indexByteCount: 0,
    wasLineTruncated: false,
    wasByteTruncated: false,
    indexText: '',
    files: [],
  };
}

describe('runAgentLoop workspace reads (#264)', () => {
  for (const mode of ['default', 'accept-edits'] as const) {
    it(`runs Read, Glob and Grep inside the workspace without a prompt in ${mode}`, async () => {
      const prompt = vi.fn(async () => 'deny' as const);
      const results: ToolResult[] = [];
      await runAgentLoop(
        defaultConfig({ workspace, maxTurns: 2 }),
        createDefaultRegistry(),
        'look around',
        [],
        noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
        mode,
        {
          provider: toolsThenText([
            { id: 'r1', name: 'Read', arguments: { filePath: 'notes.txt' } },
            { id: 'g1', name: 'Glob', arguments: { pattern: '*.txt' } },
            { id: 'g2', name: 'Grep', arguments: { pattern: 'hello' } },
          ]),
          isNewSession: false,
        },
      );
      expect(prompt).not.toHaveBeenCalled();
      expect(results).toHaveLength(3);
      expect(results.every((result) => result.status === 'success')).toBe(true);
      expect(byId(results, 'r1')?.content).toContain('hello from notes');
    });
  }

  it('refuses a read outside the workspace without asking, in every judging mode', async () => {
    // #305 item 3. Before this, an outside Read raised a prompt nobody could satisfy: the tool
    // would answer `path_outside_workspace` whatever the user said, and an "Always allow" would
    // have written a rule for a call that could never run.
    for (const mode of ['default', 'accept-edits', 'plan'] as const) {
      const prompt = vi.fn(async () => 'allow' as const);
      const results: ToolResult[] = [];
      await runAgentLoop(
        defaultConfig({ workspace, maxTurns: 2 }),
        createDefaultRegistry(),
        'read it',
        [],
        noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
        mode,
        {
          provider: toolsThenText([
            { id: 'r1', name: 'Read', arguments: { filePath: join(outside, 'secret.txt') } },
          ]),
          isNewSession: false,
        },
      );
      const result = byId(results, 'r1');
      expect(prompt, `mode ${mode}`).not.toHaveBeenCalled();
      expect(result?.status, `mode ${mode}`).toBe('blocked');
      // Named by the code the streak remedy classifies as `outside`, not by prose.
      expect(result?.structuredError?.code).toBe('path_outside_workspace');
      expect(result?.content).toContain('additionalDirectories');
    }
  });

  it('refuses a pattern the matcher cannot read as a pattern, and never asks', async () => {
    // The refusal used to be the outside-workspace one, so the model was sent after a directory:
    // "add its directory to additionalDirectories" for a pattern that is not about a directory at
    // all, with nothing the user could say that would make the walk happen.
    const prompt = vi.fn(async () => 'allow' as const);
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2 }),
      createDefaultRegistry(),
      'find them',
      [],
      noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
      'default',
      {
        provider: toolsThenText([
          {
            id: 'g1',
            name: 'Glob',
            arguments: { pattern: '!('.repeat(2500) + ')'.repeat(2500) },
          },
        ]),
        isNewSession: false,
      },
    );
    const result = byId(results, 'g1');
    expect(prompt).not.toHaveBeenCalled();
    expect(result?.status).toBe('blocked');
    expect(result?.structuredError?.code).toBe('pattern_unreadable');
    // The message reaches the model with the reason it can act on, and names no directory to add.
    expect(result?.content).toContain('The matcher cannot read the pattern');
    expect(result?.content).not.toMatch(/^Add /m);
  });

  it("keeps asking in a workspace that holds Book's own home", async () => {
    process.env.BOOK_HOME = join(workspace, '.book-home');
    mkdirSync(process.env.BOOK_HOME);
    const prompt = vi.fn(async () => 'allow' as const);
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2 }),
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({ onPermissionRequired: prompt }),
      'default',
      {
        provider: toolsThenText([{ id: 'r1', name: 'Read', arguments: { filePath: 'notes.txt' } }]),
        isNewSession: false,
      },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('keeps asking in a workspace that holds the home directory, wherever BOOK_HOME points', async () => {
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    // os.homedir() reads HOME (POSIX) or USERPROFILE (Windows) on every call.
    process.env.HOME = workspace;
    process.env.USERPROFILE = workspace;
    try {
      const prompt = vi.fn(async () => 'allow' as const);
      await runAgentLoop(
        defaultConfig({ workspace, maxTurns: 2 }),
        createDefaultRegistry(),
        'read it',
        [],
        noopCallbacks({ onPermissionRequired: prompt }),
        'default',
        {
          provider: toolsThenText([
            { id: 'r1', name: 'Read', arguments: { filePath: 'notes.txt' } },
          ]),
          isNewSession: false,
        },
      );
      expect(prompt).toHaveBeenCalledTimes(1);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('keeps asking when the workspace reaches the home directory through a link', async () => {
    const home = tempDir('book-loop-home-real-');
    writeFileSync(join(home, 'notes.txt'), 'home notes\n');
    const linked = join(tempDir('book-loop-home-link-'), 'ws');
    // A junction needs no symlink privilege on Windows; elsewhere the type is ignored.
    symlinkSync(home, linked, 'junction');
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      const prompt = vi.fn(async () => 'allow' as const);
      await runAgentLoop(
        defaultConfig({ workspace: linked, maxTurns: 2 }),
        createDefaultRegistry(),
        'read it',
        [],
        noopCallbacks({ onPermissionRequired: prompt }),
        'default',
        {
          provider: toolsThenText([
            { id: 'r1', name: 'Read', arguments: { filePath: 'notes.txt' } },
          ]),
          isNewSession: false,
        },
      );
      expect(prompt).toHaveBeenCalledTimes(1);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('lets a Read whose arguments were not valid JSON reach the tool, which names the problem', async () => {
    const notices: string[] = [];
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2 }),
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({
        onPermissionRequired: noApprover,
        onToolResult: (r) => results.push(r),
        onNotice: (notice) => notices.push(notice),
      }),
      'default',
      {
        provider: toolsThenText([
          { id: 'r1', name: 'Read', arguments: { __raw: '{"filePath": "a.tx' } },
        ]),
        isNewSession: false,
      },
    );
    expect(byId(results, 'r1')?.structuredError?.code).toBe('invalid_json_arguments');
    expect(notices.filter((notice) => notice.includes('needs approval'))).toHaveLength(0);
  });

  it('names an outside target as unreachable even where reads keep asking', async () => {
    process.env.BOOK_HOME = join(workspace, '.book-home');
    mkdirSync(process.env.BOOK_HOME);
    const notices: string[] = [];
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2 }),
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({
        onPermissionRequired: noApprover,
        onToolResult: (r) => results.push(r),
        onNotice: (notice) => notices.push(notice),
      }),
      'default',
      {
        provider: toolsThenText([
          { id: 'r1', name: 'Read', arguments: { filePath: join(outside, 'secret.txt') } },
        ]),
        isNewSession: false,
      },
    );
    expect(byId(results, 'r1')?.content).toContain('outside the workspace');
    expect(notices.filter((notice) => notice.includes('needs approval'))).toHaveLength(0);
    // #305 item 3: the approver is not even consulted, because nothing it could answer would
    // have let the read happen.
    expect(byId(results, 'r1')?.structuredError?.code).toBe('path_outside_workspace');
  });

  it('says a prompt nobody answered was dismissed, and prints no remedy', async () => {
    const notices: string[] = [];
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2 }),
      createDefaultRegistry(),
      'run it',
      [],
      noopCallbacks({
        onPermissionRequired: async (): Promise<PermissionDecision> => ({
          result: 'deny',
          reason: 'dismissed',
        }),
        onToolResult: (r) => results.push(r),
        onNotice: (notice) => notices.push(notice),
      }),
      'default',
      {
        provider: toolsThenText([{ id: 'b1', name: 'Bash', arguments: { command: 'echo hi' } }]),
        isNewSession: false,
      },
    );
    const content = byId(results, 'b1')?.content ?? '';
    expect(content).toContain('dismissed');
    expect(content).not.toContain('The user declined');
    expect(notices.filter((notice) => notice.includes('needs approval'))).toHaveLength(0);
  });

  it('names the allow rule when an explicitly requested skill needs consent nobody can give', async () => {
    writeLoopSkill(workspace, 'review');
    const config = defaultConfig({ workspace, maxTurns: 1 });
    config.settings.skills.execution.review = 'ask';
    let requestText = '';
    const provider: Provider = {
      id: 'scripted',
      stream: async function* (_config, messages) {
        requestText = JSON.stringify(messages);
        yield { type: 'text' as const, content: 'done' };
        yield { type: 'done' as const };
      },
    };
    const notices: string[] = [];
    await runAgentLoop(
      config,
      createDefaultRegistry(),
      '$review inspect this change',
      [],
      noopCallbacks({
        onPermissionRequired: noApprover,
        onNotice: (notice) => notices.push(notice),
      }),
      'default',
      { provider, isNewSession: false, typedText: '$review inspect this change' },
    );
    expect(requestText).toContain('nothing in this run can answer');
    const refusals = notices.filter((notice) => notice.includes('needs approval'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('"InvokeSkill(review)"');
    expect(refusals[0]).toContain('--permission-mode auto still asks');
  });

  it('says an explicitly requested skill went unanswered when its prompt was dismissed', async () => {
    writeLoopSkill(workspace, 'review');
    const config = defaultConfig({ workspace, maxTurns: 1 });
    config.settings.skills.execution.review = 'ask';
    let requestText = '';
    const provider: Provider = {
      id: 'scripted',
      stream: async function* (_config, messages) {
        requestText = JSON.stringify(messages);
        yield { type: 'text' as const, content: 'done' };
        yield { type: 'done' as const };
      },
    };
    await runAgentLoop(
      config,
      createDefaultRegistry(),
      '$review inspect this change',
      [],
      noopCallbacks({
        onPermissionRequired: async (): Promise<PermissionDecision> => ({
          result: 'deny',
          reason: 'dismissed',
        }),
      }),
      'default',
      { provider, isNewSession: false, typedText: '$review inspect this change' },
    );
    expect(requestText).toContain('was not answered');
    expect(requestText).not.toContain('Explicit skill activation was denied');
  });

  it('prompts for a workspace read that an ask rule covers, however the path is spelled', async () => {
    const config = defaultConfig({ workspace, maxTurns: 2 });
    config.settings.permissions.ask = ['Read(notes.txt)'];
    const prompt = vi.fn(async () => 'allow' as const);
    await runAgentLoop(
      config,
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({ onPermissionRequired: prompt }),
      'default',
      {
        provider: toolsThenText([
          { id: 'r1', name: 'Read', arguments: { filePath: join(workspace, 'notes.txt') } },
        ]),
        isNewSession: false,
      },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  for (const mode of ['default', 'auto'] as const) {
    it(`denies a deny-ruled file however the path is spelled, in ${mode}`, async () => {
      writeFileSync(join(workspace, '.env'), 'KEY=1\n');
      const config = defaultConfig({ workspace, maxTurns: 2 });
      config.settings.permissions.deny = ['Read(.env)'];
      const prompt = vi.fn(async () => 'allow' as const);
      const results: ToolResult[] = [];
      await runAgentLoop(
        config,
        createDefaultRegistry(),
        'read it',
        [],
        noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
        mode,
        {
          provider: toolsThenText([
            { id: 'r1', name: 'Read', arguments: { filePath: join(workspace, '.env') } },
          ]),
          isNewSession: false,
        },
      );
      expect(prompt).not.toHaveBeenCalled();
      expect(byId(results, 'r1')?.status).toBe('blocked');
      expect(byId(results, 'r1')?.content).toContain('Read(.env)');
      expect(byId(results, 'r1')?.content).toContain('permissions.deny');
    });
  }

  it('keeps dontAsk refusing workspace reads, and says dontAsk refused them', async () => {
    const prompt = vi.fn(async () => 'allow' as const);
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2 }),
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
      'dontAsk',
      {
        provider: toolsThenText([{ id: 'r1', name: 'Read', arguments: { filePath: 'notes.txt' } }]),
        isNewSession: false,
      },
    );
    expect(prompt).not.toHaveBeenCalled();
    const result = byId(results, 'r1');
    expect(result?.status).toBe('blocked');
    expect(result?.structuredError?.code).toBe('permission_denied');
    expect(result?.content).toContain('dontAsk');
    expect(result?.content).not.toContain('configured permission policy');
  });

  /**
   * PR #334. `dontAsk` does not change what it refuses — the owner decided a workspace read with
   * no allow rule stays refused — so only the *kind* of refusal moves. An outside target used to
   * come back as `permission_denied`, and the `all_tools_blocked` stop message for a streak of
   * those advises an allow rule, which can never make `Read` serve a path outside every root.
   * It now gets the same `path_outside_workspace` refusal, and the same remedy, as `default`.
   */
  it('refuses an outside read in dontAsk as unreachable, not as a permission it could grant', async () => {
    const prompt = vi.fn(async () => 'allow' as const);
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2 }),
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
      'dontAsk',
      {
        provider: toolsThenText([
          { id: 'r1', name: 'Read', arguments: { filePath: join(outside, 'secret.txt') } },
        ]),
        isNewSession: false,
      },
    );

    const result = byId(results, 'r1');
    expect(prompt).not.toHaveBeenCalled();
    expect(result?.status).toBe('blocked');
    // The code the streak remedy classifies as `outside`, so the stop message names a directory
    // rather than a rule. `permission_denied` would classify as `permission` and advise the rule.
    expect(result?.structuredError?.code).toBe('path_outside_workspace');
    expect(result?.content).toContain('additionalDirectories');
    expect(result?.content).not.toContain('dontAsk mode refuses every call');
  });

  it('searches the memory directory with Glob and Grep without a prompt, dot-entries left out', async () => {
    const memory = tempDir('book-loop-memory-');
    writeFileSync(join(memory, 'build.md'), 'run pnpm install\n');
    writeFileSync(join(memory, '.format'), 'run pnpm install\n');
    mkdirSync(join(memory, '.inbox'), { recursive: true });
    writeFileSync(join(memory, '.inbox', 'pending.md'), 'run pnpm install\n');
    const prompt = vi.fn(async () => 'deny' as const);
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({
        workspace,
        maxTurns: 2,
        memoryContext: loadedMemory(memory),
      }),
      createDefaultRegistry(),
      'search memory',
      [],
      noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
      'default',
      {
        provider: toolsThenText([
          { id: 'g1', name: 'Glob', arguments: { pattern: join(memory, '**', '*') } },
          { id: 'g2', name: 'Grep', arguments: { pattern: 'pnpm', path: memory } },
        ]),
        isNewSession: false,
      },
    );

    expect(prompt).not.toHaveBeenCalled();
    for (const id of ['g1', 'g2']) {
      const result = byId(results, id);
      expect(result?.status, id).toBe('success');
      expect(result?.content, id).toContain('build.md');
      expect(result?.content, id).not.toContain('.format');
      expect(result?.content, id).not.toContain('pending.md');
    }
  });

  it('refuses what nobody can approve, says why, and tells the operator once', async () => {
    const notices: string[] = [];
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2 }),
      createDefaultRegistry(),
      'run it',
      [],
      noopCallbacks({
        onPermissionRequired: noApprover,
        onToolResult: (r) => results.push(r),
        onNotice: (notice) => notices.push(notice),
      }),
      'default',
      {
        provider: toolsThenText([
          { id: 'b1', name: 'Bash', arguments: { command: 'echo one' } },
          { id: 'b2', name: 'Bash', arguments: { command: 'echo two' } },
        ]),
        isNewSession: false,
      },
    );
    expect(results.map((result) => result.status)).toEqual(['blocked', 'blocked']);
    const content = byId(results, 'b1')?.content ?? '';
    expect(content).toContain('print mode');
    expect(content).toContain('"Bash(echo one)"');
    expect(content).toContain('--permission-mode auto');
    expect(content).not.toContain('configured permission policy');
    const refusals = notices.filter((notice) => notice.includes('needs approval'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('--permission-mode auto');
  });

  it('tells the operator once per session, across the runs that share it', async () => {
    const notices: string[] = [];
    const runtime = new SessionRuntime();
    try {
      for (const command of ['echo one', 'echo two']) {
        await runAgentLoop(
          defaultConfig({ workspace, maxTurns: 2 }),
          createDefaultRegistry(),
          'run it',
          [],
          noopCallbacks({
            onPermissionRequired: noApprover,
            onNotice: (notice) => notices.push(notice),
          }),
          'default',
          {
            provider: toolsThenText([{ id: 'b1', name: 'Bash', arguments: { command } }]),
            isNewSession: false,
            runtime,
          },
        );
      }
    } finally {
      runtime.dispose();
    }
    expect(notices.filter((notice) => notice.includes('needs approval'))).toHaveLength(1);
  });

  it('points an unattended refusal under an ask rule at that rule', async () => {
    const config = defaultConfig({ workspace, maxTurns: 2 });
    config.settings.permissions.ask = ['Read(notes.txt)'];
    const notices: string[] = [];
    const results: ToolResult[] = [];
    await runAgentLoop(
      config,
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({
        onPermissionRequired: noApprover,
        onToolResult: (r) => results.push(r),
        onNotice: (notice) => notices.push(notice),
      }),
      'default',
      {
        provider: toolsThenText([{ id: 'r1', name: 'Read', arguments: { filePath: 'notes.txt' } }]),
        isNewSession: false,
      },
    );
    const content = byId(results, 'r1')?.content ?? '';
    expect(content).toContain('permissions.ask rule Read(notes.txt)');
    expect(content).not.toContain('add a permissions.allow rule');
    const refusals = notices.filter((notice) => notice.includes('needs approval'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain('permissions.ask rule Read(notes.txt)');
  });

  it('says an unattended Read outside the workspace cannot be allowed, with no notice', async () => {
    const notices: string[] = [];
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2 }),
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({
        onPermissionRequired: noApprover,
        onToolResult: (r) => results.push(r),
        onNotice: (notice) => notices.push(notice),
      }),
      'default',
      {
        provider: toolsThenText([
          { id: 'r1', name: 'Read', arguments: { filePath: join(outside, 'secret.txt') } },
        ]),
        isNewSession: false,
      },
    );
    const content = byId(results, 'r1')?.content ?? '';
    expect(byId(results, 'r1')?.status).toBe('blocked');
    expect(content).toContain('outside the workspace');
    expect(content).not.toContain('--permission-mode auto');
    expect(notices.filter((notice) => notice.includes('needs approval'))).toHaveLength(0);
  });

  it('names bypassPermissions as the only way through for a persistent background shell', async () => {
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2 }),
      createDefaultRegistry(),
      'start it',
      [],
      noopCallbacks({ onPermissionRequired: noApprover, onToolResult: (r) => results.push(r) }),
      'auto',
      {
        provider: toolsThenText([
          {
            id: 'b1',
            name: 'Bash',
            arguments: { command: 'echo hi', run_in_background: true, lifetime: 'persistent' },
          },
        ]),
        isNewSession: false,
      },
    );
    const content = byId(results, 'b1')?.content ?? '';
    expect(byId(results, 'b1')?.status).toBe('blocked');
    expect(content).toContain('--permission-mode bypassPermissions');
    expect(content).not.toContain('--permission-mode auto');
  });

  it('says the user declined when a person refused the prompt', async () => {
    // A workspace read, because that is the call that still reaches a prompt: an outside read is
    // refused before the approver is consulted (#305 item 3), so it can no longer be declined.
    const results: ToolResult[] = [];
    const config = defaultConfig({ workspace, maxTurns: 2 });
    config.settings.permissions.ask = ['Read(notes.txt)'];
    await runAgentLoop(
      config,
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({
        onPermissionRequired: async () => 'deny' as const,
        onToolResult: (r) => results.push(r),
      }),
      'default',
      {
        provider: toolsThenText([{ id: 'r1', name: 'Read', arguments: { filePath: 'notes.txt' } }]),
        isNewSession: false,
      },
    );
    const content = byId(results, 'r1')?.content ?? '';
    expect(content).toContain('The user declined');
    expect(content).not.toContain('configured permission policy');
  });
});

/**
 * #305 item 7. Plan mode exists to let a model read a lot without writing, so before this change
 * it auto-approved every read-only tool outside its small `PLAN_PERMISSION_REQUIRED_TOOLS` set.
 * A guarded Read ran with no prompt, and an outside Read reached the tool and came back
 * `path_outside_workspace` after a prompt that could not have helped. Recorded here so the
 * tightening below is measurable.
 */
describe('plan mode judges reads like default (#305)', () => {
  it('asks for a workspace read an ask rule covers', async () => {
    const prompt = vi.fn(async () => 'allow' as const);
    const config = defaultConfig({ workspace, maxTurns: 2 });
    config.settings.permissions.ask = ['Read(notes.txt)'];
    await runAgentLoop(
      config,
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({ onPermissionRequired: prompt }),
      'plan',
      {
        provider: toolsThenText([{ id: 'r1', name: 'Read', arguments: { filePath: 'notes.txt' } }]),
        isNewSession: false,
      },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('refuses an outside read, and never reaches the tool', async () => {
    const prompt = vi.fn(async () => 'allow' as const);
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2 }),
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
      'plan',
      {
        provider: toolsThenText([
          { id: 'r1', name: 'Read', arguments: { filePath: join(outside, 'secret.txt') } },
        ]),
        isNewSession: false,
      },
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(byId(results, 'r1')?.status).toBe('blocked');
    // The refusal names the remedy, so the model does not retry the same path.
    expect(byId(results, 'r1')?.content).toContain('additionalDirectories');
  });

  it('runs an unguarded workspace read without a prompt', async () => {
    const prompt = vi.fn(async () => 'deny' as const);
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2 }),
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
      'plan',
      {
        provider: toolsThenText([{ id: 'r1', name: 'Read', arguments: { filePath: 'notes.txt' } }]),
        isNewSession: false,
      },
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(byId(results, 'r1')?.status).toBe('success');
  });
});

/**
 * #300. `additionalDirectories` is the only thing that widens which paths Read, Glob and Grep may
 * open without a prompt, so each of these states is a distinct security boundary: a directory the
 * user approved is an ordinary read root, its siblings are not, a declared-but-unapproved one is
 * not, and a root holding a home directory still asks.
 */
describe('runAgentLoop reads an approved additional directory (#300)', () => {
  /**
   * The loop sees a `ResolvedSettings`, which the settings loader has already reduced to the
   * approved entries. Writing the store decision and the surviving list together keeps this test
   * on the same seam the real launcher uses: a decision that never reached the list would be
   * indistinguishable here from a permission bug.
   */
  function configHonoring(extra: string, maxTurns = 2): AgentConfig {
    const config = defaultConfig({ workspace, maxTurns });
    config.settings.additionalDirectories = [realpathSync.native(extra)];
    return config;
  }

  for (const mode of ['default', 'accept-edits', 'plan'] as const) {
    it(`reads, globs and greps inside the root without a prompt in ${mode}`, async () => {
      writeFileSync(join(outside, 'visible.txt'), 'visible from the extra root\n');
      const prompt = vi.fn(async () => 'deny' as const);
      const results: ToolResult[] = [];
      await runAgentLoop(
        configHonoring(outside),
        createDefaultRegistry(),
        'read it',
        [],
        noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
        mode,
        {
          provider: toolsThenText([
            { id: 'r1', name: 'Read', arguments: { filePath: join(outside, 'visible.txt') } },
            { id: 'g1', name: 'Glob', arguments: { pattern: '*.txt' } },
            { id: 'g2', name: 'Grep', arguments: { pattern: 'visible' } },
          ]),
          isNewSession: false,
        },
      );
      expect(prompt, `mode ${mode}`).not.toHaveBeenCalled();
      expect(byId(results, 'r1')?.status).toBe('success');
      expect(byId(results, 'r1')?.content).toContain('visible from the extra root');
    });
  }

  it('refuses a symlink that escapes an approved root, rather than serving the link target', async () => {
    // The stricter reading, chosen deliberately: approving `/opt/stuff` is a decision about that
    // directory, and a link planted inside it pointing at `~` is the shape of attack this brief
    // asks to be refused rather than guessed at. The resolved target is outside every root, so
    // the call is the outside refusal — not a prompt, because no approval could serve it.
    const linked = tempDir('book-loop-linked-');
    symlinkSync(outside, join(linked, 'into'), 'junction');
    writeFileSync(join(outside, 'visible.txt'), 'visible through the link\n');
    const prompt = vi.fn(async () => 'allow' as const);
    const results: ToolResult[] = [];
    await runAgentLoop(
      configHonoring(linked),
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
      'default',
      {
        provider: toolsThenText([
          { id: 'r1', name: 'Read', arguments: { filePath: join(linked, 'into', 'visible.txt') } },
        ]),
        isNewSession: false,
      },
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(byId(results, 'r1')?.status).toBe('blocked');
  });

  it('does not read a sibling of an approved directory, which is not a root', async () => {
    const sibling = tempDir('book-loop-sibling-');
    writeFileSync(join(sibling, 'sneaky.txt'), 'not covered\n');
    const results: ToolResult[] = [];
    await runAgentLoop(
      configHonoring(outside),
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({ onToolResult: (r) => results.push(r) }),
      'default',
      {
        provider: toolsThenText([
          { id: 'r1', name: 'Read', arguments: { filePath: join(sibling, 'sneaky.txt') } },
        ]),
        isNewSession: false,
      },
    );
    expect(byId(results, 'r1')?.status).toBe('blocked');
  });

  it('does not read a directory the settings loader withheld', async () => {
    // What the loop receives for a project-declared, unapproved directory is an empty list — the
    // gate lives in `settings-loader`, and this is the state it produces.
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2 }),
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({ onToolResult: (r) => results.push(r) }),
      'default',
      {
        provider: toolsThenText([
          { id: 'r1', name: 'Read', arguments: { filePath: join(outside, 'secret.txt') } },
        ]),
        isNewSession: false,
      },
    );
    expect(byId(results, 'r1')?.status).toBe('blocked');
  });

  /**
   * A directory holding a home directory is a root the user may approve and still get asked about:
   * a home holds SSH keys, provider keys, and Book's own trust store. Approving it must not
   * become a standing key to everything under it.
   */
  it('still asks for a read under a root that holds BOOK_HOME', async () => {
    const realHome = tempDir('book-loop-roothome-');
    const previousHome = process.env.BOOK_HOME;
    process.env.BOOK_HOME = realHome;
    try {
      writeFileSync(join(realHome, 'id_rsa'), 'PRIVATE KEY\n');
      const prompt = vi.fn(async () => 'allow' as const);
      const results: ToolResult[] = [];
      await runAgentLoop(
        configHonoring(realHome),
        createDefaultRegistry(),
        'read it',
        [],
        noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
        'default',
        {
          provider: toolsThenText([
            { id: 'r1', name: 'Read', arguments: { filePath: join(realHome, 'id_rsa') } },
          ]),
          isNewSession: false,
        },
      );
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(byId(results, 'r1')?.content).toContain('PRIVATE KEY');
    } finally {
      process.env.BOOK_HOME = previousHome;
    }
  });

  it('still asks for a read under a root that holds the home directory, wherever HOME points', async () => {
    const realHome = tempDir('book-loop-roothome2-');
    writeFileSync(join(realHome, 'id_rsa'), 'PRIVATE KEY\n');
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = realHome;
    process.env.USERPROFILE = realHome;
    try {
      const prompt = vi.fn(async () => 'allow' as const);
      await runAgentLoop(
        configHonoring(realHome),
        createDefaultRegistry(),
        'read it',
        [],
        noopCallbacks({ onPermissionRequired: prompt }),
        'default',
        {
          provider: toolsThenText([
            { id: 'r1', name: 'Read', arguments: { filePath: join(realHome, 'id_rsa') } },
          ]),
          isNewSession: false,
        },
      );
      expect(prompt).toHaveBeenCalledTimes(1);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('prompts for a guarded read in plan mode, as it does in default (PR #334 finding 5)', async () => {
    // Decision C said plan mode would judge reads the way `default` does. The verdict did: these
    // targets come back `ask`. The prompt did not, because `planAutoApproved` skipped the whole
    // permission block for any read-only tool outside `PLAN_PERMISSION_REQUIRED_TOOLS`, so a
    // guarded Read ran inside a plan with nobody asked. The guarded cases, not just an ask rule.
    const results: ToolResult[] = [];
    const prompt = vi.fn(async () => 'allow' as const);
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2 }),
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
      'plan',
      {
        provider: toolsThenText([
          {
            id: 'r1',
            name: 'Read',
            arguments: { filePath: join(workspace, '.book', 'settings.local.json') },
          },
        ]),
        isNewSession: false,
      },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('does not treat ExitPlanMode as a guarded read in plan mode (PR #334 finding 5)', async () => {
    // The regression a first pass at finding 5 walked into. `ExitPlanMode` is in
    // `READ_ONLY_PLAN_TOOLS` and its verdict is `ask`, so keying the new guard on the verdict
    // alone prompted for it — and with no approver a prompt is "stop with the plan", which the
    // loop already implements, so one turn became five ExitPlanMode retries. Only the tools that
    // read the filesystem are guarded reads.
    writeFileSync(join(workspace, 'notes.txt'), 'plan me\n');
    const prompt = vi.fn(async () => 'deny' as const);
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 3 }),
      createDefaultRegistry(),
      'plan it',
      [],
      noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
      'plan',
      {
        provider: toolsThenText([{ id: 'r1', name: 'Read', arguments: { filePath: 'notes.txt' } }]),
        isNewSession: false,
      },
    );
    // The guarded-read prompt did not leak onto a tool that merely returns `ask`; an ordinary
    // workspace read still runs unprompted, and the run ends on the text turn rather than
    // retrying.
    expect(prompt).not.toHaveBeenCalled();
    expect(byId(results, 'r1')?.status).toBe('success');
  });

  it('still runs an unguarded workspace read in plan mode without a prompt', async () => {
    // The other half of decision C, and the reason the fix keys on the verdict rather than on
    // the tool: a plan is written by reading, so an ordinary workspace read must not prompt.
    writeFileSync(join(workspace, 'notes.txt'), 'plan me\n');
    const prompt = vi.fn(async () => 'deny' as const);
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2 }),
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
      'plan',
      {
        provider: toolsThenText([{ id: 'r1', name: 'Read', arguments: { filePath: 'notes.txt' } }]),
        isNewSession: false,
      },
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(byId(results, 'r1')?.status).toBe('success');
  });

  it('still asks for a local settings file under an approved root', async () => {
    // Every root Book serves carries its own `.book/settings.local.json`, and a local one can hold
    // an API key exactly as the workspace's does.
    const root = tempDir('book-loop-localsettings-');
    mkdirSync(join(root, '.book'), { recursive: true });
    writeFileSync(join(root, '.book', 'settings.local.json'), '{"apiKey":"sk-secret"}');
    const prompt = vi.fn(async () => 'allow' as const);
    const results: ToolResult[] = [];
    await runAgentLoop(
      configHonoring(root),
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
      'default',
      {
        provider: toolsThenText([
          {
            id: 'r1',
            name: 'Read',
            arguments: { filePath: join(root, '.book', 'settings.local.json') },
          },
        ]),
        isNewSession: false,
      },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it('writes into an approved directory, the way it writes into the workspace', async () => {
    // An approved directory is a root for the write tools too, so the write goes through the
    // ordinary permission flow for its mode: `default` prompts, and the file only appears once
    // the operator has agreed. Owner decision A — the alternative (reads only) is a deviation.
    const results: ToolResult[] = [];
    const prompt = vi.fn(async () => 'deny' as const);
    await runAgentLoop(
      configHonoring(outside),
      createDefaultRegistry(),
      'write it',
      [],
      noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
      'default',
      {
        provider: toolsThenText([
          {
            id: 'w1',
            name: 'Write',
            arguments: { filePath: join(outside, 'planted.txt'), content: 'planted\n' },
          },
        ]),
        isNewSession: false,
      },
    );
    // Reached the prompt, rather than being refused as outside or silently written: the tool
    // served the path, so the mode decided.
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(existsSync(join(outside, 'planted.txt'))).toBe(false);
  });

  it('writes into an approved directory in accept-edits without a prompt', async () => {
    // The parity that decision A asks for: the same write into the workspace is auto-approved in
    // this mode, so the one into an approved directory is too.
    const results: ToolResult[] = [];
    const prompt = vi.fn(async () => 'deny' as const);
    await runAgentLoop(
      configHonoring(outside),
      createDefaultRegistry(),
      'write it',
      [],
      noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
      'accept-edits',
      {
        provider: toolsThenText([
          {
            id: 'w1',
            name: 'Write',
            arguments: { filePath: join(outside, 'planted.txt'), content: 'planted\n' },
          },
        ]),
        isNewSession: false,
      },
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(byId(results, 'w1')?.status).toBe('success');
    expect(existsSync(join(outside, 'planted.txt'))).toBe(true);
  });

  it('still refuses a write into a directory that is not approved', async () => {
    // The root is what made the call above legal, and it is still the whole of the permission.
    const results: ToolResult[] = [];
    const prompt = vi.fn(async () => 'allow' as const);
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2 }),
      createDefaultRegistry(),
      'write it',
      [],
      noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
      'accept-edits',
      {
        provider: toolsThenText([
          {
            id: 'w1',
            name: 'Write',
            arguments: { filePath: join(outside, 'planted.txt'), content: 'planted\n' },
          },
        ]),
        isNewSession: false,
      },
    );
    // Not even a prompt: no mode can make a write tool serve a path no root contains.
    expect(prompt).not.toHaveBeenCalled();
    expect(byId(results, 'w1')?.structuredError?.code).toBe('path_outside_workspace');
    expect(existsSync(join(outside, 'planted.txt'))).toBe(false);
  });
});

describe('runAgentLoop memory writes', () => {
  async function run(
    memory: string,
    calls: ScriptedCall[],
    mode: 'default' | 'accept-edits' | 'dontAsk' | 'auto' | 'bypassPermissions',
    options: {
      memoryContext?: LoadedMemoryContext;
      isSubagent?: boolean;
      notices?: string[];
      configure?: (config: AgentConfig) => void;
      userMessageKind?: 'peer-message';
    } = {},
  ) {
    const prompt = vi.fn(async () => 'deny' as const);
    const results: ToolResult[] = [];
    const config = defaultConfig({
      workspace,
      maxTurns: 2,
      memoryContext: options.memoryContext ?? loadedMemory(memory),
    });
    options.configure?.(config);
    await runAgentLoop(
      config,
      createDefaultRegistry(),
      'remember it',
      [],
      noopCallbacks({
        onPermissionRequired: prompt,
        onToolResult: (r) => results.push(r),
        onNotice: (notice) => options.notices?.push(notice),
      }),
      mode,
      {
        provider: toolsThenText(calls),
        isNewSession: false,
        isSubagent: options.isSubagent,
        userMessageKind: options.userMessageKind,
      },
    );
    return { prompt, results };
  }

  it("gives a turn another session's message started no memory write root (#620)", async () => {
    // A memory write needs no prompt, and what it saves loads into every later session, a bypass
    // one included: a peer must not be able to plant one.
    for (const mode of ['default', 'auto'] as const) {
      const memory = tempDir('book-loop-memory-');
      const file = join(memory, 'fact.md');
      const { results } = await run(
        memory,
        [
          {
            id: 'w1',
            name: 'Write',
            arguments: {
              filePath: file,
              content:
                '---\nname: fact\ndescription: A fact\nmetadata:\n  type: project\n---\nBody\n',
            },
          },
        ],
        mode,
        { userMessageKind: 'peer-message' },
      );
      expect(byId(results, 'w1')?.status, mode).not.toBe('success');
      expect(existsSync(file), mode).toBe(false);
    }
  });

  for (const mode of ['default', 'accept-edits', 'dontAsk', 'auto'] as const) {
    it(`writes a memory file without a prompt in ${mode}, stamped with the session`, async () => {
      const memory = tempDir('book-loop-memory-');
      const file = join(memory, 'fact.md');
      const { prompt, results } = await run(
        memory,
        [
          {
            id: 'w1',
            name: 'Write',
            arguments: {
              filePath: file,
              content:
                '---\nname: fact\ndescription: A fact\nmetadata:\n  type: project\n---\nBody\n',
            },
          },
        ],
        mode,
      );
      expect(prompt).not.toHaveBeenCalled();
      expect(byId(results, 'w1')?.status).toBe('success');
      expect(readFileSync(file, 'utf8')).toContain('  modified: ');
    });
  }

  it('still denies a memory write when a deny rule names Write', async () => {
    const memory = tempDir('book-loop-memory-');
    const file = join(memory, 'fact.md');
    const { prompt, results } = await run(
      memory,
      [{ id: 'w1', name: 'Write', arguments: { filePath: file, content: 'x\n' } }],
      'default',
      { configure: (config) => config.settings.permissions.deny.push('Write') },
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(byId(results, 'w1')?.structuredError?.code).toBe('permission_denied');
    expect(existsSync(file)).toBe(false);
  });

  it('keeps a subagent out of the memory directory, whatever its mode', async () => {
    const memory = tempDir('book-loop-memory-');
    const file = join(memory, 'fact.md');
    const { results } = await run(
      memory,
      [{ id: 'w1', name: 'Write', arguments: { filePath: file, content: 'x\n' } }],
      'bypassPermissions',
      { isSubagent: true },
    );
    expect(byId(results, 'w1')?.structuredError?.code).toBe('path_outside_workspace');
    expect(existsSync(file)).toBe(false);
  });

  it('makes memory read-only with autoSave off', async () => {
    const memory = tempDir('book-loop-memory-');
    const file = join(memory, 'fact.md');
    const { results } = await run(
      memory,
      [{ id: 'w1', name: 'Write', arguments: { filePath: file, content: 'x\n' } }],
      'auto',
      { configure: (config) => (config.settings.memory.autoSave = false) },
    );
    expect(byId(results, 'w1')?.structuredError?.code).toBe('path_outside_workspace');
    expect(existsSync(file)).toBe(false);
  });

  it('announces a saved memory file with its name, and says nothing of an index edit', async () => {
    const memory = tempDir('book-loop-memory-');
    writeFileSync(join(memory, 'MEMORY.md'), '# Memory\n');
    const notices: string[] = [];
    const { results } = await run(
      memory,
      [
        {
          id: 'w1',
          name: 'Write',
          arguments: {
            filePath: join(memory, 'fact.md'),
            content:
              '---\nname: fact\ndescription: A fact\nmetadata:\n  type: project\n---\nBody\n',
          },
        },
        {
          id: 'e1',
          name: 'Edit',
          arguments: {
            filePath: join(memory, 'MEMORY.md'),
            oldString: '# Memory',
            newString: '# Memory\n- [Fact](fact.md) — a pointer',
          },
        },
      ],
      'default',
      { notices, memoryContext: { ...loadedMemory(memory), indexLoaded: true } },
    );
    expect(byId(results, 'w1')?.status).toBe('success');
    expect(byId(results, 'e1')?.status).toBe('success');
    expect(notices).toEqual(['memory saved: fact.md']);
    // The row names the file relative to the memory directory, and says it is a memory write.
    expect(byId(results, 'w1')?.artifacts?.fileMutation).toMatchObject({
      filePath: 'memory/fact.md',
      memory: true,
    });
  });

  it('announces an ApplyPatch delete of a memory file', async () => {
    const memory = tempDir('book-loop-memory-');
    writeFileSync(join(memory, 'stale.md'), 'old\n');
    const notices: string[] = [];
    const { results } = await run(
      memory,
      [
        {
          id: 'p1',
          name: 'ApplyPatch',
          arguments: {
            patch:
              '*** Begin Patch\n*** Delete File: ' + join(memory, 'stale.md') + '\n*** End Patch',
          },
        },
      ],
      'default',
      { notices },
    );
    expect(byId(results, 'p1')?.status).toBe('success');
    expect(existsSync(join(memory, 'stale.md'))).toBe(false);
    expect(notices).toEqual(['memory deleted: stale.md']);
  });

  it('refuses a memory write in plan mode', async () => {
    const memory = tempDir('book-loop-memory-');
    const file = join(memory, 'fact.md');
    const { results } = await run(
      memory,
      [{ id: 'w1', name: 'Write', arguments: { filePath: file, content: 'x\n' } }],
      'plan' as 'default',
    );
    expect(byId(results, 'w1')?.status).not.toBe('success');
    expect(existsSync(file)).toBe(false);
  });

  it('seeds a whole MEMORY.md so its first Edit needs no Read', async () => {
    const memory = tempDir('book-loop-memory-');
    writeFileSync(join(memory, 'MEMORY.md'), '# Memory\n');
    const { results } = await run(
      memory,
      [
        {
          id: 'e1',
          name: 'Edit',
          arguments: {
            filePath: join(memory, 'MEMORY.md'),
            oldString: '# Memory',
            newString: '# Memory\n- [Fact](fact.md) — a pointer',
          },
        },
      ],
      'default',
      { memoryContext: { ...loadedMemory(memory), indexLoaded: true } },
    );
    expect(byId(results, 'e1')?.status).toBe('success');
    expect(readFileSync(join(memory, 'MEMORY.md'), 'utf8')).toContain('(fact.md)');
  });

  it('does not seed a cut MEMORY.md, so the model must Read it first', async () => {
    const memory = tempDir('book-loop-memory-');
    writeFileSync(join(memory, 'MEMORY.md'), '# Memory\n');
    const { results } = await run(
      memory,
      [
        {
          id: 'e1',
          name: 'Edit',
          arguments: {
            filePath: join(memory, 'MEMORY.md'),
            oldString: '# Memory',
            newString: '# Memory\n- [Fact](fact.md) — a pointer',
          },
        },
      ],
      'default',
      { memoryContext: { ...loadedMemory(memory), indexLoaded: true, wasLineTruncated: true } },
    );
    expect(byId(results, 'e1')?.structuredError?.code).toBe('file_not_observed');
    expect(readFileSync(join(memory, 'MEMORY.md'), 'utf8')).toBe('# Memory\n');
  });
});

describe('runAgentLoop under the /memory consolidate tool set', () => {
  const stamped = (name: string, body: string) =>
    `---\nname: ${name}\ndescription: ${name}\nmetadata:\n  type: project\n---\n${body}\n`;

  async function run(memory: string, calls: ScriptedCall[]) {
    const prompt = vi.fn(async () => 'deny' as const);
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2, memoryContext: loadedMemory(memory) }),
      createDefaultRegistry(),
      'consolidate',
      [],
      noopCallbacks({ onPermissionRequired: prompt, onToolResult: (r) => results.push(r) }),
      'default',
      {
        provider: toolsThenText(calls),
        isNewSession: false,
        allowedTools: memoryConsolidateTools(memory),
      },
    );
    return { prompt, results };
  }

  it('reads, merges, removes and re-indexes in default mode with no prompt', async () => {
    const memory = tempDir('book-loop-consolidate-');
    const index = join(memory, 'MEMORY.md');
    writeFileSync(index, '- [A](a.md) — one\n- [B](b.md) — two\nA note.\n');
    writeFileSync(join(memory, 'a.md'), stamped('a', 'Use pnpm.'));
    writeFileSync(join(memory, 'b.md'), stamped('b', 'Use pnpm.'));

    const { prompt, results } = await run(memory, [
      { id: 'r1', name: 'Read', arguments: { filePath: index } },
      { id: 'r2', name: 'Read', arguments: { filePath: join(memory, 'b.md') } },
      {
        id: 'w1',
        name: 'Write',
        arguments: { filePath: join(memory, 'merged.md'), content: stamped('merged', 'Use pnpm.') },
      },
      { id: 'x1', name: 'Bash', arguments: { command: `rm ${join(memory, 'b.md')}` } },
      {
        id: 'e1',
        name: 'Edit',
        arguments: {
          filePath: index,
          oldString: '- [B](b.md) — two',
          newString: '- [Merged](merged.md) — pnpm',
        },
      },
    ]);

    expect(prompt).not.toHaveBeenCalled();
    for (const id of ['r1', 'r2', 'w1', 'x1', 'e1']) {
      expect(byId(results, id)?.status, id).toBe('success');
    }
    expect(existsSync(join(memory, 'b.md'))).toBe(false);
    expect(existsSync(join(memory, 'merged.md'))).toBe(true);
    expect(readFileSync(index, 'utf8')).toBe(
      '- [A](a.md) — one\n- [Merged](merged.md) — pnpm\nA note.\n',
    );
  });

  it('refuses everything outside the set, and runs none of it', async () => {
    const memory = tempDir('book-loop-consolidate-');
    writeFileSync(join(memory, 'a.md'), stamped('a', 'Use pnpm.'));
    const victim = join(workspace, 'victim.md');
    writeFileSync(victim, 'keep me\n');
    const patch = `*** Begin Patch\n*** Add File: ${join(memory, 'p.md')}\n+x\n*** End Patch`;

    const { prompt, results } = await run(memory, [
      { id: 'w1', name: 'Write', arguments: { filePath: join(workspace, 'new.md'), content: 'x' } },
      {
        id: 'w2',
        name: 'Write',
        arguments: { filePath: join(memory, '..', 'up.md'), content: 'x' },
      },
      { id: 'p1', name: 'ApplyPatch', arguments: { patch } },
      { id: 'x1', name: 'Bash', arguments: { command: `rm -rf ${memory}` } },
      { id: 'x2', name: 'Bash', arguments: { command: `rm ${victim}` } },
      {
        id: 'x3',
        name: 'Bash',
        arguments: { command: `rm ${join(memory, 'a.md')} && touch ${join(workspace, 'pwned')}` },
      },
      { id: 'm1', name: 'mcp__evil__run', arguments: {} },
    ]);

    expect(prompt).not.toHaveBeenCalled();
    for (const id of ['w1', 'w2', 'p1', 'x1', 'x2', 'x3', 'm1']) {
      expect(byId(results, id)?.status, id).not.toBe('success');
    }
    expect(existsSync(join(workspace, 'new.md'))).toBe(false);
    expect(existsSync(join(memory, '..', 'up.md'))).toBe(false);
    expect(existsSync(join(memory, 'p.md'))).toBe(false);
    expect(existsSync(join(memory, 'a.md'))).toBe(true);
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(join(workspace, 'pwned'))).toBe(false);
  });
});

/**
 * #512, decision 2. A Bash deny or ask rule is a glob over one line, so a compound command slips
 * past it; `auto` never prompts, so the `ask` verdict that catches it was ignored. These runs use a
 * stub Bash tool that records what it was asked to run and never reaches a shell, so a gate that is
 * wrong cannot execute anything.
 */
describe('runAgentLoop compound Bash commands under a Bash deny or ask rule (#512)', () => {
  const COMPOUND = 'echo a && echo b';

  async function run(options: {
    command: string;
    mode: 'default' | 'auto' | 'dontAsk' | 'bypassPermissions';
    deny?: string[];
    ask?: string[];
    allow?: string[];
    onPermissionRequired?: AgentLoopCallbacks['onPermissionRequired'];
    notices?: string[];
  }) {
    const executed: string[] = [];
    const registry = createDefaultRegistry();
    registry.register({
      ...registry.getTool('Bash')!,
      execute: async (args) => {
        executed.push(String(args.command));
        return { ...okResult, content: 'stub ran' };
      },
    });
    const config = defaultConfig({ workspace, maxTurns: 2 });
    config.settings.permissions.deny = options.deny ?? [];
    config.settings.permissions.ask = options.ask ?? [];
    config.settings.permissions.allow = options.allow ?? [];
    const prompt = vi.fn(options.onPermissionRequired ?? (async () => 'deny' as const));
    const results: ToolResult[] = [];
    await runAgentLoop(
      config,
      registry,
      'run it',
      [],
      noopCallbacks({
        onPermissionRequired: prompt,
        onToolResult: (r) => results.push(r),
        onNotice: (notice) => options.notices?.push(notice),
      }),
      options.mode,
      {
        provider: toolsThenText([
          { id: 'b1', name: 'Bash', arguments: { command: options.command } },
        ]),
        isNewSession: false,
      },
    );
    return { executed, prompt, result: byId(results, 'b1') };
  }
  const okResult = {
    version: 2 as const,
    toolCallId: '',
    status: 'success' as const,
    content: '',
  };

  it('prompts in auto, and does not run the command when it is denied', async () => {
    const { executed, prompt, result } = await run({
      command: COMPOUND,
      mode: 'auto',
      deny: ['Bash(rm *)'],
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(executed).toEqual([]);
    expect(result?.status).toBe('blocked');
  });

  it('runs it in auto once the prompt is approved', async () => {
    const { executed, prompt } = await run({
      command: COMPOUND,
      mode: 'auto',
      deny: ['Bash(rm *)'],
      onPermissionRequired: async () => 'allow',
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(executed).toEqual([COMPOUND]);
  });

  it('prompts in auto for an ask rule that matches the whole compound command', async () => {
    const { executed, prompt } = await run({
      command: 'echo a && echo b',
      mode: 'auto',
      ask: ['Bash(echo *)'],
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(executed).toEqual([]);
  });

  it('prompts in auto for a bare Bash allow rule beside a Bash deny rule', async () => {
    const { executed, prompt } = await run({
      command: COMPOUND,
      mode: 'auto',
      allow: ['Bash'],
      deny: ['Bash(rm *)'],
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(executed).toEqual([]);
  });

  it('runs it unprompted in bypassPermissions', async () => {
    const { executed, prompt } = await run({
      command: COMPOUND,
      mode: 'bypassPermissions',
      deny: ['Bash(rm *)'],
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(executed).toEqual([COMPOUND]);
  });

  it('refuses it in dontAsk without prompting', async () => {
    const { executed, prompt, result } = await run({
      command: COMPOUND,
      mode: 'dontAsk',
      deny: ['Bash(rm *)'],
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
    expect(result?.content).toContain('dontAsk');
  });

  it('runs a compound command in auto unprompted when no Bash deny or ask rule exists', async () => {
    for (const rules of [{}, { deny: ['Read(.env)'] }, { ask: ['Write(src/**)'] }]) {
      const { executed, prompt } = await run({ command: COMPOUND, mode: 'auto', ...rules });
      expect(prompt, JSON.stringify(rules)).not.toHaveBeenCalled();
      expect(executed, JSON.stringify(rules)).toEqual([COMPOUND]);
    }
  });

  it('keeps a non-compound command unprompted in auto, quoted rule text included', async () => {
    for (const command of ['git commit -m "rm stuff"', 'echo "a && b"', 'echo hi']) {
      const { executed, prompt } = await run({ command, mode: 'auto', deny: ['Bash(rm *)'] });
      expect(prompt, command).not.toHaveBeenCalled();
      expect(executed, command).toEqual([command]);
    }
  });

  it('lets an exact allow rule admit its exact command in auto', async () => {
    const { executed, prompt } = await run({
      command: COMPOUND,
      mode: 'auto',
      allow: [`Bash(${COMPOUND})`],
      deny: ['Bash(rm *)'],
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(executed).toEqual([COMPOUND]);
  });

  it('refuses it with the compound remedy, and no --permission-mode auto, when nobody can ask', async () => {
    const notices: string[] = [];
    const { executed, result } = await run({
      command: COMPOUND,
      mode: 'auto',
      deny: ['Bash(rm *)'],
      onPermissionRequired: noApprover,
      notices,
    });
    expect(executed).toEqual([]);
    const content = result?.content ?? '';
    expect(content).toContain('as its own Bash call');
    expect(content).toContain(`"Bash(${COMPOUND})"`);
    expect(content).toContain('bypassPermissions');
    expect(content).not.toContain('--permission-mode auto');
    const refusals = notices.filter((notice) => notice.includes('needs approval'));
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).not.toContain('--permission-mode auto');
  });

  it('omits the allow-rule option when no exact rule could admit the command', async () => {
    const { result } = await run({
      command: 'echo a\necho b',
      mode: 'auto',
      deny: ['Bash(rm *)'],
      onPermissionRequired: noApprover,
    });
    const content = result?.content ?? '';
    expect(content).toContain('as its own Bash call');
    expect(content).not.toContain('permissions.allow');
    expect(content).not.toContain('--permission-mode auto');
  });

  it.each(['echo a\necho b', 'ls *.ts && echo x'])(
    'never tells the operator to add a bare Bash rule for %j, which no single rule covers',
    async (command) => {
      const notices: string[] = [];
      const { executed, result } = await run({
        command,
        mode: 'default',
        onPermissionRequired: noApprover,
        notices,
      });
      expect(executed).toEqual([]);
      const texts = [result?.content ?? '', ...notices.filter((n) => n.includes('needs approval'))];
      expect(texts).toHaveLength(2);
      for (const text of texts) {
        expect(text).not.toMatch(/"Bash"/);
        expect(text).toContain('no single permissions.allow rule');
      }
    },
  );

  it('still names the exact rule when one covers the command', async () => {
    const { result } = await run({
      command: 'cd x && npm test',
      mode: 'default',
      onPermissionRequired: noApprover,
    });
    expect(result?.content).toContain('"Bash(cd x && npm test)"');
  });

  describe('"Always allow"', () => {
    it('saves the exact rule, which then admits the same call without a prompt', async () => {
      const persisted: string[] = [];
      const executed: string[] = [];
      const registry = createDefaultRegistry();
      registry.register({
        ...registry.getTool('Bash')!,
        execute: async (args) => {
          executed.push(String(args.command));
          return { ...okResult, content: 'stub ran' };
        },
      });
      const config = defaultConfig({ workspace, maxTurns: 3 });
      config.settings.permissions.deny = ['Bash(rm *)'];
      const prompt = vi.fn(async () => 'always' as const);
      let turn = 0;
      const provider: Provider = {
        id: 'scripted',
        stream: async function* () {
          turn++;
          if (turn <= 2) {
            yield {
              type: 'tool_call' as const,
              toolCall: { id: `b${turn}`, name: 'Bash', arguments: { command: COMPOUND } },
            };
          } else {
            yield { type: 'text' as const, content: 'done' };
          }
          yield { type: 'done' as const };
        },
      };
      await runAgentLoop(
        config,
        registry,
        'run it',
        [],
        noopCallbacks({
          onPermissionRequired: prompt,
          onPersistPermissionRule: (rule) => persisted.push(rule),
        }),
        'auto',
        { provider, isNewSession: false },
      );
      expect(persisted).toEqual([`Bash(${COMPOUND})`]);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(executed).toEqual([COMPOUND, COMPOUND]);
    });

    it('runs the call once and remembers nothing when no exact rule could admit it', async () => {
      const { executed, prompt } = await run({
        command: 'echo a\necho b',
        mode: 'auto',
        deny: ['Bash(rm *)'],
        onPermissionRequired: async () => 'always',
      });
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(executed).toEqual(['echo a\necho b']);
    });

    it('never lets a bare Bash or glob session rule skip the prompt for a flagged call', async () => {
      for (const rule of ['Bash', 'Bash(echo *)']) {
        const executed: string[] = [];
        const registry = createDefaultRegistry();
        registry.register({
          ...registry.getTool('Bash')!,
          execute: async (args) => {
            executed.push(String(args.command));
            return { ...okResult, content: 'stub ran' };
          },
        });
        const config = defaultConfig({ workspace, maxTurns: 3 });
        config.settings.permissions.deny = ['Bash(rm *)'];
        let turn = 0;
        const provider: Provider = {
          id: 'scripted',
          stream: async function* () {
            turn++;
            if (turn === 1) {
              yield {
                type: 'tool_call' as const,
                toolCall: { id: 'b1', name: 'Bash', arguments: { command: 'echo seed' } },
              };
            } else if (turn === 2) {
              yield {
                type: 'tool_call' as const,
                toolCall: { id: 'b2', name: 'Bash', arguments: { command: COMPOUND } },
              };
            } else {
              yield { type: 'text' as const, content: 'done' };
            }
            yield { type: 'done' as const };
          },
        };
        // The first call's "Always" answer carries the session rule under test; the second,
        // compound call must still reach the approver, which denies it.
        let asked = 0;
        const answers: Array<PermissionDecision | 'deny'> = [{ result: 'always', rule }, 'deny'];
        const compoundPrompts: string[] = [];
        await runAgentLoop(
          config,
          registry,
          'run it',
          [],
          noopCallbacks({
            onPermissionRequired: async (call) => {
              asked++;
              if (call.arguments.command === COMPOUND) compoundPrompts.push(rule);
              return answers[Math.min(asked - 1, answers.length - 1)];
            },
          }),
          'default',
          { provider, isNewSession: false },
        );
        expect(compoundPrompts, rule).toEqual([rule]);
        expect(executed, rule).not.toContain(COMPOUND);
      }
    });
  });
});

// A plain call that matched an `ask` rule ran unprompted in `auto`: only a compound Bash command
// under a Bash deny or ask rule asked there.
describe('runAgentLoop an ask rule prompts in auto too (#527)', () => {
  const PUSH = 'git push origin main';
  const okResult = {
    version: 2 as const,
    toolCallId: '',
    status: 'success' as const,
    content: 'stub ran',
  };

  async function run(options: {
    mode: 'auto' | 'bypassPermissions';
    ask?: string[];
    call: ScriptedCall;
    onPermissionRequired?: AgentLoopCallbacks['onPermissionRequired'];
  }) {
    const executed: string[] = [];
    const registry = createDefaultRegistry();
    registry.register({
      ...registry.getTool('Bash')!,
      execute: async (args) => {
        executed.push(String(args.command));
        return okResult;
      },
    });
    const config = defaultConfig({ workspace, maxTurns: 2 });
    config.settings.permissions.ask = options.ask ?? [];
    const prompt = vi.fn(options.onPermissionRequired ?? (async () => 'deny' as const));
    const notices: string[] = [];
    const results: ToolResult[] = [];
    await runAgentLoop(
      config,
      registry,
      'run it',
      [],
      noopCallbacks({
        onPermissionRequired: prompt,
        onToolResult: (r) => results.push(r),
        onNotice: (notice) => notices.push(notice),
      }),
      options.mode,
      { provider: toolsThenText([options.call]), isNewSession: false },
    );
    return { executed, prompt, notices, result: byId(results, options.call.id) };
  }
  const push = { id: 'b1', name: 'Bash', arguments: { command: PUSH } };

  it('prompts for a plain Bash call an ask rule covers, and runs it once allowed', async () => {
    const { executed, prompt } = await run({
      mode: 'auto',
      ask: ['Bash(git push *)'],
      call: push,
      onPermissionRequired: async () => 'allow',
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(executed).toEqual([PUSH]);
  });

  it('does not run it when the prompt is denied', async () => {
    const { executed, prompt, result } = await run({
      mode: 'auto',
      ask: ['Bash(git push *)'],
      call: push,
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(executed).toEqual([]);
    expect(result?.status).toBe('blocked');
  });

  it('refuses it with the ask-rule remedy, and no auto advice, when nobody can ask', async () => {
    const { executed, notices, result } = await run({
      mode: 'auto',
      ask: ['Bash(git push *)'],
      call: push,
      onPermissionRequired: noApprover,
    });
    expect(executed).toEqual([]);
    expect(result?.status).toBe('blocked');
    const refusals = notices.filter((notice) => notice.includes('needs approval'));
    expect(refusals).toHaveLength(1);
    for (const text of [result?.content ?? '', refusals[0]]) {
      expect(text).toContain('narrow or remove the permissions.ask rule Bash(git push *)');
      expect(text).not.toContain('add a permissions.allow rule');
      expect(text).not.toContain('--permission-mode auto');
    }
  });

  it('runs it unprompted in bypassPermissions', async () => {
    const { executed, prompt } = await run({
      mode: 'bypassPermissions',
      ask: ['Bash(git push *)'],
      call: push,
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(executed).toEqual([PUSH]);
  });

  it('prompts for a non-Bash call an ask rule covers', async () => {
    const { prompt, result } = await run({
      mode: 'auto',
      ask: ['Write(secrets/**)'],
      call: {
        id: 'w1',
        name: 'Write',
        arguments: { filePath: 'secrets/key.txt', content: 'k\n' },
      },
    });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(result?.status).toBe('blocked');
    expect(existsSync(join(workspace, 'secrets', 'key.txt'))).toBe(false);
  });

  it('still runs a plain call unprompted in auto when no ask rule covers it', async () => {
    for (const ask of [[], ['Bash(git push *)']]) {
      const { executed, prompt } = await run({
        mode: 'auto',
        ask,
        call: { id: 'b1', name: 'Bash', arguments: { command: 'git status' } },
      });
      expect(prompt, JSON.stringify(ask)).not.toHaveBeenCalled();
      expect(executed, JSON.stringify(ask)).toEqual(['git status']);
    }
  });
});

describe('runAgentLoop "Always allow" on a Bash command holding * (#521)', () => {
  const COMMAND = 'rm -rf build/*';
  const okResult = {
    version: 2 as const,
    toolCallId: '',
    status: 'success' as const,
    content: 'stub ran',
  };

  /** A registry whose Bash only records the command: nothing here may really run `rm -rf`. */
  function recordingRegistry(executed: string[]) {
    const registry = createDefaultRegistry();
    registry.register({
      ...registry.getTool('Bash')!,
      execute: async (args) => {
        executed.push(String(args.command));
        return okResult;
      },
    });
    return registry;
  }

  it('saves no rule, and the identical call later in the session prompts again', async () => {
    const persisted: string[] = [];
    const executed: string[] = [];
    const prompt = vi.fn(async () => 'always' as const);
    let turn = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        turn++;
        if (turn <= 2) {
          yield {
            type: 'tool_call' as const,
            toolCall: { id: `b${turn}`, name: 'Bash', arguments: { command: COMMAND } },
          };
        } else {
          yield { type: 'text' as const, content: 'done' };
        }
        yield { type: 'done' as const };
      },
    };
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 3 }),
      recordingRegistry(executed),
      'clean it',
      [],
      noopCallbacks({
        onPermissionRequired: prompt,
        onPersistPermissionRule: (rule) => persisted.push(rule),
      }),
      'default',
      { provider, isNewSession: false },
    );
    expect(persisted).toEqual([]);
    expect(prompt).toHaveBeenCalledTimes(2);
    expect(executed).toEqual([COMMAND, COMMAND]);
  });

  // The remedy names the reason the command has no rule, not always the `*` (review of #531).
  it.each([
    ['a `*`', COMMAND, { star: true, lineBreak: false }],
    ['a line break', 'npm ci\nnpm test', { star: false, lineBreak: true }],
    ['both', 'rm -rf build/*\nnpm test', { star: true, lineBreak: true }],
  ])(
    'names no rule in the unattended remedy for a command with %s, and says why',
    async (_label, command, why) => {
      const executed: string[] = [];
      const notices: string[] = [];
      const results: ToolResult[] = [];
      await runAgentLoop(
        defaultConfig({ workspace, maxTurns: 2 }),
        recordingRegistry(executed),
        'clean it',
        [],
        noopCallbacks({
          onPermissionRequired: noApprover,
          onToolResult: (r) => results.push(r),
          onNotice: (notice) => notices.push(notice),
        }),
        'default',
        {
          provider: toolsThenText([{ id: 'b1', name: 'Bash', arguments: { command } }]),
          isNewSession: false,
        },
      );
      expect(executed).toEqual([]);
      const texts = [
        byId(results, 'b1')?.content ?? '',
        ...notices.filter((n) => n.includes('needs approval')),
      ];
      expect(texts).toHaveLength(2);
      for (const text of texts) {
        expect(text).not.toMatch(/"Bash/);
        expect(text).toContain('no single permissions.allow rule');
        expect(text.includes('`*`'), text).toBe(why.star);
        expect(text.includes('one-line Bash call'), text).toBe(why.lineBreak);
      }
    },
  );

  it('never offers a bare tool rule for a non-Bash call whose argument holds a wildcard', async () => {
    const notices: string[] = [];
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2 }),
      createDefaultRegistry(),
      'write it',
      [],
      noopCallbacks({
        onPermissionRequired: noApprover,
        onToolResult: (r) => results.push(r),
        onNotice: (notice) => notices.push(notice),
      }),
      'default',
      {
        provider: toolsThenText([
          { id: 'w1', name: 'Write', arguments: { filePath: 'docs/what?.md', content: 'x\n' } },
        ]),
        isNewSession: false,
      },
    );
    const texts = [
      byId(results, 'w1')?.content ?? '',
      ...notices.filter((n) => n.includes('needs approval')),
    ];
    expect(texts).toHaveLength(2);
    for (const text of texts) {
      expect(text).not.toMatch(/"Write/);
      expect(text).toContain('`*` or `?`');
    }
  });
});

// A session approve-all rule is an allow rule, and an `ask` rule outranks every allow rule: a
// widened rung saved earlier in the session must not skip the prompt the ask rule asks for.
describe('runAgentLoop session rules under an ask rule (review of #531)', () => {
  const okResult = {
    version: 2 as const,
    toolCallId: '',
    status: 'success' as const,
    content: 'stub ran',
  };

  /**
   * Runs `calls` one per turn. `answer` answers each prompt; the first call is the seed whose
   * "Always" answer puts the session rule under test into the run's approve-all rules.
   */
  async function runTurns(options: {
    mode: 'default' | 'auto';
    ask: string[];
    calls: ScriptedCall[];
    answer: (call: ScriptedCall) => PermissionDecision | 'allow' | 'deny' | 'always';
  }) {
    const executed: string[] = [];
    const registry = createDefaultRegistry();
    registry.register({
      ...registry.getTool('Bash')!,
      execute: async (args) => {
        executed.push(String(args.command));
        return okResult;
      },
    });
    const config = defaultConfig({ workspace, maxTurns: options.calls.length + 1 });
    config.settings.permissions.ask = options.ask;
    const prompted: string[] = [];
    let turn = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        const next = options.calls[turn++];
        if (next) yield { type: 'tool_call' as const, toolCall: next };
        else yield { type: 'text' as const, content: 'done' };
        yield { type: 'done' as const };
      },
    };
    await runAgentLoop(
      config,
      registry,
      'go',
      [],
      noopCallbacks({
        onPermissionRequired: async (call) => {
          prompted.push(call.id);
          return options.answer(call as ScriptedCall);
        },
      }),
      options.mode,
      { provider, isNewSession: false },
    );
    return { executed, prompted };
  }

  const bash = (id: string, command: string): ScriptedCall => ({
    id,
    name: 'Bash',
    arguments: { command },
  });

  for (const mode of ['default', 'auto'] as const) {
    it(`a widened session rule does not skip the ask rule in ${mode}`, async () => {
      const { executed, prompted } = await runTurns({
        mode,
        ask: ['Bash(git push *)'],
        calls: [bash('seed', 'git push origin dev'), bash('push', 'git push origin main')],
        answer: (call) => (call.id === 'seed' ? { result: 'always', rule: 'Bash(git *)' } : 'deny'),
      });
      expect(prompted).toEqual(['seed', 'push']);
      expect(executed).toEqual(['git push origin dev']);
    });

    it(`the call's own exact session rule still admits it in ${mode}`, async () => {
      const { executed, prompted } = await runTurns({
        mode,
        ask: ['Bash(git push *)'],
        calls: [bash('first', 'git push origin main'), bash('again', 'git push origin main')],
        // A bare "always" saves the call's exact rule, `Bash(git push origin main)`.
        answer: (call) => (call.id === 'first' ? 'always' : 'deny'),
      });
      expect(prompted).toEqual(['first']);
      expect(executed).toEqual(['git push origin main', 'git push origin main']);
    });
  }

  it('a widened session rule does not skip an ask rule on another tool', async () => {
    const write = (id: string, filePath: string): ScriptedCall => ({
      id,
      name: 'Write',
      arguments: { filePath, content: 'k\n' },
    });
    const { prompted } = await runTurns({
      mode: 'default',
      ask: ['Write(secrets/**)'],
      calls: [write('seed', 'secrets/a.txt'), write('next', 'secrets/b.txt')],
      answer: (call) =>
        call.id === 'seed' ? { result: 'always', rule: 'Write(secrets/*)' } : 'deny',
    });
    expect(prompted).toEqual(['seed', 'next']);
    expect(existsSync(join(workspace, 'secrets', 'b.txt'))).toBe(false);
  });
});

// In `auto` the read target was not judged, so an ask-ruled read of a file outside every root
// carried no `outsideWorkspace` marker: an unattended run named the ask rule, which cannot help,
// where `default` names the unreachable target (review of #531).
//
// The ask rule has to match the target first. A target no root serves used to be tested only as
// written, so on Windows (`C:\...\.env`) `Read(**/.env)` never matched it: `default` still refused
// the read early, and `auto` ran it unprompted.
describe('runAgentLoop an ask-ruled read outside every root (review of #531)', () => {
  async function readOutside(
    mode: 'default' | 'auto',
    approver: AgentLoopCallbacks['onPermissionRequired'],
    spelling: { filePath?: string; ask?: string } = {},
  ) {
    writeFileSync(join(outside, '.env'), 'SECRET=1\n');
    const config = defaultConfig({ workspace, maxTurns: 2 });
    config.settings.permissions.ask = [spelling.ask ?? 'Read(**/.env)'];
    const prompt = vi.fn(approver);
    const notices: string[] = [];
    const results: ToolResult[] = [];
    await runAgentLoop(
      config,
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({
        onPermissionRequired: prompt,
        onToolResult: (r) => results.push(r),
        onNotice: (notice) => notices.push(notice),
      }),
      mode,
      {
        provider: toolsThenText([
          {
            id: 'r1',
            name: 'Read',
            arguments: { filePath: spelling.filePath ?? join(outside, '.env') },
          },
        ]),
        isNewSession: false,
      },
    );
    return { prompt, notices, result: byId(results, 'r1') };
  }

  for (const mode of ['default', 'auto'] as const) {
    it(`names the unreachable target, not the ask rule, when nobody can ask, in ${mode}`, async () => {
      const { notices, result } = await readOutside(mode, noApprover);
      expect(result?.status).toBe('blocked');
      expect(result?.content).toContain('outside the workspace');
      expect(result?.content).not.toContain('permissions.ask rule');
      expect(result?.content).not.toContain('SECRET');
      expect(notices.filter((notice) => notice.includes('needs approval'))).toHaveLength(0);
    });
  }

  it('treats the call in auto exactly as default does when a person can answer', async () => {
    const answered = async () => 'allow' as const;
    const inDefault = await readOutside('default', answered);
    const inAuto = await readOutside('auto', answered);
    // Asked once in each: equal counts alone would pass with the rule matching in neither.
    expect(inDefault.prompt).toHaveBeenCalledTimes(1);
    expect(inAuto.prompt).toHaveBeenCalledTimes(1);
    expect(inAuto.result?.status).toBe(inDefault.result?.status);
    expect(inAuto.result?.content).not.toContain('SECRET');
  });

  // The same gap, reproducible on every platform: a relative spelling of the outside file was
  // tested only as written, so a rule naming its absolute path never matched it.
  for (const mode of ['default', 'auto'] as const) {
    it(`matches an absolute ask rule against a relative spelling of the target in ${mode}`, async () => {
      const target = join(outside, '.env');
      const { prompt, result } = await readOutside(mode, noApprover, {
        filePath: relative(workspace, target),
        ask: `Read(${target.replace(/\\/g, '/')})`,
      });
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(result?.status).toBe('blocked');
      expect(result?.content).toContain('outside the workspace');
      expect(result?.content).not.toContain('SECRET');
    });
  }
});
