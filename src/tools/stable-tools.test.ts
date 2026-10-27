import { describe, expect, it } from 'vitest';
import type { Message } from '../types/messages.js';
import type { AgentConfig } from '../types/runtime.js';
import type { ToolContext, ToolDefinition } from '../types/tools.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { convertTools as openAiTools } from '../provider/openai-compatible.js';
import { createToolSurface } from './catalog.js';
import { createDefaultRegistry, createRegistry } from './registry.js';
import { toolSuccess } from './result.js';

// Stable tools (#619): a request's tools only grow during a session. A loaded tool is appended
// after the core and every tool loaded before it, nothing is evicted to make room, and the loaded
// set starts over only at a reset point. A stable surface also declares every authorized tool
// from the first request, so an activation changes the messages, never `tools[]`.

function config(): AgentConfig {
  return {
    apiKey: 'test',
    baseUrl: 'http://localhost',
    model: 'test',
    maxTokens: 128_000,
    compactStrategy: 'summary',
    autoCompactEnabled: false,
    workspace: process.cwd(),
    animation: { typewriterSpeed: 0, spinnerStyle: 'dots' },
    accessibility: { screenReader: false, reducedMotion: false },
    settings: structuredClone(DEFAULT_SETTINGS),
    retry: {
      maxAttempts: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      totalBudgetMs: 0,
      requestTimeoutMs: 10_000,
      streamStallTimeoutMs: 10_000,
      toolRetries: 0,
      watchdog: false,
    },
  };
}

function context(): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    env: {},
    currentMode: 'default',
    backgroundShells: { nextId: 1, shells: new Map() },
  };
}

function definition(name: string): ToolDefinition {
  return {
    name,
    description: `The ${name} capability.`,
    parameters: { type: 'object', properties: {} },
    execute: async () => toolSuccess(`ran ${name}`),
  };
}

function message(overrides: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
  return { content: '', includeInContext: true, timestamp: 0, ...overrides };
}

const user = (id: string) => message({ id, role: 'user', content: id });
const checkpoint = (id: string) =>
  message({ id, role: 'user', kind: 'checkpoint', content: 'summary' });
/** A reply whose request offered `names` by addition, as the Anthropic provider records it. */
const reply = (id: string, names: string[]) =>
  message({ id, role: 'assistant', content: 'ok', providerMetadata: { toolAdditions: names } });

const namesOf = (definitions: ToolDefinition[]) => definitions.map((entry) => entry.name);

function defaultSurface(runtimeContext = context(), configure?: (config: AgentConfig) => void) {
  const runtimeConfig = config();
  configure?.(runtimeConfig);
  return createToolSurface({
    config: runtimeConfig,
    context: runtimeContext,
    definitions: createDefaultRegistry().getDefinitions(),
  });
}

describe('append-only activation (#619)', () => {
  it('appends a loaded tool after the core and every tool loaded before it', () => {
    const surface = defaultSurface();
    const core = namesOf(surface.prepareRequest([]).active);

    surface.activate(['WebFetch']);
    expect(namesOf(surface.prepareRequest([]).active)).toEqual([...core, 'WebFetch']);
    // GitLog sits before WebFetch in the catalog, but it loaded after it.
    surface.select!(['GitLog']);
    expect(namesOf(surface.prepareRequest([]).active)).toEqual([...core, 'WebFetch', 'GitLog']);
    // Calling a tool refreshes its recency, never its position.
    expect(surface.canExecute({ id: 'w', name: 'WebFetch', arguments: { url: 'https://x' } })).toBe(
      true,
    );
    expect(namesOf(surface.prepareRequest([]).active)).toEqual([...core, 'WebFetch', 'GitLog']);
  });

  it('never evicts across 30 activations, and refuses each one once the set is full', () => {
    const tools = Array.from({ length: 30 }, (_, index) => definition(`Special${index}`));
    const runtimeConfig = config();
    runtimeConfig.settings.toolDiscovery.mode = 'deferred';
    runtimeConfig.settings.toolDiscovery.maxLoadedTools = 20;
    // The count binds, not the schema budget.
    runtimeConfig.settings.toolDiscovery.schemaTokenBudget = 100_000;
    runtimeConfig.modelInfo = { contextWindow: 2_000_000 };
    const surface = createToolSurface({
      config: runtimeConfig,
      context: context(),
      definitions: [definition('Read'), ...tools],
    });

    let previous = openAiTools(surface.prepareRequest([]).active).map((tool) => tool.function.name);
    for (const [index, tool] of tools.entries()) {
      const outcome = surface.select!([tool.name])[0];
      const next = openAiTools(surface.prepareRequest([]).active).map(
        (entry) => entry.function.name,
      );
      // What the provider was sent before is still the front of what it is sent now.
      expect(next.slice(0, previous.length)).toEqual(previous);
      if (index < 20) {
        expect(outcome?.status).toBe('loaded');
        expect(next).toEqual([...previous, tool.name]);
      } else {
        expect(outcome?.status).toBe('budget');
        expect(next).toEqual(previous);
      }
      previous = next;
    }
    expect(previous.filter((name) => name.startsWith('Special'))).toEqual(
      tools.slice(0, 20).map((tool) => tool.name),
    );
  });

  it('lands every activation of one tool round in the next request together', () => {
    const surface = defaultSurface();
    const before = namesOf(surface.prepareRequest([]).active);

    // Two ToolSearch calls in one response, then the next request.
    surface.select!(['GitLog']);
    surface.select!(['GitDiff', 'WebSearch']);
    const after = namesOf(surface.prepareRequest([]).active);

    expect(after).toEqual([...before, 'GitLog', 'GitDiff', 'WebSearch']);
  });

  it('admits in rank order, and a tool already loaded takes no new slot', () => {
    const surface = defaultSurface(context(), (config) => {
      config.settings.toolDiscovery.maxLoadedTools = 2;
    });
    expect(surface.activate(['GitLog', 'GitDiff', 'WebFetch'])).toEqual(['GitLog', 'GitDiff']);
    expect(surface.activate(['GitDiff', 'GitLog'])).toEqual(['GitDiff', 'GitLog']);
    expect(surface.activate(['WebFetch'])).toEqual([]);
  });

  it('starts the loaded set over at a new compaction checkpoint, and only then', () => {
    const surface = defaultSurface();
    surface.activate(['GitLog']);
    expect(namesOf(surface.prepareRequest([user('u1')]).active)).toContain('GitLog');

    const compacted = [checkpoint('c1'), user('u2')];
    expect(namesOf(surface.prepareRequest(compacted).active)).not.toContain('GitLog');
    surface.activate(['WebFetch']);
    // The same checkpoint is not a second reset.
    expect(namesOf(surface.prepareRequest([...compacted, user('u3')]).active)).toContain(
      'WebFetch',
    );
    expect(namesOf(surface.prepareRequest([checkpoint('c2'), user('u4')]).active)).not.toContain(
      'WebFetch',
    );
  });

  it('keeps across a reset point what loaded since the last answered request', () => {
    const surface = defaultSurface();
    surface.activate(['GitLog']);
    surface.prepareRequest([user('u1')]);
    // The tool round after that request: the model has not seen WebFetch declared yet.
    surface.select!(['WebFetch']);

    const after = namesOf(surface.prepareRequest([checkpoint('c1'), user('u2')]).active);

    expect(after).toContain('WebFetch');
    expect(after).not.toContain('GitLog');
  });

  it("keeps the last round's loads when a compaction rebuilds the request mid-turn", () => {
    const surface = defaultSurface();
    surface.activate(['GitLog']);
    surface.prepareRequest([user('u1')]);
    surface.select!(['WebFetch']);
    // The next turn builds its request, compacts before sending it, and builds it again.
    surface.prepareRequest([user('u1'), reply('a1', [])]);

    const rebuilt = namesOf(
      surface.prepareRequest([checkpoint('c1'), reply('a1', [])], { rebuild: true }).active,
    );

    expect(rebuilt).toContain('WebFetch');
    expect(rebuilt).not.toContain('GitLog');
  });

  it('says why a directly called tool did not load', () => {
    const full = defaultSurface(context(), (config) => {
      config.settings.toolDiscovery.maxLoadedTools = 1;
    });
    full.activate(['GitDiff']);
    expect(full.admitDirect?.('GitLog')).toEqual({ loaded: false });
    expect(full.unloadedReason?.('GitLog')).toBe('full');

    const tight = defaultSurface(context(), (config) => {
      config.settings.toolDiscovery.schemaTokenBudget = 1;
    });
    expect(tight.admitDirect?.('GitLog')).toEqual({ loaded: false });
    expect(tight.unloadedReason?.('GitLog')).toBe('schema');
  });

  it('names a full loaded set, not the schema, when a direct call runs without loading', async () => {
    const definitions = createDefaultRegistry()
      .getDefinitions()
      .map((entry) =>
        entry.name === 'GitLog'
          ? { ...entry, execute: async () => toolSuccess('ran GitLog') }
          : entry,
      );
    const runtimeConfig = config();
    runtimeConfig.settings.toolDiscovery.maxLoadedTools = 1;
    const runtimeContext = context();
    const surface = createToolSurface({
      config: runtimeConfig,
      context: runtimeContext,
      definitions,
    });
    runtimeContext.toolDiscovery = surface;
    surface.activate(['GitDiff']);
    surface.prepareRequest([]);
    const registry = createRegistry();
    registry.registerAll(definitions);

    const result = await registry.execute(
      { id: 'log-1', name: 'GitLog', arguments: {} },
      runtimeContext,
    );

    expect(result.status).toBe('success');
    expect(result.content).toBe(
      'ran GitLog\n\nGitLog ran without being loaded: the loaded tools already fill the tool discovery budgets until the conversation is compacted, so it is not declared next turn either; call it directly again when you need it.',
    );
  });
});

describe('a stable declaration (#619)', () => {
  const stableOf = (surface: ReturnType<typeof defaultSurface>, history: Message[] = []) => {
    const request = surface.prepareRequest(history, { stable: true });
    if (!request.stable) throw new Error('no stable declaration');
    return { ...request.stable, active: request.active };
  };

  it('declares every authorized tool, the fixed core first, and keeps it through activations', () => {
    const surface = defaultSurface();
    const first = stableOf(surface);
    const tools = namesOf(first.tools);

    expect(first.deferred.has('GitLog')).toBe(true);
    expect(first.deferred.has('WebFetch')).toBe(true);
    expect(first.deferred.has('Read')).toBe(false);
    expect(first.deferred.has('ToolSearch')).toBe(false);
    const firstDeferred = tools.findIndex((name) => first.deferred.has(name));
    expect(tools.slice(0, firstDeferred).every((name) => !first.deferred.has(name))).toBe(true);
    expect(tools.slice(firstDeferred).every((name) => first.deferred.has(name))).toBe(true);
    expect(first.additions).toEqual([]);

    surface.select!(['GitLog', 'WebFetch']);
    const second = stableOf(surface, [user('u1')]);
    expect(namesOf(second.tools)).toEqual(tools);
    expect(second.tools).toEqual(first.tools);
    expect(second.additions).toEqual(['GitLog', 'WebFetch']);
    expect(namesOf(second.active)).toEqual([...namesOf(first.active), 'GitLog', 'WebFetch']);
  });

  it('offers an addition once: the reply that recorded it covers it', () => {
    const surface = defaultSurface();
    surface.select!(['GitLog']);
    expect(stableOf(surface, [user('u1')]).additions).toEqual(['GitLog']);
    expect(stableOf(surface, [user('u1'), reply('a1', ['GitLog'])]).additions).toEqual([]);
  });

  it('loads what a resumed history offers, so the surface agrees with the provider', () => {
    const surface = defaultSurface();
    const resumed = stableOf(surface, [user('u1'), reply('a1', ['GitLog']), user('u2')]);

    expect(namesOf(resumed.active)).toContain('GitLog');
    expect(resumed.additions).toEqual([]);
    expect(surface.isActive?.('GitLog')).toBe(true);
  });

  it('keeps what the compacted history still offers at a reset point, and drops the rest', () => {
    const surface = defaultSurface();
    surface.select!(['GitLog', 'WebFetch']);
    stableOf(surface, [user('u1')]);

    const compacted = stableOf(surface, [checkpoint('c1'), reply('a2', ['WebFetch']), user('u3')]);

    expect(namesOf(compacted.active)).toContain('WebFetch');
    expect(namesOf(compacted.active)).not.toContain('GitLog');
    expect(compacted.additions).toEqual([]);
  });

  it('declares the background-shell tools before a shell exists and offers them when one starts', () => {
    const runtimeContext = context();
    const surface = defaultSurface(runtimeContext);
    const before = stableOf(surface);
    expect(before.deferred.has('BashOutput')).toBe(true);
    expect(before.deferred.has('KillShell')).toBe(true);
    expect(namesOf(before.active)).not.toContain('BashOutput');

    runtimeContext.backgroundShells!.shells.set('shell-1', {
      id: 'shell-1',
      command: 'sleep 1',
      effectiveCommand: 'sleep 1',
      workdir: runtimeContext.workspaceRoot,
      status: 'running',
      output: '',
      readOffset: 0,
      truncatedBytes: 0,
      startedAt: 0,
    });
    const during = stableOf(surface, [user('u1')]);

    expect(during.tools).toEqual(before.tools);
    expect(during.additions).toEqual(['BashOutput', 'KillShell']);
    expect(namesOf(during.active)).toContain('BashOutput');
  });

  it('declares the active tools alone when nothing is deferred', () => {
    const surface = defaultSurface(context(), (config) => {
      config.settings.toolDiscovery.mode = 'eager';
    });
    const eager = stableOf(surface);
    expect(eager.tools).toEqual(eager.active);
    expect(eager.deferred.size).toBe(0);
  });

  it('changes the declaration only when authorization does', () => {
    const surface = defaultSurface();
    const before = namesOf(stableOf(surface).tools);
    const restore = surface.pushRestriction(['Read', 'GitLog']);
    const narrowed = namesOf(stableOf(surface).tools);
    expect(narrowed).not.toEqual(before);
    expect(narrowed).toContain('GitLog');
    expect(narrowed).not.toContain('WebFetch');
    restore();
    expect(namesOf(stableOf(surface).tools)).toEqual(before);
  });
});
