import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLoop } from './loop.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { defaultConfig } from '../test/fixtures.js';
import { SessionRuntime } from '../session/runtime.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type { PermissionDecision, ToolResult } from '../types/tools.js';
import type { Provider } from '../provider/index.js';

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

  it('still asks before reading outside the workspace', async () => {
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
          { id: 'r1', name: 'Read', arguments: { filePath: join(outside, 'secret.txt') } },
        ]),
        isNewSession: false,
      },
    );
    expect(prompt).toHaveBeenCalledTimes(1);
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
    const results: ToolResult[] = [];
    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 2 }),
      createDefaultRegistry(),
      'read it',
      [],
      noopCallbacks({
        onPermissionRequired: async () => 'deny' as const,
        onToolResult: (r) => results.push(r),
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
    expect(content).toContain('The user declined');
    expect(content).not.toContain('configured permission policy');
  });
});
