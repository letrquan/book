import { describe, expect, it } from 'vitest';
import { runAgentLoop } from './loop.js';
import { createRegistry } from '../tools/registry.js';
import { toolFailure } from '../tools/result.js';
import { defaultConfig } from '../test/fixtures.js';
import { SessionRuntime } from '../session/runtime.js';
import type { Provider } from '../provider/index.js';
import type { AgentLoopCallbacks, ProviderStreamEvent } from '../types/providers.js';
import type { AgentTerminalOutcome } from '../types/terminal.js';
import type { Message } from '../types/messages.js';
import type { ToolResult } from '../types/tools.js';

/**
 * A run cancelled while a tool runs (#669): the tool stops, and its cancelled result still reaches
 * the host and the history. Before the fix, the PostToolUse hook step threw the abort reason
 * first, so the result was never published — the transcript row kept saying `Running…` — and the
 * step never reached the history.
 */

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
});
