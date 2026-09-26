import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  getPackageVersion,
  getChangelogTail,
  buildReleaseNotesReport,
  releaseDigest,
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
  const changelog = [
    '# Changelog',
    '',
    '## [Unreleased]',
    '',
    '- Something not shipped yet.',
    '',
    '## [9.9.9] - 2026-09-01',
    '',
    '### Added',
    '',
    '- **The feature this version shipped.** A long explanation that wraps',
    '  onto a second line of the file.',
    '- A plain change without a bold lead. And a second sentence.',
    '',
    '### Fixed',
    '',
    '- **A bug it fixed.** Details.',
    '',
    '## [9.9.8] - 2026-08-01',
    '',
    '- An older change.',
  ].join('\n');

  it("digests the installed version's entry to one line per change", () => {
    const digest = releaseDigest(changelog, '9.9.9');
    expect(digest?.heading).toBe('[9.9.9] - 2026-09-01');
    expect(digest?.lines).toEqual([
      '### Added',
      '- The feature this version shipped.',
      '- A plain change without a bold lead.',
      '### Fixed',
      '- A bug it fixed.',
    ]);
    expect(digest?.hidden).toBe(0);
  });

  it('joins a hard-wrapped first sentence and never cuts inside a code span', () => {
    const wrapped = [
      '## [2.0.0]',
      '',
      '- npm blocks install scripts by default, so the patch does not apply on a',
      '  fresh install. More words follow.',
      `- ${'word '.repeat(18)}then \`npm install -g @letrquan/book --with-a-long-flag\` and more.`,
    ].join('\n');
    const lines = releaseDigest(wrapped, '2.0.0')!.lines;
    expect(lines[0]).toBe(
      '- npm blocks install scripts by default, so the patch does not apply on a fresh install.',
    );
    expect(lines[1]!.endsWith('…')).toBe(true);
    expect((lines[1]!.match(/`/g) ?? []).length % 2).toBe(0);
  });

  it('falls back to the newest entry for a build ahead of its last release', () => {
    expect(releaseDigest(changelog, '10.0.0')?.heading).toBe('[Unreleased]');
  });

  it('lists the first changes and counts the rest', () => {
    const long = ['## [1.0.0]', ...Array.from({ length: 30 }, (_, i) => `- change ${i}.`)].join(
      '\n',
    );
    const digest = releaseDigest(long, '1.0.0', 10);
    expect(digest?.lines).toHaveLength(10);
    expect(digest?.hidden).toBe(20);
  });

  it("reads Book's own changelog, not the workspace's", () => {
    // The repository root's CHANGELOG.md is Book's; a report built from it
    // names a Book release.
    const report = buildReleaseNotesReport();
    expect(report).toMatch(/^Book v\S+ · \[/);
  });

  it('says so when a build ships no changelog', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'book-rel-'));
    try {
      const report = buildReleaseNotesReport(join(tmp, 'CHANGELOG.md'));
      expect(report).toContain('Book v');
      expect(report).toContain('No release notes ship with this build.');
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
