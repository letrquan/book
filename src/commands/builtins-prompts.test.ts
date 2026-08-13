import { describe, it, expect } from 'vitest';
import { buildSecurityReviewPrompt, SECURITY_REVIEW_TOOLS } from './builtins-prompts.js';

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

  it('appends a focus scope when provided', () => {
    expect(buildSecurityReviewPrompt('src/auth')).toContain('src/auth');
  });
});

describe('tool allowlists', () => {
  it('security review is read-only and adds WebSearch', () => {
    expect(SECURITY_REVIEW_TOOLS).toContain('Read');
    expect(SECURITY_REVIEW_TOOLS).toContain('WebSearch');
    expect(SECURITY_REVIEW_TOOLS).not.toContain('Write');
    expect(SECURITY_REVIEW_TOOLS).not.toContain('Bash');
  });
});
