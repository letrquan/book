import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSystemBlocks, chatCompletionStream, convertMessages } from './anthropic.js';
import { defaultConfig } from '../test/fixtures.js';

// Anthropic request-body assembly is mostly covered indirectly by convertMessages:
// zoned system prompts are carried through so chatCompletionStream can place
// cache_control only on the stable prefix block.
describe('convertMessages', () => {
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
    for await (const _event of stream) {
      // Drain the error event.
    }
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
