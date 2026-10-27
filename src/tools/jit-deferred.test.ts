import { describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../types/runtime.js';
import type { ToolContext, ToolDefinition, ToolDiscoveryState } from '../types/tools.js';
import { DEFAULT_SETTINGS } from '../settings.js';
import { createToolSurface } from './catalog.js';
import { createDefaultRegistry, createRegistry } from './registry.js';
import { toolSuccess } from './result.js';

// Just-in-time execution of deferred tools (#619): a direct call to an authorized deferred tool
// that is not active is admitted, loaded for the next request, and then meets every gate a call
// after `select:` would meet.

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

const STUBBED = ['GitLog', 'GitStatus', 'WebFetch', 'NotebookEdit'];

/** The default tools with the ones these tests call stubbed, so nothing touches git or the network. */
function stubbedDefinitions(extra: ToolDefinition[] = []): {
  definitions: ToolDefinition[];
  ran: string[];
} {
  const ran: string[] = [];
  const definitions = createDefaultRegistry()
    .getDefinitions()
    .map((definition) =>
      STUBBED.includes(definition.name)
        ? {
            ...definition,
            execute: async () => {
              ran.push(definition.name);
              return toolSuccess(`ran ${definition.name}`);
            },
          }
        : definition,
    );
  return { definitions: [...definitions, ...extra], ran };
}

function setup(
  options: {
    capabilityRules?: string[];
    extra?: ToolDefinition[];
    configure?: (config: AgentConfig) => void;
    state?: ToolDiscoveryState;
  } = {},
) {
  const runtimeConfig = config();
  options.configure?.(runtimeConfig);
  const { definitions, ran } = stubbedDefinitions(options.extra);
  const runtimeContext: ToolContext = {
    ...context(),
    ...(options.state
      ? { runtime: { toolDiscoveryState: options.state } as unknown as ToolContext['runtime'] }
      : {}),
  };
  const surface = createToolSurface({
    config: runtimeConfig,
    context: runtimeContext,
    definitions,
    capabilityRules: options.capabilityRules,
  });
  runtimeContext.toolDiscovery = surface;
  const registry = createRegistry();
  registry.registerAll(definitions);
  const names = () => surface.activeDefinitions().map((definition) => definition.name);
  // The loop builds the first request's definitions before any tool runs.
  const firstRequest = names();
  return { surface, registry, context: runtimeContext, ran, names, firstRequest };
}

describe('a direct call to an inactive deferred tool (#619)', () => {
  it('runs an authorized one and loads it for the next request', async () => {
    const { registry, context, ran, names, firstRequest } = setup();
    expect(firstRequest).not.toContain('GitLog');

    const result = await registry.execute({ id: 'log-1', name: 'GitLog', arguments: {} }, context);

    expect(result.status).toBe('success');
    expect(result.content).toBe('ran GitLog');
    expect(ran).toEqual(['GitLog']);
    expect(names()).toContain('GitLog');
  });

  it('admits a call that names the tool by an alias or with a provider prefix', async () => {
    const { registry, context, ran } = setup();

    await registry.execute({ id: 'log-1', name: 'functions.GitLog', arguments: {} }, context);
    await registry.execute({ id: 'status-1', name: 'git_status', arguments: {} }, context);

    expect(ran).toEqual(['GitLog', 'GitStatus']);
  });

  it('admits a tool once per request, so a second call in the same response loads nothing', () => {
    const state: ToolDiscoveryState = { clock: 0, loaded: new Map() };
    const { surface } = setup({ state });

    expect(surface.admitDirect?.('GitLog')).toEqual({ loaded: true });
    const clock = state.clock;
    expect(surface.admitDirect?.('GitLog')).toEqual({ loaded: true });
    expect(state.clock).toBe(clock);
    expect(surface.isActive?.('GitLog')).toBe(true);
  });

  it('keeps an admission through a search later in the same request', async () => {
    const { surface, registry, context, ran } = setup({
      configure: (config) => {
        config.settings.toolDiscovery.schemaTokenBudget = 1;
      },
    });
    expect(surface.admitDirect?.('GitLog')).toEqual({ loaded: false });
    // A search rebuilds the active snapshot from the loaded tools, which GitLog is not among.
    surface.search('web fetch');

    await registry.execute({ id: 'log-1', name: 'GitLog', arguments: {} }, context);

    expect(ran).toEqual(['GitLog']);
  });

  it('admits nothing it does not authorize, and refuses the call as today', async () => {
    const { surface, registry, context, ran, names } = setup({ capabilityRules: ['Read'] });

    const result = await registry.execute(
      { id: 'fetch-1', name: 'WebFetch', arguments: { url: 'https://example.com' } },
      context,
    );

    expect(surface.admitDirect?.('WebFetch')).toBeUndefined();
    expect(result.status).toBe('blocked');
    expect(result.structuredError?.code).toBe('tool_not_active');
    expect(result.structuredError?.details?.activatable).toBe(false);
    expect(ran).toEqual([]);
    expect(names()).not.toContain('WebFetch');
  });

  it('never carries an unauthorized tool schema, even for invalid arguments', async () => {
    const { registry, context } = setup({ capabilityRules: ['Read'] });

    const result = await registry.execute(
      { id: 'fetch-1', name: 'WebFetch', arguments: { link: 'x' } },
      context,
    );

    const text = `${result.structuredError?.message} ${result.structuredError?.remediation}`;
    expect(result.structuredError?.code).toBe('tool_not_active');
    for (const property of ['url', 'format', 'prompt', 'takes'])
      expect(text).not.toContain(property);
  });

  it('refuses a runtime tool its state does not offer as unavailable', async () => {
    // BashOutput is a runtime tool: core once a shell exists. With none, it is not authorized,
    // so neither a direct call nor ToolSearch can load it, and the refusal says so.
    const { surface, registry, context } = setup();

    const result = await registry.execute(
      { id: 'out-1', name: 'BashOutput', arguments: { bash_id: '1' } },
      context,
    );

    expect(surface.admitDirect?.('Read')).toBeUndefined();
    expect(result.structuredError?.code).toBe('tool_not_active');
    expect(result.structuredError?.details).toMatchObject({
      activatable: false,
      unavailable: true,
    });
    expect(result.structuredError?.remediation).toContain('not available');
    expect(result.structuredError?.remediation).not.toContain('Call ToolSearch');
  });

  it('refuses a deferred tool the runtime does not offer, without pointing at ToolSearch', async () => {
    const offline: ToolDefinition = {
      name: 'OfflineProbe',
      description: 'Probe a service that is not running.',
      parameters: { type: 'object', properties: {} },
      catalog: { available: () => false },
      execute: async () => toolSuccess('never'),
    };
    const { registry, context } = setup({ extra: [offline] });
    // The repeat escalation is kept on the runtime.
    context.runtime = { recentToolFailures: new Map() } as unknown as ToolContext['runtime'];
    const call = { id: 'probe-1', name: 'OfflineProbe', arguments: {} };

    const first = await registry.execute(call, context);
    const repeat = await registry.execute({ ...call, id: 'probe-2' }, context);

    expect(first.structuredError?.code).toBe('tool_not_active');
    expect(first.structuredError?.remediation).toContain('not available in this mode');
    expect(repeat.structuredError?.remediation).not.toContain('Call ToolSearch');
    expect(repeat.structuredError?.remediation).not.toContain('activate it with ToolSearch');
    expect(repeat.structuredError?.remediation).toContain('not available in this mode or state');
  });

  it('admits a core tool that became available after the request was built, as select: would', async () => {
    // A background shell started earlier in the response: BashOutput is authorized and core
    // now, but not in this request's snapshot. `select:BashOutput` would rebuild the snapshot
    // and report it active, so a direct call must run too (review of #637, finding 1).
    const { surface, registry, context, ran } = setup({ extra: [] });
    const shells = context.backgroundShells!.shells;
    shells.set('shell-1', {
      id: 'shell-1',
      command: 'sleep 1',
      effectiveCommand: 'sleep 1',
      workdir: process.cwd(),
      status: 'exited',
      output: '',
      readOffset: 0,
      truncatedBytes: 0,
      startedAt: 0,
    });
    const output: ToolDefinition = {
      ...registry.getTool('BashOutput')!,
      execute: async () => {
        ran.push('BashOutput');
        return toolSuccess('ran BashOutput');
      },
    };
    registry.register(output);

    const result = await registry.execute(
      { id: 'out-1', name: 'BashOutput', arguments: { shell_id: 'shell-1' } },
      context,
    );

    expect(result.status).toBe('success');
    expect(ran).toEqual(['BashOutput']);
    expect(surface.isActive?.('BashOutput')).toBe(true);
  });

  it('says why a tool is inactive, from the surface rather than from its shape', () => {
    const offline: ToolDefinition = {
      name: 'OfflineProbe',
      description: 'Probe a service that is not running.',
      parameters: { type: 'object', properties: {} },
      catalog: { available: () => false },
      execute: async () => toolSuccess('never'),
    };
    const { surface } = setup({ capabilityRules: ['Read', 'OfflineProbe'], extra: [offline] });

    expect(surface.whyInactive?.('WebFetch')).toBe('unauthorized');
    expect(surface.whyInactive?.('OfflineProbe')).toBe('unavailable');
    expect(surface.whyInactive?.('NoSuchTool')).toBe('unauthorized');
  });

  it('keeps the ToolSearch advice for a discovery that admits but cannot say why', async () => {
    // A discovery object of its own, with `admitDirect` but no `whyInactive`: the registry must
    // not guess "unavailable" from the methods it has.
    const { registry, context } = setup();
    const discovery = context.toolDiscovery!;
    const result = await registry.execute(
      { id: 'probe-1', name: 'GitLog', arguments: {} },
      {
        ...context,
        toolDiscovery: {
          ...discovery,
          whyInactive: undefined,
          isActive: () => false,
          admitDirect: () => undefined,
          isAuthorized: () => true,
        },
      },
    );

    expect(result.structuredError?.code).toBe('tool_not_active');
    expect(result.structuredError?.remediation).toBe(
      'Call ToolSearch to discover it or use an authorized active tool.',
    );
    expect(result.structuredError?.details?.unavailable).toBeUndefined();
  });

  it('applies the argument-scoped rules after admission', async () => {
    const { registry, context, ran } = setup({
      // Book scopes WebFetch by a glob over its URL, not a `domain:` form.
      capabilityRules: ['Read', 'WebFetch(https://example.com/*)'],
    });

    const other = await registry.execute(
      { id: 'fetch-1', name: 'WebFetch', arguments: { url: 'https://other.test/' } },
      context,
    );
    const allowed = await registry.execute(
      { id: 'fetch-2', name: 'WebFetch', arguments: { url: 'https://example.com/' } },
      context,
    );

    expect(other.structuredError?.code).toBe('arguments_not_allowed');
    expect(allowed.status).toBe('success');
    expect(ran).toEqual(['WebFetch']);
  });
});

describe('invalid arguments on a just-in-time call (#619)', () => {
  it('names the arguments and their types, and still loads the tool', async () => {
    const { registry, context, ran, names } = setup();

    const result = await registry.execute(
      { id: 'fetch-1', name: 'WebFetch', arguments: { link: 'https://example.com' } },
      context,
    );

    expect(result.structuredError?.code).toBe('invalid_arguments');
    const message = result.structuredError?.message ?? '';
    expect(message).toContain('arguments.url is required');
    expect(message).toMatch(
      /WebFetch takes \{url: string; format\?: "markdown" \| "text" \| "html"/,
    );
    expect(message.length).toBeLessThan(2_500);
    expect(ran).toEqual([]);
    expect(names()).toContain('WebFetch');
  });

  it('names the types for a tool select: loaded earlier in the same response', async () => {
    // `select:` loaded it, but the request the model answered did not declare it, so the call
    // was written without the schema just as a direct one is (review of #637, finding 9).
    const { surface, registry, context } = setup();
    surface.select?.(['WebFetch']);

    const result = await registry.execute(
      { id: 'fetch-1', name: 'WebFetch', arguments: { link: 'https://example.com' } },
      context,
    );

    expect(result.structuredError?.message).toContain('WebFetch takes {url: string;');
  });

  it('keeps the short key list for a tool that was already active', async () => {
    const { surface, registry, context } = setup();
    surface.select?.(['WebFetch']);
    surface.activeDefinitions();

    const result = await registry.execute(
      { id: 'fetch-1', name: 'WebFetch', arguments: { link: 'https://example.com' } },
      context,
    );

    expect(result.structuredError?.message).toContain('Allowed arguments: url,');
    expect(result.structuredError?.message).not.toContain('WebFetch takes');
  });

  it('cuts a large signature and points at select:, and never prints property descriptions', async () => {
    const properties = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [
        `field_${index}`,
        { type: 'string', description: 'SERVER-WRITTEN DESCRIPTION' },
      ]),
    );
    const mcp: ToolDefinition = {
      name: 'mcp__demo__wide',
      description: 'A wide MCP tool.',
      parameters: { type: 'object', properties, required: ['field_0'] },
      execute: async () => toolSuccess('never'),
    };
    const { registry, context } = setup({ extra: [mcp] });

    const result = await registry.execute(
      { id: 'wide-1', name: 'mcp__demo__wide', arguments: {} },
      context,
    );

    expect(result.structuredError?.code).toBe('invalid_arguments');
    const message = result.structuredError?.message ?? '';
    expect(message).toContain('select:mcp__demo__wide');
    expect(message).not.toContain('SERVER-WRITTEN');
    expect(message.length).toBeLessThan(2_400);
  });

  it('spells out nested objects, arrays and unions', async () => {
    const nested: ToolDefinition = {
      name: 'NestedProbe',
      description: 'Takes nested arguments.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, line: { type: 'integer' } },
              required: ['path'],
            },
          },
          mode: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['items'],
      },
      execute: async () => toolSuccess('never'),
    };
    const { registry, context } = setup({ extra: [nested] });

    const result = await registry.execute(
      { id: 'nested-1', name: 'NestedProbe', arguments: {} },
      context,
    );

    expect(result.structuredError?.message).toContain(
      'NestedProbe takes {items: {path: string; line?: integer}[]; mode?: string | null}',
    );
  });
});

describe('the argument signature of a just-in-time call (#619)', () => {
  async function signatureOf(parameters: Record<string, unknown>): Promise<string> {
    const probe: ToolDefinition = {
      name: 'ShapeProbe',
      description: 'Takes shaped arguments.',
      parameters,
      execute: async () => toolSuccess('never'),
    };
    const { registry, context } = setup({ extra: [probe] });
    const result = await registry.execute(
      { id: 'shape-1', name: 'ShapeProbe', arguments: { unexpected: 1 } },
      context,
    );
    return result.structuredError?.message ?? '';
  }

  it('lists the variants of a top-level union instead of "no arguments"', async () => {
    const message = await signatureOf({
      anyOf: [
        { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      ],
    });

    expect(message).toContain('ShapeProbe takes {id: string} | {name: string}');
    expect(message).not.toContain('no arguments');
  });

  it('names the value type of a map', async () => {
    const message = await signatureOf({
      type: 'object',
      additionalProperties: { type: 'string' },
    });

    expect(message).toContain('ShapeProbe takes {[key: string]: string}');
  });

  it('says "no arguments" only for a schema that allows none', async () => {
    expect(await signatureOf({ type: 'object', properties: {} })).toContain(
      'ShapeProbe takes no arguments.',
    );
  });

  it('spells out two object levels and collapses the third', async () => {
    const message = await signatureOf({
      type: 'object',
      properties: {
        outer: {
          type: 'object',
          properties: { inner: { type: 'object', properties: { leaf: { type: 'string' } } } },
        },
      },
    });

    expect(message).toContain('ShapeProbe takes {outer?: {inner?: object}}');
  });
});

describe('the schema budget on a just-in-time call (#619)', () => {
  it('runs a tool too large to load, says so, and leaves it out of the next request', async () => {
    const { surface, registry, context, ran, names } = setup({
      configure: (config) => {
        config.settings.toolDiscovery.schemaTokenBudget = 1;
      },
    });

    const result = await registry.execute({ id: 'log-1', name: 'GitLog', arguments: {} }, context);

    expect(result.status).toBe('success');
    expect(ran).toEqual(['GitLog']);
    expect(result.content).toBe(
      'ran GitLog\n\nGitLog ran without being loaded: its schema alone is larger than the tool discovery budget, so it is not declared next turn either; call it directly again when you need it.',
    );
    expect(names()).not.toContain('GitLog');
    // `select:` would not load it either: the one difference is that the direct call ran.
    expect(surface.select?.(['GitLog'])).toEqual([
      expect.objectContaining({ name: 'GitLog', status: 'budget' }),
    ]);
  });

  it('never says a refused or failed over-budget call ran', async () => {
    const failing: ToolDefinition = {
      name: 'mcp__demo__fails',
      description: 'Fails.',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({
        version: 2,
        toolCallId: '',
        status: 'blocked',
        content: 'refused by policy',
      }),
    };
    const { registry, context } = setup({
      extra: [failing],
      configure: (config) => {
        config.settings.toolDiscovery.schemaTokenBudget = 1;
      },
    });

    const result = await registry.execute(
      { id: 'fail-1', name: 'mcp__demo__fails', arguments: {} },
      context,
    );

    expect(result.status).toBe('blocked');
    expect(result.content).not.toContain('ran');
    expect(result.content).toContain('not loaded');
  });

  it('admits it again on the next request, as nothing loaded it', async () => {
    const { registry, context, ran, names } = setup({
      configure: (config) => {
        config.settings.toolDiscovery.schemaTokenBudget = 1;
      },
    });

    await registry.execute({ id: 'log-1', name: 'GitLog', arguments: {} }, context);
    names();
    const second = await registry.execute({ id: 'log-2', name: 'GitLog', arguments: {} }, context);

    expect(second.status).toBe('success');
    expect(ran).toEqual(['GitLog', 'GitLog']);
  });
});

describe('a rule or hook on ToolSearch itself (#619, decision c)', () => {
  // Whoever wrote one meant to gate the deferred catalog, so the surface admits no direct call
  // and the model goes through ToolSearch, where the rule or hook applies, as before #619.
  it.each([
    ['a deny rule', { deny: ['ToolSearch'] }],
    ['an ask rule', { ask: ['ToolSearch'] }],
    ['an ask rule with a pattern', { ask: ['ToolSearch(select:*)'] }],
    ['a deny rule written with spaces', { deny: [' ToolSearch '] }],
  ] as const)('%s restores the not-active refusal', async (_name, rules) => {
    const { surface, registry, context, ran } = setup({
      configure: (config) => {
        config.settings.permissions.deny = [...('deny' in rules ? rules.deny : [])];
        config.settings.permissions.ask = [...('ask' in rules ? rules.ask : [])];
      },
    });

    const result = await registry.execute({ id: 'log-1', name: 'GitLog', arguments: {} }, context);

    expect(surface.admitDirect?.('GitLog')).toBeUndefined();
    expect(result.structuredError?.code).toBe('tool_not_active');
    expect(result.structuredError?.remediation).toBe(
      'Call ToolSearch to discover it or use an authorized active tool.',
    );
    expect(ran).toEqual([]);
  });

  it.each([
    ['PreToolUse', 'ToolSearch'],
    ['PreToolUse', 'ToolSearch(select:*)'],
    // An audit hook: it cannot block, but whoever wrote it means to see every load.
    ['PostToolUse', 'ToolSearch'],
  ] as const)('a %s hook matching %s restores it', async (event, matcher) => {
    const { surface } = setup({
      configure: (config) => {
        config.settings.hooks[event] = [{ command: 'exit 0', matcher, env: {} }];
      },
    });

    expect(surface.admitDirect?.('GitLog')).toBeUndefined();
  });

  it.each([
    ['no matcher, which runs on every call', undefined],
    ['another tool', 'Bash'],
  ])('a PreToolUse hook with %s does not', (_name, matcher) => {
    const { surface } = setup({
      configure: (config) => {
        config.settings.hooks.PreToolUse = [
          { command: 'exit 0', env: {}, ...(matcher ? { matcher } : {}) },
        ];
        // A rule on another tool, or an allow rule on ToolSearch, gates nothing either.
        config.settings.permissions.deny = ['Bash(rm *)'];
        config.settings.permissions.allow = ['ToolSearch'];
      },
    });

    expect(surface.admitDirect?.('GitLog')).toEqual({ loaded: true });
  });

  it('lists the deferred tools without offering direct calls', () => {
    const gated = setup({
      configure: (config) => {
        config.settings.permissions.deny = ['ToolSearch'];
      },
    }).surface.catalogSummary();
    const open = setup().surface.catalogSummary();

    expect(gated).not.toContain('directly');
    expect(gated).toContain('Loaded tools are callable on the next turn.');
    expect(
      setup({
        configure: (config) => {
          config.settings.permissions.deny = ['ToolSearch'];
        },
      }).surface.admitsDirectCalls?.(),
    ).toBe(false);
    expect(setup().surface.admitsDirectCalls?.()).toBe(true);
    expect(gated.split('\n').slice(1, -1)).toEqual(open.split('\n').slice(1, -1));
  });
});

describe('the deferred tool list across a direct admission (#619)', () => {
  it('is byte-identical before and after the admission', async () => {
    const { surface, registry, context } = setup();
    const before = surface.catalogSummary();

    await registry.execute({ id: 'log-1', name: 'GitLog', arguments: {} }, context);
    surface.activeDefinitions();

    expect(surface.catalogSummary()).toBe(before);
    expect(before).toContain('call any tool listed here directly by name');
    expect(before).toContain('select:Name1,Name2');
  });

  it('logs a direct activation as its own reason', async () => {
    const debug = vi.fn();
    vi.resetModules();
    vi.doMock('../debug-log.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../debug-log.js')>()),
      createDebugLogger: () => ({ debug, info: vi.fn(), warn: vi.fn() }),
    }));
    try {
      const catalog = await import('./catalog.js');
      const surface = catalog.createToolSurface({
        config: config(),
        context: context(),
        definitions: stubbedDefinitions().definitions,
      });
      surface.activeDefinitions();
      surface.admitDirect?.('GitLog');
      surface.select?.(['WebFetch']);
      // The host loading a tool itself (a skill's resource reader) is not a search.
      surface.activate(['GitStatus']);
      surface.activate(['GitBranch'], 'search');

      expect(debug).toHaveBeenCalledWith('tools activated', {
        reason: 'direct',
        requested: ['GitLog'],
        loaded: ['GitLog'],
      });
      expect(debug).toHaveBeenCalledWith(
        'tools activated',
        expect.objectContaining({ reason: 'select', requested: ['WebFetch'] }),
      );
      expect(debug).toHaveBeenCalledWith(
        'tools activated',
        expect.objectContaining({ reason: 'host', requested: ['GitStatus'] }),
      );
      expect(debug).toHaveBeenCalledWith(
        'tools activated',
        expect.objectContaining({ reason: 'search', requested: ['GitBranch'] }),
      );
    } finally {
      vi.doUnmock('../debug-log.js');
      vi.resetModules();
    }
  });
});
