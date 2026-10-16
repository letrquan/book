import { describe, expect, it } from 'vitest';
import { KEPT_BOOK_ENV, clearInheritedBookEnv } from './inherited-book-env.js';

describe('clearInheritedBookEnv', () => {
  it('removes inherited BOOK_* overrides and keeps BOOK_HOME and the telemetry root', () => {
    const env: NodeJS.ProcessEnv = {
      BOOK_HOME: '/tmp/pinned-home',
      BOOK_TOOL_TELEMETRY_DIR: '/tmp/telemetry',
      BOOK_EFFORT: 'high',
      BOOK_MODEL: 'x/y',
      BOOK_API_KEY: 'dummy',
      PATH: '/usr/bin',
      BOOKISH: 'not-a-prefix-match',
    };

    const removed = clearInheritedBookEnv(env);

    expect(removed.sort()).toEqual(['BOOK_API_KEY', 'BOOK_EFFORT', 'BOOK_MODEL']);
    expect(env).toEqual({
      BOOK_HOME: '/tmp/pinned-home',
      BOOK_TOOL_TELEMETRY_DIR: '/tmp/telemetry',
      PATH: '/usr/bin',
      BOOKISH: 'not-a-prefix-match',
    });
  });

  it('honours an explicit keep list', () => {
    const env: NodeJS.ProcessEnv = { BOOK_HOME: 'h', BOOK_EFFORT: 'high', BOOK_MODEL: 'x/y' };

    clearInheritedBookEnv(env, ['BOOK_MODEL']);

    expect(env).toEqual({ BOOK_MODEL: 'x/y' });
  });

  it('is a no-op on a clean environment and keeps BOOK_HOME unset when it was unset', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

    expect(clearInheritedBookEnv(env)).toEqual([]);
    expect(env).toEqual({ PATH: '/usr/bin' });
  });

  it('keeps only BOOK_HOME and BOOK_TOOL_TELEMETRY_DIR by default', () => {
    expect([...KEPT_BOOK_ENV]).toEqual(['BOOK_HOME', 'BOOK_TOOL_TELEMETRY_DIR']);
  });

  it('has already cleaned this process: no inherited override reaches a test file', () => {
    // vitest-setup-clean-env.ts ran before this file. The unit and contract tiers list it; a
    // test that wants an override sets it itself, after setup.
    const leftover = Object.keys(process.env).filter(
      (key) => key.startsWith('BOOK_') && !KEPT_BOOK_ENV.includes(key),
    );
    expect(leftover).toEqual([]);
  });
});
