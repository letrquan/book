import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runHooks } from './hooks.js';
import type { HookEntry, HookEvent } from './settings.js';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dir: string;
const ctx = (overrides: Record<string, unknown> = {}) => ({
  workspace: dir,
  event: 'PreToolUse' as HookEvent,
  toolName: 'Bash',
  toolArgs: { command: 'ls' },
  ...overrides,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-hooks-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('runHooks — empty input', () => {
  it('returns empty array when no hooks configured', async () => {
    const results = await runHooks([], 'PreToolUse', ctx());
    expect(results).toEqual([]);
  });
});

describe('runHooks — continue', () => {
  it('runs a hook that exits 0 and returns continue', async () => {
    const hook: HookEntry = {
      command:
        process.platform === 'win32'
          ? 'echo {"action":"continue"}'
          : 'echo \'{"action":"continue"}\'',
      env: {},
    };
    const results = await runHooks([hook], 'Stop', ctx({ event: 'Stop' as HookEvent }));
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('continue');
  });

  it('treats exit code 0 with non-JSON stdout as continue', async () => {
    const hook: HookEntry = {
      command: process.platform === 'win32' ? 'echo just text' : 'echo "just text"',
      env: {},
    };
    const results = await runHooks([hook], 'Stop', ctx({ event: 'Stop' as HookEvent }));
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('continue');
  });
});

describe('runHooks — block', () => {
  it('detects exit code 2 as block', async () => {
    const hook: HookEntry = {
      command:
        process.platform === 'win32'
          ? 'echo {"action":"block","message":"nope"} & exit 2'
          : 'echo \'{"action":"block","message":"nope"}\' && exit 2',
      env: {},
    };
    const results = await runHooks([hook], 'PreToolUse', ctx());
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('block');
    expect(results[0].message).toBe('nope');
  });

  it('stops after first block on blocking events (PreToolUse)', async () => {
    const hook1: HookEntry = {
      command: process.platform === 'win32' ? 'exit 2' : 'exit 2',
      env: {},
    };
    const hook2: HookEntry = {
      command: process.platform === 'win32' ? 'echo never-runs' : 'echo "never-runs"',
      env: {},
    };
    const results = await runHooks([hook1, hook2], 'PreToolUse', ctx());
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('block');
  });
});

describe('runHooks — modify', () => {
  it('returns modify action with modified prompt', async () => {
    const hook: HookEntry = {
      command:
        process.platform === 'win32'
          ? 'echo {"action":"modify","message":"new prompt"}'
          : 'echo \'{"action":"modify","message":"new prompt"}\'',
      env: {},
    };
    const results = await runHooks(
      [hook],
      'UserPromptSubmit',
      ctx({ event: 'UserPromptSubmit' as HookEvent, userPrompt: 'old', toolName: undefined }),
    );
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('modify');
    expect(results[0].modifiedPrompt).toBe('new prompt');
  });
});

describe('runHooks — timeout', () => {
  it('skips a hook that exceeds the 10s timeout', async () => {
    const hook: HookEntry = {
      command: process.platform === 'win32' ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30',
      env: {},
    };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const results = await runHooks([hook], 'Stop', ctx({ event: 'Stop' as HookEvent }));
    warnSpy.mockRestore();
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('continue');
  }, 15000);
});

describe('runHooks — matcher filtering', () => {
  it('runs hook when matcher matches the tool call', async () => {
    const hook: HookEntry = {
      matcher: 'Bash(ls *)',
      command:
        process.platform === 'win32'
          ? 'echo {"action":"block"} & exit 2'
          : 'echo \'{"action":"block"}\' && exit 2',
      env: {},
    };
    const results = await runHooks([hook], 'PreToolUse', ctx());
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('block');
  });

  it('skips hook when matcher does not match', async () => {
    const hook: HookEntry = {
      matcher: 'Bash(rm *)',
      command: process.platform === 'win32' ? 'exit 2' : 'exit 2',
      env: {},
    };
    const results = await runHooks([hook], 'PreToolUse', ctx({ toolArgs: { command: 'ls' } }));
    expect(results.length).toBe(0);
  });

  it('runs hook with no matcher for all tool calls', async () => {
    const hook: HookEntry = {
      command: process.platform === 'win32' ? 'exit 2' : 'exit 2',
      env: {},
    };
    const results = await runHooks([hook], 'PreToolUse', ctx());
    expect(results.length).toBe(1);
    expect(results[0].action).toBe('block');
  });
});

describe('runHooks — env vars', () => {
  it('passes BOOK_WORKSPACE to the hook', async () => {
    const scriptPath = join(dir, 'test-hook.sh');
    writeFileSync(
      scriptPath,
      `#!/bin/bash
if [ "$BOOK_WORKSPACE" = "${dir.replace(/\\/g, '/')}" ]; then
  echo '{"action":"continue"}'
else
  echo '{"action":"block","message":"wrong workspace"}'
  exit 2
fi`,
    );
    const hook: HookEntry = {
      command: process.platform === 'win32' ? `echo {"action":"continue"}` : `bash "${scriptPath}"`,
      env: {},
    };
    const results = await runHooks([hook], 'Stop', ctx({ event: 'Stop' as HookEvent }));
    expect(results[0].action).toBe('continue');
  });
});
