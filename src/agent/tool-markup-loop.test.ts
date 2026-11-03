/**
 * A reply that is tool-call markup in plain text (#667).
 *
 * A route that cannot parse a model's tool-call syntax passes it on as `content`, so the turn
 * calls no tool and used to end the run as `completed` / `normal_completion`. It is re-asked once
 * like an empty completion, and the run fails as `malformed_tool_call` when the reply comes back
 * the same way.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runAgentLoop } from './loop.js';
import { finalAnswerText } from './final-answer.js';
import { createSteeringInbox, type SteeringInboxHandle } from './steering.js';
import { createDefaultRegistry, createRegistry } from '../tools/registry.js';
import { SessionRuntime } from '../session/runtime.js';
import { defaultConfig } from '../test/fixtures.js';
import { terminalRecovery, type AgentTerminalOutcome } from '../types/terminal.js';
import type { AgentLoopCallbacks, ProviderStreamEvent } from '../types/providers.js';
import type { AgentConfig } from '../types/runtime.js';
import type { Message } from '../types/messages.js';
import type { Provider } from '../provider/index.js';
import { isContextOverflowError, isOversizedForRateLimit } from '../provider/reliability.js';

/** The scenario text of #667, as the issue wrote it. */
const DSML =
  '<｜DSML｜ calls>\n<｜DSML｜ invoke name="Grep">\n<｜DSML｜ parameter name="pattern" string="true">queue</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>';

/** One scripted reply: plain text, or the exact events of the stream. */
type Reply = string | ProviderStreamEvent[];

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) rmSync(workspace, { recursive: true, force: true });
});

function callbacks(overrides: Partial<AgentLoopCallbacks> = {}): AgentLoopCallbacks {
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

/** Request number `n` gets reply `n`; once the script runs out its last reply repeats. */
function scripted(replies: Reply[]): { provider: Provider; calls: () => number } {
  let calls = 0;
  const provider: Provider = {
    id: 'scripted',
    stream: async function* () {
      const reply = replies[Math.min(calls, replies.length - 1)];
      calls++;
      if (typeof reply === 'string') {
        yield { type: 'text', content: reply };
        yield { type: 'done', finishReasons: ['stop'] };
        return;
      }
      for (const event of reply) yield event;
    },
  };
  return { provider, calls: () => calls };
}

interface Observed {
  history: Message[];
  calls: number;
  errors: string[];
  outcomes: AgentTerminalOutcome[];
  discards: number;
  retries: Array<[string, number, number, number, string | undefined]>;
  texts: string[];
}

async function run(
  replies: Reply[],
  options: {
    config?: Partial<AgentConfig>;
    registry?: ReturnType<typeof createRegistry>;
  } = {},
): Promise<Observed> {
  const { provider, calls } = scripted(replies);
  const observed: Observed = {
    history: [],
    calls: 0,
    errors: [],
    outcomes: [],
    discards: 0,
    retries: [],
    texts: [],
  };
  observed.history = await runAgentLoop(
    defaultConfig({ maxTurns: 1, ...options.config }),
    options.registry ?? createRegistry(),
    'find the queue',
    [],
    callbacks({
      onText: (text) => observed.texts.push(text),
      onError: (error) => observed.errors.push(error),
      onTerminal: (outcome) => observed.outcomes.push(outcome),
      onAttemptDiscarded: () => observed.discards++,
      onRetry: (phase, attempt, max, delayMs, reason) =>
        observed.retries.push([phase, attempt, max, delayMs, reason]),
    }),
    'default',
    { provider, isNewSession: false },
  );
  observed.calls = calls();
  return observed;
}

/** A budget that would re-issue a turn twice, which the markup retry must not draw on. */
const generousRetries = (): AgentConfig['retry'] => ({
  ...defaultConfig().retry,
  baseDelayMs: 1,
  maxDelayMs: 4,
  streamReissueAttempts: 2,
});

describe('a reply that is tool-call markup (#667)', () => {
  it('asks again, and ends normally when the second reply is an answer', async () => {
    const seen = await run([DSML, 'The queue is drained in FIFO order.']);

    expect(seen.calls).toBe(2);
    expect(seen.errors).toEqual([]);
    expect(seen.outcomes[0]).toMatchObject({ status: 'completed', reason: 'normal_completion' });
    // The abandoned attempt is taken back from the host, and never reaches the history.
    expect(seen.discards).toBe(1);
    expect(seen.history.some((message) => message.content.includes('DSML'))).toBe(false);
    expect(finalAnswerText(seen.history)).toBe('The queue is drained in FIFO order.');
  });

  it('reports the retry to the host the way an empty completion is reported', async () => {
    const seen = await run([DSML, 'done'], { config: { retry: generousRetries() } });

    // Base delay doubling per attempt, as a transport re-issue waits: 1 * 2.
    expect(seen.retries).toEqual([['reissue', 1, 1, 2, 'malformed_tool_call']]);
  });

  it('asks again even when the re-issue allowance is zero', async () => {
    // `streamReissueAttempts: 0` describes the transport budget, as for an empty completion.
    const seen = await run([DSML, 'done'], {
      config: { retry: { ...defaultConfig().retry, streamReissueAttempts: 0 } },
    });

    expect(seen.calls).toBe(2);
    expect(seen.outcomes[0]).toMatchObject({ status: 'completed' });
  });

  it('fails as malformed_tool_call when the reply comes back as markup again', async () => {
    const seen = await run([DSML], { config: { retry: generousRetries() } });

    // Exactly one retry: not the stream-level re-issues the budget above would allow, which a
    // `provider_error` outcome would have drawn on and re-sent with a `[continuation]` prompt.
    expect(seen.calls).toBe(2);
    expect(seen.outcomes).toHaveLength(1);
    // Nothing of either reply is left, so the run produced no partial output.
    expect(seen.outcomes[0]).toMatchObject({
      status: 'failed',
      reason: 'malformed_tool_call',
      partialOutput: false,
    });
    expect(terminalRecovery(seen.outcomes[0])).toBe('none');
    expect(seen.errors).toHaveLength(1);
    expect(seen.outcomes[0].message).toBe(seen.errors[0]);
    expect(seen.errors[0]).toContain('DeepSeek DSML');
    expect(seen.errors[0]).toMatch(/tool call/i);
    expect(seen.history.filter((message) => message.derivedContent)).toEqual([]);
    expect(seen.retries).toHaveLength(1);
    // The host is told to drop both replies, so what it shows and what a consumer of the stream
    // keeps is what the history records.
    expect(seen.discards).toBe(2);
  });

  it('leaves the markup out of the answer and the history of the failed run', async () => {
    const seen = await run([DSML]);

    // An unexecuted Grep is not what the model answered: a print run must not hand it on.
    expect(finalAnswerText(seen.history)).toBe('');
    expect(seen.history.some((message) => message.content.includes('DSML'))).toBe(false);
    expect(seen.history.map((message) => message.role)).toEqual(['user']);
  });

  it('drops the reasoning that came with the replies too', async () => {
    const reply: ProviderStreamEvent[] = [
      { type: 'reasoning', reasoning: 'I should search for the queue.' },
      { type: 'text', content: DSML },
      { type: 'done', finishReasons: ['stop'] },
    ];
    const seen = await run([reply]);

    expect(seen.outcomes[0]).toMatchObject({ status: 'failed', reason: 'malformed_tool_call' });
    // No assistant message is left to carry it into a resumed session.
    expect(seen.history.map((message) => message.role)).toEqual(['user']);
  });

  it('words its error clear of the overflow and rate-limit classifiers', async () => {
    // The failure goes through the stream-error path, which reads the message for an overflow
    // before it settles the outcome: a message the classifiers took for one would have the run
    // compact and retry instead of ending.
    const seen = await run([DSML], { config: { autoCompactEnabled: true } });

    expect(seen.outcomes[0]).toMatchObject({ reason: 'malformed_tool_call' });
    expect(seen.calls).toBe(2);
    expect(isContextOverflowError(seen.errors[0])).toBe(false);
    expect(isOversizedForRateLimit(seen.errors[0])).toBe(false);
  });

  it('names the format the reply was written in', async () => {
    const hermes = await run(['<tool_call>\n{"name": "Grep", "arguments": {}}\n</tool_call>']);
    const v3 = await run([
      '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>Grep\n```json\n{}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
    ]);

    expect(hermes.outcomes[0]).toMatchObject({ reason: 'malformed_tool_call' });
    expect(hermes.errors[0]).toContain('<tool_call> tags');
    expect(v3.outcomes[0]).toMatchObject({ reason: 'malformed_tool_call' });
    expect(v3.errors[0]).toContain('DeepSeek tool-call tokens');
  });

  it('asks again on a later turn, after the model has been calling tools', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-markup-loop-'));
    workspaces.push(workspace);
    const seen = await run(
      [
        [
          {
            type: 'tool_call',
            toolCall: { id: 'call-1', name: 'Glob', arguments: { pattern: '*.ts' } },
          },
          { type: 'done', finishReasons: ['tool_calls'] },
        ],
        DSML,
        'There is nothing to find.',
      ],
      { config: { maxTurns: 3, workspace }, registry: createDefaultRegistry() },
    );

    expect(seen.calls).toBe(3);
    expect(seen.errors).toEqual([]);
    expect(seen.outcomes[0]).toMatchObject({ status: 'completed', reason: 'normal_completion' });
    expect(finalAnswerText(seen.history)).toBe('There is nothing to find.');
  });

  it('still reports the output of earlier turns when a later one fails', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-markup-loop-'));
    workspaces.push(workspace);
    const seen = await run(
      [
        [
          { type: 'text', content: 'Looking for the queue.' },
          {
            type: 'tool_call',
            toolCall: { id: 'call-1', name: 'Glob', arguments: { pattern: '*.ts' } },
          },
          { type: 'done', finishReasons: ['tool_calls'] },
        ],
        DSML,
      ],
      { config: { maxTurns: 3, workspace }, registry: createDefaultRegistry() },
    );

    expect(seen.calls).toBe(3);
    // The narration of turn one stays; only the discarded replies are taken out.
    expect(seen.outcomes[0]).toMatchObject({
      status: 'failed',
      reason: 'malformed_tool_call',
      partialOutput: true,
    });
    expect(seen.discards).toBe(2);
  });

  it('does not read the markup beside a real tool call as the reply', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-markup-loop-'));
    workspaces.push(workspace);
    const seen = await run(
      [
        [
          { type: 'text', content: DSML },
          {
            type: 'tool_call',
            toolCall: { id: 'call-1', name: 'Glob', arguments: { pattern: '*.ts' } },
          },
          { type: 'done', finishReasons: ['tool_calls'] },
        ],
        'done',
      ],
      { config: { maxTurns: 2, workspace }, registry: createDefaultRegistry() },
    );

    expect(seen.calls).toBe(2);
    expect(seen.discards).toBe(0);
    expect(seen.outcomes[0]).toMatchObject({ status: 'completed', reason: 'normal_completion' });
  });

  it('leaves a reply the provider cut off at its output limit to the output-cap path', async () => {
    const seen = await run([
      [
        { type: 'text', content: DSML },
        { type: 'done', finishReasons: ['length'] },
      ],
    ]);

    expect(seen.calls).toBe(1);
    expect(seen.outcomes[0]).toMatchObject({ status: 'failed', reason: 'output_cap' });
  });

  it('does not re-ask when the run was cancelled', async () => {
    const controller = new AbortController();
    let calls = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        calls++;
        yield { type: 'text', content: DSML };
        controller.abort();
        yield { type: 'done', finishReasons: ['stop'] };
      },
    };
    const outcomes: AgentTerminalOutcome[] = [];

    await runAgentLoop(
      defaultConfig({ maxTurns: 1 }),
      createRegistry(),
      'find the queue',
      [],
      callbacks({ onTerminal: (outcome) => outcomes.push(outcome) }),
      'default',
      { provider, isNewSession: false, signal: controller.signal },
    );

    expect(calls).toBe(1);
    expect(outcomes[0]).toMatchObject({ status: 'cancelled' });
  });

  describe('replies that only talk about the format are answers', () => {
    it.each([
      ['a tag named in inline code', 'Qwen wraps each call in `<tool_call>` tags.'],
      [
        'a tag named in prose before more prose',
        'Qwen emits\n<tool_call>\n{}\n</tool_call>\nwhen its parser is off.',
      ],
      ['a fenced example', 'The raw output is:\n\n```xml\n<tool_call>\n{}\n</tool_call>\n```'],
      ['an example in a fence that was never closed', 'The raw output is:\n\n```xml\n' + DSML],
      [
        'a DSML example, then prose',
        `The router sent\n\n\`\`\`\n${DSML}\n\`\`\`\n\nthat is the leak.`,
      ],
    ])('ends normally on the first request for %s', async (_name, text) => {
      const seen = await run([text], { config: { retry: generousRetries() } });

      expect(seen.calls).toBe(1);
      expect(seen.discards).toBe(0);
      expect(seen.errors).toEqual([]);
      expect(seen.outcomes[0]).toMatchObject({ status: 'completed', reason: 'normal_completion' });
      expect(finalAnswerText(seen.history)).toBe(text);
    });
  });
});

describe('a reply that is tool-call markup, beside send-now (#661)', () => {
  type StreamScript = (signal: AbortSignal | undefined) => AsyncGenerator<ProviderStreamEvent>;

  /** A provider whose request `n` runs script `n`, and which hands each script its request's abort. */
  function abortAware(...scripts: StreamScript[]): { provider: Provider; requests: number[] } {
    const requests: number[] = [];
    const provider = {
      id: 'scripted',
      stream: (
        _config: unknown,
        _messages: unknown,
        _tools: unknown,
        options?: { signal?: AbortSignal },
      ) => {
        const script = scripts.shift();
        if (!script) throw new Error('Scripted provider has no request left');
        requests.push(requests.length + 1);
        return script(options?.signal);
      },
    } as unknown as Provider;
    return { provider, requests };
  }

  function abortOf(signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
      if (!signal) return;
      if (signal.aborted) return resolve();
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
  }

  /** The user types a correction and presses the send-now chord. */
  function sendNow(inbox: SteeringInboxHandle, id: string, content: string): void {
    inbox.push({ id, content, timestamp: 1_700_000_000_000 });
    inbox.requestNow();
  }

  async function runWithSteering(inbox: SteeringInboxHandle, provider: Provider) {
    const errors: string[] = [];
    const outcomes: AgentTerminalOutcome[] = [];
    let discards = 0;
    const history = await runAgentLoop(
      defaultConfig(),
      createRegistry(),
      'start',
      [],
      callbacks({
        onError: (error) => errors.push(error),
        onTerminal: (outcome) => outcomes.push(outcome),
        onAttemptDiscarded: () => discards++,
      }),
      'auto',
      { isNewSession: false, runtime: new SessionRuntime(), steering: inbox, provider },
    );
    return { history, errors, outcomes, discards };
  }

  it('does not take a reply that send-now cut off for a finished answer', async () => {
    const inbox = createSteeringInbox();
    // A block with no closing tag is what the markup check reads, but this reply never finished:
    // the user stopped it, and what it said stays as the user read it.
    const cutOff =
      '<｜DSML｜ calls>\n<｜DSML｜ invoke name="Grep">\n<｜DSML｜ parameter name="pattern" string="true">que';
    const { provider, requests } = abortAware(
      async function* (signal) {
        yield { type: 'text', content: cutOff };
        sendNow(inbox, 'steer-1', 'stop and say hi');
        await abortOf(signal);
      },
      async function* () {
        yield { type: 'text', content: 'hi' };
        yield { type: 'done', finishReasons: ['stop'] };
      },
    );

    const seen = await runWithSteering(inbox, provider);

    // The stopped request and the one that answers the steer: no re-ask in between.
    expect(requests).toHaveLength(2);
    expect(seen.discards).toBe(0);
    expect(seen.errors).toEqual([]);
    expect(seen.outcomes[0]).toMatchObject({ status: 'completed', reason: 'normal_completion' });
    expect(finalAnswerText(seen.history)).toBe('hi');
    expect(inbox.hasPending()).toBe(false);
  });

  it('keeps the steer through the re-ask of a reply that had already finished', async () => {
    const inbox = createSteeringInbox();
    // The reply is whole when send-now is pressed, so it is judged like any other and re-asked.
    // The send-now still stands, so it stops the re-ask at once, and the steer goes with the
    // request after it: three requests, and the steer is not lost on the way.
    const { provider, requests } = abortAware(
      async function* () {
        yield { type: 'text', content: DSML };
        yield { type: 'done', finishReasons: ['stop'] };
        sendNow(inbox, 'steer-1', 'also check the cache');
      },
      async function* () {
        yield { type: 'text', content: 'The cache is fine.' };
        yield { type: 'done', finishReasons: ['stop'] };
      },
      async function* () {
        yield { type: 'text', content: 'The cache is fine.' };
        yield { type: 'done', finishReasons: ['stop'] };
      },
    );

    const seen = await runWithSteering(inbox, provider);

    expect(requests).toHaveLength(3);
    expect(seen.errors).toEqual([]);
    expect(seen.outcomes[0]).toMatchObject({ status: 'completed', reason: 'normal_completion' });
    expect(seen.history.some((message) => message.content.includes('DSML'))).toBe(false);
    expect(
      seen.history.some(
        (message) => message.steered && message.content.includes('check the cache'),
      ),
    ).toBe(true);
    expect(finalAnswerText(seen.history)).toBe('The cache is fine.');
    expect(inbox.hasPending()).toBe(false);
  });
});
