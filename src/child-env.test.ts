import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULTED_NODE_ENV_MARKER, buildChildEnv } from './child-env.js';

/**
 * Book defaults NODE_ENV to `production` so React loads its production renderer. That default is
 * a fact about Book's own process, not about the command a user asked for, and every child that
 * inherited it saw `npm install` drop devDependencies. The marker below is how the default is
 * told apart from a NODE_ENV the user chose.
 */
const DEFAULTED_ENV = {
  PATH: '/usr/bin',
  BOOK_DEFAULTED_NODE_ENV: '1',
  NODE_ENV: 'production',
} as NodeJS.ProcessEnv;

const USER_ENV = { PATH: '/usr/bin', NODE_ENV: 'development' } as NodeJS.ProcessEnv;

describe('buildChildEnv', () => {
  it('drops a NODE_ENV Book defaulted, and never passes the marker on', () => {
    const env = buildChildEnv(DEFAULTED_ENV);

    expect(env.PATH).toBe('/usr/bin');
    expect(env.NODE_ENV).toBeUndefined();
    expect(env[DEFAULTED_NODE_ENV_MARKER]).toBeUndefined();
  });

  it('keeps a NODE_ENV the user set before Book started', () => {
    expect(buildChildEnv(USER_ENV).NODE_ENV).toBe('development');
  });

  it('lets an explicit override win over the default Book applied', () => {
    const env = buildChildEnv(DEFAULTED_ENV, { NODE_ENV: 'test' });

    expect(env.NODE_ENV).toBe('test');
    expect(env[DEFAULTED_NODE_ENV_MARKER]).toBeUndefined();
  });

  it('keeps an explicit NODE_ENV that happens to be the value Book defaulted', () => {
    // A hook or an MCP server configured with `env: { NODE_ENV: "production" }` asked for exactly
    // what Book asked for itself. Reading the agreement as consent to drop it deletes a setting
    // the project wrote down, and the value is indistinguishable from the default by content
    // alone.
    const env = buildChildEnv(DEFAULTED_ENV, { NODE_ENV: 'production' });

    expect(env.NODE_ENV).toBe('production');
    expect(env[DEFAULTED_NODE_ENV_MARKER]).toBeUndefined();
  });

  it('drops the default when the override layer is a copy of Book’s own environment', () => {
    // The agent path hands `ToolContext.env` the ambient environment itself, so the invented
    // NODE_ENV arrives through the override layer as well. The marker is what tells those two
    // apart: an override carrying it is a copy of `process.env`, and its NODE_ENV is Book's
    // default reaching a child by a second route rather than a request for it.
    const env = buildChildEnv(DEFAULTED_ENV, { ...DEFAULTED_ENV });

    expect(env.NODE_ENV).toBeUndefined();
    expect(env[DEFAULTED_NODE_ENV_MARKER]).toBeUndefined();
  });

  it('keeps the marker from reaching the child even when it was never ours to set', () => {
    const env = buildChildEnv({ BOOK_DEFAULTED_NODE_ENV: '1' } as NodeJS.ProcessEnv);

    expect(env[DEFAULTED_NODE_ENV_MARKER]).toBeUndefined();
  });

  it('strips the marker from a caller-supplied base and a caller-supplied override alike', () => {
    const env = buildChildEnv(
      { PATH: '/usr/bin' } as NodeJS.ProcessEnv,
      { [DEFAULTED_NODE_ENV_MARKER]: '1' } as NodeJS.ProcessEnv,
    );

    expect(env[DEFAULTED_NODE_ENV_MARKER]).toBeUndefined();
  });

  it('does not reach past the overrides for a NODE_ENV the base never carried', () => {
    // The default is only recognisable through the marker: a base without
    // NODE_ENV at all is a process that never ran `runtime-env`, and whatever
    // the user set for the child is the only NODE_ENV there is.
    const env = buildChildEnv({ PATH: '/usr/bin' } as NodeJS.ProcessEnv);

    expect(env.NODE_ENV).toBeUndefined();
  });

  it('leaves an environment with nothing to remove alone', () => {
    const env = buildChildEnv(USER_ENV, { CI: '1' });

    expect(env).toEqual({ PATH: '/usr/bin', NODE_ENV: 'development', CI: '1' });
  });
});

describe('buildChildEnv against the live process environment', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it('reads process.env when no base is given', () => {
    process.env.PATH = '/usr/bin';
    process.env.BOOK_DEFAULTED_NODE_ENV = '1';
    process.env.NODE_ENV = 'production';

    const env = buildChildEnv();

    expect(env.PATH).toBe('/usr/bin');
    expect(env.NODE_ENV).toBeUndefined();
    expect(env[DEFAULTED_NODE_ENV_MARKER]).toBeUndefined();
  });

  it('reads the ambient environment as the override layer when that is what a caller has', () => {
    // `ToolContext.env` is `process.env` in the agent, and `spec.env` in a persistent job is a
    // snapshot of it taken at spawn time, so both look exactly like a layer that restates the
    // default without having chosen it.
    process.env.PATH = '/usr/bin';
    process.env.BOOK_DEFAULTED_NODE_ENV = '1';
    process.env.NODE_ENV = 'production';

    expect(buildChildEnv(process.env, { ...process.env }).NODE_ENV).toBeUndefined();
  });
});
