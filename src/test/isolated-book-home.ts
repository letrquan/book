import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

/**
 * Points BOOK_HOME at a fresh temporary directory for each test in the calling file,
 * and puts the previous value back afterwards. Returns the current test's directory.
 *
 * The suite setup leaves BOOK_HOME unpinned on purpose (`vitest-setup.ts`), so a suite
 * that drives the print-mode runner without this writes every run's record into the
 * developer's real `~/.book/runs` (#421).
 */
export function isolateBookHome(prefix = 'book-test-home-'): () => string {
  const previous = process.env.BOOK_HOME;
  let home: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), prefix));
    process.env.BOOK_HOME = home;
  });
  afterEach(() => {
    // Restore in `finally`: a throwing rmSync would otherwise leave BOOK_HOME at a
    // deleted directory for every later file in the worker.
    try {
      if (home) rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } finally {
      home = undefined;
      if (previous === undefined) delete process.env.BOOK_HOME;
      else process.env.BOOK_HOME = previous;
    }
  });
  return () => {
    if (!home) throw new Error('isolateBookHome: read outside a running test');
    return home;
  };
}
