import { describe, expect, it } from 'vitest';
import type { Message } from '../types/messages.js';
import type { AgentConfig } from '../types/runtime.js';
import type { ToolContext, ToolDefinition, ToolDiscoveryState } from '../types/tools.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { convertTools as openAiTools } from '../provider/openai-compatible.js';
import { createToolSurface } from './catalog.js';
import { createDefaultRegistry, createRegistry } from './registry.js';
import { toolSearchTools } from './tool-search.js';
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

function context(state?: ToolDiscoveryState): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    env: {},
    currentMode: 'default',
    backgroundShells: { nextId: 1, shells: new Map() },
    ...(state
      ? { runtime: { toolDiscoveryState: state } as unknown as ToolContext['runtime'] }
      : {}),
  };
}

function definition(name: string, description = `The ${name} capability.`): ToolDefinition {
  return {
    name,
    description,
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
const deferredOf = (definitions: ToolDefinition[]) =>
  definitions.filter((entry) => entry.deferLoading).map((entry) => entry.name);
/** A declaration's bytes, as far as the catalog decides them: names, order and deferral. */
const layoutOf = (definitions: ToolDefinition[]) =>
  JSON.stringify(definitions.map((entry) => [entry.name, entry.deferLoading === true]));

function startShell(runtimeContext: ToolContext): void {
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
}

function defaultSurface(runtimeContext = context(), configure?: (config: AgentConfig) => void) {
  const runtimeConfig = config();
  configure?.(runtimeConfig);
  return createToolSurface({
    config: runtimeConfig,
    context: runtimeContext,
    definitions: createDefaultRegistry().getDefinitions(),
  });
}

/** Room for every schema, so the loaded-tool count is the limit that binds. */
const roomy = (config: AgentConfig) => {
  config.settings.toolDiscovery.schemaTokenBudget = 100_000;
  config.modelInfo = { contextWindow: 2_000_000 };
};

describe('append-only activation (#619)', () => {
  it('appends a loaded tool after the core and every tool loaded before it', () => {
    const surface = defaultSurface();
    const core = namesOf(surface.prepareRequest([]).tools);

    surface.select!(['WebFetch']);
    expect(namesOf(surface.prepareRequest([]).tools)).toEqual([...core, 'WebFetch']);
    // GitLog sits before WebFetch in the catalog, but it loaded after it.
    surface.select!(['GitLog']);
    expect(namesOf(surface.prepareRequest([]).tools)).toEqual([...core, 'WebFetch', 'GitLog']);
    // Calling a tool refreshes its recency, never its position.
    expect(surface.canExecute({ id: 'w', name: 'WebFetch', arguments: { url: 'https://x' } })).toBe(
      true,
    );
    expect(namesOf(surface.prepareRequest([]).tools)).toEqual([...core, 'WebFetch', 'GitLog']);
  });

  it('never evicts across 30 activations, and refuses each one once the set is full', () => {
    const tools = Array.from({ length: 30 }, (_, index) => definition(`Special${index}`));
    const runtimeConfig = config();
    runtimeConfig.settings.toolDiscovery.mode = 'deferred';
    runtimeConfig.settings.toolDiscovery.maxLoadedTools = 20;
    roomy(runtimeConfig);
    const surface = createToolSurface({
      config: runtimeConfig,
      context: context(),
      definitions: [definition('Read'), ...tools],
    });

    let previous = openAiTools(surface.prepareRequest([]).tools).map((tool) => tool.function.name);
    for (const [index, tool] of tools.entries()) {
      const outcome = surface.select!([tool.name])[0];
      const next = openAiTools(surface.prepareRequest([]).tools).map(
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
    const before = namesOf(surface.prepareRequest([]).tools);

    // Two ToolSearch calls in one response, then the next request.
    surface.select!(['GitLog']);
    surface.select!(['GitDiff', 'WebSearch']);
    const after = namesOf(surface.prepareRequest([]).tools);

    expect(after).toEqual([...before, 'GitLog', 'GitDiff', 'WebSearch']);
  });

  it('admits in rank order, and a tool already loaded takes no new slot', () => {
    const surface = defaultSurface(context(), (config) => {
      config.settings.toolDiscovery.maxLoadedTools = 2;
    });
    expect(surface.activate(['GitLog', 'GitDiff', 'WebFetch'], 'search')).toEqual([
      'GitLog',
      'GitDiff',
    ]);
    expect(surface.activate(['GitDiff', 'GitLog'], 'search')).toEqual(['GitDiff', 'GitLog']);
    expect(surface.activate(['WebFetch'], 'search')).toEqual([]);
  });

  it('loads a host-required tool even when the set is full, outside the budgets', () => {
    const surface = defaultSurface(context(), (config) => {
      config.settings.toolDiscovery.maxLoadedTools = 1;
    });
    expect(surface.select!(['GitLog'])[0]?.status).toBe('loaded');

    // An active skill's resource reader: the loop loads it as the host.
    expect(surface.activate(['ReadSkillResource'])).toEqual(['ReadSkillResource']);
    expect(namesOf(surface.prepareRequest([]).tools)).toContain('ReadSkillResource');
    // It took no slot: GitLog alone still fills the set.
    expect(surface.select!(['WebFetch'])[0]?.status).toBe('budget');
  });

  it('counts only the loaded tools the mode still authorizes', () => {
    const surface = defaultSurface(context(), roomy);
    const deferred = deferredOf(surface.prepareRequest([], { stable: true }).tools).filter(
      // Every deferred tool a select can load: not the runtime's, nor the one the test selects last.
      (name) =>
        !['WebFetch', 'BashOutput', 'KillShell', 'ReadSkillResource', 'Advisor'].includes(name),
    );
    const fifteen = [
      'NotebookEdit',
      'GitCommit',
      ...deferred.filter((name) => !['NotebookEdit', 'GitCommit'].includes(name)),
    ].slice(0, 15);
    expect(fifteen).toHaveLength(15);
    expect(surface.select!(fifteen).every((outcome) => outcome.status === 'loaded')).toBe(true);
    expect(surface.select!(['WebFetch'])[0]?.status).toBe('budget');

    // Plan mode hides the mutating ones: they hold no slot while it does.
    const planContext = context();
    const planSurface = defaultSurface(planContext, roomy);
    planSurface.select!(fifteen);
    planContext.currentMode = 'plan';
    expect(planSurface.select!(['WebFetch'])[0]?.status).toBe('loaded');
  });

  it('starts the loaded set over at a new compaction checkpoint, and only then', () => {
    const surface = defaultSurface();
    surface.select!(['GitLog']);
    expect(namesOf(surface.prepareRequest([user('u1')]).tools)).toContain('GitLog');
    surface.markAnswered();

    const compacted = [checkpoint('c1'), user('u2')];
    expect(namesOf(surface.prepareRequest(compacted).tools)).not.toContain('GitLog');
    surface.markAnswered();
    surface.select!(['WebFetch']);
    // The same checkpoint is not a second reset.
    expect(namesOf(surface.prepareRequest([...compacted, user('u3')]).tools)).toContain('WebFetch');
    surface.markAnswered();
    expect(namesOf(surface.prepareRequest([checkpoint('c2'), user('u4')]).tools)).not.toContain(
      'WebFetch',
    );
  });

  it('keeps across a reset point what loaded since the last answered request', () => {
    const surface = defaultSurface();
    surface.select!(['GitLog']);
    surface.prepareRequest([user('u1')]);
    surface.markAnswered();
    // The tool round after that request: the model has not seen WebFetch declared yet.
    surface.select!(['WebFetch']);

    const after = namesOf(surface.prepareRequest([checkpoint('c1'), user('u2')]).tools);

    expect(after).toContain('WebFetch');
    expect(after).not.toContain('GitLog');
  });

  it('does not count a request that failed as answered at the reset point', () => {
    const surface = defaultSurface();
    surface.select!(['GitLog']);
    surface.prepareRequest([user('u1')]);
    surface.markAnswered();
    surface.select!(['WebFetch']);
    // The next request is built and refused (an overflow), so nothing marks it answered; the
    // history is compacted and the same turn is retried.
    surface.prepareRequest([user('u1'), reply('a1', [])]);

    const retried = namesOf(surface.prepareRequest([checkpoint('c1'), reply('a1', [])]).tools);

    expect(retried).toContain('WebFetch');
    expect(retried).not.toContain('GitLog');
  });

  it('treats a model change as a reset point', () => {
    const state: ToolDiscoveryState = { clock: 0, loaded: new Map() };
    const first = defaultSurface(context(state), (config) => {
      config.model = 'model-a';
    });
    first.select!(['GitLog']);
    first.prepareRequest([user('u1')]);
    first.markAnswered();
    first.select!(['WebFetch']);

    // `/model` starts a new run, and so a new surface over the same session state.
    const second = defaultSurface(context(state), (config) => {
      config.model = 'model-b';
    });
    const after = namesOf(second.prepareRequest([user('u1'), user('u2')]).tools);

    expect(after).toContain('WebFetch');
    expect(after).not.toContain('GitLog');
  });

  it('trims to a smaller schema budget at the reset it causes, oldest first', () => {
    // About 370 schema tokens each: three overflow 1,000, two fit.
    const big = (name: string) => definition(name, `${name}: ${'x'.repeat(1_400)}`);
    const runtimeConfig = config();
    runtimeConfig.settings.toolDiscovery.mode = 'deferred';
    roomy(runtimeConfig);
    const surface = createToolSurface({
      config: runtimeConfig,
      context: context(),
      definitions: [definition('Read'), big('Oldest'), big('Middle'), big('Newest')],
    });
    surface.select!(['Oldest']);
    surface.select!(['Middle']);
    surface.select!(['Newest']);
    expect(namesOf(surface.prepareRequest([]).tools)).toEqual(
      expect.arrayContaining(['Oldest', 'Middle', 'Newest']),
    );

    runtimeConfig.settings.toolDiscovery.schemaTokenBudget = 1_000;
    const trimmed = namesOf(surface.prepareRequest([]).tools);

    expect(trimmed).not.toContain('Oldest');
    expect(trimmed).toEqual(expect.arrayContaining(['Middle', 'Newest']));
  });

  it('decides deferral once, so a background shell never flips it', () => {
    // Ten tools with no shell running: at the eager limit. BashOutput and KillShell would make it
    // twelve, which alone would have turned deferral on and rewritten every request's tools.
    const runtimeContext = context();
    const shellTools = createDefaultRegistry()
      .getDefinitions()
      .filter((entry) => ['BashOutput', 'KillShell'].includes(entry.name));
    const surface = createToolSurface({
      config: config(),
      context: runtimeContext,
      definitions: [
        definition('Read'),
        ...Array.from({ length: 9 }, (_, index) => definition(`Plain${index}`)),
        ...shellTools,
        ...toolSearchTools,
      ],
    });
    const before = surface.prepareRequest([user('u1')]).tools;
    expect(namesOf(before)).not.toContain('ToolSearch');

    startShell(runtimeContext);
    const during = surface.prepareRequest([user('u1')]).tools;
    expect(namesOf(during)).toEqual([...namesOf(before), 'BashOutput', 'KillShell']);

    runtimeContext.backgroundShells!.shells.clear();
    const after = surface.prepareRequest([user('u1')]).tools;
    // Declared once available, and kept: execution refuses it while no shell runs.
    expect(namesOf(after)).toEqual(namesOf(during));
    expect(surface.isActive?.('BashOutput')).toBe(false);
    expect(surface.whyInactive?.('BashOutput')).toBe('unavailable');
  });

  it('says why a directly called tool did not load', () => {
    const full = defaultSurface(context(), (config) => {
      config.settings.toolDiscovery.maxLoadedTools = 1;
    });
    full.select!(['GitDiff']);
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
    surface.select!(['GitDiff']);
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

describe('ToolSearch under append-only activation (#619)', () => {
  it('loads only the matches that score at least half of the best one', () => {
    const runtimeConfig = config();
    runtimeConfig.settings.toolDiscovery.mode = 'deferred';
    const surface = createToolSurface({
      config: runtimeConfig,
      context: context(),
      definitions: [
        definition('Read'),
        definition('FetchPage', 'Fetch a page.'),
        definition('PageNotes', 'Keep notes.'),
        definition('Archive', 'Fetch remote copies of a page.'),
      ],
    });

    // FetchPage names both words (8); PageNotes one (4); Archive only has them in its
    // description (2), a quarter of the best.
    const names = surface.search('fetch page').map((match) => match.name);

    expect(names).toEqual(['FetchPage', 'PageNotes']);
  });

  it('says the set is full until the next compaction, not to narrow the query', async () => {
    const runtimeConfig = config();
    runtimeConfig.settings.toolDiscovery.maxLoadedTools = 1;
    const runtimeContext = context();
    const definitions = createDefaultRegistry().getDefinitions();
    const surface = createToolSurface({
      config: runtimeConfig,
      context: runtimeContext,
      definitions,
    });
    runtimeContext.toolDiscovery = surface;
    surface.select!(['GitLog']);
    const registry = createRegistry();
    registry.registerAll(toolSearchTools);

    const searched = await registry.execute(
      { id: 's1', name: 'ToolSearch', arguments: { query: 'fetch web page url' } },
      runtimeContext,
    );
    const selected = await registry.execute(
      { id: 's2', name: 'ToolSearch', arguments: { query: 'select:WebFetch' } },
      runtimeContext,
    );

    for (const result of [searched, selected]) {
      expect(result.structuredError?.code).toBe('tool_discovery_budget_exceeded');
      expect(result.structuredError?.remediation).toBe(
        'The loaded-tool set is full until the next compaction; call a listed tool directly (it runs without being loaded) or select: one exact tool.',
      );
    }
  });
});

describe('a stable declaration (#619)', () => {
  const stableOf = (surface: ReturnType<typeof defaultSurface>, history: Message[] = []) =>
    surface.prepareRequest(history, { stable: true });

  it('declares every authorized tool, the fixed core first, and keeps it through activations', () => {
    const surface = defaultSurface();
    const first = stableOf(surface);
    const tools = namesOf(first.tools);
    const deferred = new Set(deferredOf(first.tools));

    expect(deferred.has('GitLog')).toBe(true);
    expect(deferred.has('WebFetch')).toBe(true);
    expect(deferred.has('Read')).toBe(false);
    expect(deferred.has('ToolSearch')).toBe(false);
    const firstDeferred = tools.findIndex((name) => deferred.has(name));
    expect(tools.slice(0, firstDeferred).every((name) => !deferred.has(name))).toBe(true);
    expect(tools.slice(firstDeferred).every((name) => deferred.has(name))).toBe(true);
    expect(first.additions).toEqual([]);

    surface.select!(['GitLog', 'WebFetch']);
    const second = stableOf(surface, [user('u1')]);
    expect(layoutOf(second.tools)).toBe(layoutOf(first.tools));
    expect(second.tools).toEqual(first.tools);
    expect(second.additions).toEqual(['GitLog', 'WebFetch']);
    expect(namesOf(second.shown)).toEqual([...namesOf(first.shown), 'GitLog', 'WebFetch']);
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

    expect(namesOf(resumed.shown)).toContain('GitLog');
    expect(resumed.additions).toEqual([]);
    expect(surface.isActive?.('GitLog')).toBe(true);
  });

  it('keeps what the compacted history still offers at a reset point, and drops the rest', () => {
    const surface = defaultSurface();
    surface.select!(['GitLog', 'WebFetch']);
    stableOf(surface, [user('u1')]);
    surface.markAnswered();

    const compacted = stableOf(surface, [checkpoint('c1'), reply('a2', ['WebFetch']), user('u3')]);

    expect(namesOf(compacted.shown)).toContain('WebFetch');
    expect(namesOf(compacted.shown)).not.toContain('GitLog');
    expect(compacted.additions).toEqual([]);
  });

  it('leaves tools[] byte-identical while a background shell starts and ends', () => {
    const runtimeContext = context();
    const surface = defaultSurface(runtimeContext);
    const before = stableOf(surface, [user('u1')]);
    expect(deferredOf(before.tools)).toEqual(expect.arrayContaining(['BashOutput', 'KillShell']));
    expect(namesOf(before.shown)).not.toContain('BashOutput');

    startShell(runtimeContext);
    const during = stableOf(surface, [user('u1')]);
    expect(layoutOf(during.tools)).toBe(layoutOf(before.tools));
    expect(during.additions).toEqual(['BashOutput', 'KillShell']);
    expect(namesOf(during.shown)).toContain('BashOutput');

    runtimeContext.backgroundShells!.shells.clear();
    const after = stableOf(surface, [user('u1'), reply('a1', ['BashOutput', 'KillShell'])]);
    expect(layoutOf(after.tools)).toBe(layoutOf(before.tools));
    expect(after.additions).toEqual([]);
    expect(surface.isActive?.('BashOutput')).toBe(false);
  });

  it('declares a runtime-gated core tool deferred, and offers it whenever it is available', () => {
    let advisorConfigured = true;
    const runtimeConfig = config();
    const surface = createToolSurface({
      config: runtimeConfig,
      context: context(),
      definitions: [
        ...createDefaultRegistry().getDefinitions(),
        {
          ...definition('Helper'),
          catalog: { exposure: 'core', available: () => advisorConfigured },
        },
      ],
    });
    const first = stableOf(surface, [user('u1')]);
    expect(deferredOf(first.tools)).toContain('Helper');
    expect(first.additions).toEqual(['Helper']);

    advisorConfigured = false;
    const later = stableOf(surface, [user('u1'), reply('a1', ['Helper'])]);
    expect(layoutOf(later.tools)).toBe(layoutOf(first.tools));
    expect(surface.isActive?.('Helper')).toBe(false);
  });

  it('defers only the runtime-gated tools (Advisor, the shell tools) when nothing else is', () => {
    const surface = defaultSurface(context(), (config) => {
      config.settings.toolDiscovery.mode = 'eager';
    });
    const eager = stableOf(surface);
    expect(deferredOf(eager.tools).sort()).toEqual(['Advisor', 'BashOutput', 'KillShell']);
    expect(namesOf(eager.tools)).not.toContain('ToolSearch');
    expect(eager.additions).toEqual([]);
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
