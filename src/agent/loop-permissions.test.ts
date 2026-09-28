import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLoop } from './loop.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { defaultConfig } from '../test/fixtures.js';
import { SessionRuntime } from '../session/runtime.js';
import type { AgentConfig } from '../types/runtime.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type { PermissionDecision, ToolResult } from '../types/tools.js';
import type { Provider } from '../provider/index.js';
import type { LoadedMemoryContext } from '../memory-store.js';

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
let previousBookHome: string | undefined;
let workspace: string;
let outside: string;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  // The loop reads and writes user-global state under BOOK_HOME; keep it off the real one.
  previousBookHome = process.env.BOOK_HOME;
  process.env.BOOK_HOME = tempDir('book-loop-perm-home-');
  workspace = tempDir('book-loop-reads-');
  outside = tempDir('book-loop-reads-out-');
  writeFileSync(join(workspace, 'notes.txt'), 'hello from notes\n');
  writeFileSync(join(outside, 'secret.txt'), 'secret\n');
});

afterEach(() => {
  if (previousBookHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = previousBookHome;
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function byId(results: ToolResult[], id: string): ToolResult | undefined {
  return results.find((result) => result.toolCallId === id);
}

/** The loop turns a memory context into the read-only root whose `.inbox` it excludes. */
function loadedMemory(dir: string): LoadedMemoryContext {
  return {
    dir,
    indexFile: join(dir, 'MEMORY.md'),
    indexLoaded: false,
    indexLineCount: 0,
    loadedLineCount: 0,
    indexText: '',
    files: [],
    candidates: [],
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
      { provider, isNewSession: false },
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
      { provider, isNewSession: false },
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

  /**
   * #305 item 3, second half. `readToolTarget` already judged an excluded path — a read-only
   * root's `exclude` list, which is how Book's memory inbox is kept closed — and reported
   * `hidden`, but nothing consumed that verdict: the call fell through to the default `ask`, and
   * the prompt could not be satisfied because the tool refuses the path either way. Refused
   * before the prompt, with a message that says the path is excluded.
   */
  it('refuses a read of an excluded path, rather than asking about a call the tool refuses', async () => {
    // The memory directory is the read-only root that carries an `exclude` in production: `Read`
    // may cross it, and `.inbox` inside it is the one subpath the tool itself refuses.
    const memory = tempDir('book-loop-memory-');
    mkdirSync(join(memory, '.inbox'), { recursive: true });
    writeFileSync(join(memory, '.inbox', 'pending.md'), 'pending\n');
    const prompt = vi.fn(async () => 'allow' as const);
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({
        workspace,
        maxTurns: 2,
        memoryContext: loadedMemory(memory),
      }),
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
            arguments: { filePath: join(memory, '.inbox', 'pending.md') },
          },
        ]),
        isNewSession: false,
      },
    );

    // The approver is not consulted: "always allow" would have saved a rule for a path the tool
    // never opens, which is the same dead end #305 item 3 was about.
    expect(prompt).not.toHaveBeenCalled();
    const result = byId(results, 'r1');
    expect(result?.status).toBe('blocked');
    expect(result?.structuredError?.code).toBe('path_excluded');
    // Its own code, so the streak remedy does not answer an exclusion with "add its directory to
    // additionalDirectories", which would not lift it either.
    expect(result?.content).toContain('excluded');
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
