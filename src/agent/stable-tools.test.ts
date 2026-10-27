import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgentLoop } from './loop.js';
import { countCacheBreakpoints } from '../provider/anthropic.js';
import { createDefaultRegistry } from '../tools/registry.js';
import { toolSuccess } from '../tools/result.js';
import type { Provider, ProviderStreamOptions } from '../provider/index.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type { AgentConfig } from '../types/runtime.js';
import type { ToolCall } from '../types/tools.js';
import { defaultConfig } from '../test/fixtures.js';
import { isolateBookHome } from '../test/isolated-book-home.js';

// Stable tools (#619) through the whole agent loop: the model loads GitLog with `select:`, calls
// it, and answers. On a supported Anthropic model `tools[]` is the same bytes on all three requests
// and the activation is a `tool_addition`; everywhere else the array only grows, at its end.

isolateBookHome();

let workspace: string;
beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-stable-tools-'));
});
afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const BETA = 'mid-conversation-tool-changes-2026-07-01';

interface Body {
  tools: Array<Record<string, unknown>>;
  system: unknown[];
  messages: Array<{ role: string; content: unknown }>;
}

interface Captured {
  body: Body;
  beta?: string;
}

function sse(events: unknown[]): Response {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function toolUse(id: string, name: string, input: Record<string, unknown>): Response {
  return sse([
    { type: 'message_start', message: { id: `msg-${id}`, usage: { input_tokens: 3 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id, name, input: {} },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]);
}

function text(value: string): Response {
  return sse([
    { type: 'message_start', message: { id: 'msg-text', usage: { input_tokens: 3 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ]);
}

function callbacks(): AgentLoopCallbacks {
  return {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onError: () => {},
    onTurnStart: () => {},
    onDone: () => {},
    onPermissionRequired: async () => 'allow',
  };
}

function registry() {
  const tools = createDefaultRegistry();
  tools.register({ ...tools.getTool('GitLog')!, execute: async () => toolSuccess('abc123 init') });
  return tools;
}

/** Run select:GitLog, then GitLog, then an answer, against the real Anthropic client. */
async function runAnthropic(overrides: Partial<AgentConfig>): Promise<Captured[]> {
  const replies = [
    toolUse('toolu_1', 'ToolSearch', { query: 'select:GitLog' }),
    toolUse('toolu_2', 'GitLog', {}),
    text('done'),
  ];
  const captured: Captured[] = [];
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    captured.push({ body: JSON.parse(String(init.body)), beta: headers['anthropic-beta'] });
    const reply = replies.shift();
    if (!reply) throw new Error('no scripted reply left');
    return reply;
  });
  const config = defaultConfig({ workspace, maxTurns: 6, provider: 'anthropic', ...overrides });
  await runAgentLoop(config, registry(), 'go', [], callbacks(), 'default', {
    isNewSession: false,
  });
  return captured;
}

const names = (body: Body) => body.tools.map((tool) => String(tool.name));

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

/** `earlier`'s cached prefix, up to its last breakpoint, is the front of `later`, byte for byte. */
function expectCachedPrefixKept(earlier: Body, later: Body): void {
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

const breakpoints = (body: Body) =>
  countCacheBreakpoints(body as unknown as Parameters<typeof countCacheBreakpoints>[0]);

describe('stable tools through the loop on a supported Anthropic model (#619)', () => {
  it('keeps tools[] byte-identical and offers the loaded tool by addition', async () => {
    const [first, second, third] = await runAnthropic({
      model: 'claude-opus-5-5',
      baseUrl: 'https://api.anthropic.com',
    });

    expect(first && second && third).toBeTruthy();
    const gitLog = first!.body.tools.find((tool) => tool.name === 'GitLog');
    expect(gitLog?.defer_loading).toBe(true);
    expect(JSON.stringify(second!.body.tools)).toBe(JSON.stringify(first!.body.tools));
    expect(JSON.stringify(third!.body.tools)).toBe(JSON.stringify(first!.body.tools));

    // Before the activation: no tool change, so no beta.
    expect(first!.beta).toBeUndefined();
    expect(first!.body.messages.some((entry) => entry.role === 'system')).toBe(false);

    // The request after `select:GitLog` offers it after the tool result.
    const addition = {
      role: 'system',
      content: [{ type: 'tool_addition', tool: { type: 'tool_reference', name: 'GitLog' } }],
    };
    expect(second!.beta).toBe(BETA);
    expect(second!.body.messages.map((entry) => entry.role)).toEqual([
      'user',
      'assistant',
      'user',
      'system',
    ]);
    expect(second!.body.messages[3]).toEqual(addition);

    // Later requests send it again where it was, right before the reply that called GitLog.
    expect(third!.beta).toBe(BETA);
    expect(third!.body.messages.map((entry) => entry.role)).toEqual([
      'user',
      'assistant',
      'user',
      'system',
      'assistant',
      'user',
    ]);
    expect(third!.body.messages[3]).toEqual(addition);

    expectCachedPrefixKept(first!.body, second!.body);
    expectCachedPrefixKept(second!.body, third!.body);
    for (const request of [first!, second!, third!]) expect(breakpoints(request.body)).toBe(3);
  });

  it('declares nothing deferred with the kill switch off', async () => {
    const requests = await runAnthropic({
      model: 'claude-opus-5-5',
      baseUrl: 'https://api.anthropic.com',
      settings: (() => {
        const config = defaultConfig();
        config.settings.toolDiscovery.stableTools = 'off';
        return config.settings;
      })(),
    });
    expect(requests.every((request) => request.beta === undefined)).toBe(true);
    expect(requests[0]!.body.tools.some((tool) => tool.defer_loading)).toBe(false);
  });
});

describe('append-only tools where the beta is not used (#619)', () => {
  it.each([
    ['Sonnet 5 on the first-party API', 'claude-sonnet-5', 'https://api.anthropic.com'],
    [
      'Opus 5.5 on Azure Foundry',
      'claude-opus-5-5',
      'https://my-resource.services.ai.azure.com/anthropic',
    ],
    ['Opus 5.5 through a router', 'claude-opus-5-5', 'http://127.0.0.1:4000/v1'],
  ])('%s: no beta, no deferral, and GitLog appended at the end', async (_label, model, baseUrl) => {
    const [first, second, third] = await runAnthropic({ model, baseUrl });

    for (const request of [first!, second!, third!]) {
      expect(request.beta).toBeUndefined();
      expect(request.body.tools.some((tool) => tool.defer_loading)).toBe(false);
      expect(request.body.messages.some((entry) => entry.role === 'system')).toBe(false);
      expect(breakpoints(request.body)).toBe(3);
    }
    expect(names(first!.body)).not.toContain('GitLog');
    expect(names(second!.body)).toEqual([...names(first!.body), 'GitLog']);
    expect(names(third!.body)).toEqual(names(second!.body));
  });
});

describe('append-only tools on an OpenAI-compatible provider (#619)', () => {
  it('appends three activations over three turns, with no reorder and no eviction', async () => {
    const select = (name: string): ToolCall => ({
      id: `select-${name}`,
      name: 'ToolSearch',
      arguments: { query: `select:${name}` },
    });
    const turns: ToolCall[][] = [[select('GitLog')], [select('GitDiff')], [select('WebFetch')]];
    const requests: string[][] = [];
    const options: Array<ProviderStreamOptions | undefined> = [];
    let turn = 0;
    const provider = {
      id: 'scripted',
      stream: async function* (
        _config: unknown,
        _messages: unknown,
        tools: Array<{ name: string }>,
        streamOptions?: ProviderStreamOptions,
      ) {
        requests.push(tools.map((tool) => tool.name));
        options.push(streamOptions);
        const calls = turns[turn++];
        if (calls) for (const toolCall of calls) yield { type: 'tool_call', toolCall };
        else yield { type: 'text', content: 'done' };
        yield { type: 'done' };
      },
    } as unknown as Provider;

    await runAgentLoop(
      defaultConfig({ workspace, maxTurns: 6 }),
      registry(),
      'go',
      [],
      callbacks(),
      'default',
      { provider, isNewSession: false },
    );

    expect(requests).toHaveLength(4);
    const [core, ...rest] = requests;
    expect(rest).toEqual([
      [...core!, 'GitLog'],
      [...core!, 'GitLog', 'GitDiff'],
      [...core!, 'GitLog', 'GitDiff', 'WebFetch'],
    ]);
    expect(options.every((entry) => entry?.stableTools === undefined)).toBe(true);
  });
});
