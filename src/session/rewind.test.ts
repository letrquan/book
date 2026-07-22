import { appendFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CompactRecordData,
  RewindRecordData,
  SessionRecord,
  TurnCheckpointRecordData,
} from '../types/sessions.js';
import type { Message } from '../types/messages.js';
import { SessionStore } from './store.js';

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'book-session-rewind-'));
  roots.push(root);
  const store = new SessionStore(root);
  const id = store.create({ cwd: root });
  return { store, id };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function user(store: SessionStore, id: string, eventId: string, content: string) {
  store.append(id, {
    type: 'user',
    eventId,
    timestamp: Date.now(),
    data: { id: eventId, content, kind: 'conversation' },
  });
}

function assistant(store: SessionStore, id: string, eventId: string, content: string) {
  store.append(id, {
    type: 'assistant',
    eventId,
    timestamp: Date.now(),
    data: { id: eventId, content, complete: true, kind: 'conversation' },
  });
}

function checkpoint(
  store: SessionStore,
  id: string,
  checkpointId: string,
  userEventId: string,
  prompt: string,
  snapshotId?: string,
) {
  store.append(id, {
    type: 'turn_checkpoint',
    eventId: checkpointId,
    timestamp: Date.now(),
    data: {
      version: 1,
      checkpointId,
      userEventId,
      prompt,
      checkpoint: snapshotId
        ? { snapshotId, gitHead: 'head', entryCount: 1, logicalBytes: 1 }
        : { codeUnavailableReason: 'capture failed' },
    } satisfies TurnCheckpointRecordData,
  });
}

function rewind(
  store: SessionStore,
  id: string,
  targetId: string,
  targetUserEventId: string,
  action: RewindRecordData['action'],
) {
  store.append(id, {
    type: 'rewind',
    eventId: crypto.randomUUID(),
    timestamp: Date.now(),
    data: { version: 1, action, targetId, targetUserEventId } satisfies RewindRecordData,
  });
}

function compact(store: SessionStore, id: string, eventId: string, content: string) {
  const replacement: Message = {
    id: `${eventId}-summary`,
    role: 'assistant',
    content,
    includeInContext: true,
    kind: 'checkpoint',
    timestamp: Date.now(),
  };
  store.append(id, {
    type: 'compact',
    eventId,
    timestamp: Date.now(),
    data: {
      version: 1,
      trigger: 'manual',
      summary: content,
      replacementHistory: [replacement],
    } satisfies CompactRecordData,
  });
}

describe('session rewind replay', () => {
  it('offers conversation-only targets for legacy sessions', () => {
    const { store, id } = fixture();
    user(store, id, 'u1', 'legacy prompt');
    assistant(store, id, 'a1', 'legacy answer');

    const target = store.listRewindTargets(id)[0];
    expect(target).toMatchObject({
      id: 'user:u1',
      prompt: 'legacy prompt',
      codeAvailable: false,
    });

    rewind(store, id, target.id, target.userEventId, 'conversation');
    expect(store.load(id).transcript).toEqual([]);
  });

  it('restores the active branch and excludes abandoned events from history tools', () => {
    const { store, id } = fixture();
    user(store, id, 'u1', 'first prompt');
    assistant(store, id, 'a1', 'first answer');
    checkpoint(store, id, 'cp2', 'u2', 'second prompt', 'snapshot-2');
    user(store, id, 'u2', 'second prompt');
    assistant(store, id, 'a2', 'second answer with abandoned needle');
    compact(store, id, 'compact-after-second', 'summary after second');
    checkpoint(store, id, 'cp3', 'u3', 'third prompt', 'snapshot-3');
    user(store, id, 'u3', 'third prompt');
    assistant(store, id, 'a3', 'third answer');

    rewind(store, id, 'cp2', 'u2', 'conversation');
    checkpoint(store, id, 'cp4', 'u4', 'new branch prompt', 'snapshot-4');
    user(store, id, 'u4', 'new branch prompt');
    assistant(store, id, 'a4', 'new branch answer');

    const loaded = store.load(id);
    expect(loaded.transcript.map((message) => message.id)).toEqual(['u1', 'a1', 'u4', 'a4']);
    expect(loaded.contextHistory.map((message) => message.id)).toEqual(['u1', 'a1', 'u4', 'a4']);
    expect(loaded.compactBoundaries).toEqual([]);
    expect(loaded.rewindTargets.map((target) => target.id)).toEqual(['cp4', 'user:u1']);
    expect(loaded.meta.messageCount).toBe(4);
    expect(loaded.activeEventIds).not.toContain('a2');
    expect(store.searchCurrent(id, 'abandoned needle')).toEqual([]);
    expect(store.searchCurrent(id, 'first answer')).toHaveLength(1);
    expect(() => store.readCurrent(id, ['session://current/event/a2'])).toThrow(
      'Unknown session history reference',
    );
  });

  it('keeps provider compaction state captured before the selected prompt', () => {
    const { store, id } = fixture();
    user(store, id, 'u1', 'first');
    assistant(store, id, 'a1', 'answer');
    compact(store, id, 'compact-before', 'summary before selected');
    checkpoint(store, id, 'cp2', 'u2', 'second', 'snapshot-2');
    user(store, id, 'u2', 'second');
    assistant(store, id, 'a2', 'answer two');
    compact(store, id, 'compact-after', 'summary after selected');

    rewind(store, id, 'cp2', 'u2', 'conversation');
    const loaded = store.load(id);

    expect(loaded.transcript.map((message) => message.id)).toEqual(['u1', 'a1']);
    expect(loaded.contextHistory.map((message) => message.content)).toEqual([
      'summary before selected',
    ]);
    expect(loaded.compactBoundaries).toHaveLength(1);
    expect(loaded.compactBoundaries[0].id).toBe('compact-before');
  });

  it('retains the conversation for code-only records and supports repeated branch rewinds', () => {
    const { store, id } = fixture();
    checkpoint(store, id, 'cp1', 'u1', 'one', 'snapshot-1');
    user(store, id, 'u1', 'one');
    assistant(store, id, 'a1', 'answer one');
    checkpoint(store, id, 'cp2', 'u2', 'two', 'snapshot-2');
    user(store, id, 'u2', 'two');
    assistant(store, id, 'a2', 'answer two');

    rewind(store, id, 'cp1', 'u1', 'code');
    expect(store.load(id).transcript.map((message) => message.id)).toEqual([
      'u1',
      'a1',
      'u2',
      'a2',
    ]);

    rewind(store, id, 'cp2', 'u2', 'conversation');
    checkpoint(store, id, 'cp3', 'u3', 'three', 'snapshot-3');
    user(store, id, 'u3', 'three');
    rewind(store, id, 'cp3', 'u3', 'conversation');
    expect(store.load(id).transcript.map((message) => message.id)).toEqual(['u1', 'a1']);
  });

  it('ignores malformed and inactive rewind records', () => {
    const { store, id } = fixture();
    user(store, id, 'u1', 'one');
    assistant(store, id, 'a1', 'answer');
    store.append(id, {
      type: 'rewind',
      eventId: 'bad-rewind',
      timestamp: Date.now(),
      data: { version: 99, action: 'conversation', targetId: 'missing' },
    } as SessionRecord);
    appendFileSync(join(roots.at(-1)!, `${id}.jsonl`), '{not valid json}\n');

    expect(store.load(id).transcript.map((message) => message.id)).toEqual(['u1', 'a1']);
  });
});
