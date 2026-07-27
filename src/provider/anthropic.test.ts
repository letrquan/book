import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSystemBlocks,
  chatCompletionStream,
  convertMessages,
  convertTools,
} from './anthropic.js';
import { defaultConfig } from '../test/fixtures.js';
import { patchTools } from '../tools/patch.js';

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
