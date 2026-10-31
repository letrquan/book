import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLoop } from './loop.js';
import { createSteeringInbox } from './steering.js';
import { createDefaultRegistry, createRegistry } from '../tools/registry.js';
import { todoTools } from '../tools/todo.js';
import { toolSuccess } from '../tools/result.js';
import { observationKey } from '../tools/file-provenance.js';
import { createSessionListTool } from '../tools/session-list.js';
import { createSessionSendTool } from '../tools/session-send.js';
import { SessionMentionSnapshot } from '../input/session-mentions.js';
import { defaultConfig } from '../test/fixtures.js';
import { createScriptedProvider, sseResponse } from '../test/scripted-provider.js';
import { AgentSession } from '../session/agent-session.js';
import { SessionRuntime } from '../session/runtime.js';
import { SessionStore } from '../session/store.js';
import { createSessionFixture, type SessionFixture } from '../test/session-fixture.js';
import { createAgentRunContext } from '../types/runs.js';
import type { AgentSessionRunCallbacks } from '../session/agent-session.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type { AgentTerminalOutcome } from '../types/terminal.js';
import type { ImageAttachment, Message, SteeredInput } from '../types/messages.js';
import type { FileObservation, ToolResult } from '../types/tools.js';
import type {
  PeerSessionListing,
  PeerSessionRow,
  SessionMessagingHandle,
} from '../types/messaging.js';
import type { HookEntry } from '../settings.js';

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

/** The tool names a recorded request declared, in the order it sent them. */
function requestToolNames(provider: ReturnType<typeof createScriptedProvider>, index: number) {
  const body = provider.requests[index]?.init?.body;
  if (typeof body !== 'string') throw new Error(`request ${index} has no recorded body`);
  const sent = (JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> }).tools;
  return (sent ?? []).map((tool) => tool.function?.name ?? '');
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

const scratchDirs: string[] = [];

/** A directory this suite owns, removed after it, for hook scripts and steer workspaces. */
function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

const hookDir = scratch('book-steering-hooks-');

/**
 * A `UserPromptSubmit` hook that answers with `response` only for a prompt holding `marker`, and
 * otherwise continues. Matching on the prompt leaves the run's own opening prompt alone, so a test
 * pins what happens to the steer and nothing else.
 */
function hookWhenPromptHolds(marker: string, response: Record<string, unknown>): HookEntry {
  const file = join(hookDir, `${marker.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.mjs`);
  writeFileSync(
    file,
    [
      "let raw = '';",
      'for await (const chunk of process.stdin) raw += chunk;',
      `const matches = String(JSON.parse(raw).user_prompt).includes(${JSON.stringify(marker)});`,
      `const answer = matches ? ${JSON.stringify(JSON.stringify(response))} : '{"action":"continue"}';`,
      'process.stdout.write(answer);',
    ].join('\n'),
  );
  return { command: `node "${file}"`, env: {} };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
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

describe('what a steer means to the run (#661)', () => {
  it.each([false, true])(
    'drops a blocked steer, tells the user, and keeps the run going (skipUserPromptHooks: %s)',
    async (skipUserPromptHooks) => {
      const inbox = createSteeringInbox();
      const registry = createRegistry();
      const runtime = new SessionRuntime();
      const observation: FileObservation = {
        path: 'src/b.ts',
        workspaceId: 'workspace-1',
        sha256: 'sha',
        byteSize: 1,
        operation: 'mention',
        sourceRef: 'steer-1',
        timestamp: 1,
      };
      registry.register({
        name: 'SlowTool',
        description: 'Queues a steer a hook will block.',
        parameters: { type: 'object', properties: {} },
        execute: async (): Promise<ToolResult> => {
          inbox.push(
            steer('steer-1', 'BLOCKED-BY-POLICY: deploy to production', {
              fileObservations: [observation],
            }),
          );
          return toolSuccess('tool finished');
        },
      });
      const provider = createScriptedProvider(toolStep('tool-1', 'SlowTool'), textStep('Done.'));
      vi.stubGlobal('fetch', provider.fetch);

      const notices: string[] = [];
      const appended: Message[] = [];
      const config = defaultConfig();
      config.maxTurns = 4;
      config.settings.hooks.UserPromptSubmit = [
        hookWhenPromptHolds('BLOCKED-BY-POLICY', {
          action: 'block',
          message: 'the deploy policy forbids it',
        }),
      ];
      const history = await runAgentLoop(
        config,
        registry,
        'start',
        [],
        loopCallbacks({
          onNotice: (notice: string) => notices.push(notice),
          onUserMessageAppended: (message: Message) => appended.push(message),
        }),
        'auto',
        {
          isNewSession: false,
          runtime,
          steering: inbox,
          skipUserPromptHooks,
        },
      );

      // The step's batch is answered; the blocked steer mints no request of its own. The hooks
      // run for a steer even when the run skipped its own prompt's: a steer is always the
      // user's own words.
      expect(provider.requests).toHaveLength(2);
      expect(notices).toEqual([
        'UserPromptSubmit hook blocked a message sent during the run: the deploy policy forbids it',
      ]);
      expect(
        requestMessages(provider, 1).some((message) => isUserMessage(message, 'BLOCKED-BY-POLICY')),
      ).toBe(false);
      expect(appended.some((message) => message.id === 'steer-1')).toBe(false);
      expect(history.some((message) => message.id === 'steer-1')).toBe(false);
      expect(inbox.hasPending()).toBe(false);
      // A dropped steer's file is never observed: the model never saw its text.
      expect(
        runtime.fileObservationLedger.has(
          observationKey(observation.workspaceId, observation.path),
        ),
      ).toBe(false);
    },
  );

  it('delivers a hook rewrite as both the model prompt and the transcript text', async () => {
    const inbox = createSteeringInbox();
    const registry = createRegistry();
    registry.register({
      name: 'SlowTool',
      description: 'Queues a steer a hook will rewrite.',
      parameters: { type: 'object', properties: {} },
      execute: async (): Promise<ToolResult> => {
        inbox.push(
          steer('steer-1', 'REWRITE-ME: rename it', {
            displayMessage: 'REWRITE-ME: rename it',
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
    config.settings.hooks.UserPromptSubmit = [
      hookWhenPromptHolds('REWRITE-ME', {
        action: 'modify',
        prompt: 'rename the caller instead',
      }),
    ];
    await runAgentLoop(
      config,
      registry,
      'start',
      [],
      loopCallbacks({ onUserMessageAppended: (message: Message) => appended.push(message) }),
      'auto',
      { isNewSession: false, runtime: new SessionRuntime(), steering: inbox },
    );

    // The rewrite is the prompt: it is what the model reads and what the transcript shows, with
    // no second, unrewritten text behind it.
    const steered = appended.find((message) => message.id === 'steer-1');
    expect(steered).toMatchObject({ content: 'rename the caller instead', steered: true });
    expect(steered?.contextContent).toBeUndefined();
    const second = requestMessages(provider, 1);
    expect(second.some((message) => isUserMessage(message, 'rename the caller instead'))).toBe(
      true,
    );
    expect(second.some((message) => isUserMessage(message, 'REWRITE-ME'))).toBe(false);
  });

  it('ends the run normally when every steer at the turn end was blocked', async () => {
    const inbox = createSteeringInbox();
    const provider = createScriptedProvider(() => {
      // The user spoke while this answer was being written; a hook then refuses the message.
      inbox.push(steer('steer-1', 'BLOCKED-BY-POLICY: one more thing'));
      return textStep('I have finished.');
    }, textStep('This second request must not happen.'));
    vi.stubGlobal('fetch', provider.fetch);

    const notices: string[] = [];
    let outcome: AgentTerminalOutcome | undefined;
    const config = defaultConfig();
    config.maxTurns = 4;
    config.settings.hooks.UserPromptSubmit = [
      hookWhenPromptHolds('BLOCKED-BY-POLICY', { action: 'block', message: 'not now' }),
    ];
    const history = await runAgentLoop(
      config,
      createRegistry(),
      'start',
      [],
      loopCallbacks({
        onNotice: (notice: string) => notices.push(notice),
        onTerminal: (value: AgentTerminalOutcome) => (outcome = value),
      }),
      'auto',
      { isNewSession: false, runtime: new SessionRuntime(), steering: inbox },
    );

    // No steer survived its hooks, so the ordinary continuation decision ran and ended the run.
    expect(provider.requests).toHaveLength(1);
    expect(notices).toEqual([
      'UserPromptSubmit hook blocked a message sent during the run: not now',
    ]);
    expect(outcome).toMatchObject({ status: 'completed', reason: 'normal_completion' });
    expect(history.some((message) => message.id === 'steer-1')).toBe(false);
  });

  it('routes a steer by its typed text, so a URL in a correction loads WebFetch', async () => {
    const inbox = createSteeringInbox();
    const registry = createDefaultRegistry();
    registry.register({
      name: 'SlowTool',
      description: 'Queues a steer with a URL while it runs.',
      parameters: { type: 'object', properties: {} },
      execute: async (): Promise<ToolResult> => {
        inbox.push(steer('steer-1', 'also read https://example.com/notes.txt'));
        return toolSuccess('tool finished');
      },
    });
    const provider = createScriptedProvider(toolStep('tool-1', 'SlowTool'), textStep('Read it.'));
    vi.stubGlobal('fetch', provider.fetch);

    const config = defaultConfig();
    config.maxTurns = 4;
    await runAgentLoop(config, registry, 'start', [], loopCallbacks(), 'auto', {
      isNewSession: false,
      runtime: new SessionRuntime(),
      steering: inbox,
    });

    // Nothing about the run's own prompt asks for WebFetch; only the steer does.
    expect(requestToolNames(provider, 0)).not.toContain('WebFetch');
    expect(requestToolNames(provider, 1)).toContain('WebFetch');
  });

  it('registers a steer’s file observations when it is delivered, not while it waits', async () => {
    const observation: FileObservation = {
      path: 'src/a.ts',
      workspaceId: 'workspace-1',
      sha256: 'sha',
      byteSize: 1,
      operation: 'mention',
      sourceRef: 'steer-1',
      timestamp: 1,
    };
    const key = observationKey(observation.workspaceId, observation.path);
    const runtime = new SessionRuntime();
    const inbox = createSteeringInbox();
    const registry = createRegistry();
    let observedWhilePending: boolean | undefined;
    registry.register({
      name: 'SlowTool',
      description: 'Queues a steer that mentions a file.',
      parameters: { type: 'object', properties: {} },
      execute: async (): Promise<ToolResult> => {
        inbox.push(steer('steer-1', 'rename it', { fileObservations: [observation] }));
        observedWhilePending = runtime.fileObservationLedger.has(key);
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
      { isNewSession: false, runtime, steering: inbox },
    );

    expect(observedWhilePending).toBe(false);
    expect(runtime.fileObservationLedger.get(key)).toEqual(observation);
    expect(appended.find((message) => message.id === 'steer-1')?.fileObservations).toEqual([
      observation,
    ]);
  });

  it('leaves a steer pending when maxTurns leaves no turn to answer it', async () => {
    const inbox = createSteeringInbox();
    const provider = createScriptedProvider(() => {
      inbox.push(steer('steer-1', 'one more thing'));
      return textStep('I have finished.');
    }, textStep('This second request must not happen.'));
    vi.stubGlobal('fetch', provider.fetch);

    const config = defaultConfig();
    config.maxTurns = 1;
    const history = await runAgentLoop(
      config,
      createRegistry(),
      'start',
      [],
      loopCallbacks(),
      'auto',
      { isNewSession: false, runtime: new SessionRuntime(), steering: inbox },
    );

    // The run would end before sending the steer, so it stays for the host to send as its own turn.
    expect(provider.requests).toHaveLength(1);
    expect(inbox.hasPending()).toBe(true);
    expect(inbox.take().map((entry) => entry.id)).toEqual(['steer-1']);
    expect(history.some((message) => message.id === 'steer-1')).toBe(false);
  });

  it('sends a steer’s image attachment as an image part in the next request', async () => {
    const attachment: ImageAttachment = {
      id: 'image-1',
      sha256: 'sha',
      storageKey: 'image-1.png',
      mediaType: 'image/png',
      byteSize: 3,
    };
    const inbox = createSteeringInbox();
    const registry = createRegistry();
    registry.register({
      name: 'SlowTool',
      description: 'Queues a steer carrying a screenshot.',
      parameters: { type: 'object', properties: {} },
      execute: async (): Promise<ToolResult> => {
        inbox.push(steer('steer-1', 'what is in this screenshot?', { attachments: [attachment] }));
        return toolSuccess('tool finished');
      },
    });
    const provider = createScriptedProvider(toolStep('tool-1', 'SlowTool'), textStep('A cat.'));
    vi.stubGlobal('fetch', provider.fetch);

    const config = defaultConfig();
    config.maxTurns = 4;
    await runAgentLoop(config, registry, 'start', [], loopCallbacks(), 'auto', {
      isNewSession: false,
      runtime: new SessionRuntime(),
      steering: inbox,
      // What `AgentSession` passes: a reader for the attachment's bytes.
      resolveAttachment: () => Uint8Array.from([1, 2, 3]),
    });

    const second = requestMessages(provider, 1);
    const steered = second.find((message) => isUserMessage(message, 'what is in this screenshot?'));
    expect(steered?.content).toEqual([
      { type: 'text', text: 'what is in this screenshot?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQID' } },
      { type: 'text', text: expect.stringContaining('<session-state>') },
    ]);
  });
});

describe('steering keeps what it takes (#661 review)', () => {
  /** Poll a condition the loop reaches on its own schedule, so the test never sleeps blindly. */
  async function waitFor(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  /**
   * A `UserPromptSubmit` hook that stalls on a prompt holding `marker` — leaving `signal` behind
   * once it has started — and continues instantly for every other prompt.
   */
  function hookThatWaits(signal: string, marker: string): HookEntry {
    const file = join(hookDir, `wait-${marker.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.mjs`);
    writeFileSync(
      file,
      [
        "import { writeFileSync } from 'node:fs';",
        "let raw = '';",
        'for await (const chunk of process.stdin) raw += chunk;',
        `if (!String(JSON.parse(raw).user_prompt).includes(${JSON.stringify(marker)})) process.exit(0);`,
        `writeFileSync(${JSON.stringify(signal)}, 'running');`,
        // Never answer: only the run's cancellation ends this hook. The interval is what keeps
        // Node from exiting on an otherwise idle event loop while the promise stays pending.
        'await new Promise(() => setInterval(() => {}, 60_000));',
      ].join('\n'),
    );
    return { command: `node "${file}"`, env: {} };
  }

  it('puts every steer it took back when the run is cancelled during a hook', async () => {
    const inbox = createSteeringInbox();
    const registry = createRegistry();
    registry.register({
      name: 'SlowTool',
      description: 'Queues three steers a hook will stall on.',
      parameters: { type: 'object', properties: {} },
      execute: async (): Promise<ToolResult> => {
        inbox.push(steer('steer-1', 'WAIT-FOR-ME: first'));
        inbox.push(steer('steer-2', 'WAIT-FOR-ME: second'));
        inbox.push(steer('steer-3', 'WAIT-FOR-ME: third'));
        return toolSuccess('tool finished');
      },
    });
    const provider = createScriptedProvider(toolStep('tool-1', 'SlowTool'), textStep('Done.'));
    vi.stubGlobal('fetch', provider.fetch);

    const signalFile = join(scratch('book-steering-hook-wait-'), 'running');
    const controller = new AbortController();
    const appended: Message[] = [];
    const config = defaultConfig();
    config.maxTurns = 4;
    config.settings.hooks.UserPromptSubmit = [hookThatWaits(signalFile, 'WAIT-FOR-ME')];
    const run = runAgentLoop(
      config,
      registry,
      'start',
      [],
      loopCallbacks({ onUserMessageAppended: (message: Message) => appended.push(message) }),
      'auto',
      {
        isNewSession: false,
        runtime: new SessionRuntime(),
        steering: inbox,
        signal: controller.signal,
      },
    );

    await waitFor(() => existsSync(signalFile), "the first steer's hook to start");
    controller.abort();
    const history = await run;

    // Everything the drain took and did not append is back, in the order the user sent it, so the
    // host can deliver each as its own turn. Nothing of it was appended.
    expect(inbox.pending().map((entry) => entry.id)).toEqual(['steer-1', 'steer-2', 'steer-3']);
    expect(appended).toHaveLength(0);
    expect(history.some((message) => message.id.startsWith('steer-'))).toBe(false);
  });

  it('leaves a steer pending when the budget refuses the request it would join', async () => {
    // The tool-step drain is the one door a steer can come in by that no turn-end gate guards:
    // it appends, and the request that would answer it is then refused for money. The drain asks
    // the same budget check the request does, so the steer waits for the host instead.
    const inbox = createSteeringInbox();
    const registry = createRegistry();
    registry.register({
      name: 'SpendTool',
      description: 'Queues a steer after spending the run out.',
      parameters: { type: 'object', properties: {} },
      execute: async (): Promise<ToolResult> => {
        inbox.push(steer('steer-1', 'one more thing'));
        return toolSuccess('tool finished');
      },
    });
    const provider = createScriptedProvider(
      sseResponse([
        JSON.stringify({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'tool-1',
                    function: { name: 'SpendTool', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        }),
        // $5 of input at gpt-5's rate, against a one-tenth-of-a-cent budget.
        JSON.stringify({
          choices: [],
          model: 'gpt-5',
          usage: { prompt_tokens: 1_000_000, completion_tokens: 1, total_tokens: 1_000_001 },
        }),
      ]),
      textStep('This second request must not happen.'),
    );
    vi.stubGlobal('fetch', provider.fetch);

    const runtime = new SessionRuntime();
    const runContext = createAgentRunContext({
      sessionId: 'steering-budget',
      runId: 'steering-budget-run',
      source: 'headless',
      startedAt: 1,
    });
    runtime.runAccounting.startRoot(runContext, 0.001);

    let outcome: AgentTerminalOutcome | undefined;
    const config = defaultConfig({ model: 'gpt-5' });
    config.maxTurns = 4;
    const history = await runAgentLoop(
      config,
      registry,
      'start',
      [],
      loopCallbacks({ onTerminal: (value: AgentTerminalOutcome) => (outcome = value) }),
      'auto',
      { isNewSession: false, runtime, runContext, steering: inbox },
    );

    // The budget ended the run exactly as it would have; the steer was never appended for a
    // request that never went out.
    expect(provider.requests).toHaveLength(1);
    expect(outcome).toMatchObject({ status: 'failed', reason: 'budget_exceeded' });
    expect(inbox.pending().map((entry) => entry.id)).toEqual(['steer-1']);
    expect(history.some((message) => message.id === 'steer-1')).toBe(false);
  });

  it('promises mid-run messages only in a run whose host can steer', async () => {
    // The cached prefix must be the same on every run of a steerable session — including the run
    // started for a notification — so the host sets the option, and only the host does.
    const line = 'The user can send messages while you work';
    const send = async (steeringHost: boolean | undefined) => {
      const provider = createScriptedProvider(textStep('Done.'));
      vi.stubGlobal('fetch', provider.fetch);
      const config = defaultConfig();
      config.maxTurns = 2;
      await runAgentLoop(config, createRegistry(), 'start', [], loopCallbacks(), 'auto', {
        isNewSession: false,
        runtime: new SessionRuntime(),
        ...(steeringHost !== undefined ? { steeringHost } : {}),
      });
      const body = provider.requests[0]?.init?.body;
      if (typeof body !== 'string') throw new Error('request has no recorded body');
      return JSON.stringify((JSON.parse(body) as { messages: unknown }).messages);
    };

    expect(await send(undefined)).not.toContain(line);
    expect(await send(false)).not.toContain(line);
    expect(await send(true)).toContain(line);
  });

  const peer = (name: string): PeerSessionRow => ({
    name,
    ref: '825389',
    socketPath: `/tmp/socks/${name}.sock`,
    kind: 'interactive',
    status: 'idle',
    startedAt: 0,
    sessionId: `session-${name}`,
    pid: 1,
    self: false,
  });

  const PEERS: PeerSessionListing = {
    self: { ...peer('book-1'), self: true, ref: 'ffffff' },
    peers: [peer('book-36'), peer('book-37')],
  };

  /** A messaging handle whose peers list and resolve, so `@name` mentions earn their note. */
  function notesMessaging(): SessionMessagingHandle {
    return {
      available: () => true,
      list: async () => PEERS,
      resolve: async (to) => {
        const target = PEERS.peers.find((row) => row.name === to.trim()) as
          (PeerSessionRow & { socketPath: string }) | undefined;
        return target ? { ok: true, target } : { ok: false, problem: 'not_found', candidates: [] };
      },
      send: async () => ({ status: 'unavailable' }),
    };
  }

  /** A registry that offers the messaging tools, plus the tool a note-bearing test registers. */
  function notesRegistry(handle: SessionMessagingHandle) {
    const registry = createDefaultRegistry();
    registry.registerAll([createSessionListTool(handle), createSessionSendTool(handle)]);
    return registry;
  }

  /** The user turns one recorded request sent, as text, block and all. */
  function requestUserTexts(provider: ReturnType<typeof createScriptedProvider>, index: number) {
    return requestMessages(provider, index)
      .filter((message) => message.role === 'user')
      .map((message) => JSON.stringify(message.content));
  }

  function mentions(texts: string[], name: string): boolean {
    return texts.some((text) => text.includes(`@-mentioned the Book session \\"${name}`));
  }

  it('keeps both notes when the run prompt and a steer land on the same turn', async () => {
    // The steer is appended by the first drain, so it — not the run's prompt — is the newest user
    // turn whose block renders. The prompt's note must ride along rather than be overwritten.
    const inbox = createSteeringInbox();
    inbox.push(steer('steer-1', 'then ask @book-37 to review it'));
    const handle = notesMessaging();
    const snapshot = new SessionMentionSnapshot(handle);
    await snapshot.fresh();
    const provider = createScriptedProvider(textStep('Asked both.'));
    vi.stubGlobal('fetch', provider.fetch);

    const config = defaultConfig();
    config.maxTurns = 4;
    await runAgentLoop(
      config,
      notesRegistry(handle),
      'ask @book-36 to run the tests',
      [],
      loopCallbacks(),
      'default',
      {
        isNewSession: false,
        runtime: new SessionRuntime(),
        steering: inbox,
        sessionMentions: snapshot,
        typedText: 'ask @book-36 to run the tests',
      },
    );

    const first = requestUserTexts(provider, 0);
    expect(mentions(first, 'book-36')).toBe(true);
    expect(mentions(first, 'book-37')).toBe(true);
  });

  it('keeps both steers’ notes when two are drained into one turn', async () => {
    const inbox = createSteeringInbox();
    const handle = notesMessaging();
    const snapshot = new SessionMentionSnapshot(handle);
    await snapshot.fresh();
    const registry = notesRegistry(handle);
    registry.register({
      name: 'SlowTool',
      description: 'Queues two steers, each naming a session.',
      parameters: { type: 'object', properties: {} },
      execute: async (): Promise<ToolResult> => {
        inbox.push(steer('steer-1', 'ask @book-36 to run the tests'));
        inbox.push(steer('steer-2', 'ask @book-37 to review it'));
        return toolSuccess('tool finished');
      },
    });
    const provider = createScriptedProvider(
      toolStep('tool-1', 'SlowTool'),
      textStep('Asked both.'),
    );
    vi.stubGlobal('fetch', provider.fetch);

    const config = defaultConfig();
    config.maxTurns = 4;
    await runAgentLoop(
      config,
      registry,
      'start',
      [],
      loopCallbacks({ onPermissionRequired: async () => 'allow' }),
      'default',
      {
        isNewSession: false,
        runtime: new SessionRuntime(),
        steering: inbox,
        sessionMentions: snapshot,
      },
    );

    // The request that carries the steers: the second is the newest user turn, and the first's
    // note has to join it rather than vanish.
    const second = requestUserTexts(provider, 1);
    expect(mentions(second, 'book-36')).toBe(true);
    expect(mentions(second, 'book-37')).toBe(true);
  });

  it('keeps a turn-end steer’s note when a work-state refresh follows it', async () => {
    // The refresh is appended after the steer at the next turn's start, so the steer is no longer
    // the newest user turn — its note still has to reach the block the request renders.
    const inbox = createSteeringInbox();
    const handle = notesMessaging();
    const snapshot = new SessionMentionSnapshot(handle);
    await snapshot.fresh();
    const provider = createScriptedProvider(() => {
      // The user spoke while this answer was being written.
      inbox.push(steer('steer-1', 'also ask @book-36 to run the tests'));
      return textStep('I have finished.');
    }, textStep('Asked.'));
    vi.stubGlobal('fetch', provider.fetch);

    const runtime = new SessionRuntime({
      todos: [{ content: 'finish the task', status: 'pending' }],
    });
    const config = defaultConfig();
    config.maxTurns = 4;
    config.settings.continuation.enabled = true;
    config.settings.continuation.planRefreshTurns = 1;
    await runAgentLoop(config, notesRegistry(handle), 'start', [], loopCallbacks(), 'default', {
      isNewSession: false,
      runtime,
      steering: inbox,
      sessionMentions: snapshot,
    });

    // The refresh is the newest user turn of the second request, and it carries the steer's note.
    const second = requestUserTexts(provider, 1);
    expect(second.some((text) => text.includes('[work-state]'))).toBe(true);
    expect(mentions(second, 'book-36')).toBe(true);
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

  it('persists a hook’s rewrite in place of the text the user typed', async () => {
    fixture = createSessionFixture('book-steering-hook-');
    const sessionId = fixture.store.create({ cwd: fixture.root });
    fixture.store.append(sessionId, {
      type: 'user',
      eventId: 'prompt-1',
      timestamp: 10,
      data: { id: 'prompt-1', content: 'start', kind: 'conversation' },
    });

    const inbox = createSteeringInbox();
    const provider = createScriptedProvider(() => {
      inbox.push(
        steer('steer-1', 'REWRITE-ME: fix the name', {
          displayMessage: 'REWRITE-ME: fix the name',
        }),
      );
      return textStep('Starting.');
    }, textStep('Fixed with the rewrite.'));
    vi.stubGlobal('fetch', provider.fetch);

    const config = defaultConfig();
    config.maxTurns = 4;
    config.settings.hooks.UserPromptSubmit = [
      hookWhenPromptHolds('REWRITE-ME', { action: 'modify', prompt: 'fix the caller name' }),
    ];
    await new AgentSession().run({
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

    // The rewrite is what the user's message was, so it is what a resumed session shows.
    const records = fixture.store.readRecords(sessionId);
    const steeredRecord = records.find(
      (record) => record.type === 'user' && (record.data as { id?: string }).id === 'steer-1',
    );
    expect(steeredRecord).toMatchObject({
      type: 'user',
      data: { id: 'steer-1', content: 'fix the caller name', steered: true },
    });
    expect((steeredRecord?.data as { contextContent?: string }).contextContent).toBeUndefined();
    const loaded = new SessionStore(fixture.root)
      .load(sessionId)
      .transcript.find((message) => message.id === 'steer-1');
    expect(loaded).toMatchObject({ role: 'user', content: 'fix the caller name', steered: true });
    expect(loaded?.derivedContent).toBeUndefined();
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
