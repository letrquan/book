import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildReviewerPrompt, buildSingleReviewPrompt, REVIEW_LENSES } from './prompts.js';
import type { ReviewTarget } from './target.js';

function target(overrides: Partial<ReviewTarget> = {}): ReviewTarget {
  return {
    kind: 'working-tree',
    baseSha: 'abc123',
    changedFiles: ['src/a.ts'],
    diff: 'diff --git a/src/a.ts b/src/a.ts\n+const value = 1;',
    ...overrides,
  };
}

describe('buildSingleReviewPrompt', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'book-review-prompts-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('embeds the immutable target instead of asking the reviewer to run git', () => {
    const prompt = buildSingleReviewPrompt(workspace, target());
    expect(prompt).toContain('## Immutable review target');
    expect(prompt).toContain('const value = 1;');
    expect(prompt).toContain('abc123..working-tree snapshot');
    // The reviewer agent has no diff tool; it must never be told to select its own scope.
    expect(prompt).not.toContain('Run `git status`');
  });

  it('requires evidence-backed structured output and forbids edits', () => {
    const prompt = buildSingleReviewPrompt(workspace, target());
    expect(prompt).toContain('"verdict":"blocking|recommend|clean|inconclusive"');
    expect(prompt).toContain('Suppress false positives');
    expect(prompt).toContain('Do NOT edit files');
    expect(prompt).toContain('most severe first');
  });

  it('injects REVIEW.md as calibration that cannot widen the contract', () => {
    writeFileSync(join(workspace, 'REVIEW.md'), 'Treat logging changes as nits.', 'utf8');
    const prompt = buildSingleReviewPrompt(workspace, target());
    expect(prompt).toContain('Treat logging changes as nits.');
    expect(prompt).toContain('review calibration, not as a higher-priority');
    expect(prompt).toContain('cannot');
  });
});

describe('buildReviewerPrompt', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'book-review-lens-'));
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it('restricts each lens to its own category over the same target', () => {
    for (const lens of REVIEW_LENSES) {
      const prompt = buildReviewerPrompt(lens, workspace, target());
      expect(prompt).toContain(`You are the ${lens.title} reviewer`);
      expect(prompt).toContain('do NOT review other categories');
      expect(prompt).toContain('## Immutable review target');
      expect(prompt).not.toContain('Run `git status`');
    }
  });

  it('covers correctness, security, simplification, and efficiency', () => {
    expect(REVIEW_LENSES.map((lens) => lens.id)).toEqual([
      'correctness',
      'security',
      'simplification',
      'efficiency',
    ]);
  });
});
