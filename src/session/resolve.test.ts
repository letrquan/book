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

  it('forks the ordered event stream with transcript, context, locals, and boundaries', () => {
    const id = store.create({ cwd: '/proj' });
    store.append(id, { type: 'user', eventId: 'old', timestamp: 1, data: { content: 'copied' } });
    store.append(id, {
      type: 'local',
      eventId: 'local',
      timestamp: 2,
      data: { kind: 'local', role: 'assistant', content: 'local output' },
    });
    store.append(id, {
      type: 'compact',
      eventId: 'boundary',
      timestamp: 3,
      data: {
        version: 1,
        trigger: 'manual',
        summary: 'summary',
        replacementHistory: [
          {
            id: 'summary',
            role: 'user',
            content: 'summary',
            includeInContext: true,
            timestamp: 3,
          },
        ],
      },
    });
    store.append(id, { type: 'user', eventId: 'later', timestamp: 4, data: { content: 'later' } });

    const result = resolveSessionBootstrap(store, {
      cwd: '/proj',
      resume: id,
      forkSession: true,
    });
    expect(result.sessionId).not.toBe(id);
    expect(result.history.map((message) => message.content)).toEqual(['summary', 'later']);
    expect(result.contextHistory).toBe(result.history);
    expect(result.transcript?.map((message) => message.content)).toEqual([
      'copied',
      'local output',
      'later',
    ]);
    expect(result.compactBoundaries).toHaveLength(1);
    expect(store.readEvents(result.sessionId).map((event) => event.eventId)).toEqual([
      'old',
      'local',
      'boundary',
      'later',
    ]);
  });

  it('uses an ephemeral id when persistence is disabled', () => {
    const result = resolveSessionBootstrap(undefined, { cwd: '/proj' });
    expect(result.persisted).toBe(false);
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);
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
