import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLoop } from './loop.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { defaultConfig } from '../test/fixtures.js';
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

function setup() {
  const workspace = mkdtempSync(join(tmpdir(), 'book-loop-reads-'));
  const outside = mkdtempSync(join(tmpdir(), 'book-loop-reads-out-'));
  writeFileSync(join(workspace, 'notes.txt'), 'hello from notes\n');
  writeFileSync(join(outside, 'secret.txt'), 'secret\n');
  return {
    workspace,
    outside,
    cleanup: () => {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    },
  };
}

function byId(results: ToolResult[], id: string): ToolResult | undefined {
  return results.find((result) => result.toolCallId === id);
}

describe('runAgentLoop workspace reads (#264)', () => {
  for (const mode of ['default', 'accept-edits'] as const) {
    it(`runs Read, Glob and Grep inside the workspace without a prompt in ${mode}`, async () => {
      const { workspace, cleanup } = setup();
      try {
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
      } finally {
        cleanup();
      }
    });
  }

  it('still asks before reading outside the workspace', async () => {
    const { workspace, outside, cleanup } = setup();
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
            { id: 'r1', name: 'Read', arguments: { filePath: join(outside, 'secret.txt') } },
          ]),
          isNewSession: false,
        },
      );
      expect(prompt).toHaveBeenCalledTimes(1);
    } finally {
      cleanup();
    }
  });

  it('prompts for a workspace read that an ask rule covers, however the path is spelled', async () => {
    const { workspace, cleanup } = setup();
    try {
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
    } finally {
      cleanup();
    }
  });

  for (const mode of ['default', 'auto'] as const) {
    it(`denies a deny-ruled file however the path is spelled, in ${mode}`, async () => {
      const { workspace, cleanup } = setup();
      try {
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
      } finally {
        cleanup();
      }
    });
  }

  it('keeps dontAsk refusing workspace reads, and says dontAsk refused them', async () => {
    const { workspace, cleanup } = setup();
    try {
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
            { id: 'r1', name: 'Read', arguments: { filePath: 'notes.txt' } },
          ]),
          isNewSession: false,
        },
      );
      expect(prompt).not.toHaveBeenCalled();
      const result = byId(results, 'r1');
      expect(result?.status).toBe('blocked');
      expect(result?.structuredError?.code).toBe('permission_denied');
      expect(result?.content).toContain('dontAsk');
      expect(result?.content).not.toContain('configured permission policy');
    } finally {
      cleanup();
    }
  });

  it('refuses what nobody can approve, says why, and tells the operator once', async () => {
    const { workspace, outside, cleanup } = setup();
    try {
      const notices: string[] = [];
      const results: ToolResult[] = [];
      await runAgentLoop(
        defaultConfig({ workspace, maxTurns: 2 }),
        createDefaultRegistry(),
        'read it',
        [],
        noopCallbacks({
          onPermissionRequired: async (): Promise<PermissionDecision> => ({
            result: 'deny',
            reason: 'no_approver',
          }),
          onToolResult: (r) => results.push(r),
          onNotice: (notice) => notices.push(notice),
        }),
        'default',
        {
          provider: toolsThenText([
            { id: 'r1', name: 'Read', arguments: { filePath: join(outside, 'secret.txt') } },
            { id: 'r2', name: 'Read', arguments: { filePath: join(outside, 'other.txt') } },
          ]),
          isNewSession: false,
        },
      );
      expect(results.map((result) => result.status)).toEqual(['blocked', 'blocked']);
      const content = byId(results, 'r1')?.content ?? '';
      expect(content).toContain('print mode');
      expect(content).toContain('permissions.allow');
      expect(content).toContain('--permission-mode auto');
      expect(content).not.toContain('configured permission policy');
      expect(notices.filter((notice) => notice.includes('--permission-mode auto'))).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  it('says the user declined when a person refused the prompt', async () => {
    const { workspace, outside, cleanup } = setup();
    try {
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
    } finally {
      cleanup();
    }
  });
});
