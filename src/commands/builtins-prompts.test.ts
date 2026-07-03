import { describe, it, expect } from 'vitest';
import {
  buildReviewPrompt,
  buildSecurityReviewPrompt,
  REVIEW_TOOLS,
  SECURITY_REVIEW_TOOLS,
} from './builtins-prompts.js';

describe('buildReviewPrompt', () => {
  it('instructs git diff + ranked findings, read-only', () => {
    const p = buildReviewPrompt('');
    expect(p).toContain('git diff');
    expect(p).toContain('findings');
    expect(p).toContain('most severe first');
    expect(p).toContain('Do NOT edit files');
  });

  it('appends a focus scope when provided', () => {
    const p = buildReviewPrompt('src/auth');
    expect(p).toContain('src/auth');
  });
});

describe('buildSecurityReviewPrompt', () => {
  it('enumerates the OWASP-shaped defect classes for an agent CLI', () => {
    const p = buildSecurityReviewPrompt('');
    expect(p).toContain('Command injection');
    expect(p).toContain('Path traversal');
    expect(p).toContain('permission checks');
    expect(p).toContain('Secret leakage');
    expect(p).toContain('SSRF');
  });

  it('requires verification of each finding before reporting', () => {
    const p = buildSecurityReviewPrompt('');
    expect(p).toContain('Verify each candidate finding is real');
    expect(p).toContain('confirmed findings');
  });
});

describe('tool allowlists', () => {
  it('review tools are read-only + git', () => {
    expect(REVIEW_TOOLS).toContain('Read');
    expect(REVIEW_TOOLS).toContain('GitDiff');
    expect(REVIEW_TOOLS).not.toContain('Write');
    expect(REVIEW_TOOLS).not.toContain('Bash');
  });

  it('security review adds WebSearch', () => {
    expect(SECURITY_REVIEW_TOOLS).toContain('WebSearch');
    expect(SECURITY_REVIEW_TOOLS).not.toContain('Write');
  });
});
