import { describe, expect, it } from 'vitest';
import { editFormatFor, resolveEditFormat } from './models.js';

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
