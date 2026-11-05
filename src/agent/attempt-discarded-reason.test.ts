import { describe, expect, it } from 'vitest';
import { runAgentLoop } from './loop.js';
import { createRegistry } from '../tools/registry.js';
import { defaultConfig } from '../test/fixtures.js';
import type { Provider } from '../provider/index.js';
import type {
  AgentLoopCallbacks,
  AttemptDiscardReason,
  ProviderStreamEvent,
} from '../types/providers.js';

/**
 * `onAttemptDiscarded` names what made the loop take an attempt back (#686). It used to carry
 * nothing, so the session wrote `empty_response` for every discard.
 */

const DSML =
  '<｜DSML｜ calls>\n<｜DSML｜ invoke name="Grep">\n<｜DSML｜ parameter name="pattern" string="true">queue</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>';

const ENVELOPE =
  '[Error] An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID bef67f5c-a3e8-4c5e-9a88-ba86facfddfa in your message.';

/** The first request gets `first`; every later one answers normally. */
function firstThenAnswer(first: ProviderStreamEvent[]): Provider {
  let calls = 0;
  return {
    id: 'scripted',
    stream: async function* () {
      calls++;
      if (calls === 1) {
        for (const event of first) yield event;
        return;
      }
      yield { type: 'text', content: 'recovered answer' };
      yield { type: 'done', finishReasons: ['stop'] };
    },
  };
}

async function discardReasons(first: ProviderStreamEvent[]): Promise<AttemptDiscardReason[]> {
  const reasons: AttemptDiscardReason[] = [];
  await runAgentLoop(
    defaultConfig({
      maxTurns: 1,
      retry: { ...defaultConfig().retry, baseDelayMs: 1, maxDelayMs: 4, streamReissueAttempts: 1 },
    }),
    createRegistry(),
    'hello',
    [],
    {
      onText: () => {},
      onToolCall: () => {},
      onToolResult: () => {},
      onError: () => {},
      onTurnStart: () => {},
      onDone: () => {},
      onPermissionRequired: async () => 'allow' as const,
      onAttemptDiscarded: (reason) => reasons.push(reason),
    } as AgentLoopCallbacks,
    'default',
    { provider: firstThenAnswer(first), isNewSession: false },
  );
  return reasons;
}

describe('the reason an attempt was discarded (#686)', () => {
  it('names an empty completion', async () => {
    expect(await discardReasons([{ type: 'done' }])).toEqual(['empty_response']);
  });

  it('names a content_filter stop', async () => {
    expect(
      await discardReasons([
        { type: 'text', content: 'x'.repeat(48) },
        { type: 'done', finishReasons: ['content_filter'] },
      ]),
    ).toEqual(['content_filter']);
  });

  it('names an upstream error envelope streamed as content', async () => {
    expect(
      await discardReasons([
        { type: 'text', content: ENVELOPE },
        {
          type: 'done',
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
          finishReasons: ['stop'],
        },
      ]),
    ).toEqual(['error_envelope']);
  });

  it('names a tool call written out as plain text', async () => {
    expect(
      await discardReasons([
        { type: 'text', content: DSML },
        { type: 'done', finishReasons: ['stop'] },
      ]),
    ).toEqual(['malformed_tool_call']);
  });
});
