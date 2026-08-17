import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSystemBlocks,
  chatCompletionStream,
  convertMessages,
  convertTools,
  countCacheBreakpoints,
  markLastMessageForCaching,
} from './anthropic.js';
import { defaultConfig } from '../test/fixtures.js';
import { patchTools } from '../tools/patch.js';
import { todoTools } from '../tools/todo.js';
import type { ProviderMessage } from '../types/providers.js';
import type { ToolDefinition } from '../types/tools.js';

describe('Anthropic tool contracts', () => {
  it('preserves the compact ApplyPatch string schema', () => {
    const converted = convertTools(patchTools);
    expect(converted[0]).toMatchObject({
      name: 'ApplyPatch',
      input_schema: {
        type: 'object',
        required: ['patch'],
        properties: { patch: { type: 'string' } },
      },
    });
  });

  it('preserves ApplyPatch text when converting assistant tool calls', () => {
    const patch = '*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch';
    const converted = convertMessages([
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'patch-1',
            type: 'function',
            function: { name: 'ApplyPatch', arguments: JSON.stringify({ patch }) },
          },
        ],
      },
    ]);
    expect(converted.messages[0]).toMatchObject({
      role: 'assistant',
      content: expect.arrayContaining([
        expect.objectContaining({ type: 'tool_use', name: 'ApplyPatch', input: { patch } }),
      ]),
    });
  });
});

// Anthropic request-body assembly is mostly covered indirectly by convertMessages:
// zoned system prompts are carried through so chatCompletionStream can place
// cache_control only on the stable prefix block.
describe('convertMessages', () => {
  it('replays native thinking signatures unchanged', () => {
    const blocks = [
      { type: 'thinking', thinking: 'inspect', signature: 'sig-1' },
      { type: 'text', text: 'I will read it.' },
      { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: 'a.ts' } },
    ];
    const out = convertMessages([
      { role: 'assistant', content: '', providerMetadata: { anthropicContentBlocks: blocks } },
    ]);
    expect(out.messages).toEqual([{ role: 'assistant', content: blocks }]);
  });

  it('includes unsigned legacy reasoning as delimited assistant context', () => {
    const out = convertMessages([
      { role: 'assistant', content: 'answer', reasoningContent: 'inspect first' },
    ]);
    expect(out.messages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '<reasoning_context>\ninspect first\n</reasoning_context>' },
          { type: 'text', text: 'answer' },
        ],
      },
    ]);
  });

  it('converts image content parts to Anthropic base64 blocks', () => {
    const out = convertMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is shown?' },
          { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' },
        ],
      },
    ]);
    expect(out.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'What is shown?' },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
        },
      ],
    });
  });

  it('preserves two-zone system prompts for Anthropic cache blocks', () => {
    const zones = {
      cachedPrefix: 'static instructions',
      dynamicSuffix: 'current todos',
    };

    const out = convertMessages([
      { role: 'system', content: zones },
      { role: 'user', content: 'hi' },
    ]);

    expect(out.systemZones).toEqual(zones);
    expect(out.system).toBe('static instructions\n\ncurrent todos');
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('keeps flat string system prompts compatible', () => {
    const out = convertMessages([
      { role: 'system', content: 'flat instructions' },
      { role: 'user', content: 'hi' },
    ]);

    expect(out.systemZones).toBeUndefined();
    expect(out.system).toBe('flat instructions');
  });
});

afterEach(() => vi.unstubAllGlobals());

describe('Anthropic request URL', () => {
  it.each([
    ['https://api.anthropic.com', 'https://api.anthropic.com/v1/messages'],
    ['https://proxy.test/v1', 'https://proxy.test/v1/messages'],
  ])('normalizes %s without duplicating /v1', async (baseUrl, expected) => {
    const fetchMock = vi.fn(
      async (_url: string | URL | Request, _init?: RequestInit) =>
        new Response('{}', { status: 400 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const stream = chatCompletionStream(defaultConfig({ baseUrl, provider: 'anthropic' }), [], []);
    for await (const event of stream) void event;
    expect(fetchMock.mock.calls[0][0]).toBe(expected);
  });
});

describe('Anthropic thinking configuration', () => {
  it('requests summarized adaptive thinking for Opus 5', async () => {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response('{}', { status: 400 });
      }),
    );

    for await (const event of chatCompletionStream(
      defaultConfig({
        model: 'claude-opus-5-20260101',
        provider: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
      }),
      [{ role: 'user', content: 'hi' }],
      [],
    )) {
      void event;
    }

    expect(requestBody?.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(requestBody?.output_config).toEqual({ effort: 'high' });
  });
});

describe('Anthropic terminal framing', () => {
  it('captures complete thinking blocks and signatures for replay', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                [
                  'data: {"type":"message_start","message":{"usage":{"input_tokens":2}}}',
                  '',
                  'data: {"type":"content_block_start","content_block":{"type":"thinking","thinking":""}}',
                  '',
                  'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"inspect"}}',
                  '',
                  'data: {"type":"content_block_delta","delta":{"type":"signature_delta","signature":"sig-1"}}',
                  '',
                  'data: {"type":"content_block_stop"}',
                  '',
                  'data: {"type":"message_stop"}',
                  '',
                ].join('\n'),
              ),
            );
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );
    const events = [];
    for await (const event of chatCompletionStream(
      defaultConfig({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com' }),
      [{ role: 'user', content: 'hi' }],
      [],
    )) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({
      providerMetadata: {
        anthropicContentBlocks: [{ type: 'thinking', thinking: 'inspect', signature: 'sig-1' }],
      },
    });
  });

  it('emits thinking deltas as reasoning events', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                [
                  'data: {"type":"message_start","message":{"usage":{"input_tokens":2}}}',
                  '',
                  'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"inspect first"}}',
                  '',
                  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"answer"}}',
                  '',
                  'data: {"type":"message_stop"}',
                  '',
                ].join('\n'),
              ),
            );
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const events = [];
    for await (const event of chatCompletionStream(
      defaultConfig({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com' }),
      [{ role: 'user', content: 'hi' }],
      [],
    )) {
      events.push(event);
    }

    expect(events).toEqual(
      expect.arrayContaining([
        { type: 'reasoning', reasoning: 'inspect first' },
        { type: 'text', content: 'answer' },
      ]),
    );
  });

  it('reports transport interruption when EOF arrives without message_stop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                [
                  'data: {"type":"message_start","message":{"usage":{"input_tokens":2}}}',
                  '',
                  'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}',
                  '',
                ].join('\n'),
              ),
            );
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const events = [];
    const stream = chatCompletionStream(
      defaultConfig({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com' }),
      [{ role: 'user', content: 'hi' }],
      [],
    );
    for await (const event of stream) events.push(event);

    expect(events).toEqual([
      { type: 'text', content: 'partial' },
      {
        type: 'error',
        error: 'Provider stream ended before its terminal event.',
        errorCode: 'transport_interrupted',
      },
    ]);
  });
});

describe('Anthropic response metadata', () => {
  it('preserves response identity and stop reason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                [
                  'data: {"type":"message_start","message":{"id":"msg-1","model":"claude-sonnet-5","usage":{"input_tokens":2}}}',
                  '',
                  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
                  '',
                  'data: {"type":"message_stop"}',
                  '',
                ].join('\n'),
              ),
            );
            controller.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const events = [];
    for await (const event of chatCompletionStream(
      defaultConfig({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com' }),
      [{ role: 'user', content: 'hi' }],
      [],
    )) {
      events.push(event);
    }
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      responseId: 'msg-1',
      responseModel: 'claude-sonnet-5',
      finishReasons: ['end_turn'],
    });
  });
});

describe('buildSystemBlocks', () => {
  it('caches only the static prefix for zoned system prompts', () => {
    const blocks = buildSystemBlocks('ignored flat fallback', {
      cachedPrefix: 'static instructions',
      dynamicSuffix: 'current todos',
    });

    expect(blocks).toEqual([
      {
        type: 'text',
        text: 'static instructions',
        cache_control: { type: 'ephemeral' },
      },
      {
        type: 'text',
        text: 'current todos',
      },
    ]);
  });

  it('keeps flat string system prompts as one cached block', () => {
    expect(buildSystemBlocks('flat instructions')).toEqual([
      {
        type: 'text',
        text: 'flat instructions',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });
});

describe('markLastMessageForCaching', () => {
  it('promotes string content to a marked text block', () => {
    const messages = [
      { role: 'user' as const, content: 'first' },
      { role: 'user' as const, content: 'newest' },
    ];

    markLastMessageForCaching(messages);

    expect(messages[0].content).toBe('first');
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'newest', cache_control: { type: 'ephemeral' } },
    ]);
  });

  it('marks the final block of array content', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'tool_result' as const, tool_use_id: 'a', content: 'ok' },
          { type: 'tool_result' as const, tool_use_id: 'b', content: 'ok' },
        ],
      },
    ];

    markLastMessageForCaching(messages);

    expect(messages[0].content).toEqual([
      { type: 'tool_result', tool_use_id: 'a', content: 'ok' },
      {
        type: 'tool_result',
        tool_use_id: 'b',
        content: 'ok',
        cache_control: { type: 'ephemeral' },
      },
    ]);
  });

  it('skips thinking blocks, which the API rejects a marker on', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'answer' },
          { type: 'thinking' as const, thinking: 'inspect', signature: 'sig-1' },
        ],
      },
    ];

    markLastMessageForCaching(messages);

    expect(messages[0].content).toEqual([
      { type: 'text', text: 'answer', cache_control: { type: 'ephemeral' } },
      { type: 'thinking', thinking: 'inspect', signature: 'sig-1' },
    ]);
  });

  it('tolerates an empty message list', () => {
    expect(() => markLastMessageForCaching([])).not.toThrow();
  });
});

describe('Anthropic cache breakpoint placement', () => {
  async function captureRequestBody(
    tools: ToolDefinition[],
    messages: ProviderMessage[],
  ): Promise<Record<string, unknown>> {
    let requestBody: Record<string, unknown> | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return new Response('{}', { status: 400 });
      }),
    );

    for await (const event of chatCompletionStream(
      defaultConfig({ provider: 'anthropic', baseUrl: 'https://api.anthropic.com' }),
      messages,
      tools,
    )) {
      void event;
    }

    if (!requestBody) throw new Error('request body was never captured');
    return requestBody;
  }

  const zones = { cachedPrefix: 'static instructions', dynamicSuffix: 'active policy' };

  it('marks only the last tool, whatever the tool count', async () => {
    const tools = [...patchTools, ...todoTools];
    expect(tools.length).toBeGreaterThan(1);

    const body = await captureRequestBody(tools, [{ role: 'user', content: 'hi' }]);
    const sent = body.tools as Array<Record<string, unknown>>;

    expect(sent).toHaveLength(tools.length);
    expect(sent.filter((tool) => tool.cache_control)).toEqual([
      expect.objectContaining({ name: tools[tools.length - 1].name }),
    ]);
  });

  it('places exactly three breakpoints with tools, zones, and history active', async () => {
    const body = await captureRequestBody(patchTools, [
      { role: 'system', content: zones },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'newest' },
    ]);

    expect(countCacheBreakpoints(body)).toBe(3);
  });

  it('marks the newest message and leaves earlier turns untouched', async () => {
    const body = await captureRequestBody(patchTools, [
      { role: 'system', content: zones },
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'newest' },
    ]);
    const sent = body.messages as Array<{ role: string; content: unknown }>;

    expect(sent.slice(0, -1).every((message) => typeof message.content === 'string')).toBe(true);
    expect(sent.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'text', text: 'newest', cache_control: { type: 'ephemeral' } }],
    });
  });

  it('marks the last tool result when the newest turn carries them', async () => {
    const body = await captureRequestBody(patchTools, [
      { role: 'system', content: zones },
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'ApplyPatch', arguments: '{}' } },
          { id: 'call-2', type: 'function', function: { name: 'ApplyPatch', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'applied' },
      { role: 'tool', tool_call_id: 'call-2', content: 'applied' },
    ]);
    const sent = body.messages as Array<{ content: Array<Record<string, unknown>> }>;

    expect(countCacheBreakpoints(body)).toBe(3);
    expect(sent.at(-1)?.content.map((block) => Boolean(block.cache_control))).toEqual([
      false,
      true,
    ]);
  });

  it('still sends one cached system block when the dynamic suffix is empty', async () => {
    const body = await captureRequestBody(patchTools, [
      { role: 'system', content: { cachedPrefix: 'static instructions', dynamicSuffix: '' } },
      { role: 'user', content: 'hi' },
    ]);

    expect(body.system).toEqual([
      { type: 'text', text: 'static instructions', cache_control: { type: 'ephemeral' } },
    ]);
    expect(countCacheBreakpoints(body)).toBe(3);
  });

  it('stays within budget when no tools are registered', async () => {
    const body = await captureRequestBody(
      [],
      [
        { role: 'system', content: zones },
        { role: 'user', content: 'hi' },
      ],
    );

    expect(body.tools).toBeUndefined();
    expect(countCacheBreakpoints(body)).toBe(2);
  });
});

describe('countCacheBreakpoints', () => {
  it('ignores cache_control keys nested inside tool inputs', () => {
    expect(
      countCacheBreakpoints({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'call-1',
                name: 'Write',
                input: { content: { cache_control: { type: 'ephemeral' } } },
              },
            ],
          },
        ],
      }),
    ).toBe(0);
  });
});
