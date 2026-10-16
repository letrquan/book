import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from './store.js';
import { discardUntouchedSession, resolveSessionBootstrap, selectSession } from './resolve.js';

let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-resolve-'));
  store = new SessionStore(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('resolveSessionBootstrap', () => {
  it('creates a fresh persisted session', () => {
    const result = resolveSessionBootstrap(store, { cwd: '/proj', sessionName: 'work' });
    expect(result.persisted).toBe(true);
    expect(result.source).toBe('startup');
    expect(store.load(result.sessionId).meta.name).toBe('work');
  });

  it('records the driver on a session it creates or forks', () => {
    const created = resolveSessionBootstrap(store, { cwd: '/proj', driver: 'human' });
    expect(store.findById(created.sessionId)?.driver).toBe('human');
    const byHuman = resolveSessionBootstrap(store, {
      cwd: '/proj',
      resume: created.sessionId,
      forkSession: true,
      driver: 'human',
    });
    expect(store.findById(byHuman.sessionId)?.driver).toBe('human');
    const byAgent = resolveSessionBootstrap(store, {
      cwd: '/proj',
      resume: created.sessionId,
      forkSession: true,
      driver: 'agent',
    });
    expect(store.findById(byAgent.sessionId)?.driver).toBe('agent');
  });

  it('keeps a fork of an agent-driven session agent-driven, whoever forks it', () => {
    // The fork carries every delegated turn; a human fork would hand them to extraction.
    const id = store.create({ cwd: '/proj', name: 'delegated', driver: 'agent' });
    const forked = resolveSessionBootstrap(store, {
      cwd: '/proj',
      resume: 'delegated',
      forkSession: true,
      driver: 'human',
    });
    expect(forked.sessionId).not.toBe(id);
    expect(store.findById(forked.sessionId)?.driver).toBe('agent');
  });

  it('marks a session agent-driven once an agent resumes it, and never back', () => {
    // A delegator resuming a session the user started writes the turns that follow; extraction
    // must stop reading that session as the user's.
    const id = store.create({ cwd: '/proj', name: 'typed', driver: 'human' });
    resolveSessionBootstrap(store, { cwd: '/proj', resume: 'typed', driver: 'agent' });
    expect(store.findById(id)?.driver).toBe('agent');
    resolveSessionBootstrap(store, { cwd: '/proj', resume: 'typed', driver: 'human' });
    expect(store.findById(id)?.driver).toBe('agent');
  });

  it('resumes by name', () => {
    const id = store.create({ cwd: '/proj', name: 'feature' });
    store.append(id, { type: 'user', timestamp: 1, data: { content: 'remember me' } });

    const result = resolveSessionBootstrap(store, { cwd: '/proj', resume: 'feature' });
    expect(result.sessionId).toBe(id);
    expect(result.history[0].content).toBe('remember me');
    expect(result.source).toBe('resume');
    expect(result.created).toBe(false);
  });

  it('reuses a named session when only --name is supplied', () => {
    const id = store.create({ cwd: '/proj', name: 'feature' });
    store.append(id, { type: 'user', timestamp: 1, data: { content: 'remember me' } });

    const result = resolveSessionBootstrap(store, { cwd: '/proj', sessionName: 'feature' });
    expect(result.sessionId).toBe(id);
    expect(result.history[0].content).toBe('remember me');
    expect(result.created).toBe(false);
  });

  it('scopes id-prefix resume to the current workspace', () => {
    const prefix = '12345678';
    const local = store.create({ cwd: '/proj', id: `${prefix}-aaaa` });
    store.create({ cwd: '/other', id: `${prefix}-bbbb` });

    expect(resolveSessionBootstrap(store, { cwd: '/proj', resume: prefix }).sessionId).toBe(local);
  });

  it('forks resumed history into a durable new session', () => {
    const id = store.create({ cwd: '/proj' });
    store.append(id, { type: 'user', timestamp: 1, data: { content: 'copied' } });

    const result = resolveSessionBootstrap(store, {
      cwd: '/proj',
      resume: id,
      forkSession: true,
    });
    expect(result.sessionId).not.toBe(id);
    expect(store.load(result.sessionId).history[0].content).toBe('copied');
  });

  it('--continue starts fresh when every session in the folder is empty (#428)', () => {
    const empties = [store.create({ cwd: '/proj' }), store.create({ cwd: '/proj' })];

    const result = resolveSessionBootstrap(store, { cwd: '/proj', continue: true });

    expect(result.created).toBe(true);
    expect(empties).not.toContain(result.sessionId);
  });

  it('uses an ephemeral id when persistence is disabled', () => {
    const result = resolveSessionBootstrap(undefined, { cwd: '/proj' });
    expect(result.persisted).toBe(false);
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('preserves an explicit ephemeral id when persistence is disabled', () => {
    const result = resolveSessionBootstrap(undefined, {
      cwd: '/proj',
      sessionId: 'ephemeral-session',
    });
    expect(result.sessionId).toBe('ephemeral-session');
    expect(result.persisted).toBe(false);
  });
});

describe('selectSession', () => {
  it('selects a unique id prefix', () => {
    const id = store.create({ cwd: '/proj' });
    expect(selectSession(store, id.slice(0, 8)).id).toBe(id);
  });

  it('throws for missing selectors', () => {
    expect(() => selectSession(store, 'missing')).toThrow('Session not found');
  });
});

describe('discardUntouchedSession (#444)', () => {
  it('removes a session the launch created and never wrote to: no file, no index entry', () => {
    const launch = resolveSessionBootstrap(store, { cwd: '/proj' });
    expect(launch.created).toBe(true);
    expect(existsSync(join(dir, `${launch.sessionId}.jsonl`))).toBe(true);

    expect(discardUntouchedSession(store, launch)).toBe(true);

    expect(existsSync(join(dir, `${launch.sessionId}.jsonl`))).toBe(false);
    const index = JSON.parse(readFileSync(join(dir, 'session-index.json'), 'utf-8')) as {
      sessions: Record<string, unknown>;
    };
    expect(Object.keys(index.sessions)).toEqual([]);
    expect(store.list()).toEqual([]);
  });

  it('keeps a launch that recorded one prompt', () => {
    const launch = resolveSessionBootstrap(store, { cwd: '/proj' });
    store.append(launch.sessionId, { type: 'user', timestamp: 2, data: { content: 'hello' } });

    expect(discardUntouchedSession(store, launch)).toBe(false);
    expect(store.findById(launch.sessionId)?.messageCount).toBe(1);
  });

  it('keeps state a hook wrote after the bootstrap', () => {
    const launch = resolveSessionBootstrap(store, { cwd: '/proj' });
    store.patchMeta(launch.sessionId, { driver: 'agent' });

    expect(discardUntouchedSession(store, launch)).toBe(false);
    expect(existsSync(join(dir, `${launch.sessionId}.jsonl`))).toBe(true);
  });

  it('never removes a resumed or continued session, however empty', () => {
    const id = store.create({ cwd: '/proj', name: 'earlier' });
    const resumed = resolveSessionBootstrap(store, { cwd: '/proj', resume: 'earlier' });
    expect(resumed).toMatchObject({ sessionId: id, created: false });

    expect(discardUntouchedSession(store, resumed)).toBe(false);
    expect(existsSync(join(dir, `${id}.jsonl`))).toBe(true);
  });

  it('keeps a launch named with --name that never sent a prompt', () => {
    const launch = resolveSessionBootstrap(store, { cwd: '/proj', sessionName: 'release-work' });

    expect(discardUntouchedSession(store, launch)).toBe(false);
    expect(store.findByName('release-work')?.id).toBe(launch.sessionId);
  });

  it('does nothing without a store, and keeps everything in a store that cannot remove', () => {
    const launch = resolveSessionBootstrap(store, { cwd: '/proj' });
    expect(discardUntouchedSession(undefined, launch)).toBe(false);
    // An SDK caller's own store may not know how to remove a session.
    const bare = { create: () => 'x' };
    expect(discardUntouchedSession(bare as never, launch)).toBe(false);
    expect(existsSync(join(dir, `${launch.sessionId}.jsonl`))).toBe(true);
  });

  it('never throws from the exit path', () => {
    const launch = resolveSessionBootstrap(store, { cwd: '/proj' });
    const failing = {
      removeUntouched: () => {
        throw Object.assign(new Error('locked'), { code: 'EPERM' });
      },
    };

    expect(() => discardUntouchedSession(failing as never, launch)).not.toThrow();
    expect(discardUntouchedSession(failing as never, launch)).toBe(false);
  });
});
