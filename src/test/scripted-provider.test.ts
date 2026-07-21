import { describe, expect, it } from 'vitest';
import {
  createRepeatingScriptedProvider,
  createScriptedProvider,
  sseResponse,
} from './scripted-provider.js';

describe('scripted provider fixture', () => {
  it('records requests and serves deterministic SSE responses', async () => {
    const provider = createScriptedProvider(
      sseResponse(['{"choices":[{"delta":{"content":"hello"}}]}']),
    );

    const response = await provider.fetch('http://provider.test/v1/chat/completions', {
      method: 'POST',
      body: JSON.stringify({ model: 'fixture-model' }),
    });
    const text = await response.text();

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].input).toBe('http://provider.test/v1/chat/completions');
    expect(text).toContain('hello');
    expect(text).toContain('[DONE]');
  });

  it('supports explicit repeating responses for multi-turn tests', async () => {
    const provider = createRepeatingScriptedProvider(() => sseResponse(['{"choices":[]}']));

    await provider.fetch('http://provider.test/first');
    await provider.fetch('http://provider.test/second');

    expect(provider.requests).toHaveLength(2);
  });
});
