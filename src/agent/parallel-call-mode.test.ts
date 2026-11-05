import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHooks } from '../hooks.js';
import type { Provider } from '../provider/index.js';
import { defaultConfig } from '../test/fixtures.js';
import { isolateBookHome } from '../test/isolated-book-home.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { toolSuccess } from '../tools/result.js';
import type { AgentConfig, PermissionMode } from '../types/runtime.js';
import type { ToolResult } from '../types/tools.js';
import { runAgentLoop } from './loop.js';

vi.mock('../hooks.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../hooks.js')>();
  return { ...original, runHooks: vi.fn(original.runHooks) };
});

const realHooks = await vi.importActual<typeof import('../hooks.js')>('../hooks.js');

isolateBookHome();

type ScriptedCall = { id: string; name: string; arguments: Record<string, unknown> };

let workspace: string;

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'book-parallel-mode-')));
  writeFileSync(join(workspace, 'a.txt'), 'a\n');
  writeFileSync(join(workspace, 'denied.txt'), 'd\n');
  vi.mocked(runHooks).mockReset();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** Each turn makes its calls; the turn after the last answers with text. */
function scripted(turns: ScriptedCall[][]): Provider {
  let turn = 0;
  return {
    id: 'scripted',
    stream: async function* () {
      const calls = turns[turn++];
      if (calls) for (const toolCall of calls) yield { type: 'tool_call' as const, toolCall };
      else yield { type: 'text' as const, content: 'done' };
      yield { type: 'done' as const };
    },
  };
}

/** The loop with a host that keeps its mode as `useAgent` does: `onModeChange` writes it. */
async function drive(options: {
  host: { mode: PermissionMode };
  turns: ScriptedCall[][];
  answer?: 'allow' | 'deny';
  configure?: (config: AgentConfig) => void;
  registry?: ReturnType<typeof createDefaultRegistry>;
}) {
  const config = defaultConfig({ workspace, maxTurns: options.turns.length + 1 });
  options.configure?.(config);
  const results = new Map<string, ToolResult>();
  const modeChanges: PermissionMode[] = [];
  const onPermissionRequired = vi.fn(async () => options.answer ?? ('deny' as const));
  await runAgentLoop(
    config,
    options.registry ?? createDefaultRegistry(),
    'go',
    [],
    {
      onText: () => {},
      onToolCall: () => {},
      onToolResult: (result) => results.set(result.toolCallId ?? '', result),
      onError: () => {},
      onTurnStart: () => {},
      onDone: () => {},
      onPermissionRequired,
      getMode: () => options.host.mode,
      onModeChange: (mode) => {
        modeChanges.push(mode);
        options.host.mode = mode;
      },
    },
    options.host.mode,
    { provider: scripted(options.turns) },
  );
  return { results, modeChanges, onPermissionRequired };
}

const writeAfter: ScriptedCall = {
  id: 'write',
  name: 'Write',
  arguments: { file_path: 'after.txt', content: 'x\n' },
};

describe('a tool call in a parallel wave does not write the permission mode back', () => {
  function hostMoves(host: { mode: PermissionMode }, to: PermissionMode): void {
    vi.mocked(runHooks).mockImplementation(async (...args) => {
      const payload = args[2] as { toolArgs?: { filePath?: unknown } };
      if (args[1] === 'PreToolUse' && String(payload.toolArgs?.filePath).endsWith('denied.txt')) {
        host.mode = to;
      }
      return realHooks.runHooks(...args);
    });
  }
  const wave: ScriptedCall[] = [
    { id: 'a', name: 'Read', arguments: { file_path: 'a.txt' } },
    { id: 'denied', name: 'Read', arguments: { file_path: 'denied.txt' } },
  ];
  const denyOneRead = (config: AgentConfig) => {
    config.settings.permissions.deny = ['Read(denied.txt)'];
  };

  it('the host keeps default, and the next write asks', async () => {
    const host: { mode: PermissionMode } = { mode: 'auto' };
    hostMoves(host, 'default');

    const { results, modeChanges, onPermissionRequired } = await drive({
      host,
      configure: denyOneRead,
      turns: [wave, [writeAfter]],
    });

    expect(results.get('a')?.status).toBe('success');
    expect(results.get('denied')?.structuredError?.code).toBe('permission_denied');
    expect(modeChanges).toEqual([]);
    expect(host.mode).toBe('default');
    expect(onPermissionRequired).toHaveBeenCalledOnce();
    expect(existsSync(join(workspace, 'after.txt'))).toBe(false);
  });

  it('the host keeps plan, and the next write is refused', async () => {
    const host: { mode: PermissionMode } = { mode: 'auto' };
    hostMoves(host, 'plan');

    const { results, modeChanges, onPermissionRequired } = await drive({
      host,
      configure: denyOneRead,
      turns: [wave, [writeAfter]],
    });

    expect(modeChanges).toEqual([]);
    expect(host.mode).toBe('plan');
    expect(results.get('write')?.structuredError?.code).toBe('plan_mode_blocked');
    expect(onPermissionRequired).not.toHaveBeenCalled();
    expect(existsSync(join(workspace, 'after.txt'))).toBe(false);
  });

  it('a call reported as parallel_state_mutation leaves the mode as it was', async () => {
    const registry = createDefaultRegistry();
    registry.register({
      name: 'ParallelModeWriter',
      description: 'A parallel tool that writes the mode on its context',
      parameters: { type: 'object', properties: {} },
      policy: { concurrency: 'parallel' },
      execute: async (_args, context) => {
        context.currentMode = 'auto';
        return toolSuccess('ran');
      },
    });
    const host: { mode: PermissionMode } = { mode: 'default' };

    const { results, modeChanges, onPermissionRequired } = await drive({
      host,
      registry,
      answer: 'allow',
      turns: [[{ id: 'writer', name: 'ParallelModeWriter', arguments: {} }], [writeAfter]],
    });

    expect(results.get('writer')?.structuredError?.code).toBe('parallel_state_mutation');
    expect(modeChanges).toEqual([]);
    expect(host.mode).toBe('default');
    // Both calls asked: the writer, and the write the mode it wrote would have let through.
    expect(onPermissionRequired).toHaveBeenCalledTimes(2);
  });

  it('a wave that leaves the host alone changes nothing', async () => {
    const host: { mode: PermissionMode } = { mode: 'auto' };

    const { results, modeChanges } = await drive({ host, turns: [wave] });

    expect(results.get('a')?.status).toBe('success');
    expect(results.get('denied')?.status).toBe('success');
    expect(modeChanges).toEqual([]);
    expect(host.mode).toBe('auto');
  });
});

describe('a serial call can', () => {
  it('EnterPlanMode writes plan back, and the next write is refused', async () => {
    const host: { mode: PermissionMode } = { mode: 'default' };

    const { results, modeChanges, onPermissionRequired } = await drive({
      host,
      turns: [[{ id: 'enter', name: 'EnterPlanMode', arguments: {} }], [writeAfter]],
    });

    expect(results.get('enter')?.status).toBe('success');
    expect(modeChanges).toEqual(['plan']);
    expect(host.mode).toBe('plan');
    expect(results.get('write')?.structuredError?.code).toBe('plan_mode_blocked');
    expect(onPermissionRequired).not.toHaveBeenCalled();
    expect(existsSync(join(workspace, 'after.txt'))).toBe(false);
  });
});
