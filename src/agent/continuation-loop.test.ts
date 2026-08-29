import { describe, it, expect } from 'vitest';
import { runAgentLoop } from './loop.js';
import { createRegistry } from '../tools/registry.js';
import { todoTools } from '../tools/todo.js';
import { defaultConfig } from '../test/fixtures.js';
import { SessionRuntime } from '../session/runtime.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type { Provider } from '../provider/index.js';
import type { AgentTerminalOutcome } from '../types/terminal.js';
import type { Message } from '../types/messages.js';

function configWith(continuation: Partial<{ enabled: boolean; noProgressLimit: number }>) {
  const config = defaultConfig();
  config.maxTurns = 0; // unlimited; continuation supplies its own ceilings
  config.settings.continuation = { ...config.settings.continuation, ...continuation };
  return config;
}

function registryWithTodos() {
  const registry = createRegistry();
  registry.registerAll(todoTools);
  return registry;
}

async function run(
  config: ReturnType<typeof configWith>,
  provider: Provider,
): Promise<{
  outcome?: AgentTerminalOutcome;
  history: Message[];
  appended: Message[];
}> {
  let outcome: AgentTerminalOutcome | undefined;
  const appended: Message[] = [];
  const runtime = new SessionRuntime();
  const callbacks = {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onError: () => {},
    onTurnStart: () => {},
    onDone: () => {},
    onTerminal: (value: AgentTerminalOutcome) => (outcome = value),
    onUserMessageAppended: (message: Message) => appended.push(message),
  } as unknown as AgentLoopCallbacks;

  const history = await runAgentLoop(
    config,
    registryWithTodos(),
    'migrate every call site',
    [],
    callbacks,
    'auto',
    { provider, isNewSession: false, runtime },
  );
  return { outcome, history, appended };
}

/** A provider that writes a todo list, then answers with text forever. */
function stallingProvider(): Provider {
  let turn = 0;
  return {
    id: 'scripted',
    stream: async function* () {
      turn++;
      if (turn === 1) {
        yield {
          type: 'tool_call',
          toolCall: {
            id: 'todo-1',
            name: 'TodoWrite',
            arguments: { todos: [{ content: 'migrate call sites', status: 'pending' }] },
          },
        };
        yield { type: 'done' };
        return;
      }
      yield { type: 'text', content: 'I think I am done.' };
      yield { type: 'done' };
    },
  } as unknown as Provider;
}

describe('continuation in the loop', () => {
  it('ends the run at the first text-only turn when disabled', async () => {
    // The historical behavior, and the default. One user message is the run.
    const { outcome, appended } = await run(configWith({ enabled: false }), stallingProvider());

    expect(appended).toHaveLength(0);
    expect(outcome).toMatchObject({ status: 'completed', reason: 'normal_completion' });
  });

  it('continues past a premature stop, then brakes when nothing changes', async () => {
    // Parts 1 and 4 of the milestone are tested together on purpose: continuation
    // without the brake would spin and bill silently, which is strictly worse than
    // stopping, because today a stalled run stops and a human notices.
    const { outcome, appended } = await run(
      configWith({ enabled: true, noProgressLimit: 3 }),
      stallingProvider(),
    );

    expect(appended.length).toBeGreaterThan(0);
    expect(appended.length).toBeLessThanOrEqual(4);
    expect(appended[0].role).toBe('user');
    expect(appended[0].content).toContain('migrate call sites');
    // 'conversation' is load-bearing: it is what opens a compaction bundle.
    expect(appended[0].kind).toBe('conversation');
    expect(outcome).toMatchObject({ status: 'failed', reason: 'no_progress' });
  });

  it('reports objective_complete when the plan is actually finished', async () => {
    let turn = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        turn++;
        if (turn === 1) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: 'todo-1',
              name: 'TodoWrite',
              arguments: { todos: [{ content: 'the work', status: 'pending' }] },
            },
          };
          yield { type: 'done' };
          return;
        }
        if (turn === 2) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: 'todo-2',
              name: 'TodoWrite',
              arguments: { todos: [{ content: 'the work', status: 'completed' }] },
            },
          };
          yield { type: 'done' };
          return;
        }
        yield { type: 'text', content: 'All done.' };
        yield { type: 'done' };
      },
    } as unknown as Provider;

    const { outcome, appended } = await run(configWith({ enabled: true }), provider);

    expect(appended).toHaveLength(0);
    expect(outcome).toMatchObject({ status: 'completed', reason: 'objective_complete' });
  });

  it('appends the continuation to history so a resume can see it', async () => {
    const { history } = await run(
      configWith({ enabled: true, noProgressLimit: 2 }),
      stallingProvider(),
    );

    const continuation = history.find(
      (message) => message.role === 'user' && message.content.startsWith('[continuation]'),
    );
    expect(continuation).toBeDefined();
    expect(continuation?.includeInContext).toBe(true);
  });
});

describe('periodic work-state refresh', () => {
  it('restores compaction bundle boundaries in a run that never stops', async () => {
    // The failure it prevents: a model grinding tool calls never produces a
    // text-only turn, so it never triggers a continuation either. The compaction
    // candidate span is then all-assistant, splitUserLedBundles returns no
    // bundles, and the retained tail is unconditionally zero at generation 2+.
    const config = configWith({ enabled: true });
    config.settings.continuation.planRefreshTurns = 2;

    let turn = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        turn++;
        if (turn === 1) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: 'todo-1',
              name: 'TodoWrite',
              arguments: { todos: [{ content: 'long grind', status: 'in_progress' }] },
            },
          };
          yield { type: 'done' };
          return;
        }
        if (turn <= 6) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: `todo-${turn}`,
              name: 'TodoWrite',
              arguments: { todos: [{ content: `long grind ${turn}`, status: 'in_progress' }] },
            },
          };
          yield { type: 'done' };
          return;
        }
        yield { type: 'text', content: 'stopping' };
        yield { type: 'done' };
      },
    } as unknown as Provider;

    const { history, appended } = await run(config, provider);

    const workState = appended.filter((message) => message.content.startsWith('[work-state]'));
    expect(workState.length).toBeGreaterThan(0);
    expect(workState[0].kind).toBe('conversation');
    expect(workState[0].content).toContain('long grind');
    // It has to be in history, where splitUserLedBundles will see it.
    expect(history.some((message) => message.content.startsWith('[work-state]'))).toBe(true);
  });

  it('emits nothing when there is no open plan to restate', async () => {
    const config = configWith({ enabled: true });
    config.settings.continuation.planRefreshTurns = 1;

    let turn = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        turn++;
        if (turn <= 3) {
          yield {
            type: 'tool_call',
            toolCall: { id: `c-${turn}`, name: 'TodoWrite', arguments: { todos: [] } },
          };
          yield { type: 'done' };
          return;
        }
        yield { type: 'text', content: 'done' };
        yield { type: 'done' };
      },
    } as unknown as Provider;

    const { appended } = await run(config, provider);
    expect(appended.filter((m) => m.content.startsWith('[work-state]'))).toHaveLength(0);
  });
});

describe('completion gate', () => {
  it('turns a blocking Stop hook into another turn instead of finishing', async () => {
    // "Do not consider this done until `npm run check` passes" is not expressible
    // from outside the process any other way: a Stop hook's block used to be
    // collected and discarded.
    const config = configWith({ enabled: true });
    config.settings.hooks.Stop = [
      {
        // Exit 2 with a reason on stderr is the block protocol.
        command: `node -e "console.error('two tests are failing'); process.exit(2)"`,
        env: {},
      },
    ];

    let turn = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        turn++;
        if (turn === 1) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: 'todo-1',
              name: 'TodoWrite',
              arguments: { todos: [{ content: 'the work', status: 'completed' }] },
            },
          };
          yield { type: 'done' };
          return;
        }
        yield { type: 'text', content: 'All done.' };
        yield { type: 'done' };
      },
    } as unknown as Provider;

    const { appended } = await run(config, provider);

    const gate = appended.filter((m) => m.content.includes('completion gate refused'));
    expect(gate.length).toBeGreaterThan(0);
    expect(gate[0].content).toContain('two tests are failing');
  });

  it('lets a passing gate finish the run', async () => {
    const config = configWith({ enabled: true });
    config.settings.hooks.Stop = [{ command: `node -e ""`, env: {} }];

    let turn = 0;
    const provider: Provider = {
      id: 'scripted',
      stream: async function* () {
        turn++;
        if (turn === 1) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: 'todo-1',
              name: 'TodoWrite',
              arguments: { todos: [{ content: 'the work', status: 'completed' }] },
            },
          };
          yield { type: 'done' };
          return;
        }
        yield { type: 'text', content: 'All done.' };
        yield { type: 'done' };
      },
    } as unknown as Provider;

    const { outcome, appended } = await run(config, provider);
    expect(appended.filter((m) => m.content.includes('completion gate'))).toHaveLength(0);
    expect(outcome).toMatchObject({ status: 'completed', reason: 'objective_complete' });
  });
});
