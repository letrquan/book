import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isolateBookHome } from './isolated-book-home.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

describe('isolateBookHome', () => {
  const previous = process.env.BOOK_HOME;
  const bookHome = isolateBookHome('book-isolated-home-test-');

  it('points BOOK_HOME at a directory of the test', () => {
    expect(process.env.BOOK_HOME).toBe(bookHome());
    expect(bookHome()).not.toBe(previous);
  });

  // A suite that drives the print-mode runner (directly, or through the SDK) without a
  // pinned home writes each run's record into the developer's real ~/.book/runs (#421).
  it('is pinned by every suite that drives the print-mode runner', () => {
    const drivesRunner = /\brunHeadless\(|from '\.{1,2}\/sdk\.js'/;
    const unpinned = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
      .filter((file) => /\.test\.tsx?$/.test(file))
      .filter((file) => {
        const source = readFileSync(join(SRC, file), 'utf8');
        return drivesRunner.test(source) && !/\bBOOK_HOME\b|\bisolateBookHome\(/.test(source);
      });
    expect(unpinned).toEqual([]);
  });
});
