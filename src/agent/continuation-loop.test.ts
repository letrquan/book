import { describe, it, expect, vi } from 'vitest';
import { runAgentLoop } from './loop.js';
import { createRegistry, createDefaultRegistry } from '../tools/registry.js';
import { todoTools } from '../tools/todo.js';
import { defaultConfig } from '../test/fixtures.js';
import { SessionRuntime } from '../session/runtime.js';
import { renderSessionState } from './session-state.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type { Provider } from '../provider/index.js';
import type { AgentTerminalOutcome } from '../types/terminal.js';
import type { Message } from '../types/messages.js';
import type { ToolResult } from '../types/tools.js';
import { createWebTools } from '../tools/web.js';

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
    // Host-authored, like the continuation prompts: not the user's words, and no answer.
    expect(workState[0].derivedContent).toBe(true);
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

/** A provider that keeps issuing the same mutating tool call, forever. */
function refusedToolProvider(): Provider {
  let call = 0;
  return {
    id: 'scripted',
    stream: async function* () {
      call++;
      yield {
        type: 'tool_call',
        toolCall: {
          id: `write-${call}`,
          name: 'Write',
          arguments: { file_path: 'generated.txt', content: 'work' },
        },
      };
      yield { type: 'done' };
    },
  } as unknown as Provider;
}

async function runDenied(
  config: ReturnType<typeof configWith>,
  provider: Provider,
  unattended = true,
): Promise<{ outcome?: AgentTerminalOutcome; denials: number }> {
  let outcome: AgentTerminalOutcome | undefined;
  let denials = 0;
  const callbacks = {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onError: () => {},
    onTurnStart: () => {},
    onDone: () => {},
    onTerminal: (value: AgentTerminalOutcome) => (outcome = value),
    // Refuse the mutation only. Denying the planning tool too would leave the run
    // with no plan at all, which stops for an entirely different reason.
    onPermissionRequired: async (call: { name: string }) => {
      if (call.name !== 'Write') return 'allow' as const;
      denials++;
      return 'deny' as const;
    },
  } as unknown as AgentLoopCallbacks;

  await runAgentLoop(config, createDefaultRegistry(), 'do the work', [], callbacks, 'default', {
    provider,
    isNewSession: false,
    runtime: new SessionRuntime(),
    unattended,
  });
  return { outcome, denials };
}

describe('a run whose every tool call is refused', () => {
  it('stops instead of spinning, even with continuation disabled', async () => {
    // The failure this exists for: a refusal spin never produces an empty turn, so
    // the turn-end gate never fires and neither brake downstream of it is ever
    // consulted. Continuation is OFF here on purpose — this spin predates it and
    // happens today in headless, which answers every unresolved prompt `deny`.
    const config = configWith({ enabled: false });
    config.settings.continuation.blockedToolTurnLimit = 3;
    // A ceiling so a broken brake fails the assertion instead of hanging the suite.
    config.maxTurns = 25;

    const { outcome, denials } = await runDenied(config, refusedToolProvider());

    expect(outcome).toMatchObject({ status: 'failed', reason: 'all_tools_blocked' });
    // The operator has to be told which tool to unblock, or the exit is not actionable.
    expect(outcome?.message).toContain('Write');
    expect(outcome?.message).toContain('grant the permission');
    expect(outcome?.message).not.toContain('BOOK_WEB_ALLOW_PRIVATE_NETWORK');
    expect(denials).toBe(3);
  });

  it('is disabled by a zero limit', async () => {
    const config = configWith({ enabled: false });
    config.settings.continuation.blockedToolTurnLimit = 0;
    config.maxTurns = 4;

    const { outcome } = await runDenied(config, refusedToolProvider());

    expect(outcome?.reason).not.toBe('all_tools_blocked');
  });
});

describe('the no-progress witness', () => {
  it('does not accept a refused tool call as progress', async () => {
    // `toolCallStats` increments for every attempted call, refusals included, so a
    // witness drawn from it changes on every turn of a denial spin — the one leg
    // that is supposed to prove nothing moved is guaranteed to move. The witness
    // must count only calls that actually ran.
    //
    // The blocked-turn brake is off here so that the ONLY thing able to stop this
    // run is the witness itself.
    const config = configWith({ enabled: true, noProgressLimit: 2 });
    config.settings.continuation.blockedToolTurnLimit = 0;
    config.maxTurns = 30;

    let turn = 0;
    const provider = {
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
        // Alternate: a refused mutation, then a text-only turn that hands control
        // to the continuation decision — which is where the witness is compared.
        if (turn % 2 === 1) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: `write-${turn}`,
              name: 'Write',
              arguments: { file_path: 'generated.txt', content: 'work' },
            },
          };
          yield { type: 'done' };
          return;
        }
        yield { type: 'text', content: 'Still working on it.' };
        yield { type: 'done' };
      },
    } as unknown as Provider;

    const { outcome } = await runDenied(config, provider);

    expect(outcome).toMatchObject({ status: 'failed', reason: 'no_progress' });
  });
});

describe('the session-state block across a long run', () => {
  it('tells the model how long it has been running, coarsely', () => {
    // The only temporal signal in the entire prompt was a UTC calendar date at day
    // granularity, so a model five days into a week-long objective could not tell
    // that from turn 3 — it could not pace itself or notice it had been circling.
    expect(renderSessionState({ workspace: '/w', runElapsedMs: 5 * 24 * 3600_000 })).toContain(
      '- Running for: 5d 0h',
    );
    // Below a minute there is nothing worth saying.
    expect(renderSessionState({ workspace: '/w', runElapsedMs: 5_000 })).not.toContain(
      'Running for',
    );
    // Absent when the host does not track it.
    expect(renderSessionState({ workspace: '/w' })).not.toContain('Running for');
  });

  it('reports pending memory candidates only when positive', () => {
    expect(renderSessionState({ workspace: '/w', pendingMemoryCandidates: 3 })).toContain(
      '- Pending memory candidates: 3 — /memory inbox',
    );
    expect(renderSessionState({ workspace: '/w', pendingMemoryCandidates: 0 })).not.toContain(
      'Pending memory candidates',
    );
    expect(renderSessionState({ workspace: '/w' })).not.toContain('Pending memory candidates');
  });

  it('omits elapsed time when the evaluator has frozen the clock', () => {
    // Equivalent evaluation arms must receive byte-identical prompts.
    const previous = process.env.BOOK_EVALUATION_DATE;
    process.env.BOOK_EVALUATION_DATE = '2026-01-01';
    try {
      expect(renderSessionState({ workspace: '/w', runElapsedMs: 9 * 3600_000 })).not.toContain(
        'Running for',
      );
    } finally {
      if (previous === undefined) delete process.env.BOOK_EVALUATION_DATE;
      else process.env.BOOK_EVALUATION_DATE = previous;
    }
  });

  it('stamps every continuation message, not just the first user turn', async () => {
    // `ensureSessionState` early-returns on `newest.sessionState !== undefined`,
    // and before continuation existed a whole run had exactly ONE user message —
    // so the date, git status, todos and stale-file warnings were rendered once at
    // turn 1 and frozen for the life of the run. Continuation appends real user
    // messages, which is what makes each one get a fresh block. If a future change
    // reuses one message or marks continuations as checkpoints, this fails.
    const { history } = await run(
      configWith({ enabled: true, noProgressLimit: 3 }),
      stallingProvider(),
    );
    const stamped = history.filter(
      (message) => message.role === 'user' && message.sessionState !== undefined,
    );
    // The original prompt plus at least one continuation, each with its own block.
    expect(stamped.length).toBeGreaterThan(1);
  });
});

describe('the refusal brake only applies where nobody can say otherwise', () => {
  it('leaves an interactive run alone when a person declines', () => {
    // A refusal in the TUI is a human saying no, and they are right there to say
    // something else next. Ending their session `failed / all_tools_blocked` for
    // declining three calls — and telling them to "change the permission mode" —
    // would be absurd. The spin this brake exists for is headless, which answers
    // every unresolved prompt `deny` with nobody present.
    const config = configWith({ enabled: false });
    config.settings.continuation.blockedToolTurnLimit = 3;
    config.maxTurns = 6;

    return runDenied(config, refusedToolProvider(), false).then(({ outcome }) => {
      expect(outcome?.reason).not.toBe('all_tools_blocked');
    });
  });
});

/**
 * A provider that activates WebFetch, then fetches a loopback address on every turn. With
 * `alternateWrite`, every other turn is a Write instead, which the host refuses on permission
 * grounds, so the streak holds both kinds of refusal while its last turn holds only one.
 */
function privateFetchProvider(alternateWrite = false): Provider {
  let call = 0;
  return {
    id: 'scripted',
    stream: async function* () {
      call++;
      if (call === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'search-1', name: 'ToolSearch', arguments: { query: 'WebFetch' } },
        };
      } else if (alternateWrite && call % 2 === 1) {
        yield {
          type: 'tool_call',
          toolCall: {
            id: `write-${call}`,
            name: 'Write',
            arguments: { file_path: 'generated.txt', content: 'work' },
          },
        };
      } else {
        yield {
          type: 'tool_call',
          toolCall: {
            id: `fetch-${call}`,
            name: 'WebFetch',
            arguments: { url: 'https://127.0.0.1/' },
          },
        };
      }
      yield { type: 'done' };
    },
  } as unknown as Provider;
}

/**
 * An unattended run with the refusal brake at 3, recording the code of every refused call. The
 * host opt-in is pinned off: set in the developer's shell, it would turn the WebFetch refusals
 * these tests count on into real requests.
 */
async function runRefusals(
  provider: Provider,
  mode: 'default' | 'bypassPermissions',
  registry = createDefaultRegistry(),
): Promise<{ outcome?: AgentTerminalOutcome; codes: string[] }> {
  vi.stubEnv('BOOK_WEB_ALLOW_PRIVATE_NETWORK', '');
  const config = configWith({ enabled: false });
  config.settings.continuation.blockedToolTurnLimit = 3;
  config.maxTurns = 25;
  let outcome: AgentTerminalOutcome | undefined;
  const codes: string[] = [];
  const callbacks = {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: (result: ToolResult) => {
      if (result.status === 'blocked') codes.push(result.structuredError?.code ?? 'none');
    },
    onError: () => {},
    onTurnStart: () => {},
    onDone: () => {},
    onTerminal: (value: AgentTerminalOutcome) => (outcome = value),
    onPermissionRequired: async (call: { name: string }) =>
      call.name === 'Write' ? ('deny' as const) : ('allow' as const),
  } as unknown as AgentLoopCallbacks;

  try {
    await runAgentLoop(config, registry, 'check the local service', [], callbacks, mode, {
      provider,
      isNewSession: false,
      runtime: new SessionRuntime(),
      unattended: true,
    });
  } finally {
    vi.unstubAllEnvs();
  }
  return { outcome, codes };
}

/** A provider that activates the web tools, then issues the same web calls on every turn. */
function refusedWebProvider(
  calls: Array<'WebFetch' | 'WebSearch'>,
  fetchUrl = 'https://127.0.0.1/',
): Provider {
  let turn = 0;
  return {
    id: 'scripted',
    stream: async function* () {
      turn++;
      if (turn === 1) {
        yield {
          type: 'tool_call',
          toolCall: { id: 'search-1', name: 'ToolSearch', arguments: { query: 'WebSearch' } },
        };
      } else {
        for (const name of calls) {
          yield {
            type: 'tool_call',
            toolCall: {
              id: `${name}-${turn}`,
              name,
              arguments: name === 'WebFetch' ? { url: fetchUrl } : { query: 'book agent docs' },
            },
          };
        }
      }
      yield { type: 'done' };
    },
  } as unknown as Provider;
}

/**
 * The default tools, with the web tools rebuilt on a resolver that answers every hostname inside
 * 198.18.0.0/15, as behind a fake-IP DNS proxy. Each built-in search provider is then refused
 * before any request leaves the host.
 */
function fakeIpDnsWebRegistry() {
  const registry = createDefaultRegistry();
  registry.registerAll(createWebTools({ resolveHostname: async () => ['198.18.0.1'] }));
  return registry;
}

/** The default tools, with WebFetch rebuilt on a server whose every page redirects to another origin. */
function crossOriginRedirectWebRegistry() {
  const registry = createDefaultRegistry();
  registry.registerAll(
    createWebTools({
      resolveHostname: async () => ['93.184.216.34'],
      fetch: async () =>
        new Response(null, { status: 302, headers: { location: 'https://other.example/next' } }),
    }),
  );
  return registry;
}

describe('the refusal brake names the cause it stopped on', () => {
  it('gives a streak of stopped cross-origin redirects their own remedy, not permission advice', async () => {
    // A redirect to another origin is never followed by the same WebFetch; the model has to fetch
    // the target itself. No permission, mode or setting changes that, even under bypassPermissions.
    const { outcome, codes } = await runRefusals(
      refusedWebProvider(['WebFetch'], 'https://example.com/start'),
      'bypassPermissions',
      crossOriginRedirectWebRegistry(),
    );

    expect(codes).toEqual([
      'cross_origin_redirect',
      'cross_origin_redirect',
      'cross_origin_redirect',
    ]);
    expect(outcome).toMatchObject({ status: 'failed', reason: 'all_tools_blocked' });
    expect(outcome?.message).toContain('redirected to another origin');
    expect(outcome?.message).not.toContain('grant the permission');
    expect(outcome?.message).not.toContain('BOOK_WEB_ALLOW_PRIVATE_NETWORK');
  });

  it('points a streak of network-policy refusals at the host opt-in, not at permissions', async () => {
    // Under bypassPermissions there is no permission left to grant, so "grant the permission, add
    // an allow rule, or change the permission mode" is a dead end. No rule or mode lifts the web
    // network policy; only the host's opt-in does.
    const { outcome, codes } = await runRefusals(privateFetchProvider(), 'bypassPermissions');

    expect(codes).toEqual([
      'private_network_forbidden',
      'private_network_forbidden',
      'private_network_forbidden',
    ]);
    expect(outcome).toMatchObject({ status: 'failed', reason: 'all_tools_blocked' });
    expect(outcome?.message).toContain('WebFetch');
    expect(outcome?.message).toContain('BOOK_WEB_ALLOW_PRIVATE_NETWORK');
    expect(outcome?.message).not.toContain('grant the permission');
    // The operator sees what was refused, and that the opt-in is not scoped to it: it switches
    // the private-network check off for every WebFetch.
    expect(outcome?.message).toContain('127.0.0.1');
    expect(outcome?.message).toContain('every destination');
  });

  it('names both remedies when the streak mixes network-policy and permission refusals', async () => {
    // The streak's last turn is a WebFetch alone, so a message built from that turn would drop the
    // permission advice the Write refused before it still needs.
    const { outcome, codes } = await runRefusals(privateFetchProvider(true), 'default');

    expect(codes).toEqual([
      'private_network_forbidden',
      'permission_denied',
      'private_network_forbidden',
    ]);
    expect(outcome).toMatchObject({ status: 'failed', reason: 'all_tools_blocked' });
    expect(outcome?.message).toContain('BOOK_WEB_ALLOW_PRIVATE_NETWORK');
    expect(outcome?.message).toContain('grant the permission');
    // The Write refused two turns back is the call the permission remedy is for, so it is named.
    expect(outcome?.message).toContain('Write');
  });

  it('does not offer the WebFetch opt-in for a streak of refused WebSearch calls', async () => {
    // The built-in search providers validate with allowPrivateNetwork: false whatever the host
    // sets, so BOOK_WEB_ALLOW_PRIVATE_NETWORK would strip WebFetch's protection and still leave
    // WebSearch refused. What helps is fixing the DNS or proxy that sent the providers private.
    const { outcome, codes } = await runRefusals(
      refusedWebProvider(['WebSearch']),
      'bypassPermissions',
      fakeIpDnsWebRegistry(),
    );

    expect(codes).toEqual([
      'search_all_providers_failed',
      'search_all_providers_failed',
      'search_all_providers_failed',
    ]);
    expect(outcome).toMatchObject({ status: 'failed', reason: 'all_tools_blocked' });
    expect(outcome?.message).toContain('WebSearch');
    expect(outcome?.message).toContain('DNS or proxy');
    // The fake-IP answer is named, which is what points the operator at the DNS proxy.
    expect(outcome?.message).toContain('198.18.0.1');
    expect(outcome?.message).not.toContain('BOOK_WEB_ALLOW_PRIVATE_NETWORK');
    expect(outcome?.message).not.toContain('grant the permission');
  });

  it('names each remedy that applies when WebFetch and WebSearch are both refused', async () => {
    const { outcome, codes } = await runRefusals(
      refusedWebProvider(['WebFetch', 'WebSearch']),
      'bypassPermissions',
      fakeIpDnsWebRegistry(),
    );

    expect(new Set(codes)).toEqual(
      new Set(['private_network_forbidden', 'search_all_providers_failed']),
    );
    expect(outcome).toMatchObject({ status: 'failed', reason: 'all_tools_blocked' });
    expect(outcome?.message).toContain('BOOK_WEB_ALLOW_PRIVATE_NETWORK');
    expect(outcome?.message).toContain('DNS or proxy');
    expect(outcome?.message).not.toContain('grant the permission');
  });
});
