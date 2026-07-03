import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getPackageVersion,
  getChangelogTail,
  buildReleaseNotesReport,
  writeFeedbackReport,
} from './version-info.js';

describe('getPackageVersion', () => {
  it('returns a non-empty version string (reads the workspace package.json)', () => {
    expect(getPackageVersion().length).toBeGreaterThan(0);
  });
});

describe('getChangelogTail', () => {
  it('returns null when no changelog exists', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'book-rel-'));
    try {
      expect(getChangelogTail(tmp)).toBeNull();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reads CHANGELOG.md when present', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'book-rel-'));
    writeFileSync(join(tmp, 'CHANGELOG.md'), '# v0.2.0\n- Added foo\n- Fixed bar\n', 'utf-8');
    try {
      const tail = getChangelogTail(tmp);
      expect(tail).toContain('v0.2.0');
      expect(tail).toContain('Added foo');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('buildReleaseNotesReport', () => {
  it('shows version and notes when no changelog', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'book-rel-'));
    try {
      const r = buildReleaseNotesReport(tmp);
      expect(r).toContain('Book v');
      expect(r).toContain('No CHANGELOG.md');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('writeFeedbackReport', () => {
  it('writes a feedback file under .book/feedback/', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'book-fb-'));
    try {
      const r = writeFeedbackReport({
        workspace: tmp,
        model: 'claude-sonnet-5',
        provider: 'anthropic',
        turn: 2,
        messageCount: 5,
        lastUserPromptPreview: 'please fix the bug',
        lastError: 'something failed',
        note: 'it crashes on /usage',
      });
      expect(r.ok).toBe(true);
      expect(r.path).toBeDefined();
      expect(existsSync(r.path!)).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
