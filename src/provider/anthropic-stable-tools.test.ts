import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatCompletionStream, countCacheBreakpoints } from './anthropic.js';
import { keepsToolsStable } from './port.js';
import { supportsMidConversationToolChanges } from '../models.js';
import { createToolSurface } from '../tools/catalog.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { defaultConfig } from '../test/fixtures.js';
import type { AgentConfig } from '../types/runtime.js';
import type {
  ProviderMessage,
  ProviderStreamEvent,
  StableToolsRequest,
} from '../types/providers.js';
import type { ToolContext, ToolDefinition } from '../types/tools.js';

// Stable tools on Anthropic (#619): on a model that takes mid-conversation tool changes, the first
// request declares every authorized tool, the deferred ones with `defer_loading`, and an
// activation becomes a `tool_addition` in a system message, so `tools[]` and every byte before the
// previous request's last breakpoint stay the same. Request shapes: the claude-api skill,
// `shared/tool-use-concepts.md` § Mid-conversation tool changes, and
// platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages.

const BETA = 'mid-conversation-tool-changes-2026-07-01';

interface Captured {
  body: {
    tools: Array<Record<string, unknown>>;
    system: unknown[];
    messages: Array<{ role: string; content: unknown }>;
  };
  headers: Record<string, string>;
}

const SSE_TEXT = [
  { type: 'message_start', message: { id: 'msg-1', usage: { input_tokens: 3 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];

function captureFetch(): Captured[] {
  const captured: Captured[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    captured.push({
      body: JSON.parse(String(init.body)),
      headers: init.headers as Record<string, string>,
    });
    return new Response(SSE_TEXT.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  return captured;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function stableConfig(model = 'claude-opus-5-5'): AgentConfig {
  return defaultConfig({ model, baseUrl: 'https://api.anthropic.com', provider: 'anthropic' });
}

function context(): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    env: {},
    currentMode: 'default',
    backgroundShells: { nextId: 1, shells: new Map() },
  };
}

/** The default registry's stable declaration, as the agent loop builds it. */
function declaration() {
  const config = stableConfig();
  const surface = createToolSurface({
    config,
    context: context(),
    definitions: createDefaultRegistry().getDefinitions(),
  });
  const first = surface.prepareRequest([], { stable: true }).stable!;
  return { config, surface, tools: first.tools, deferred: first.deferred };
}

const system: ProviderMessage = {
  role: 'system',
  content: { cachedPrefix: 'You are Book.', dynamicSuffix: '## Deferred tool catalog\nGitLog' },
};

async function send(
  config: AgentConfig,
  messages: ProviderMessage[],
  tools: ToolDefinition[],
  stableTools?: StableToolsRequest,
): Promise<ProviderStreamEvent[]> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of chatCompletionStream(config, messages, tools, { stableTools })) {
    events.push(event);
  }
  return events;
}

const assistantReply = (toolAdditions?: string[]): ProviderMessage => ({
  role: 'assistant',
  content: 'ok',
  ...(toolAdditions ? { providerMetadata: { toolAdditions } } : {}),
});

/**
 * Messages' bytes with the moving breakpoint taken out. The breakpoint also turns the newest
 * message's string `content` into the one text block it is shorthand for, which a later request
 * sends as the string again (before #619 too); the API reads both as that block, so the shorthand
 * is spelled out here.
 */
function unmarked(messages: unknown[]): string {
  return JSON.stringify(
    messages.map((entry) => {
      const message = entry as { content: unknown };
      return typeof message.content === 'string'
        ? { ...message, content: [{ type: 'text', text: message.content }] }
        : message;
    }),
    (key, value) => (key === 'cache_control' ? undefined : value),
  );
}

/**
 * The prefix `earlier` cached is the front of `later`, byte for byte: the same tools and system
 * blocks, and the same messages up to the one carrying `earlier`'s last breakpoint, once the
 * moving `cache_control` marker is taken out of both.
 */
function expectCachedPrefixKept(earlier: Captured['body'], later: Captured['body']): void {
  expect(JSON.stringify(later.tools)).toBe(JSON.stringify(earlier.tools));
  expect(JSON.stringify(later.system)).toBe(JSON.stringify(earlier.system));
  let marked = -1;
  earlier.messages.forEach((entry, index) => {
    if (JSON.stringify(entry).includes('"cache_control"')) marked = index;
  });
  expect(marked).toBeGreaterThanOrEqual(0);
  expect(unmarked(later.messages.slice(0, marked + 1))).toBe(
    unmarked(earlier.messages.slice(0, marked + 1)),
  );
}

describe('the stable request on a supported model (#619)', () => {
  it('declares every tool from the first request, deferred ones with defer_loading, no beta', async () => {
    const captured = captureFetch();
    const { config, tools, deferred } = declaration();

    await send(config, [system, { role: 'user', content: 'hi' }], tools, {
      deferred,
      additions: [],
    });

    const [{ body, headers }] = captured;
    expect(body.tools.map((tool) => tool.name)).toEqual(tools.map((tool) => tool.name));
    for (const tool of body.tools) {
      expect(tool.defer_loading, String(tool.name)).toBe(
        deferred.has(String(tool.name)) ? true : undefined,
      );
    }
    expect(body.tools.find((tool) => tool.name === 'GitLog')?.defer_loading).toBe(true);
    expect(body.tools.find((tool) => tool.name === 'Read')?.defer_loading).toBeUndefined();
    // The tool breakpoint sits on the last non-deferred tool: a deferred one may not carry it.
    const marked = body.tools.filter((tool) => tool.cache_control);
    expect(marked).toHaveLength(1);
    expect(marked[0]?.defer_loading).toBeUndefined();
    const lastFixed = body.tools.map((tool) => Boolean(tool.defer_loading)).lastIndexOf(false);
    expect(body.tools[lastFixed]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.messages.some((entry) => entry.role === 'system')).toBe(false);
    expect(headers['anthropic-beta']).toBeUndefined();
    expect(
      countCacheBreakpoints(body as unknown as Parameters<typeof countCacheBreakpoints>[0]),
    ).toBe(3);
  });

  it('turns an activation into a tool_addition, leaving tools[] byte-identical', async () => {
    const captured = captureFetch();
    const { config, surface, tools, deferred } = declaration();
    const before: ProviderMessage[] = [system, { role: 'user', content: 'hi' }];
    await send(config, before, tools, { deferred, additions: [] });

    surface.select!(['GitLog']);
    const next = surface.prepareRequest([], { stable: true }).stable!;
    expect(next.tools).toEqual(tools);
    expect(next.additions).toEqual(['GitLog']);
    const during = [...before, assistantReply(), { role: 'user', content: 'next' }];
    const events = await send(config, during, next.tools, {
      deferred: next.deferred,
      additions: next.additions,
    });

    const [first, second] = captured;
    expect(JSON.stringify(second.body.tools)).toBe(JSON.stringify(first.body.tools));
    expect(second.body.messages.at(-1)).toEqual({
      role: 'system',
      content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'GitLog' } }],
    });
    // The moving breakpoint is on the user turn before the addition, not on the addition.
    expect(JSON.stringify(second.body.messages.at(-2))).toContain('"cache_control"');
    expect(JSON.stringify(second.body.messages.at(-1))).not.toContain('cache_control');
    expect(second.headers['anthropic-beta']).toBe(BETA);
    expect(
      countCacheBreakpoints(second.body as unknown as Parameters<typeof countCacheBreakpoints>[0]),
    ).toBe(3);
    expectCachedPrefixKept(first.body, second.body);
    // The reply records what its request offered, so later requests send it again in place.
    expect(events.find((event) => event.type === 'done')?.providerMetadata?.toolAdditions).toEqual([
      'GitLog',
    ]);
  });

  it('sends a recorded addition right before the reply it preceded, with the beta', async () => {
    const captured = captureFetch();
    const { config, tools, deferred } = declaration();
    const activation: ProviderMessage[] = [
      system,
      { role: 'user', content: 'hi' },
      assistantReply(),
      { role: 'user', content: 'next' },
    ];
    await send(config, activation, tools, { deferred, additions: ['GitLog'] });
    const later = [...activation, assistantReply(['GitLog']), { role: 'user', content: 'again' }];
    await send(config, later, tools, { deferred, additions: [] });

    const [second, third] = captured;
    expect(third.body.messages.map((entry) => entry.role)).toEqual([
      'user',
      'assistant',
      'user',
      'system',
      'assistant',
      'user',
    ]);
    expect(third.body.messages[3]).toEqual(second.body.messages.at(-1));
    expect(third.headers['anthropic-beta']).toBe(BETA);
    expect(
      countCacheBreakpoints(third.body as unknown as Parameters<typeof countCacheBreakpoints>[0]),
    ).toBe(3);
    expectCachedPrefixKept(second.body, third.body);
  });

  it('sends no reference to a tool the request does not declare deferred', async () => {
    const captured = captureFetch();
    const { config, tools, deferred } = declaration();

    await send(
      config,
      [system, { role: 'user', content: 'hi' }, assistantReply(['Read', 'NoSuchTool'])],
      tools,
      { deferred, additions: ['Read'] },
    );

    expect(captured[0]!.body.messages.some((entry) => entry.role === 'system')).toBe(false);
    expect(captured[0]!.headers['anthropic-beta']).toBeUndefined();
  });

  it('defers nothing when every tool would be deferred', async () => {
    const captured = captureFetch();
    const { config, tools } = declaration();
    const everything = new Set(tools.map((tool) => tool.name));

    await send(config, [system, { role: 'user', content: 'hi' }], tools, {
      deferred: everything,
      additions: ['GitLog'],
    });

    expect(captured[0]!.body.tools.some((tool) => tool.defer_loading)).toBe(false);
    expect(captured[0]!.body.messages.some((entry) => entry.role === 'system')).toBe(false);
  });

  it('renders no addition and no beta without a stable declaration', async () => {
    const captured = captureFetch();
    const { config, tools } = declaration();

    await send(
      config,
      [
        system,
        { role: 'user', content: 'hi' },
        assistantReply(['GitLog']),
        { role: 'user', content: 'x' },
      ],
      tools,
    );

    expect(captured[0]!.body.tools.some((tool) => tool.defer_loading)).toBe(false);
    expect(captured[0]!.body.messages.some((entry) => entry.role === 'system')).toBe(false);
    expect(captured[0]!.headers['anthropic-beta']).toBeUndefined();
  });
});

describe('where tools stay stable (#619)', () => {
  it('names the models that take mid-conversation tool changes exactly', () => {
    for (const model of [
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-opus-4-8',
      'claude-fable-5',
      'claude-fable-5-1',
      'claude-mythos-5',
      'claude-mythos-5-1',
      'claude-sonnet-5-5',
      'anthropic/claude-opus-5-5',
    ]) {
      expect(supportsMidConversationToolChanges(model), model).toBe(true);
    }
    for (const model of ['claude-sonnet-5', 'claude-opus-4-7', 'claude-sonnet-4-6', 'gpt-5', 'm']) {
      expect(supportsMidConversationToolChanges(model), model).toBe(false);
    }
  });

  it('holds only on the first-party API, for a supported model, with the switch on', () => {
    expect(keepsToolsStable(stableConfig())).toBe(true);
    expect(keepsToolsStable(stableConfig('claude-sonnet-5'))).toBe(false);
    const foundry = stableConfig();
    foundry.baseUrl = 'https://my-resource.services.ai.azure.com/anthropic';
    expect(keepsToolsStable(foundry)).toBe(false);
    const router = stableConfig();
    router.baseUrl = 'http://127.0.0.1:4000/v1';
    expect(keepsToolsStable(router)).toBe(false);
    const off = stableConfig();
    off.settings.toolDiscovery.stableTools = 'off';
    expect(keepsToolsStable(off)).toBe(false);
    const openai = stableConfig();
    openai.provider = 'openai';
    expect(keepsToolsStable(openai)).toBe(false);
  });
});
