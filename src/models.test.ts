import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW,
  editFormatFor,
  hasDeclaredContextWindow,
  normalizeModelName,
  resolveContextLimit,
  resolveContextWindow,
  resolveEditFormat,
  resolveFamilyContextWindow,
} from './models.js';

describe('editFormatFor', () => {
  it('prefers the patch format for GPT/Codex-family models', () => {
    for (const model of ['gpt-5', 'gpt-4o', 'openai/gpt-5.2', 'codex-mini', 'o3', 'o4-mini']) {
      expect(editFormatFor(model), model).toBe('patch');
    }
  });

  it('prefers exact-replace for everything else, including unknown models', () => {
    for (const model of [
      'claude-opus-4-8',
      'qwen3.7-max',
      '9router/qc/qwen3.7-max',
      'glm-4.6',
      'gemini-2.5-pro',
      'grok-4',
      'totally-unknown-model',
    ]) {
      expect(editFormatFor(model), model).toBe('replace');
    }
  });

  it('does not misclassify community models whose ids merely contain gpt', () => {
    for (const model of ['gpt-j', 'gpt-neox-20b', 'gpt4all', 'nemotron-gpt', 'magpt']) {
      expect(editFormatFor(model), model).toBe('replace');
    }
  });

  it('matches the family on the final path segment of routed ids', () => {
    expect(editFormatFor('9router/oa/gpt-5')).toBe('patch');
    expect(editFormatFor('gpt-router/qwen3')).toBe('replace');
  });
});

describe('resolveEditFormat', () => {
  it('lets a settings override win over the family prior', () => {
    expect(resolveEditFormat('gpt-5', 'replace')).toBe('replace');
    expect(resolveEditFormat('qwen3.7-max', 'whole')).toBe('whole');
    expect(resolveEditFormat('qwen3.7-max', undefined)).toBe('replace');
  });
});

describe('normalizeModelName', () => {
  it('normalizes router prefixes of one or two segments to the terminal name', () => {
    expect(normalizeModelName('9router/ag/gemini-3.8-flash-high')).toBe('gemini-3.8-flash-high');
    expect(normalizeModelName('openai/gpt-4o')).toBe('gpt-4o');
    expect(normalizeModelName('gemini-1.5-flash')).toBe('gemini-1.5-flash');
  });

  it('strips trailing date suffixes from model identifiers', () => {
    expect(normalizeModelName('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(normalizeModelName('openai/gpt-4o-2024-08-06')).toBe('gpt-4o');
    expect(normalizeModelName('anthropic/claude-sonnet-5.20260115')).toBe('claude-sonnet-5');
  });

  it('leaves non-date numbers and suffixes intact', () => {
    expect(normalizeModelName('gemini-3.8-flash-high')).toBe('gemini-3.8-flash-high');
    expect(normalizeModelName('gemini-1.5-flash-001')).toBe('gemini-1.5-flash-001');
  });
});

describe('resolveFamilyContextWindow', () => {
  it('matches Gemini Flash models to 1,048,576 tokens', () => {
    expect(resolveFamilyContextWindow('9router/ag/gemini-3.8-flash-high')).toBe(1_048_576);
    expect(resolveFamilyContextWindow('gemini-1.5-flash')).toBe(1_048_576);
    expect(resolveFamilyContextWindow('gemini-2.0-flash')).toBe(1_048_576);
  });

  it('excludes Gemini Flash image and TTS variants from the 1M window', () => {
    expect(resolveFamilyContextWindow('gemini-2.5-flash-image')).toBeUndefined();
    expect(resolveFamilyContextWindow('gemini-2.5-flash-preview-tts')).toBeUndefined();
  });

  it('matches Claude models to 200,000 tokens', () => {
    expect(resolveFamilyContextWindow('claude-sonnet-5')).toBe(200_000);
    expect(resolveFamilyContextWindow('claude-opus-4-8')).toBe(200_000);
    expect(resolveFamilyContextWindow('claude-haiku-4-5-20251001')).toBe(200_000);
    expect(resolveFamilyContextWindow('claude-3-5-sonnet-20241022')).toBe(200_000);
    expect(resolveFamilyContextWindow('9router/ag/claude-3.5-haiku')).toBe(200_000);
  });

  it('excludes legacy Claude models from the 200,000 window', () => {
    expect(resolveFamilyContextWindow('claude-2.0')).toBeUndefined();
    expect(resolveFamilyContextWindow('claude-2.1')).toBeUndefined();
    expect(resolveFamilyContextWindow('claude-instant-1.2')).toBeUndefined();
  });

  it('matches GPT-4o models to 128,000 tokens', () => {
    expect(resolveFamilyContextWindow('gpt-4o')).toBe(128_000);
    expect(resolveFamilyContextWindow('openai/gpt-4o-mini')).toBe(128_000);
  });

  it('matches GPT-4 Turbo models to 128,000 tokens', () => {
    expect(resolveFamilyContextWindow('gpt-4-turbo')).toBe(128_000);
    expect(resolveFamilyContextWindow('gpt-4-turbo-2024-04-09')).toBe(128_000);
    expect(resolveFamilyContextWindow('gpt-4-0125-preview')).toBe(128_000);
  });

  it('matches OpenAI o-series reasoning models to 128,000 tokens', () => {
    expect(resolveFamilyContextWindow('o1')).toBe(128_000);
    expect(resolveFamilyContextWindow('o1-mini')).toBe(128_000);
    expect(resolveFamilyContextWindow('o1-preview')).toBe(128_000);
    expect(resolveFamilyContextWindow('o3')).toBe(128_000);
    expect(resolveFamilyContextWindow('o3-mini')).toBe(128_000);
    expect(resolveFamilyContextWindow('o4-preview')).toBe(128_000);
  });

  it('returns undefined for unknown or nonsense models', () => {
    expect(resolveFamilyContextWindow('nonsense/unknown-model-xyz')).toBeUndefined();
    expect(resolveFamilyContextWindow('totally-unknown-model')).toBeUndefined();
  });

  it('deliberately excludes Qwen models due to 32k-1M variance across variants', () => {
    expect(resolveFamilyContextWindow('qwen-2.5-coder-32b')).toBeUndefined();
    expect(resolveFamilyContextWindow('qwen2.5-72b-instruct')).toBeUndefined();
    expect(resolveFamilyContextWindow('qc/qwen3.7-max')).toBeUndefined();
  });
});

describe('resolveContextWindow', () => {
  it('prioritizes declared contextWindow over family match and default', () => {
    const result = resolveContextWindow({
      model: '9router/ag/gemini-3.8-flash-high',
      modelInfo: { contextWindow: 500_000 },
    });
    expect(result).toEqual({ window: 500_000, source: 'declared' });
  });

  it('resolves family match for a two-segment router prefix (owner active model)', () => {
    const result = resolveContextWindow({
      model: '9router/ag/gemini-3.8-flash-high',
    });
    expect(result).toEqual({ window: 1_048_576, source: 'family' });
  });

  it('resolves family match for a single-segment router prefix', () => {
    const result = resolveContextWindow({
      model: 'openai/gpt-4o',
    });
    expect(result).toEqual({ window: 128_000, source: 'family' });
  });

  it('falls through to default for nonsense or uncatalogued models', () => {
    const result = resolveContextWindow({
      model: 'nonsense/unknown-model-xyz',
    });
    expect(result).toEqual({ window: DEFAULT_CONTEXT_WINDOW, source: 'default' });
  });

  it('falls through to default for Qwen models without declared window', () => {
    const result = resolveContextWindow({
      model: 'qwen2.5-coder-32b',
    });
    expect(result).toEqual({ window: DEFAULT_CONTEXT_WINDOW, source: 'default' });
  });

  it('falls through to default when model is absent and nothing is declared', () => {
    const result = resolveContextWindow({});
    expect(result).toEqual({ window: DEFAULT_CONTEXT_WINDOW, source: 'default' });
  });
});

describe('resolveContextLimit', () => {
  it('returns the declared window when present', () => {
    expect(resolveContextLimit({ modelInfo: { contextWindow: 200_000 } })).toBe(200_000);
  });

  it('returns the family window when matched', () => {
    expect(resolveContextLimit({ model: '9router/ag/gemini-3.8-flash-high' })).toBe(1_048_576);
  });

  it('returns the default window when unmatched', () => {
    expect(resolveContextLimit({ model: 'unknown-model' })).toBe(DEFAULT_CONTEXT_WINDOW);
  });
});

describe('hasDeclaredContextWindow', () => {
  it('returns true when modelInfo has a valid contextWindow', () => {
    expect(hasDeclaredContextWindow({ modelInfo: { contextWindow: 200_000 } })).toBe(true);
  });

  it('returns false for family matches without explicit modelInfo', () => {
    expect(
      hasDeclaredContextWindow({
        model: '9router/ag/gemini-3.8-flash-high',
      } as Parameters<typeof hasDeclaredContextWindow>[0]),
    ).toBe(false);
  });

  it('returns false when neither declared nor family matched', () => {
    expect(hasDeclaredContextWindow({ modelInfo: undefined })).toBe(false);
  });
});
