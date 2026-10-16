import { describe, expect, it } from 'vitest';
import {
  BOOK_TIER_ENV,
  INTEGRATION_TIER,
  KEEP_ENV_VAR,
  KEPT_BOOK_ENV,
  TUI_PROVIDER_ENV_VARS,
  clearInheritedBookEnv,
  resolveKeptBookEnv,
} from './inherited-book-env.js';

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

  it('matches the prefix and the keep list case-insensitively', () => {
    const env: NodeJS.ProcessEnv = {
      Book_Effort: 'high',
      book_model: 'x/y',
      Book_Home: '/tmp/pinned-home',
      Book_Debug: '1',
      PATH: '/usr/bin',
    };

    const removed = clearInheritedBookEnv(env, ['BOOK_HOME', 'book_debug']);

    expect(removed.sort()).toEqual(['Book_Effort', 'book_model']);
    expect(env).toEqual({ Book_Home: '/tmp/pinned-home', Book_Debug: '1', PATH: '/usr/bin' });
  });

  it('keeps only BOOK_HOME and BOOK_TOOL_TELEMETRY_DIR by default', () => {
    expect([...KEPT_BOOK_ENV]).toEqual(['BOOK_HOME', 'BOOK_TOOL_TELEMETRY_DIR']);
  });
});

describe('resolveKeptBookEnv', () => {
  it('keeps only the defaults outside the integration tier', () => {
    expect(resolveKeptBookEnv({ BOOK_EFFORT: 'high' })).toEqual([...KEPT_BOOK_ENV]);
    expect(resolveKeptBookEnv({ [BOOK_TIER_ENV]: 'unit' })).toEqual([...KEPT_BOOK_ENV]);
  });

  it('adds the provider variables in the integration tier, and nothing else', () => {
    const env: NodeJS.ProcessEnv = {
      [BOOK_TIER_ENV]: INTEGRATION_TIER,
      BOOK_API_KEY: 'dummy',
      BOOK_BASE_URL: 'http://127.0.0.1:9',
      BOOK_PROVIDER: 'openai-compatible',
      BOOK_MODEL: 'x/y',
      BOOK_EFFORT: 'high',
      BOOK_MAX_TOKENS: '111',
      BOOK_DEBUG: '1',
      BOOK_HOME: '/tmp/pinned-home',
    };

    const keep = resolveKeptBookEnv(env);
    expect([...TUI_PROVIDER_ENV_VARS].sort()).toEqual([
      'BOOK_API_KEY',
      'BOOK_BASE_URL',
      'BOOK_EFFORT',
      'BOOK_MODEL',
      'BOOK_PROVIDER',
    ]);
    expect(keep).toEqual([...KEPT_BOOK_ENV, ...TUI_PROVIDER_ENV_VARS]);

    const removed = clearInheritedBookEnv(env, keep);
    expect(removed.sort()).toEqual(['BOOK_DEBUG', 'BOOK_MAX_TOKENS']);
    expect(env.BOOK_API_KEY).toBe('dummy');
    expect(env.BOOK_HOME).toBe('/tmp/pinned-home');
    expect(env[BOOK_TIER_ENV]).toBe(INTEGRATION_TIER);
  });

  it('adds the names BOOK_TEST_KEEP_ENV lists, trimming blanks', () => {
    const keep = resolveKeptBookEnv({ [KEEP_ENV_VAR]: ' BOOK_DEBUG , BOOK_DEBUG_STDERR,, ' });

    expect(keep).toEqual([...KEPT_BOOK_ENV, 'BOOK_DEBUG', 'BOOK_DEBUG_STDERR']);
  });

  it('clears BOOK_TEST_KEEP_ENV itself unless it lists itself', () => {
    const env: NodeJS.ProcessEnv = {
      [KEEP_ENV_VAR]: 'BOOK_DEBUG,BOOK_DEBUG_STDERR',
      BOOK_DEBUG: '1',
      BOOK_DEBUG_STDERR: '1',
      BOOK_EFFORT: 'high',
    };
    clearInheritedBookEnv(env, resolveKeptBookEnv(env));
    expect(env).toEqual({ BOOK_DEBUG: '1', BOOK_DEBUG_STDERR: '1' });

    const selfListed: NodeJS.ProcessEnv = {
      [KEEP_ENV_VAR]: `BOOK_DEBUG,${KEEP_ENV_VAR}`,
      BOOK_DEBUG: '1',
    };
    clearInheritedBookEnv(selfListed, resolveKeptBookEnv(selfListed));
    expect(selfListed).toEqual({ [KEEP_ENV_VAR]: `BOOK_DEBUG,${KEEP_ENV_VAR}`, BOOK_DEBUG: '1' });
  });

  it('reads the escape hatch, the tier and the kept names regardless of case', () => {
    const env: NodeJS.ProcessEnv = {
      vitest_book_tier: INTEGRATION_TIER,
      Book_Test_Keep_Env: 'book_debug',
      Book_Debug: '1',
      Book_Api_Key: 'dummy',
      Book_Effort_Level: 'high',
    };

    clearInheritedBookEnv(env, resolveKeptBookEnv(env));

    expect(env).toEqual({
      vitest_book_tier: INTEGRATION_TIER,
      Book_Debug: '1',
      Book_Api_Key: 'dummy',
    });
  });
});

describe('the test process', () => {
  it('has already been cleaned: no inherited override reaches a test file', () => {
    // vitest-setup.ts ran before this file, in every tier's config. A test that wants an override
    // sets it itself, after setup. (With BOOK_TEST_KEEP_ENV on purpose this fails by design: the
    // names it keeps are exactly what this guard forbids.)
    const kept = new Set(resolveKeptBookEnv(process.env).map((name) => name.toUpperCase()));
    const leftover = Object.keys(process.env).filter(
      (key) => key.toUpperCase().startsWith('BOOK_') && !kept.has(key.toUpperCase()),
    );
    expect(leftover).toEqual([]);
  });
});
