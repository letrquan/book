import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from './store.js';
import { resolveSessionBootstrap, selectSession } from './resolve.js';

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
