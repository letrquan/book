import { describe, expect, it } from 'vitest';
import type { AgentConfig } from '../types/runtime.js';
import type { Message } from '../types/messages.js';
import type { PermissionMode } from '../types/runtime.js';
import type { ToolContext, ToolDefinition } from '../types/tools.js';
import { defaultConfig } from '../test/fixtures.js';
import { createToolSurface } from './catalog.js';
import { createDefaultRegistry } from './registry.js';
import { toolSuccess } from './result.js';
import {
  routeTurnIntent,
  SEARCH_INTENT_PHRASES,
  searchIntentRouter,
  urlRouter,
  type IntentRouter,
} from './intent-routing.js';

function context(mode: PermissionMode = 'default'): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    env: {},
    currentMode: mode,
    backgroundShells: { nextId: 1, shells: new Map() },
  };
}

function surface(
  options: {
    config?: AgentConfig;
    mode?: PermissionMode;
    capabilityRules?: string[];
    isSubagent?: boolean;
    extra?: ToolDefinition[];
  } = {},
) {
  const config = options.config ?? defaultConfig();
  const toolContext = context(options.mode);
  const discovery = createToolSurface({
    config,
    context: toolContext,
    definitions: [...createDefaultRegistry().getDefinitions(), ...(options.extra ?? [])],
    capabilityRules: options.capabilityRules,
    isSubagent: options.isSubagent,
  });
  const declared = () => discovery.activeDefinitions().map((definition) => definition.name);
  return { config, toolContext, discovery, declared };
}

const routed = (router: IntentRouter, text: string): string[] =>
  router
    .route({ text: text.normalize('NFC'), config: defaultConfig(), context: context() })
    ?.tools?.map((route) => route.tool) ?? [];

describe('the URL router', () => {
  it.each([
    'Read https://example.com/a?b=c and summarize it',
    'see http://127.0.0.1:8080/notes.txt',
    '(https://example.com)',
    // A URL inside a code fence is still one the user wrote.
    'Why does this fail?\n```\ncurl https://api.example.com/v1/items\n```',
  ])('activates WebFetch for %j', (text) => {
    expect(routed(urlRouter, text)).toEqual(['WebFetch']);
  });

  it.each([
    'no link here',
    'the http module and https in general',
    'ftp://example.com/file',
    'https://',
    'xhttps://example.com',
  ])('routes nothing for %j', (text) => {
    expect(routed(urlRouter, text)).toEqual([]);
  });
});

describe('the search-intent router', () => {
  it('lists its phrases in one exported constant', () => {
    expect(SEARCH_INTENT_PHRASES).toEqual([
      'search',
      'look up',
      'latest',
      'news',
      'tìm',
      'tin tức',
    ]);
  });

  it.each([
    'search the web for vitest 5 release notes',
    'Please look up the changelog',
    'look\n  up the changelog',
    'What is the LATEST Node.js LTS?',
    'any news on the Bun 2 release?',
    'Search: what changed in TypeScript 6',
    'tìm giúp tôi tài liệu về Ink 8',
    'TÌM tài liệu về Ink 8',
    // Decomposed, as some input methods and macOS send it.
    'tìm tài liệu',
    'tin tức hôm nay về Node.js',
    'TIN TỨC về Node.js',
  ])('activates WebSearch for %j', (text) => {
    expect(routed(searchIntentRouter, text)).toEqual(['WebSearch']);
  });

  it.each([
    'do some research on this bug',
    'the researcher wrote a newsletter',
    'searching is not a whole word match',
    'add a lookup table',
    'the latestVersion field',
    'tin nhắn mới',
    'tìmkiếm',
    'fix the parser',
  ])('routes nothing for %j', (text) => {
    expect(routed(searchIntentRouter, text)).toEqual([]);
  });
});

describe('routeTurnIntent', () => {
  const URL_TEXT = 'What does https://example.com/notes.txt say?';

  it('loads a routed tool for the next request through the surface', () => {
    const { config, toolContext, discovery, declared } = surface();
    expect(declared()).not.toContain('WebFetch');
    const result = routeTurnIntent(
      { typedText: URL_TEXT, config, context: toolContext },
      discovery,
    );
    expect(result.activated).toEqual(['WebFetch']);
    expect(result.routes).toEqual([{ tool: 'WebFetch', reason: 'a URL', router: 'url' }]);
    expect(declared()).toContain('WebFetch');
  });

  it('routes nothing with the setting off', () => {
    const config = defaultConfig();
    config.settings.toolDiscovery.intentRouting = false;
    const { toolContext, discovery, declared } = surface({ config });
    const result = routeTurnIntent(
      { typedText: URL_TEXT, config, context: toolContext },
      discovery,
    );
    expect(result).toEqual({ routes: [], activated: [], notes: [] });
    expect(declared()).not.toContain('WebFetch');
  });

  it.each<[string, { typedText?: string; kind?: Message['kind']; isSubagent?: boolean }]>([
    ['no typed text', {}],
    ['blank typed text', { typedText: '   ' }],
    ['an agent notification', { typedText: URL_TEXT, kind: 'agent-notification' }],
    ['a checkpoint', { typedText: URL_TEXT, kind: 'checkpoint' }],
    ['a carried turn', { typedText: URL_TEXT, kind: 'carried' }],
    ['a local message', { typedText: URL_TEXT, kind: 'local' }],
    ['a subagent', { typedText: URL_TEXT, isSubagent: true }],
  ])('never runs for %s', (_name, request) => {
    const { config, toolContext, discovery, declared } = surface();
    let called = false;
    const spy: IntentRouter = {
      name: 'spy',
      route: () => {
        called = true;
        return { tools: [{ tool: 'WebFetch', reason: 'spy' }] };
      },
    };
    const result = routeTurnIntent({ ...request, config, context: toolContext }, discovery, [spy]);
    expect(called).toBe(false);
    expect(result.activated).toEqual([]);
    expect(declared()).not.toContain('WebFetch');
  });

  it('collects router notes without activating anything for them', () => {
    const { config, toolContext, discovery } = surface();
    const noting: IntentRouter = { name: 'noting', route: () => ({ note: 'a meta note' }) };
    const result = routeTurnIntent(
      { typedText: 'hello', kind: 'conversation', config, context: toolContext },
      discovery,
      [noting],
    );
    expect(result).toEqual({ routes: [], activated: [], notes: ['a meta note'] });
  });

  /** A router that asks for one fixed tool, whatever the text. */
  const asking = (tool: string): IntentRouter => ({
    name: 'fixed',
    route: () => ({ tools: [{ tool, reason: 'test' }] }),
  });

  it("respects the mode: plan mode's surface does not offer a mutating tool", () => {
    const { config, toolContext, discovery, declared } = surface({ mode: 'plan' });
    const result = routeTurnIntent(
      { typedText: 'edit it', config, context: toolContext },
      discovery,
      [asking('NotebookEdit')],
    );
    expect(result.activated).toEqual([]);
    expect(declared()).not.toContain('NotebookEdit');
  });

  it('respects the role: a child surface does not offer a root-only tool', () => {
    const { discovery, declared } = surface({ isSubagent: true });
    // The seam itself never runs for a subagent; the surface refuses the activation too.
    expect(discovery.activate(['AgentSpawn'], 'route')).toEqual([]);
    expect(declared()).not.toContain('AgentSpawn');
  });

  it('respects capability rules', () => {
    const { config, toolContext, discovery, declared } = surface({ capabilityRules: ['Read'] });
    const result = routeTurnIntent(
      { typedText: URL_TEXT, config, context: toolContext },
      discovery,
    );
    expect(result.activated).toEqual([]);
    expect(declared()).not.toContain('WebFetch');
  });

  it.each<[string, (config: AgentConfig) => void]>([
    [
      'a PostToolUse hook',
      (config) => {
        config.settings.hooks.PostToolUse = [{ matcher: 'ToolSearch', command: 'exit 0', env: {} }];
      },
    ],
    [
      'a deny rule',
      (config) => {
        config.settings.permissions.deny = ['ToolSearch'];
      },
    ],
    [
      'an ask rule',
      (config) => {
        config.settings.permissions.ask = ['ToolSearch'];
      },
    ],
  ])('activates nothing when %s gates ToolSearch', (_name, gate) => {
    const config = defaultConfig();
    gate(config);
    const { toolContext, discovery, declared } = surface({ config });
    const result = routeTurnIntent(
      { typedText: URL_TEXT, config, context: toolContext },
      discovery,
    );
    expect(result.routes).toHaveLength(1);
    expect(result.activated).toEqual([]);
    expect(declared()).not.toContain('WebFetch');
  });

  it('respects the schema budget', () => {
    const huge: ToolDefinition = {
      name: 'HugeTool',
      description: 'A tool whose schema alone exceeds the budget.',
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 400 }, (_, index) => [
            `field${index}`,
            { type: 'string', description: 'x'.repeat(40) },
          ]),
        ),
      },
      execute: async () => toolSuccess('never'),
    };
    const { config, toolContext, discovery, declared } = surface({ extra: [huge] });
    const result = routeTurnIntent({ typedText: 'go', config, context: toolContext }, discovery, [
      asking('HugeTool'),
    ]);
    expect(result.activated).toEqual([]);
    expect(declared()).not.toContain('HugeTool');
  });

  it('does not load a tool that is already active', () => {
    const { config, toolContext, discovery } = surface();
    // `Read` is core: loading it would take one of the loaded-tool slots for nothing.
    const result = routeTurnIntent({ typedText: 'go', config, context: toolContext }, discovery, [
      asking('Read'),
    ]);
    expect(result.activated).toEqual([]);
  });

  it('leaves the deferred-tool list byte-identical', () => {
    const { config, toolContext, discovery } = surface();
    const before = discovery.catalogSummary();
    routeTurnIntent(
      { typedText: `${URL_TEXT} and search the news`, config, context: toolContext },
      discovery,
    );
    discovery.activeDefinitions();
    expect(discovery.catalogSummary()).toBe(before);
  });
});
