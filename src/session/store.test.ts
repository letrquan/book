import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SessionStore } from './store.js';
import { appendFileSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-sess-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SessionStore', () => {
  it('stores and verifies session-owned image attachments', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    const attachment = s.saveImageAttachment(id, {
      bytes: Uint8Array.from([1, 2, 3]),
      mediaType: 'image/png',
      displayName: 'clipboard.png',
    });
    expect(s.readImageAttachment(id, attachment)).toEqual(Uint8Array.from([1, 2, 3]));
    expect(attachment.storageKey).toMatch(/\.png$/);

    s.append(id, {
      type: 'user',
      timestamp: 1,
      data: { content: 'describe', attachments: [attachment] },
    });
    expect(s.load(id).history[0].attachments).toEqual([attachment]);

    const forkId = s.fork(id, { cwd: '/proj' });
    expect(s.readImageAttachment(forkId, attachment)).toEqual(Uint8Array.from([1, 2, 3]));
  });

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

  it('preserves stable event ids and keeps local records transcript-only', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    s.append(id, {
      type: 'user',
      eventId: 'user-1',
      timestamp: 1,
      data: { id: 'user-1', content: 'visible' },
    });
    s.append(id, {
      type: 'local',
      eventId: 'local-1',
      timestamp: 2,
      data: { id: 'local-1', content: 'local report' },
    });

    const loaded = s.load(id);
    expect(loaded.transcript.map((message) => message.id)).toEqual(['user-1', 'local-1']);
    expect(loaded.contextHistory.map((message) => message.id)).toEqual(['user-1']);
    expect(loaded.transcript[1]).toMatchObject({ kind: 'local', includeInContext: false });
  });

  it('ignores malformed compact records without changing context or boundaries', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    s.append(id, { type: 'user', eventId: 'u1', timestamp: 1, data: { content: 'keep me' } });
    s.append(id, {
      type: 'compact',
      eventId: 'bad',
      timestamp: 2,
      data: { version: 2, replacementHistory: [] },
    });

    const loaded = s.load(id);
    expect(loaded.contextHistory.map((message) => message.content)).toEqual(['keep me']);
    expect(loaded.compactBoundaries).toEqual([]);
  });

  it('searches and reads compacted-away current-session evidence with bounded references', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    s.append(id, {
      type: 'assistant',
      eventId: 'a1',
      timestamp: 1,
      data: {
        complete: true,
        content: 'inspected authentication',
        toolCalls: [{ id: 't1', name: 'Read', arguments: { filePath: 'src/auth.ts' } }],
        toolResults: [{ toolCallId: 't1', success: true, output: 'secret evidence' }],
      },
    });

    expect(s.searchCurrent(id, 'auth')).toMatchObject([
      { ref: 'session://current/event/a1', role: 'assistant' },
    ]);
    expect(s.readCurrent(id, ['session://current/tool-result/a1/t1'])[0].content).toContain(
      'secret evidence',
    );
    expect(() => s.readCurrent(id, ['session://another/event/a1'])).toThrow(/current/);
  });

  it('searches provider-facing context content as well as displayed content', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    s.append(id, {
      type: 'user',
      eventId: 'u1',
      timestamp: 1,
      data: {
        content: 'Explain @src/auth.ts',
        contextContent: 'Explain the expanded file containing unique_provider_evidence',
      },
    });

    expect(s.searchCurrent(id, 'unique_provider_evidence')).toMatchObject([
      { ref: 'session://current/event/u1', role: 'user' },
    ]);
  });

  it('does not expose provider reasoning through history search or read', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    s.append(id, {
      type: 'assistant',
      eventId: 'reasoning-1',
      timestamp: 1,
      data: { complete: true, content: 'answer', reasoningContent: 'secret internal thought' },
    });

    expect(s.searchCurrent(id, 'secret internal thought')).toEqual([]);
    expect(s.readCurrent(id, ['session://current/event/reasoning-1'])[0].content).not.toContain(
      'secret internal thought',
    );
  });

  it('marks a copied fork as recently updated', () => {
    const s = new SessionStore(dir);
    const sourceId = s.create({ cwd: '/proj' });
    s.append(sourceId, { type: 'user', eventId: 'old', timestamp: 1, data: { content: 'old' } });
    const beforeFork = Date.now();

    const forkId = s.fork(sourceId, { cwd: '/proj' });

    expect(s.load(forkId).meta.updatedAt).toBeGreaterThanOrEqual(beforeFork);
    expect(s.load(forkId).transcript[0].id).toBe('old');
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
    expect(loaded.transcript.map((message) => message.content)).toEqual([
      'old1',
      'old2',
      'next',
      'ok',
    ]);
    expect(loaded.compactBoundaries).toHaveLength(1);
    expect(loaded.meta.messageCount).toBe(4);
  });

  it('loads legacy conversation records as included context', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    s.append(id, { type: 'user', timestamp: 1, data: { content: 'legacy prompt' } });
    s.append(id, {
      type: 'assistant',
      timestamp: 2,
      data: { content: 'legacy answer', complete: true },
    });

    const loaded = s.load(id);

    expect(loaded.history.map((message) => message.includeInContext)).toEqual([true, true]);
  });

  it('preserves explicit context inclusion on compact replacement history', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    s.append(id, {
      type: 'compact',
      timestamp: 1,
      data: {
        version: 1,
        trigger: 'manual',
        summary: 'summary',
        replacementHistory: [
          {
            id: 'local',
            role: 'assistant',
            content: 'local-only',
            includeInContext: false,
            timestamp: 1,
          },
          {
            id: 'summary',
            role: 'user',
            content: 'included summary',
            includeInContext: true,
            timestamp: 1,
          },
        ],
      },
    });

    const loaded = s.load(id);

    expect(loaded.history.map((message) => message.includeInContext)).toEqual([false, true]);
  });

  it('round-trips degraded V2 compact metadata without rewriting old checkpoints', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    const checkpoint = {
      version: 2 as const,
      generation: 2,
      state: { summary: 'Reduced fidelity', status: 'unknown' as const },
      constraints: [],
      files: [],
      episodes: [],
      openThreads: [],
      statistics: { summarizedMessages: 4, retainedMessages: 0, preTokens: 900, postTokens: 100 },
      coverage: {
        status: 'degraded' as const,
        reasons: ['pass-limit' as const],
        processedMessages: 3,
        omittedMessages: 1,
        partiallyProcessedMessages: 0,
      },
    };
    s.append(id, {
      type: 'compact',
      eventId: 'compact-2',
      timestamp: 3,
      data: {
        version: 2,
        compactId: 'compact-2',
        generation: 2,
        trigger: 'auto',
        checkpoint,
        summary: 'Reduced fidelity',
        replacementHistory: [
          {
            id: 'checkpoint-2',
            role: 'user',
            content: JSON.stringify(checkpoint),
            includeInContext: true,
            kind: 'checkpoint',
            timestamp: 3,
          },
        ],
        boundary: {
          id: 'compact-2',
          trigger: 'auto',
          transcriptOrdinal: 0,
          preContextCount: 4,
          postContextCount: 1,
          preContextTokens: 900,
          postContextTokens: 100,
          generation: 2,
          checkpointVersion: 2,
          timestamp: 3,
        },
        summarizedCount: 4,
        retainedCount: 0,
        strategy: 'multi-pass',
        modelCalls: 15,
        degraded: true,
        warning: 'Exact history remains searchable.',
      },
    });

    const records = s.readRecords(id);
    const compact = records.at(-1)?.data as Record<string, unknown>;
    expect(compact).toMatchObject({
      strategy: 'multi-pass',
      modelCalls: 15,
      degraded: true,
      warning: 'Exact history remains searchable.',
    });
    expect(s.load(id).contextHistory[0].kind).toBe('checkpoint');
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

  it('lists indexed metadata without replaying session transcripts', () => {
    const writer = new SessionStore(dir);
    const id = writer.create({ cwd: '/proj', name: 'indexed' });
    writer.append(id, { type: 'user', timestamp: 10, data: { content: 'hello' } });
    appendFileSync(join(dir, `${id}.jsonl`), '{malformed json that listing must not parse}\n');

    const reader = new SessionStore(dir);

    expect(reader.list()).toEqual([
      expect.objectContaining({ id, name: 'indexed', updatedAt: 10, messageCount: 1 }),
    ]);
  });

  it('builds a persistent metadata index for legacy session files', () => {
    const id = 'legacy-session';
    writeFileSync(
      join(dir, `${id}.jsonl`),
      [
        JSON.stringify({
          type: 'session_meta',
          timestamp: 1,
          data: {
            kind: 'session_meta',
            id,
            cwd: '/proj',
            createdAt: 1,
            updatedAt: 1,
            messageCount: 0,
          },
        }),
        JSON.stringify({ type: 'user', timestamp: 2, data: { content: 'legacy prompt' } }),
        '',
      ].join('\n'),
    );

    const store = new SessionStore(dir);

    expect(store.list()[0]).toMatchObject({
      id,
      name: 'Legacy prompt',
      updatedAt: 2,
      messageCount: 1,
    });
    expect(existsSync(join(dir, 'session-index.json'))).toBe(true);
  });

  it('collects rewind snapshot references from indexed metadata', () => {
    const writer = new SessionStore(dir);
    const id = writer.create({ cwd: '/proj' });
    writer.append(id, {
      type: 'turn_checkpoint',
      timestamp: 2,
      data: {
        version: 1,
        checkpointId: 'checkpoint-1',
        userEventId: 'user-1',
        prompt: 'prompt',
        checkpoint: { snapshotId: 'snapshot-1' },
      },
    });
    appendFileSync(join(dir, `${id}.jsonl`), '{malformed}\n');

    const reader = new SessionStore(dir);

    expect(reader.listSnapshotReferences('/proj')).toEqual(new Set(['snapshot-1']));
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

  it('derives a display name for legacy sessions without name metadata', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    s.append(id, {
      type: 'user',
      timestamp: 1,
      data: { content: 'investigate legacy session labels' },
    });

    expect(s.load(id).meta.name).toBe('Investigate legacy session labels');
    expect(s.findByName('Investigate legacy session labels')?.id).toBe(id);
  });

  it('applies append-only metadata patches without counting them as messages', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    s.patchMeta(id, { name: 'named-later' });
    const loaded = s.load(id);
    expect(loaded.meta.name).toBe('named-later');
    expect(loaded.meta.messageCount).toBe(0);
  });

  it('replays complete assistant turns with file mutation metadata', () => {
    const s = new SessionStore(dir);
    const id = s.create({ cwd: '/proj' });
    const diff = '@@ -1 +1 @@\n-old\n+new';
    s.append(id, {
      type: 'assistant',
      timestamp: 2,
      data: {
        complete: true,
        content: 'done',
        toolCalls: [{ id: 'tc1', name: 'Edit', arguments: { filePath: 'a.ts' } }],
        toolResults: [
          {
            toolCallId: 'tc1',
            success: true,
            output: diff,
            fileMutation: {
              kind: 'update',
              filePath: 'a.ts',
              addedLines: 1,
              removedLines: 1,
            },
            fileMutations: [
              { kind: 'update', filePath: 'a.ts', addedLines: 1, removedLines: 1 },
              { kind: 'create', filePath: 'b.ts', addedLines: 2, removedLines: 0 },
            ],
          },
        ],
      },
    });
    const assistant = s.load(id).history[0];
    expect(assistant.toolCalls?.[0].name).toBe('Edit');
    expect(assistant.toolResults?.[0]).toMatchObject({
      version: 2,
      status: 'success',
      content: diff,
      artifacts: {
        fileMutation: {
          kind: 'update',
          filePath: 'a.ts',
          addedLines: 1,
          removedLines: 1,
        },
        fileMutations: [
          { kind: 'update', filePath: 'a.ts', addedLines: 1, removedLines: 1 },
          { kind: 'create', filePath: 'b.ts', addedLines: 2, removedLines: 0 },
        ],
      },
    });
    expect(assistant.toolResults?.[0]).not.toHaveProperty('success');
    expect(assistant.toolResults?.[0]).not.toHaveProperty('output');
    expect(assistant.toolResults?.[0]).not.toHaveProperty('fileMutation');
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

  it('preserves the active session even when its previous activity is beyond retention', () => {
    const s = new SessionStore(dir);
    const active = s.create({ cwd: '/proj' });
    s.append(active, { type: 'user', timestamp: Date.now() - 40 * 86400_000, data: {} });

    expect(s.cleanup(30, new Set([active]))).toBe(0);
    expect(existsSync(join(dir, `${active}.jsonl`))).toBe(true);
  });
});
