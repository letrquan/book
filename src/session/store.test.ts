import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from './store.js';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-sess-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SessionStore', () => {
  it('creates a session with a uuid id', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj', name: 'my-feature' });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('appends records to the session jsonl file', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    s.append(id, { type: 'user', timestamp: 1, data: { content: 'hi' } });
    s.append(id, { type: 'assistant', timestamp: 2, data: { content: 'hello' } });
    const raw = readFileSync(join(dir, `${id}.jsonl`), 'utf-8');
    expect(raw.split('\n').filter(Boolean).length).toBe(3); // meta + 2 records
  });

  it('loads a session and replays records into history', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    s.append(id, { type: 'user', timestamp: 1, data: { content: 'hi' } });
    s.append(id, { type: 'assistant', timestamp: 2, data: { content: 'hello' } });
    const loaded = s.load(id);
    expect(loaded.history.length).toBe(2);
    expect(loaded.history[0].role).toBe('user');
    expect(loaded.history[0].content).toBe('hi');
    expect(loaded.history[1].role).toBe('assistant');
    expect(loaded.history[1].content).toBe('hello');
  });

  it('replaces history atomically on a compact record', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    s.append(id, { type: 'user', timestamp: 1, data: { content: 'old1' } });
    s.append(id, { type: 'assistant', timestamp: 2, data: { content: 'old2', complete: true } });
    s.append(id, {
      type: 'compact',
      timestamp: 3,
      data: {
        version: 1,
        trigger: 'manual',
        summary: 'all the old stuff',
        replacementHistory: [
          {
            id: 'sum',
            role: 'user',
            content: '[Compacted summary of earlier conversation]\nall the old stuff',
            timestamp: 3,
          },
        ],
      },
    });
    s.append(id, { type: 'user', timestamp: 4, data: { content: 'next' } });
    s.append(id, {
      type: 'assistant',
      timestamp: 5,
      data: { content: 'ok', complete: true },
    });

    const loaded = s.load(id);
    expect(loaded.history.length).toBe(3);
    expect(loaded.history[0].content).toMatch(/Compacted summary/);
    expect(loaded.history[1].content).toBe('next');
    expect(loaded.history[2].content).toBe('ok');
    expect(loaded.meta.messageCount).toBe(3);
  });

  it('preserves hidden context content for resumed user messages', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    s.append(id, {
      type: 'user',
      timestamp: 1,
      data: {
        content: 'Explain @src/app.ts',
        contextContent: 'Explain\nContents of src/app.ts:\n```\nexport {};\n```',
      },
    });

    const loaded = s.load(id);

    expect(loaded.history[0].content).toBe('Explain @src/app.ts');
    expect(loaded.history[0].contextContent).toContain('Contents of src/app.ts:');
  });

  it('append does NOT rewrite the whole file per event (append-only)', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    s.append(id, { type: 'user', timestamp: 5, data: { content: 'a' } });
    const afterFirstAppend = readFileSync(join(dir, `${id}.jsonl`), 'utf-8');
    // append() only appends — it never reads or rewrites the file.
    const headerBefore = afterFirstAppend.split('\n')[0];
    s.append(id, { type: 'assistant', timestamp: 6, data: { content: 'b' } });
    s.append(id, { type: 'assistant', timestamp: 7, data: { content: 'c' } });
    const headerAfter = readFileSync(join(dir, `${id}.jsonl`), 'utf-8').split('\n')[0];
    expect(headerAfter).toBe(headerBefore);
    // Records still all present.
    expect(
      readFileSync(join(dir, `${id}.jsonl`), 'utf-8')
        .split('\n')
        .filter(Boolean).length,
    ).toBe(4);
    // load() derives updatedAt from the last record's timestamp.
    const loaded = s.load(id);
    expect(loaded.meta.updatedAt).toBe(7);
  });

  it('lists sessions sorted by updatedAt desc', () => {
    const s = new SessionStore(dir);
    const a = s.create({ cwd: '/proj' });
    s.append(a, { type: 'user', timestamp: 1, data: { content: 'a' } });
    const b = s.create({ cwd: '/proj' });
    s.append(b, { type: 'user', timestamp: 2, data: { content: 'b' } });
    const list = s.list();
    expect(list[0].id).toBe(b);
    expect(list[1].id).toBe(a);
  });

  it('finds most recent session in a cwd (--continue)', () => {
    const s = new SessionStore(dir);
    const a = s.create({ cwd: '/proj' });
    s.append(a, { type: 'user', timestamp: 1, data: { content: 'a' } });
    const b = s.create({ cwd: '/other' });
    s.append(b, { type: 'user', timestamp: 2, data: { content: 'b' } });
    expect(s.mostRecentInCwd('/proj')?.id).toBe(a);
    expect(s.mostRecentInCwd('/other')?.id).toBe(b);
    expect(s.mostRecentInCwd('/none')).toBeUndefined();
  });

  it('looks up by name', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj', name: 'feature-x' });
    s.append(id, { type: 'user', timestamp: 1, data: { content: 'a' } });
    expect(s.findByName('feature-x')?.id).toBe(id);
  });

  it('applies append-only metadata patches without counting them as messages', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    s.patchMeta(id, { name: 'named-later' });
    const loaded = s.load(id);
    expect(loaded.meta.name).toBe('named-later');
    expect(loaded.meta.messageCount).toBe(0);
  });

  it('replays complete assistant turns with tool metadata', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    s.append(id, {
      type: 'assistant',
      timestamp: 2,
      data: {
        complete: true,
        content: 'done',
        toolCalls: [{ id: 'tc1', name: 'Read', arguments: { filePath: 'a.ts' } }],
        toolResults: [{ toolCallId: 'tc1', success: true, output: 'ok' }],
      },
    });
    const assistant = s.load(id).history[0];
    expect(assistant.toolCalls?.[0].name).toBe('Read');
    expect(assistant.toolResults?.[0].output).toBe('ok');
  });

  it('touches a session without adding a message', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    s.touch(id);
    expect(s.load(id).meta.messageCount).toBe(0);
  });

  it('normalizes workspace paths for continue lookup', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: join(dir, 'project', '..', 'project') });
    expect(s.mostRecentInCwd(join(dir, 'project'))?.id).toBe(id);
  });

  it('deletes sessions older than cleanupPeriodDays', () => {
    const s = new SessionStore(dir);
    const old = s.create({ cwd: '/proj' });
    s.append(old, { type: 'user', timestamp: Date.now() - 40 * 86400_000, data: {} });
    const fresh = s.create({ cwd: '/proj' });
    s.append(fresh, { type: 'user', timestamp: Date.now(), data: {} });
    const removed = s.cleanup(30);
    expect(removed).toBe(1);
    expect(existsSync(join(dir, `${old}.jsonl`))).toBe(false);
    expect(existsSync(join(dir, `${fresh}.jsonl`))).toBe(true);
  });
});
