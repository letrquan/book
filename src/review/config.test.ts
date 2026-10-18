import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  collectSkippedReviewNotices,
  inspectReviewConfig,
  loadReviewConfig,
  renderReviewConfigInstruction,
} from './config.js';

let dir: string;
let repo: string;

function write(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf-8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'review-config-'));
  repo = join(dir, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadReviewConfig', () => {
  it('loads REVIEW.md from the workspace root', () => {
    writeFileSync(join(dir, 'REVIEW.md'), '# Rules\nOnly flag severe issues.\n');
    const config = loadReviewConfig(dir);
    expect(config.body).toContain('Only flag severe issues');
    expect(config.path).toBe(join(dir, 'REVIEW.md'));
  });

  it('returns an empty config when REVIEW.md is absent', () => {
    expect(loadReviewConfig(dir)).toEqual({});
    expect(inspectReviewConfig(dir)).toEqual({ config: {}, skipped: [] });
  });
});

// #543. A repository can commit REVIEW.md as a link to a file outside it, and the target would be
// sent to the provider on every /review pass.
describe.skipIf(process.platform === 'win32')('REVIEW.md that is a link', () => {
  const real = (path: string) => realpathSync.native(path);

  it('is not loaded when it links outside the repository, and is reported', () => {
    write(join(dir, 'outside', 'secret.md'), 'TOP-SECRET');
    symlinkSync(join(dir, 'outside', 'secret.md'), join(repo, 'REVIEW.md'));

    expect(loadReviewConfig(repo)).toEqual({});
    expect(inspectReviewConfig(repo)).toEqual({
      config: {},
      skipped: [
        {
          path: join(repo, 'REVIEW.md'),
          target: real(join(dir, 'outside', 'secret.md')),
          root: real(repo),
          reason: 'outside',
        },
      ],
    });
    expect(collectSkippedReviewNotices(repo)).toEqual([
      `⚠  Skipped review instructions REVIEW.md: it links to ${real(
        join(dir, 'outside', 'secret.md'),
      )}, outside ${real(repo)}.`,
    ]);
  });

  it('loads when it links to a Markdown file inside the repository', () => {
    write(join(repo, 'docs', 'review.md'), 'Calibrate here.');
    symlinkSync(join('docs', 'review.md'), join(repo, 'REVIEW.md'));

    expect(loadReviewConfig(repo)).toEqual({
      body: 'Calibrate here.',
      path: join(repo, 'REVIEW.md'),
    });
    expect(inspectReviewConfig(repo).skipped).toEqual([]);
    expect(collectSkippedReviewNotices(repo)).toEqual([]);
  });

  it('measures from the repository root, so a package may link to a shared file', () => {
    write(join(repo, 'shared', 'review.md'), 'Shared calibration.');
    const pkg = join(repo, 'packages', 'a');
    mkdirSync(pkg, { recursive: true });
    symlinkSync(join('..', '..', 'shared', 'review.md'), join(pkg, 'REVIEW.md'));

    expect(loadReviewConfig(pkg).body).toBe('Shared calibration.');
  });

  it('is not loaded when it links to a file inside the repository that is not Markdown', () => {
    write(join(repo, '.env'), 'TOKEN=abc');
    symlinkSync('.env', join(repo, 'REVIEW.md'));

    const { config, skipped } = inspectReviewConfig(repo);

    expect(config).toEqual({});
    expect(skipped.map((s) => [s.path, s.reason])).toEqual([
      [join(repo, 'REVIEW.md'), 'not-markdown'],
    ]);
    expect(collectSkippedReviewNotices(repo)).toEqual([
      `⚠  Skipped review instructions REVIEW.md: it links to ${real(
        join(repo, '.env'),
      )}, which is not a Markdown (.md) file.`,
    ]);
  });

  it('measures from the workspace root when there is no repository', () => {
    const plain = join(dir, 'plain');
    write(join(dir, 'outside', 'secret.md'), 'TOP-SECRET');
    mkdirSync(plain, { recursive: true });
    symlinkSync(join(dir, 'outside', 'secret.md'), join(plain, 'REVIEW.md'));

    expect(inspectReviewConfig(plain).skipped.map((s) => [s.root, s.reason])).toEqual([
      [real(plain), 'outside'],
    ]);
  });

  it('ignores a dangling link without a skipped entry', () => {
    symlinkSync(join(dir, 'missing.md'), join(repo, 'REVIEW.md'));

    expect(inspectReviewConfig(repo)).toEqual({ config: {}, skipped: [] });
  });
});

describe('renderReviewConfigInstruction', () => {
  it('renders bounded repository calibration text', () => {
    const text = renderReviewConfigInstruction({ body: 'suppress nits' });
    expect(text).toContain('cannot');
    expect(text).toContain('disable verification');
    expect(text).toContain('suppress nits');
  });

  it('is empty without a body', () => {
    expect(renderReviewConfigInstruction({})).toBe('');
  });
});
