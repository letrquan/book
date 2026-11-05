import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLoop } from './loop.js';
import { createRegistry } from '../tools/registry.js';
import { toolFailure, toolSuccess } from '../tools/result.js';
import { defaultConfig } from '../test/fixtures.js';
import { SessionRuntime } from '../session/runtime.js';
import type { Provider } from '../provider/index.js';
import type { AgentLoopCallbacks, ProviderStreamEvent } from '../types/providers.js';
import type { AgentTerminalOutcome } from '../types/terminal.js';
import type { Message } from '../types/messages.js';
import type { ToolResult } from '../types/tools.js';
import type { HookEntry } from '../settings.js';

/**
 * A run cancelled while a tool runs (#669): the tool stops, and its cancelled result still reaches
 * the host and the history. Before the fix, the PostToolUse hook step threw the abort reason
 * first, so the result was never published — the transcript row kept saying `Running…` — and the
 * step never reached the history.
 */

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** A PostToolUse hook that would scrub the output, if it ever finished: it takes `delayMs`. */
function scrubbingHook(delayMs: number): HookEntry {
  const dir = mkdtempSync(join(tmpdir(), 'book-cancelled-tool-hooks-'));
  scratchDirs.push(dir);
  const file = join(dir, 'scrub.mjs');
  writeFileSync(
    file,
    [
      "let raw = '';",
      'for await (const chunk of process.stdin) raw += chunk;',
      `setTimeout(() => process.stdout.write('{"action":"modify","modifiedOutput":"scrubbed"}'), ${delayMs});`,
    ].join('\n'),
  );
  return { command: `node "${file}"`, env: {} };
}

/** A hook of any event that sits for `delayMs` and so can be cancelled under. */
function sleepingHook(delayMs: number): HookEntry {
  const dir = mkdtempSync(join(tmpdir(), 'book-cancelled-tool-hooks-'));
  scratchDirs.push(dir);
  const file = join(dir, 'sleep.mjs');
  writeFileSync(file, `setTimeout(() => {}, ${delayMs});\n`);
  return { command: `node "${file}"`, env: {} };
}

/** The model calls `Bash` once; the run never gets a second request. */
function oneCallProvider(): Provider {
  return {
    id: 'scripted',
    stream: async function* (): AsyncGenerator<ProviderStreamEvent> {
      yield {
        type: 'tool_call',
        toolCall: { id: 'call-1', name: 'Bash', arguments: { command: 'cat config.env' } },
      };
      yield { type: 'done' };
    },
  } as unknown as Provider;
}

function loopCallbacks(overrides: Partial<AgentLoopCallbacks> = {}): AgentLoopCallbacks {
  return {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onError: () => {},
    onTurnStart: () => {},
    onDone: () => {},
    ...overrides,
  } as unknown as AgentLoopCallbacks;
}

describe('a run cancelled during a tool (#669)', () => {
  it('publishes the cancelled result and keeps the step in history', async () => {
    const registry = createRegistry();
    registry.register({
      name: 'Bash',
      description: 'A foreground command that runs until the run is cancelled.',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
      execute: async (_args, context): Promise<ToolResult> => {
        await new Promise<void>((resolve) => {
          if (context.signal?.aborted) resolve();
          context.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return toolFailure('Command cancelled', { status: 'cancelled', code: 'cancelled' });
      },
    });
    let requests = 0;
    const provider = {
      id: 'scripted',
      stream: async function* (): AsyncGenerator<ProviderStreamEvent> {
        requests++;
        yield {
          type: 'tool_call',
          toolCall: { id: 'call-1', name: 'Bash', arguments: { command: 'sleep 10' } },
        };
        yield { type: 'done' };
      },
    } as unknown as Provider;
    const controller = new AbortController();
    const results: ToolResult[] = [];
    let outcome: AgentTerminalOutcome | undefined;

    const history: Message[] = await runAgentLoop(
      defaultConfig(),
      registry,
      'start',
      [],
      loopCallbacks({
        // Esc while the command runs. The TUI's cancel aborts with a reason object, not an Error.
        onToolCall: () => {
          setTimeout(() => controller.abort({ bookTerminalReason: 'user_cancelled' }), 10);
        },
        onToolResult: (result: ToolResult) => results.push(result),
        onTerminal: (value: AgentTerminalOutcome) => (outcome = value),
      }),
      'bypassPermissions',
      {
        isNewSession: false,
        runtime: new SessionRuntime(),
        provider,
        signal: controller.signal,
      },
    );

    expect(requests).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolCallId: 'call-1', status: 'cancelled' });
    const step = history.find((message) => message.toolCalls?.some((c) => c.id === 'call-1'));
    expect(step?.toolResults?.map((result) => result.status)).toEqual(['cancelled']);
    expect(outcome?.status).toBe('cancelled');
  });

  it.each([
    ['during the call', 0],
    ['while its PostToolUse hooks run', 5_000],
  ])(
    'withholds the output of a call whose PostToolUse hooks a cancel skipped (%s)',
    async (_when, hookDelayMs) => {
      const controller = new AbortController();
      const registry = createRegistry();
      registry.register({
        name: 'Bash',
        description: 'Prints what a PostToolUse hook is configured to scrub.',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
        execute: async (): Promise<ToolResult> => {
          if (hookDelayMs === 0) controller.abort({ bookTerminalReason: 'user_cancelled' });
          return toolSuccess('DB_PASSWORD=hunter2');
        },
      });
      const config = defaultConfig();
      config.settings.hooks.PostToolUse = [scrubbingHook(hookDelayMs)];
      const results: ToolResult[] = [];

      const history = await runAgentLoop(
        config,
        registry,
        'start',
        [],
        loopCallbacks({
          onToolResult: (result: ToolResult) => results.push(result),
          // Esc while the hook is still working on the output.
          onHookEvent: (event: string) => {
            if (event === 'PostToolUse' && hookDelayMs > 0) {
              setTimeout(() => controller.abort({ bookTerminalReason: 'user_cancelled' }), 50);
            }
          },
        }),
        'bypassPermissions',
        {
          isNewSession: false,
          runtime: new SessionRuntime(),
          provider: oneCallProvider(),
          signal: controller.signal,
        },
      );

      // The row still settles, and the step is still recorded, but with none of the output the
      // hook never got to check.
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ toolCallId: 'call-1', status: 'cancelled' });
      expect(results[0]!.structuredError?.message).toContain('withheld');
      expect(JSON.stringify(results)).not.toContain('hunter2');
      expect(JSON.stringify(history)).not.toContain('hunter2');
    },
  );
});

describe('a run cancelled while a PreToolUse hook runs (#698)', () => {
  it('settles the call as cancelled before it started and ends the run cancelled', async () => {
    const controller = new AbortController();
    const registry = createRegistry();
    let executed = 0;
    registry.register({
      name: 'Bash',
      description: 'Must never run: the cancel lands inside its PreToolUse hook.',
      parameters: { type: 'object', properties: { command: { type: 'string' } } },
      execute: async (): Promise<ToolResult> => {
        executed++;
        return toolSuccess('ran');
      },
    });
    const config = defaultConfig();
    config.settings.hooks.PreToolUse = [sleepingHook(5_000)];
    const results: ToolResult[] = [];
    let done = 0;
    let outcome: AgentTerminalOutcome | undefined;

    const history = await runAgentLoop(
      config,
      registry,
      'start',
      [],
      loopCallbacks({
        // Esc once the hook has started, not on a timer that could land before the call does.
        onHookEvent: (event: string) => {
          if (event === 'PreToolUse') {
            setTimeout(() => controller.abort({ bookTerminalReason: 'user_cancelled' }), 50);
          }
        },
        onToolResult: (result: ToolResult) => results.push(result),
        onDone: () => done++,
        onTerminal: (value: AgentTerminalOutcome) => (outcome = value),
      }),
      'bypassPermissions',
      {
        isNewSession: false,
        runtime: new SessionRuntime(),
        provider: oneCallProvider(),
        signal: controller.signal,
      },
    );

    expect(executed).toBe(0);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      toolCallId: 'call-1',
      status: 'cancelled',
      structuredError: { code: 'cancelled_before_start' },
    });
    const step = history.find((message) => message.toolCalls?.some((c) => c.id === 'call-1'));
    expect(step?.toolResults?.map((result) => result.status)).toEqual(['cancelled']);
    expect(outcome?.status).toBe('cancelled');
    expect(done).toBe(1);
  });
});

describe('a run cancelled while the UserPromptSubmit hook runs', () => {
  it('ends the run cancelled instead of rejecting', async () => {
    const controller = new AbortController();
    const config = defaultConfig();
    config.settings.hooks.UserPromptSubmit = [sleepingHook(5_000)];
    let requests = 0;
    let outcome: AgentTerminalOutcome | undefined;
    const provider = {
      id: 'scripted',
      stream: async function* (): AsyncGenerator<ProviderStreamEvent> {
        requests++;
        yield { type: 'done' };
      },
    } as unknown as Provider;

    const history = await runAgentLoop(
      config,
      createRegistry(),
      'start',
      [],
      loopCallbacks({
        onHookEvent: (event: string) => {
          if (event === 'UserPromptSubmit') {
            setTimeout(() => controller.abort({ bookTerminalReason: 'user_cancelled' }), 100);
          }
        },
        onTerminal: (value: AgentTerminalOutcome) => (outcome = value),
      }),
      'bypassPermissions',
      {
        isNewSession: false,
        runtime: new SessionRuntime(),
        provider,
        signal: controller.signal,
      },
    );

    expect(requests).toBe(0);
    expect(outcome?.status).toBe('cancelled');
    // The prompt is kept, as for any cancelled run: a resumed session still has it.
    expect(history.map((message) => message.content)).toContain('start');
  });
});
