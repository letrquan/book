import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { loadReviewConfig, renderReviewConfigInstruction } from './config.js';

describe('loadReviewConfig', () => {
  it('loads REVIEW.md from the workspace root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-config-'));
    try {
      writeFileSync(join(dir, 'REVIEW.md'), '# Rules\nOnly flag severe issues.\n');
      const config = loadReviewConfig(dir);
      expect(config.body).toContain('Only flag severe issues');
      expect(config.path).toBe(join(dir, 'REVIEW.md'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns an empty config when REVIEW.md is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'review-config-'));
    try {
      expect(loadReviewConfig(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('renderReviewConfigInstruction', () => {
  it('renders highest-priority instruction text', () => {
    const text = renderReviewConfigInstruction({ body: 'suppress nits' });
    expect(text).toContain('highest priority');
    expect(text).toContain('suppress nits');
  });

  it('is empty without a body', () => {
    expect(renderReviewConfigInstruction({})).toBe('');
  });
});
