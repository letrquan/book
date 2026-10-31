import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgentLoop } from './loop.js';
import { createSteeringInbox } from './steering.js';
import { createRegistry } from '../tools/registry.js';
import { todoTools } from '../tools/todo.js';
import { toolSuccess } from '../tools/result.js';
import { defaultConfig } from '../test/fixtures.js';
import { createScriptedProvider, sseResponse } from '../test/scripted-provider.js';
import { AgentSession } from '../session/agent-session.js';
import { SessionRuntime } from '../session/runtime.js';
import { SessionStore } from '../session/store.js';
import { createSessionFixture, type SessionFixture } from '../test/session-fixture.js';
import type { AgentSessionRunCallbacks } from '../session/agent-session.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type { AgentTerminalOutcome } from '../types/terminal.js';
import type { ImageAttachment, Message, SteeredInput } from '../types/messages.js';
import type { ToolResult } from '../types/tools.js';

/**
 * Steering, from the loop's side (#661).
 *
 * Each loop test drives the real loop through the scripted fetch provider, so the
 * assertions read the request bodies the provider would have received — the only
 * place a steer's position relative to a tool result is observable.
 */

function steer(id: string, content: string, extra: Partial<SteeredInput> = {}): SteeredInput {
  return { id, content, timestamp: 1_700_000_000_000, ...extra };
}

function textStep(content: string) {
  return sseResponse([JSON.stringify({ choices: [{ delta: { content } }] })]);
}

function toolStep(id: string, name: string, args: Record<string, unknown> = {}) {
  return sseResponse([
    JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id,
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    }),
  ]);
}

function requestMessages(provider: ReturnType<typeof createScriptedProvider>, index: number) {
  const body = provider.requests[index]?.init?.body;
  if (typeof body !== 'string') throw new Error(`request ${index} has no recorded body`);
  return (JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> }).messages;
}

function isUserMessage(raw: { role: string; content: unknown }, text: string): boolean {
  return (
    raw.role === 'user' &&
    (typeof raw.content === 'string'
      ? raw.content.includes(text)
      : JSON.stringify(raw.content).includes(text))
  );
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('steering into the loop', () => {
  it('delivers a steer taken after a tool step in the next request, after its tool results', async () => {
    const inbox = createSteeringInbox();
    const registry = createRegistry();
    registry.register({
      name: 'SlowTool',
      description: 'Hands the loop a steer while it runs.',
      parameters: { type: 'object', properties: {} },
      execute: async (): Promise<ToolResult> => {
        // The user typed while the tool was still running.
        inbox.push(steer('steer-1', 'also rename the caller'));
        return toolSuccess('tool finished');
      },
    });
    const provider = createScriptedProvider(
      toolStep('tool-1', 'SlowTool'),
      textStep('Renamed it.'),
    );
    vi.stubGlobal('fetch', provider.fetch);

    const appended: Message[] = [];
    const config = defaultConfig();
    config.maxTurns = 4;
    await runAgentLoop(
      config,
      registry,
      'start',
      [],
      loopCallbacks({ onUserMessageAppended: (message: Message) => appended.push(message) }),
      'auto',
      { isNewSession: false, runtime: new SessionRuntime(), steering: inbox },
    );

    expect(provider.requests).toHaveLength(2);
    // Request N is the tool step itself: the user had not spoken yet.
    const first = requestMessages(provider, 0);
    expect(first.some((message) => isUserMessage(message, 'also rename the caller'))).toBe(false);

    // Request N+1 carries the step's calls and results, then the steer.
    const second = requestMessages(provider, 1);
    const toolCallIndex = second.findIndex(
      (message) => message.role === 'assistant' && JSON.stringify(message).includes('tool-1'),
    );
    const toolResultIndex = second.findIndex((message) => message.role === 'tool');
    const steerIndex = second.findIndex((message) =>
      isUserMessage(message, 'also rename the caller'),
    );
    expect(toolCallIndex).toBeGreaterThanOrEqual(0);
    expect(toolResultIndex).toBeGreaterThan(toolCallIndex);
    expect(steerIndex).toBeGreaterThan(toolResultIndex);
    // Nothing is left for a later boundary to pick up.
    expect(inbox.hasPending()).toBe(false);

    const steered = appended.find((message) => message.id === 'steer-1');
    expect(steered).toMatchObject({
      role: 'user',
      content: 'also rename the caller',
      includeInContext: true,
      kind: 'conversation',
      steered: true,
      timestamp: 1_700_000_000_000,
    });
    expect(steered?.derivedContent).toBeUndefined();
    expect(steered?.contextContent).toBeUndefined();
  });

  it('delivers two steers from one step in FIFO order in the same request', async () => {
    const inbox = createSteeringInbox();
    const registry = createRegistry();
    registry.register({
      name: 'SlowTool',
      description: 'Queues two steers while it runs.',
      parameters: { type: 'object', properties: {} },
      execute: async (): Promise<ToolResult> => {
        inbox.push(steer('steer-1', 'first correction'));
        inbox.push(steer('steer-2', 'second correction'));
        return toolSuccess('tool finished');
      },
    });
    const provider = createScriptedProvider(
      toolStep('tool-1', 'SlowTool'),
      textStep('Both applied.'),
    );
    vi.stubGlobal('fetch', provider.fetch);

    const appended: Message[] = [];
    const config = defaultConfig();
    config.maxTurns = 4;
    await runAgentLoop(
      config,
      registry,
      'start',
      [],
      loopCallbacks({ onUserMessageAppended: (message: Message) => appended.push(message) }),
      'auto',
      { isNewSession: false, runtime: new SessionRuntime(), steering: inbox },
    );

    expect(provider.requests).toHaveLength(2);
    const second = requestMessages(provider, 1);
    const first = second.findIndex((message) => isUserMessage(message, 'first correction'));
    const last = second.findIndex((message) => isUserMessage(message, 'second correction'));
    expect(first).toBeGreaterThanOrEqual(0);
    expect(last).toBeGreaterThan(first);
    expect(appended.map((message) => message.id)).toEqual(['steer-1', 'steer-2']);
  });

  it('takes the display text for the transcript and the expanded prompt for the model', async () => {
    const inbox = createSteeringInbox();
    const registry = createRegistry();
    registry.register({
      name: 'SlowTool',
      description: 'Queues one steer with an expanded prompt while it runs.',
      parameters: { type: 'object', properties: {} },
      execute: async (): Promise<ToolResult> => {
        inbox.push(
          steer('steer-1', 'rename it\n\n[file: src/a.ts]\nconst a = 1;', {
            displayMessage: 'rename it',
            typedText: 'rename it',
          }),
        );
        return toolSuccess('tool finished');
      },
    });
    const provider = createScriptedProvider(toolStep('tool-1', 'SlowTool'), textStep('Renamed.'));
    vi.stubGlobal('fetch', provider.fetch);

    const appended: Message[] = [];
    const config = defaultConfig();
    config.maxTurns = 4;
    await runAgentLoop(
      config,
      registry,
      'start',
      [],
      loopCallbacks({ onUserMessageAppended: (message: Message) => appended.push(message) }),
      'auto',
      { isNewSession: false, runtime: new SessionRuntime(), steering: inbox },
    );

    const steered = appended.find((message) => message.id === 'steer-1');
    expect(steered?.content).toBe('rename it');
    expect(steered?.contextContent).toBe('rename it\n\n[file: src/a.ts]\nconst a = 1;');
    const second = requestMessages(provider, 1);
    expect(second.some((message) => isUserMessage(message, 'const a = 1;'))).toBe(true);
    expect(second.some((message) => isUserMessage(message, 'rename it'))).toBe(true);
  });

  it('continues the same run when the model writes a final answer with a steer pending', async () => {
    const inbox = createSteeringInbox();
    const provider = createScriptedProvider(() => {
      // The user sent this while the model was writing its answer.
      inbox.push(steer('steer-1', 'wait, also update the docs'));
      return textStep('I have finished.');
    }, textStep('Docs updated too.'));
    vi.stubGlobal('fetch', provider.fetch);

    const appended: Message[] = [];
    let outcome: AgentTerminalOutcome | undefined;
    const config = defaultConfig();
    config.maxTurns = 4;
    const history = await runAgentLoop(
      config,
      createRegistry(),
      'start',
      [],
      loopCallbacks({
        onTerminal: (value: AgentTerminalOutcome) => (outcome = value),
        onUserMessageAppended: (message: Message) => appended.push(message),
      }),
      'auto',
      { isNewSession: false, runtime: new SessionRuntime(), steering: inbox },
    );

    // One more request inside the SAME run, not a new turn a host would have to start.
    expect(provider.requests).toHaveLength(2);
    expect(
      requestMessages(provider, 1).some((message) =>
        isUserMessage(message, 'also update the docs'),
      ),
    ).toBe(true);
    expect(appended.map((message) => message.id)).toContain('steer-1');
    expect(history.filter((message) => message.steered).map((message) => message.id)).toEqual([
      'steer-1',
    ]);
    // The steered turn is answered, then the run ends the ordinary way.
    expect(outcome).toMatchObject({ status: 'completed', reason: 'normal_completion' });
    expect(inbox.hasPending()).toBe(false);
  });

  it('resets the continuation allowance when the user steers', async () => {
    // `maxConsecutive: 1` allows exactly one host continuation. The second steer sits
    // between two text-only turns, so without the reset the continuation after it
    // would be over the limit and never appended; with the reset it is appended, and
    // the allowance is then spent again.
    const inbox = createSteeringInbox();
    const provider = createScriptedProvider(
      toolStep('todo-1', 'TodoWrite', {
        todos: [{ content: 'the work', status: 'in_progress' }],
      }),
      () => {
        inbox.push(steer('steer-1', 'first steer'));
        return textStep('Stopped early.');
      },
      textStep('Working on what you asked.'),
      () => {
        inbox.push(steer('steer-2', 'second steer'));
        return textStep('Stopping again.');
      },
      textStep('Continuing once more.'),
      textStep('Still stopping.'),
    );
    vi.stubGlobal('fetch', provider.fetch);

    const registry = createRegistry();
    registry.registerAll(todoTools);
    const appended: Message[] = [];
    let outcome: AgentTerminalOutcome | undefined;
    const config = defaultConfig();
    config.maxTurns = 8;
    config.settings.continuation = {
      ...config.settings.continuation,
      enabled: true,
      maxConsecutive: 1,
    };
    await runAgentLoop(
      config,
      registry,
      'start',
      [],
      loopCallbacks({
        onTerminal: (value: AgentTerminalOutcome) => (outcome = value),
        onUserMessageAppended: (message: Message) => appended.push(message),
      }),
      'auto',
      { isNewSession: false, runtime: new SessionRuntime(), steering: inbox },
    );

    const continuations = appended.filter((message) => message.derivedContent === true);
    expect(continuations).toHaveLength(2);
    // Each steer kept the same run going without minting a continuation.
    expect(appended.filter((message) => message.steered).map((message) => message.id)).toEqual([
      'steer-1',
      'steer-2',
    ]);
    expect(outcome).toMatchObject({ status: 'failed', reason: 'continuation_limit' });
  });

  it('leaves steers pending when the run is aborted', async () => {
    const inbox = createSteeringInbox();
    const registry = createRegistry();
    const controller = new AbortController();
    registry.register({
      name: 'SlowTool',
      description: 'Queues a steer just before the run is cancelled.',
      parameters: { type: 'object', properties: {} },
      execute: async (): Promise<ToolResult> => {
        inbox.push(steer('steer-1', 'never delivered'));
        return toolSuccess('tool finished');
      },
    });
    const provider = createScriptedProvider(toolStep('tool-1', 'SlowTool'), textStep('unused'));
    vi.stubGlobal('fetch', provider.fetch);

    const config = defaultConfig();
    config.maxTurns = 4;
    await runAgentLoop(
      config,
      registry,
      'start',
      [],
      loopCallbacks({
        onToolResult: () => {
          // Esc: the user cancelled while the tool was still finishing.
          controller.abort();
        },
      }),
      'auto',
      {
        isNewSession: false,
        signal: controller.signal,
        runtime: new SessionRuntime(),
        steering: inbox,
      },
    );

    expect(provider.requests).toHaveLength(1);
    expect(inbox.hasPending()).toBe(true);
    expect(inbox.take().map((entry) => entry.id)).toEqual(['steer-1']);
  });
});

describe('steering persistence', () => {
  let fixture: SessionFixture | undefined;

  afterEach(() => {
    fixture?.cleanup();
    fixture = undefined;
  });

  it('writes the steer as a steered user record and reloads it in place', async () => {
    fixture = createSessionFixture('book-steering-session-');
    const sessionId = fixture.store.create({ cwd: fixture.root });
    // What the host writes before `send` for the prompt that started the run.
    fixture.store.append(sessionId, {
      type: 'user',
      eventId: 'prompt-1',
      timestamp: 10,
      data: { id: 'prompt-1', content: 'start', kind: 'conversation' },
    });

    const inbox = createSteeringInbox();
    const provider = createScriptedProvider(() => {
      inbox.push(steer('steer-1', 'change course', { displayMessage: 'change course please' }));
      return textStep('Starting.');
    }, textStep('Course changed.'));
    vi.stubGlobal('fetch', provider.fetch);

    const config = defaultConfig();
    config.maxTurns = 4;
    const session = new AgentSession();
    await session.run({
      config,
      registry: createRegistry(),
      prompt: 'start',
      history: [],
      sessionId,
      timelineStore: fixture.store,
      steering: inbox,
      callbacks: {
        onEvent: () => {},
        onTurnStart: () => {},
      } satisfies AgentSessionRunCallbacks,
    });

    const records = fixture.store.readRecords(sessionId);
    const steeredRecord = records.find(
      (record) => record.type === 'user' && (record.data as { id?: string }).id === 'steer-1',
    );
    expect(steeredRecord).toMatchObject({
      type: 'user',
      data: {
        id: 'steer-1',
        content: 'change course please',
        contextContent: 'change course',
        steered: true,
        includeInContext: true,
        kind: 'conversation',
      },
    });
    expect((steeredRecord?.data as { derivedContent?: boolean }).derivedContent).toBeUndefined();

    const loaded = new SessionStore(fixture.root).load(sessionId);
    const transcript = loaded.transcript;
    const steerIndex = transcript.findIndex((message) => message.id === 'steer-1');
    expect(steerIndex).toBeGreaterThan(0);
    expect(transcript[steerIndex]).toMatchObject({
      role: 'user',
      content: 'change course please',
      contextContent: 'change course',
      steered: true,
    });
    expect(transcript[steerIndex].derivedContent).toBeUndefined();
    // In place: right after the assistant answer being written when it arrived.
    expect(transcript[steerIndex - 1].role).toBe('assistant');
    expect(loaded.contextHistory.some((message) => message.id === 'steer-1')).toBe(true);
  });

  it('persists a steered turn’s display text, prompt, attachments and observations', async () => {
    // The live run above proves the loop's message reaches the host. This pins the
    // record fields an attachment-bearing steer needs, which a reload must restore
    // byte for byte or the transcript would render an image it cannot resolve.
    fixture = createSessionFixture('book-steering-attachment-');
    const sessionId = fixture.store.create({ cwd: fixture.root });
    const attachment: ImageAttachment = {
      id: 'image-1',
      sha256: 'sha',
      storageKey: 'image-1.png',
      mediaType: 'image/png',
      byteSize: 3,
    };
    const observation = {
      path: 'src/a.ts',
      workspaceId: 'w',
      sha256: 'sha',
      byteSize: 1,
      operation: 'read' as const,
      sourceRef: 'steer-1',
      timestamp: 1,
    };
    const steered: Message = {
      id: 'steer-1',
      role: 'user',
      content: 'look at this',
      contextContent: 'look at this\n\n[file: src/a.ts]\nconst a = 1;',
      includeInContext: true,
      kind: 'conversation',
      steered: true,
      attachments: [attachment],
      fileObservations: [observation],
      timestamp: 20,
    };
    const session = new AgentSession({
      runLoop: async (_config, _registry, _prompt, _history, callbacks) => {
        callbacks.onUserMessageAppended?.(steered);
        return [steered];
      },
    });

    await session.run({
      config: defaultConfig(),
      registry: {} as ToolRegistry,
      prompt: 'start',
      history: [],
      sessionId,
      timelineStore: fixture.store,
      callbacks: { onEvent: () => {}, onTurnStart: () => {} },
    });

    const reloaded = new SessionStore(fixture.root).load(sessionId).transcript;
    const record = reloaded.find((message) => message.id === 'steer-1');
    expect(record).toMatchObject({
      role: 'user',
      content: 'look at this',
      contextContent: 'look at this\n\n[file: src/a.ts]\nconst a = 1;',
      steered: true,
      attachments: [attachment],
      fileObservations: [observation],
    });
    expect(record?.derivedContent).toBeUndefined();
  });
});
