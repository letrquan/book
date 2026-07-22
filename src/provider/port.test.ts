import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../test/fixtures.js';
import { createProvider, isAnthropicProvider } from './port.js';

describe('provider port', () => {
  it('selects adapters outside the agent loop', () => {
    const anthropic = defaultConfig({
      provider: 'anthropic',
      baseUrl: 'https://example.test',
      model: 'model',
    });
    const openai = defaultConfig({
      provider: 'openai',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-test',
    });

    expect(isAnthropicProvider(anthropic)).toBe(true);
    expect(createProvider(anthropic).id).toBe('anthropic');
    expect(isAnthropicProvider(openai)).toBe(false);
    expect(createProvider(openai).id).toBe('openai-compatible');
  });
});
