import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { defaultModelWindowStorePath, MemoryModelWindowStore } from './model-window-store.js';

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
  it('prioritizes declared contextWindow over family match, learned, and default', () => {
    const store = new MemoryModelWindowStore({
      '9router/ag/gemini-3.8-flash-high': { contextWindow: 65_536, learnedAt: 1000 },
    });
    const result = resolveContextWindow(
      {
        model: '9router/ag/gemini-3.8-flash-high',
        modelInfo: { contextWindow: 500_000 },
      },
      store,
    );
    expect(result).toEqual({ window: 500_000, source: 'declared' });
  });

  it('prioritizes learned contextWindow over family match', () => {
    const store = new MemoryModelWindowStore({
      '9router/ag/gemini-3.8-flash-high': { contextWindow: 65_536, learnedAt: 1000 },
    });
    const result = resolveContextWindow(
      {
        model: '9router/ag/gemini-3.8-flash-high',
      },
      store,
    );
    expect(result).toEqual({ window: 65_536, source: 'learned' });
  });

  it('prioritizes learned contextWindow over default for unknown models', () => {
    const store = new MemoryModelWindowStore({
      'router/unknown-model': { contextWindow: 32_000, learnedAt: 1000 },
    });
    const result = resolveContextWindow(
      {
        model: 'router/unknown-model',
      },
      store,
    );
    expect(result).toEqual({ window: 32_000, source: 'learned' });
  });

  it('follows strict precedence: declared -> learned -> family -> default', () => {
    const model = '9router/ag/gemini-3.8-flash-high';
    const store = new MemoryModelWindowStore({
      [model]: { contextWindow: 64_000, learnedAt: 1000 },
    });

    // 1. Declared wins when present
    expect(resolveContextWindow({ model, modelInfo: { contextWindow: 500_000 } }, store)).toEqual({
      window: 500_000,
      source: 'declared',
    });

    // 2. Learned wins over family match when not declared
    expect(resolveContextWindow({ model }, store)).toEqual({ window: 64_000, source: 'learned' });

    // 3. Family wins when not learned
    const emptyStore = new MemoryModelWindowStore();
    expect(resolveContextWindow({ model }, emptyStore)).toEqual({
      window: 1_048_576,
      source: 'family',
    });

    // 4. Default wins when unknown and not learned
    expect(resolveContextWindow({ model: 'unknown-xyz' }, emptyStore)).toEqual({
      window: DEFAULT_CONTEXT_WINDOW,
      source: 'default',
    });
  });

  it('reads learned window from config.modelWindowStore when store argument is omitted', () => {
    const store = new MemoryModelWindowStore({
      'test-model': { contextWindow: 48_000, learnedAt: 1000 },
    });
    const result = resolveContextWindow({
      model: 'test-model',
      modelWindowStore: store,
    });
    expect(result).toEqual({ window: 48_000, source: 'learned' });
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

  it('resolves dangerous small-window families (gpt-4, gpt-4-32k, gpt-3.5-turbo)', () => {
    expect(resolveContextWindow({ model: 'gpt-4' })).toEqual({
      window: 8_192,
      source: 'family',
    });
    expect(resolveContextWindow({ model: 'openai/gpt-4' })).toEqual({
      window: 8_192,
      source: 'family',
    });
    expect(resolveContextWindow({ model: 'gpt-4-0613' })).toEqual({
      window: 8_192,
      source: 'family',
    });
    expect(resolveContextWindow({ model: 'gpt-4-32k' })).toEqual({
      window: 32_768,
      source: 'family',
    });
    expect(resolveContextWindow({ model: 'gpt-4-32k-0613' })).toEqual({
      window: 32_768,
      source: 'family',
    });
    expect(resolveContextWindow({ model: 'gpt-3.5-turbo' })).toEqual({
      window: 16_385,
      source: 'family',
    });
    expect(resolveContextWindow({ model: 'openai/gpt-3.5-turbo-0125' })).toEqual({
      window: 16_385,
      source: 'family',
    });
  });

  it('distinguishes bare gpt-4 from gpt-4-turbo and dated preview patterns', () => {
    // Turbo and preview patterns resolve to 128k, NOT bare gpt-4 (8k)
    expect(resolveContextWindow({ model: 'gpt-4-turbo' })).toEqual({
      window: 128_000,
      source: 'family',
    });
    expect(resolveContextWindow({ model: 'gpt-4-turbo-2024-04-09' })).toEqual({
      window: 128_000,
      source: 'family',
    });
    expect(resolveContextWindow({ model: 'gpt-4-0125-preview' })).toEqual({
      window: 128_000,
      source: 'family',
    });
    expect(resolveContextWindow({ model: 'gpt-4-1106-preview' })).toEqual({
      window: 128_000,
      source: 'family',
    });

    // Bare gpt-4 does NOT match turbo or preview
    expect(resolveContextWindow({ model: 'gpt-4' }).window).toBe(8_192);
    expect(resolveContextWindow({ model: 'gpt-4' }).window).not.toBe(128_000);
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

  it('prefers modelSelection over model for both family and learned resolution', () => {
    const store = new MemoryModelWindowStore({
      'selected-model': { contextWindow: 48_000, learnedAt: 1000 },
      'base-model': { contextWindow: 64_000, learnedAt: 1000 },
    });
    // Learned lookup uses modelSelection:
    expect(
      resolveContextWindow({
        modelSelection: 'selected-model',
        model: 'base-model',
        modelWindowStore: store,
      }),
    ).toEqual({ window: 48_000, source: 'learned' });

    // Family lookup uses modelSelection:
    expect(
      resolveContextWindow({
        modelSelection: 'openai/gpt-4o',
        model: '9router/ag/gemini-3.8-flash-high',
      }),
    ).toEqual({ window: 128_000, source: 'family' });
  });

  it('falls through to default when model is absent and nothing is declared', () => {
    const result = resolveContextWindow({});
    expect(result).toEqual({ window: DEFAULT_CONTEXT_WINDOW, source: 'default' });
  });

  it('does not construct a store implicitly or read from disk when store is omitted', () => {
    const tempHome = mkdtempSync(join(tmpdir(), 'book-models-no-implicit-'));
    const previousBookHome = process.env.BOOK_HOME;
    try {
      process.env.BOOK_HOME = tempHome;
      const filePath = defaultModelWindowStorePath(tempHome);
      writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          models: {
            'custom-disk-model': { contextWindow: 42_000, learnedAt: Date.now() },
            'openai/gpt-4o': { contextWindow: 50_000, learnedAt: Date.now() },
          },
        }),
        'utf-8',
      );

      // When store and config.modelWindowStore are omitted, it must not read the file:
      // unknown model falls through to default rather than learned disk entry
      const unknownResult = resolveContextWindow({ model: 'custom-disk-model' });
      expect(unknownResult).toEqual({ window: DEFAULT_CONTEXT_WINDOW, source: 'default' });

      // known family model falls through to family window rather than learned disk entry
      const familyResult = resolveContextWindow({ model: 'openai/gpt-4o' });
      expect(familyResult).toEqual({ window: 128_000, source: 'family' });
    } finally {
      if (previousBookHome === undefined) delete process.env.BOOK_HOME;
      else process.env.BOOK_HOME = previousBookHome;
      rmSync(tempHome, { recursive: true, force: true });
    }
  });
});

describe('resolveContextLimit', () => {
  it('returns the declared window when present', () => {
    expect(resolveContextLimit({ modelInfo: { contextWindow: 200_000 } })).toBe(200_000);
  });

  it('returns the learned window when present and not declared', () => {
    const store = new MemoryModelWindowStore({
      'my-model': { contextWindow: 55_000, learnedAt: 1000 },
    });
    expect(resolveContextLimit({ model: 'my-model' }, store)).toBe(55_000);
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

  it('returns false when window was learned rather than declared', () => {
    const store = new MemoryModelWindowStore({
      'test-model': { contextWindow: 45_000, learnedAt: 1000 },
    });
    expect(
      hasDeclaredContextWindow({
        model: 'test-model',
        modelWindowStore: store,
      }),
    ).toBe(false);
  });

  it('returns false for family matches without explicit modelInfo', () => {
    expect(
      hasDeclaredContextWindow({
        model: '9router/ag/gemini-3.8-flash-high',
      }),
    ).toBe(false);
  });

  it('returns false when neither declared nor family matched', () => {
    expect(hasDeclaredContextWindow({ modelInfo: undefined })).toBe(false);
  });
});

describe('declared window protection', () => {
  it('prevents a recorded overflow from overwriting an explicit declared window', () => {
    const store = new MemoryModelWindowStore();
    const config = {
      model: 'my-custom-model',
      modelInfo: { contextWindow: 120_000 },
      modelWindowStore: store,
    };

    // Before overflow: declared is authoritative
    expect(resolveContextWindow(config, store)).toEqual({ window: 120_000, source: 'declared' });

    // The overflow handler checks hasDeclaredContextWindow before ratcheting:
    if (!hasDeclaredContextWindow(config)) {
      store.ratchet('my-custom-model', 40_000);
    }

    // Store was not touched:
    expect(store.get('my-custom-model')).toBeUndefined();

    // Even if an entry somehow existed in the store (e.g. from prior runs before user declared setting),
    // the declared window remains authoritative and is not overwritten:
    store.ratchet('my-custom-model', 40_000);
    expect(resolveContextWindow(config, store)).toEqual({ window: 120_000, source: 'declared' });
  });
});
