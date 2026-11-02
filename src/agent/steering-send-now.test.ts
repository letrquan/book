import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLoop } from './loop.js';
import { createSteeringInbox, type SteeringInboxHandle } from './steering.js';
import { createRegistry } from '../tools/registry.js';
import { toolSuccess } from '../tools/result.js';
import { refusedBeforeRun } from '../tools/pre-execution-codes.js';
import { convertMessages } from '../provider/anthropic.js';
import { defaultConfig } from '../test/fixtures.js';
import { SessionRuntime } from '../session/runtime.js';
import type { Provider } from '../provider/index.js';
import type {
  AgentLoopCallbacks,
  ProviderMessage,
  ProviderStreamEvent,
} from '../types/providers.js';
import type { AgentTerminalOutcome } from '../types/terminal.js';
import type { Message, SteeredInput } from '../types/messages.js';
import type { ToolResult } from '../types/tools.js';
import type { HookEntry } from '../settings.js';

/**
 * Send-now (#661, PR 3): a steer normally waits for the current tool step, and send-now stops the
 * model request in flight so it goes at once. Only that request stops — the run goes on, keeps
 * what the model already wrote, and answers the steer in its next request. A running tool is never
 * stopped (D5).
 *
 * The provider here is scripted per request, so a test decides exactly when the model is "in the
 * middle of writing" and reads back what each request was sent.
 */

type StreamScript = (signal: AbortSignal | undefined) => AsyncGenerator<ProviderStreamEvent>;

function scriptedProvider(...scripts: StreamScript[]) {
  const requests: Array<{ messages: ProviderMessage[]; signal?: AbortSignal }> = [];
  const provider = {
    id: 'scripted',
    stream: (
      _config: unknown,
      messages: ProviderMessage[],
      _tools: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      const script = scripts.shift();
      if (!script) throw new Error('Scripted provider has no request left');
      requests.push({ messages: structuredClone(messages), signal: options?.signal });
      return script(options?.signal);
    },
  } as unknown as Provider;
  return { provider, requests };
}

/** Resolves once `signal` aborts; never, without one. */
function abortOf(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function steer(id: string, content: string): SteeredInput {
  return { id, content, timestamp: 1_700_000_000_000 };
}

/** The user types a correction and presses the send-now chord. */
function sendNow(inbox: SteeringInboxHandle, id: string, content: string): void {
  inbox.push(steer(id, content));
  inbox.requestNow();
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

function textOf(message: ProviderMessage): string {
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
}

/** The conversation a request carried, from its opening prompt on, as role/text pairs. */
function conversation(messages: ProviderMessage[]): Array<{ role: string; text: string }> {
  const start = messages.findIndex(
    (message) => message.role === 'user' && textOf(message).includes('start'),
  );
  return messages.slice(start).map((message) => ({ role: message.role, text: textOf(message) }));
}

const scratchDirs: string[] = [];

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** A `UserPromptSubmit` hook that blocks a prompt holding `marker` and lets the rest through. */
function blockPromptsHolding(marker: string): HookEntry {
  const dir = mkdtempSync(join(tmpdir(), 'book-send-now-hooks-'));
  scratchDirs.push(dir);
  const file = join(dir, 'block.mjs');
  writeFileSync(
    file,
    [
      "let raw = '';",
      'for await (const chunk of process.stdin) raw += chunk;',
      `const matches = String(JSON.parse(raw).user_prompt).includes(${JSON.stringify(marker)});`,
      `process.stdout.write(matches ? '{"action":"block","message":"not now"}' : '{"action":"continue"}');`,
    ].join('\n'),
  );
  return { command: `node "${file}"`, env: {} };
}

describe('send-now in the loop (#661)', () => {
  it('stops only the request in flight, keeps the partial reply, and answers the steer in the same run', async () => {
    const inbox = createSteeringInbox();
    const { provider, requests } = scriptedProvider(
      async function* (signal) {
        yield { type: 'text', content: 'I will refactor the whole' };
        // The user reads this far, types a correction and presses the chord.
        sendNow(inbox, 'steer-1', 'stop and say hi');
        await abortOf(signal);
      },
      async function* () {
        yield { type: 'text', content: 'MOCK-NOW-OK' };
        yield { type: 'done' };
      },
    );
    const appended: Message[] = [];
    const completed: Message[] = [];
    const errors: string[] = [];
    let outcome: AgentTerminalOutcome | undefined;
    const runController = new AbortController();

    const history = await runAgentLoop(
      defaultConfig(),
      createRegistry(),
      'start',
      [],
      loopCallbacks({
        onError: (error: string) => errors.push(error),
        onTerminal: (value: AgentTerminalOutcome) => (outcome = value),
        onUserMessageAppended: (message: Message) => appended.push(message),
        onAssistantMessageComplete: (message: Message) => completed.push(message),
      }),
      'auto',
      {
        isNewSession: false,
        runtime: new SessionRuntime(),
        steering: inbox,
        provider,
        signal: runController.signal,
      },
    );

    expect(requests).toHaveLength(2);
    // The first request was stopped, and only it: the run's own signal never fired.
    expect(requests[0]!.signal?.aborted).toBe(true);
    expect(runController.signal.aborted).toBe(false);
    expect(requests[1]!.signal?.aborted).toBe(false);

    // Request 2 reads the partial reply, then the user's words.
    expect(conversation(requests[1]!.messages)).toEqual([
      { role: 'user', text: expect.stringContaining('start') },
      { role: 'assistant', text: 'I will refactor the whole' },
      { role: 'user', text: expect.stringContaining('stop and say hi') },
    ]);

    // The partial reply is a settled message of the run, not a failure.
    expect(completed[0]).toMatchObject({ role: 'assistant', content: 'I will refactor the whole' });
    expect(appended.filter((message) => message.steered).map((message) => message.id)).toEqual([
      'steer-1',
    ]);
    expect(history.filter((message) => message.role === 'assistant').map((m) => m.content)).toEqual(
      ['I will refactor the whole', 'MOCK-NOW-OK'],
    );
    expect(errors).toEqual([]);
    expect(outcome).toMatchObject({ status: 'completed', reason: 'normal_completion' });
    expect(inbox.hasPending()).toBe(false);
  });

  it('settles calls the stopped reply streamed but never ran as superseded by the user', async () => {
    const inbox = createSteeringInbox();
    const registry = createRegistry();
    let ran = false;
    registry.register({
      name: 'Edit',
      description: 'Never reached: the reply that called it was stopped.',
      parameters: { type: 'object', properties: {} },
      execute: async (): Promise<ToolResult> => {
        ran = true;
        return toolSuccess('edited');
      },
    });
    const { provider, requests } = scriptedProvider(
      async function* (signal) {
        yield { type: 'text', content: 'Editing the wrong file.' };
        yield { type: 'tool_call', toolCall: { id: 'call-1', name: 'Edit', arguments: {} } };
        sendNow(inbox, 'steer-1', 'use the other file');
        await abortOf(signal);
      },
      async function* () {
        yield { type: 'text', content: 'Switching files.' };
        yield { type: 'done' };
      },
    );
    const results: ToolResult[] = [];

    await runAgentLoop(
      defaultConfig(),
      registry,
      'start',
      [],
      loopCallbacks({ onToolResult: (result: ToolResult) => results.push(result) }),
      'auto',
      { isNewSession: false, runtime: new SessionRuntime(), steering: inbox, provider },
    );

    expect(ran).toBe(false);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ toolCallId: 'call-1', status: 'cancelled' });
    expect(results[0]!.structuredError).toMatchObject({ code: 'superseded_by_user' });
    expect(results[0]!.structuredError?.message).toContain('SUPERSEDED');
    // It never ran, so nothing reads it as work the call did.
    expect(refusedBeforeRun(results[0])).toBe(true);

    // The call keeps its result in request 2, and the steer comes after it.
    const second = conversation(requests[1]!.messages);
    const callIndex = requests[1]!.messages.findIndex((message) =>
      message.tool_calls?.some((call) => call.id === 'call-1'),
    );
    const resultIndex = requests[1]!.messages.findIndex(
      (message) => message.tool_call_id === 'call-1',
    );
    const steerIndex = requests[1]!.messages.findIndex(
      (message) => message.role === 'user' && textOf(message).includes('use the other file'),
    );
    expect(callIndex).toBeGreaterThan(-1);
    expect(resultIndex).toBeGreaterThan(callIndex);
    expect(steerIndex).toBeGreaterThan(resultIndex);
    expect(second.at(-1)?.text).toContain('use the other file');
  });

  it('changes nothing when nothing is pending', async () => {
    const inbox = createSteeringInbox();
    const { provider, requests } = scriptedProvider(async function* () {
      yield { type: 'text', content: 'one ' };
      inbox.requestNow();
      yield { type: 'text', content: 'two' };
      yield { type: 'done' };
    });
    let outcome: AgentTerminalOutcome | undefined;

    const history = await runAgentLoop(
      defaultConfig(),
      createRegistry(),
      'start',
      [],
      loopCallbacks({ onTerminal: (value: AgentTerminalOutcome) => (outcome = value) }),
      'auto',
      { isNewSession: false, runtime: new SessionRuntime(), steering: inbox, provider },
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]!.signal?.aborted).toBe(false);
    expect(history.at(-1)).toMatchObject({ role: 'assistant', content: 'one two' });
    expect(outcome).toMatchObject({ status: 'completed', reason: 'normal_completion' });
  });

  it('never stops a running tool: the steer lands after it, where it would anyway', async () => {
    const inbox = createSteeringInbox();
    const registry = createRegistry();
    let toolSignalAborted: boolean | undefined;
    registry.register({
      name: 'SlowTool',
      description: 'The user presses send-now while this runs.',
      parameters: { type: 'object', properties: {} },
      execute: async (_args, context): Promise<ToolResult> => {
        sendNow(inbox, 'steer-1', 'after the tool');
        await new Promise((resolve) => setTimeout(resolve, 20));
        toolSignalAborted = context.signal?.aborted ?? false;
        return toolSuccess('tool finished');
      },
    });
    const { provider, requests } = scriptedProvider(
      async function* () {
        yield { type: 'tool_call', toolCall: { id: 'tool-1', name: 'SlowTool', arguments: {} } };
        yield { type: 'done' };
      },
      async function* () {
        yield { type: 'text', content: 'Done.' };
        yield { type: 'done' };
      },
    );
    const results: ToolResult[] = [];

    await runAgentLoop(
      defaultConfig(),
      registry,
      'start',
      [],
      loopCallbacks({ onToolResult: (result: ToolResult) => results.push(result) }),
      'auto',
      {
        isNewSession: false,
        runtime: new SessionRuntime(),
        steering: inbox,
        provider,
        signal: new AbortController().signal,
      },
    );

    expect(toolSignalAborted).toBe(false);
    expect(results.map((result) => result.status)).toEqual(['success']);
    expect(requests).toHaveLength(2);
    // The request after the tool step was not stopped by the send-now that came before it.
    expect(requests[1]!.signal?.aborted).toBe(false);
    const second = requests[1]!.messages;
    const resultIndex = second.findIndex((message) => message.tool_call_id === 'tool-1');
    const steerIndex = second.findIndex(
      (message) => message.role === 'user' && textOf(message).includes('after the tool'),
    );
    expect(resultIndex).toBeGreaterThan(-1);
    expect(steerIndex).toBeGreaterThan(resultIndex);
  });

  it('ends the run as cancelled when the run itself is cancelled during a send-now', async () => {
    const inbox = createSteeringInbox();
    const runController = new AbortController();
    const { provider, requests } = scriptedProvider(async function* (signal) {
      yield { type: 'text', content: 'Half an answer' };
      sendNow(inbox, 'steer-1', 'never sent');
      // Esc right behind the chord: the run's cancel wins.
      runController.abort();
      await abortOf(signal);
    });
    let outcome: AgentTerminalOutcome | undefined;

    const history = await runAgentLoop(
      defaultConfig(),
      createRegistry(),
      'start',
      [],
      loopCallbacks({ onTerminal: (value: AgentTerminalOutcome) => (outcome = value) }),
      'auto',
      {
        isNewSession: false,
        runtime: new SessionRuntime(),
        steering: inbox,
        provider,
        signal: runController.signal,
      },
    );

    expect(requests).toHaveLength(1);
    expect(outcome?.status).toBe('cancelled');
    // The steer was never appended, so the host gets it back.
    expect(history.some((message) => message.steered)).toBe(false);
    expect(inbox.hasPending()).toBe(true);
  });

  it('does not hang on a provider that ignores the abort', async () => {
    const inbox = createSteeringInbox();
    const { provider, requests } = scriptedProvider(
      async function* () {
        yield { type: 'text', content: 'Writing' };
        sendNow(inbox, 'steer-1', 'stop');
        // A route that never looks at the signal keeps streaming.
        for (let index = 0; index < 1_000; index++) {
          await new Promise((resolve) => setTimeout(resolve, 1));
          yield { type: 'text', content: ' more' };
        }
        yield { type: 'done' };
      },
      async function* () {
        yield { type: 'text', content: 'Stopped.' };
        yield { type: 'done' };
      },
    );

    const history = await runAgentLoop(
      defaultConfig(),
      createRegistry(),
      'start',
      [],
      loopCallbacks(),
      'auto',
      { isNewSession: false, runtime: new SessionRuntime(), steering: inbox, provider },
    );

    expect(requests).toHaveLength(2);
    // What arrived after the chord is not part of what the model is told it wrote.
    expect(history.find((message) => message.role === 'assistant')?.content).toBe('Writing');
  });

  it('resumes the stopped reply when the steer it stopped for is blocked by a hook', async () => {
    // Without a steer to answer, request 2 would end on the stopped reply: assistant prefill,
    // which Anthropic refuses while thinking is on.
    const inbox = createSteeringInbox();
    const { provider, requests } = scriptedProvider(
      async function* (signal) {
        yield { type: 'text', content: 'Half an answer' };
        sendNow(inbox, 'steer-1', 'BLOCKED-STEER please');
        await abortOf(signal);
      },
      async function* () {
        yield { type: 'text', content: 'The rest of the answer.' };
        yield { type: 'done' };
      },
    );
    const config = defaultConfig();
    config.settings.hooks.UserPromptSubmit = [blockPromptsHolding('BLOCKED-STEER')];
    const notices: string[] = [];
    let outcome: AgentTerminalOutcome | undefined;

    await runAgentLoop(
      config,
      createRegistry(),
      'start',
      [],
      loopCallbacks({
        onNotice: (message: string) => notices.push(message),
        onTerminal: (value: AgentTerminalOutcome) => (outcome = value),
      }),
      'auto',
      { isNewSession: false, runtime: new SessionRuntime(), steering: inbox, provider },
    );

    expect(requests).toHaveLength(2);
    const second = requests[1]!.messages;
    expect(second.at(-1)?.role).toBe('user');
    expect(textOf(second.at(-1)!)).toContain('[continuation]');
    expect(second.some((message) => textOf(message).includes('BLOCKED-STEER'))).toBe(false);
    expect(notices.some((notice) => notice.includes('blocked'))).toBe(true);
    expect(outcome).toMatchObject({ status: 'completed', reason: 'normal_completion' });
  });
});

describe('send-now and Anthropic replay (#661)', () => {
  it('replays no unsigned reasoning from a reply stopped while it was thinking', async () => {
    const inbox = createSteeringInbox();
    const { provider, requests } = scriptedProvider(
      async function* (signal) {
        // Thinking streams without its signature: that arrives with the block's end.
        yield { type: 'reasoning', reasoning: 'half a thought about the parser' };
        sendNow(inbox, 'steer-1', 'look at the lexer instead');
        await abortOf(signal);
      },
      async function* () {
        yield { type: 'text', content: 'Looking at the lexer.' };
        yield { type: 'done' };
      },
    );

    await runAgentLoop(
      defaultConfig({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com' }),
      createRegistry(),
      'start',
      [],
      loopCallbacks(),
      'auto',
      { isNewSession: false, runtime: new SessionRuntime(), steering: inbox, provider },
    );

    expect(requests).toHaveLength(2);
    const converted = convertMessages(requests[1]!.messages).messages;
    const blocks = converted.flatMap((message) =>
      typeof message.content === 'string' ? [] : message.content,
    );
    expect(blocks.some((block) => block.type === 'thinking' && !block.signature)).toBe(false);
    expect(JSON.stringify(converted)).not.toContain('half a thought');
    // The request is still a conversation the API accepts: it ends on the user's words.
    expect(converted.at(-1)?.role).toBe('user');
    expect(JSON.stringify(converted.at(-1))).toContain('look at the lexer instead');
  });
});
