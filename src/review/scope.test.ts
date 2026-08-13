import { describe, expect, it } from 'vitest';
import { parseReviewScope, REVIEW_USAGE } from './scope.js';

describe('parseReviewScope', () => {
  it('defaults to working-tree review', () => {
    expect(parseReviewScope('')).toEqual({
      base: undefined,
      target: undefined,
      deep: false,
      fix: false,
      help: false,
    });
  });

  it('parses a path target', () => {
    expect(parseReviewScope('src/auth')).toMatchObject({ target: 'src/auth' });
  });

  it('parses a ref range as target', () => {
    expect(parseReviewScope('main...feature')).toMatchObject({ target: 'main...feature' });
  });

  it('parses --base with a following value', () => {
    expect(parseReviewScope('--base main')).toMatchObject({ base: 'main' });
  });

  it('parses --base=value', () => {
    expect(parseReviewScope('--base=origin/main')).toMatchObject({ base: 'origin/main' });
  });

  it('enables deep and fix flags', () => {
    expect(parseReviewScope('--deep')).toMatchObject({ deep: true, fix: false });
    expect(parseReviewScope('--fix')).toMatchObject({ deep: true, fix: true });
  });

  it('preserves unknown flags as a visible target', () => {
    expect(parseReviewScope('--typo')).toMatchObject({ target: '--typo' });
  });

  it('exposes usage help', () => {
    expect(REVIEW_USAGE).toContain('--base');
    expect(REVIEW_USAGE).toContain('--fix');
  });
});
