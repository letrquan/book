import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach } from 'vitest';

/** A BOOK_HOME entered by `enterIsolatedHome`, and the value `leaveIsolatedHome` puts back. */
export interface IsolatedHome {
  /** The temporary directory BOOK_HOME points at until the handle is left. */
  home: string;
  /** BOOK_HOME as it was on entry; undefined when the variable was not set. */
  previous: string | undefined;
}

/** Point BOOK_HOME at a fresh temporary directory, remembering what it was. */
export function enterIsolatedHome(prefix = 'book-test-home-'): IsolatedHome {
  const previous = process.env.BOOK_HOME;
  const home = mkdtempSync(join(tmpdir(), prefix));
  process.env.BOOK_HOME = home;
  return { home, previous };
}

/** Remove the directory `enterIsolatedHome` made and put BOOK_HOME back as it was. */
export function leaveIsolatedHome(handle: IsolatedHome): void {
  // Restore in `finally`: a throwing rmSync would otherwise leave BOOK_HOME at a
  // deleted directory for every later file in the worker.
  try {
    rmSync(handle.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } finally {
    if (handle.previous === undefined) delete process.env.BOOK_HOME;
    else process.env.BOOK_HOME = handle.previous;
  }
}

/**
 * Points BOOK_HOME at a fresh temporary directory for each test in the calling file,
 * and puts the previous value back afterwards. Returns the current test's directory.
 *
 * The suite setup leaves BOOK_HOME unpinned on purpose (`vitest-setup.ts`), so a suite
 * that drives the print-mode runner without this writes every run's record into the
 * developer's real `~/.book/runs` (#421).
 *
 * Call it at the top level of the file, not inside one `describe`: a call scoped to a
 * `describe` leaves the file's other tests on the real home.
 */
export function isolateBookHome(prefix = 'book-test-home-'): () => string {
  let entered: IsolatedHome | undefined;
  beforeEach(() => {
    entered = enterIsolatedHome(prefix);
  });
  afterEach(() => {
    const handle = entered;
    entered = undefined;
    if (handle) leaveIsolatedHome(handle);
  });
  return () => {
    if (!entered) throw new Error('isolateBookHome: read outside a running test');
    return entered.home;
  };
}
