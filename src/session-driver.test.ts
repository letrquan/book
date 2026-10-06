import { describe, expect, it } from 'vitest';
import { parseSessionDriver, resolveSessionDriver } from './session-driver.js';

describe('resolveSessionDriver', () => {
  it('is human with no explicit choice and no agent markers', () => {
    expect(resolveSessionDriver({ env: {} })).toEqual({ driver: 'human', signals: [] });
  });

  it('is agent under the environment Claude Code gives its children', () => {
    expect(
      resolveSessionDriver({
        env: { CLAUDECODE: '1', AI_AGENT: 'claude-code_2-1-291_agent' },
      }),
    ).toEqual({ driver: 'agent', signals: ['CLAUDECODE', 'AI_AGENT'] });
    expect(resolveSessionDriver({ env: { AI_AGENT: 'claude-code_2-1-291_agent' } })).toEqual({
      driver: 'agent',
      signals: ['AI_AGENT'],
    });
  });

  it('does not count a CLAUDECODE that is empty or 0', () => {
    expect(resolveSessionDriver({ env: { CLAUDECODE: '0' } }).driver).toBe('human');
    expect(resolveSessionDriver({ env: { CLAUDECODE: '' } }).driver).toBe('human');
    expect(resolveSessionDriver({ env: { AI_AGENT: '  ' } }).driver).toBe('human');
  });

  it('lets the flag beat BOOK_SESSION_DRIVER, and BOOK_SESSION_DRIVER beat the markers', () => {
    const env = { CLAUDECODE: '1', BOOK_SESSION_DRIVER: 'agent' };
    expect(resolveSessionDriver({ explicit: 'human', env })).toEqual({
      driver: 'human',
      signals: ['flag'],
    });
    expect(
      resolveSessionDriver({ env: { CLAUDECODE: '1', BOOK_SESSION_DRIVER: 'human' } }),
    ).toEqual({ driver: 'human', signals: ['BOOK_SESSION_DRIVER'] });
    expect(resolveSessionDriver({ env: { BOOK_SESSION_DRIVER: 'agent' } }).driver).toBe('agent');
  });

  it('ignores a BOOK_SESSION_DRIVER that names no driver', () => {
    expect(
      resolveSessionDriver({ env: { BOOK_SESSION_DRIVER: 'robot', CLAUDECODE: '1' } }),
    ).toEqual({ driver: 'agent', signals: ['CLAUDECODE'] });
  });
});

describe('parseSessionDriver', () => {
  it('accepts either driver in any case, with surrounding space', () => {
    expect(parseSessionDriver(' Human ')).toBe('human');
    expect(parseSessionDriver('AGENT')).toBe('agent');
    expect(parseSessionDriver('robot')).toBeUndefined();
    expect(parseSessionDriver(undefined)).toBeUndefined();
  });
});
