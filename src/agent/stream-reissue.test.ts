import { describe, it, expect } from 'vitest';
import { runAgentLoop } from './loop.js';
import { createRegistry } from '../tools/registry.js';
import { defaultConfig } from '../test/fixtures.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type { Provider } from '../provider/index.js';
import type { AgentTerminalOutcome } from '../types/terminal.js';
import type { Message } from '../types/messages.js';

function callbacks(
  onTerminal: (outcome: AgentTerminalOutcome) => void,
  errors: string[] = [],
): AgentLoopCallbacks {
  return {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onError: (error: string) => errors.push(error),
    onTurnStart: () => {},
    onDone: () => {},
    onTerminal,
  } as unknown as AgentLoopCallbacks;
}

function configWith(recoveries: number) {
  const config = defaultConfig();
  // Transport faults and output caps draw on separate allowances so a large
  // generated file cannot drain the budget a real socket drop needs. The fixture
  // zeroes both, so a test that wants either must ask for it; passing 0 here is
  // what asserts today's byte-for-byte behaviour.
  config.retry = {
    ...config.retry,
    streamReissueAttempts: recoveries,
    outputCapContinuations: recoveries,
  };
  return config;
}

async function run(
  streamReissueAttempts: number,
  provider: Provider,
): Promise<{ outcome?: AgentTerminalOutcome; errors: string[]; history: Message[] }> {
  let outcome: AgentTerminalOutcome | undefined;
  const errors: string[] = [];
  const history = await runAgentLoop(
    configWith(streamReissueAttempts),
    createRegistry(),
    'do the work',
    [],
    callbacks((value) => (outcome = value), errors),
    'auto',
    { provider, isNewSession: false },
  );
  return { outcome, errors, history };
}

describe('re-issuing a turn after a transport failure', () => {
  it('recovers a stalled stream instead of ending the run', async () => {
    let attempt = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        attempt++;
        if (attempt === 1) {
          yield { type: 'error', error: 'stream stalled', errorCode: 'stream_stall' };
          return;
        }
        yield { type: 'text', content: 'finished' };
        yield { type: 'done' };
      },
    } as unknown as Provider;

    const { outcome, errors } = await run(3, provider);

    expect(attempt).toBe(2);
    expect(outcome?.status).toBe('completed');
    // A recoverable hiccup must not be reported to the host as a run error.
    expect(errors).toEqual([]);
  });

  it('re-sends onto the committed history, with dangling tool calls already settled', async () => {
    // The idempotency anchor: the loop settles every dangling tool_use with a
    // `cancelled` result before it gives up, so the re-issue appends to a history
    // the provider still accepts and no tool runs twice.
    let attempt = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        attempt++;
        if (attempt === 1) {
          yield { type: 'text', content: 'starting' };
          yield {
            type: 'tool_call',
            toolCall: { id: 'call-1', name: 'Read', arguments: { file_path: 'x.ts' } },
          };
          yield { type: 'error', error: 'socket closed', errorCode: 'transport_interrupted' };
          return;
        }
        yield { type: 'text', content: 'recovered' };
        yield { type: 'done' };
      },
    } as unknown as Provider;

    const { outcome, history } = await run(3, provider);

    expect(outcome?.status).toBe('completed');
    const partial = history.find((message) => message.toolCalls?.some((c) => c.id === 'call-1'));
    expect(partial?.toolResults).toHaveLength(1);
    expect(partial?.toolResults?.[0].status).toBe('cancelled');
  });

  it('gives up with the real outcome once the attempts are spent', async () => {
    let attempt = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        attempt++;
        yield { type: 'error', error: 'stream stalled', errorCode: 'stream_stall' };
      },
    } as unknown as Provider;

    const { outcome, errors } = await run(2, provider);

    // Two re-issues on top of the first attempt, then the original diagnosis is
    // preserved rather than replaced by a generic one.
    expect(attempt).toBe(3);
    expect(outcome).toMatchObject({ status: 'timed_out', reason: 'stream_stall' });
    expect(errors).toHaveLength(1);
  });

  it('reproduces the previous end-the-run behavior at 0 attempts', async () => {
    let attempt = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        attempt++;
        yield { type: 'error', error: 'stream stalled', errorCode: 'stream_stall' };
      },
    } as unknown as Provider;

    const { outcome } = await run(0, provider);

    expect(attempt).toBe(1);
    expect(outcome).toMatchObject({ status: 'timed_out', reason: 'stream_stall' });
  });

  it('does not re-issue a context overflow', async () => {
    // Re-sending the same oversized request reproduces the same failure; the
    // loop's own compaction recovery owns this case.
    let attempt = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        attempt++;
        yield {
          type: 'error',
          error: 'maximum context length exceeded',
          errorCode: 'context_overflow',
        };
      },
    } as unknown as Provider;

    const { outcome } = await run(3, provider);

    expect(attempt).toBe(1);
    expect(outcome?.reason).toBe('context_overflow');
  });

  it('treats an output cap as continuable rather than a protocol error', async () => {
    let attempt = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        attempt++;
        if (attempt === 1) {
          yield { type: 'text', content: 'a very long file, truncated' };
          yield { type: 'done', finishReasons: ['length'] };
          return;
        }
        yield { type: 'text', content: 'the rest' };
        yield { type: 'done' };
      },
    } as unknown as Provider;

    const { outcome } = await run(3, provider);

    expect(attempt).toBe(2);
    expect(outcome?.status).toBe('completed');
  });
});

describe('a rejected credential parks rather than retries', () => {
  it('does not spend transport attempts on an auth failure', async () => {
    // Retrying a rejected key is pointless; before this it fell through to
    // provider_error, which is re-issuable, and burned every attempt.
    let attempt = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        attempt++;
        yield { type: 'error', error: 'HTTP 401 invalid api key', errorCode: 'auth' };
      },
    } as unknown as Provider;

    const { outcome } = await run(3, provider);

    expect(attempt).toBe(1);
    expect(outcome).toMatchObject({ status: 'failed', reason: 'credentials_rejected' });
  });

  it('treats a spent quota the same way', async () => {
    let attempt = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        attempt++;
        yield { type: 'error', error: 'HTTP 402 payment required', errorCode: 'quota' };
      },
    } as unknown as Provider;

    const { outcome } = await run(3, provider);
    expect(attempt).toBe(1);
    expect(outcome?.reason).toBe('credentials_rejected');
  });
});

describe('the shape of a re-issued request', () => {
  it('never ends a re-sent request with an assistant message', async () => {
    // Assistant prefill is rejected by Anthropic whenever extended thinking is on,
    // which is the default for every Opus and Sonnet model here. The 400 comes back
    // as `provider_error`, whose recovery is `reissue` — so the loop re-sent the
    // identical rejected request until the allowance ran out, then reported a
    // transport fault for what was really a malformed request.
    const seen: Array<string | undefined> = [];
    let attempt = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* (_config: unknown, messages: Array<{ role: string }>) {
        attempt++;
        seen.push(messages.at(-1)?.role);
        if (attempt === 1) {
          yield { type: 'text', content: 'a very long file, truncated' };
          yield { type: 'done', finishReasons: ['length'] };
          return;
        }
        yield { type: 'text', content: 'the rest' };
        yield { type: 'done' };
      },
    } as unknown as Provider;

    const { outcome } = await run(3, provider);

    expect(attempt).toBe(2);
    expect(outcome?.status).toBe('completed');
    // The retry must have been handed a user turn, not the truncated assistant one.
    expect(seen[1]).toBe('user');
  });

  it('gives the replayed turn its own message identity', async () => {
    // `assistantMessageId` is keyed on `turn`, which does not change on a re-issue,
    // so the truncated partial and its replacement shared one session `eventId`:
    // `load()` collapsed them and `/rewind` could address neither.
    const ids = new Set<string>();
    let attempt = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        attempt++;
        if (attempt === 1) {
          yield { type: 'error', error: 'stream stalled', errorCode: 'stream_stall' };
          return;
        }
        yield { type: 'text', content: 'finished' };
        yield { type: 'done' };
      },
    } as unknown as Provider;

    const { history } = await run(3, provider);
    for (const message of history) {
      if (message.role === 'assistant') ids.add(message.id);
    }
    const assistants = history.filter((message) => message.role === 'assistant');
    expect(ids.size).toBe(assistants.length);
  });
});
