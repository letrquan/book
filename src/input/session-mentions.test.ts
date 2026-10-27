import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mentionNamesPath } from './input-expansion.js';
import { findActiveFileMention } from './file-mentions.js';
import {
  findSessionMentions,
  replaceActiveSessionMention,
  SessionMentionSnapshot,
  sessionMentionCandidates,
} from './session-mentions.js';
import type { PeerSessionListing, PeerSessionRow } from '../types/messaging.js';

let workspace: string;

beforeEach(() => {
  workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-session-mentions-')));
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

const names = (input: string) =>
  findSessionMentions(input).map(({ name, ref }) => (ref ? { name, ref } : { name }));

describe('findSessionMentions (#620)', () => {
  it('reads @name and @name [ref], with or without the space before the ref', () => {
    expect(names('ask @book-36 to run the tests')).toEqual([{ name: 'book-36' }]);
    expect(names('ask @book-36 [A1B2C3] to run them')).toEqual([
      { name: 'book-36', ref: 'a1b2c3' },
    ]);
    expect(names('ask @book-36[a1b2c3], then stop')).toEqual([{ name: 'book-36', ref: 'a1b2c3' }]);
    // The token's own path, which a file would be inlined by.
    expect(findSessionMentions('ask @book-36[a1b2c3]')[0].path).toBe('book-36[a1b2c3]');
  });

  it('reads a quoted name, and leaves trailing punctuation off the name', () => {
    expect(names('tell @"night shift" [0f0f0f] hi')).toEqual([
      { name: 'night shift', ref: '0f0f0f' },
    ]);
    expect(names('is @book-36, or @peer.')).toEqual([{ name: 'book-36' }, { name: 'peer' }]);
  });

  it('never reads a mention inside backtick code', () => {
    expect(names('run `@book-36` and')).toEqual([]);
    expect(names('```\n@book-36\n```\nok')).toEqual([]);
  });

  it('reads one spelling once, and never a uds: address or an e-mail address', () => {
    expect(names('@peer then @peer, mail me@example.com or @uds:/tmp/x.sock')).toEqual([
      { name: 'peer' },
    ]);
  });
});

describe('mentionNamesPath (#620)', () => {
  it('is true for a file or a directory in the workspace, and false for a missing path', async () => {
    writeFileSync(join(workspace, 'book-36'), 'x');
    mkdirSync(join(workspace, 'src'));
    expect(await mentionNamesPath(workspace, 'book-36')).toBe(true);
    expect(await mentionNamesPath(workspace, 'src')).toBe(true);
    expect(await mentionNamesPath(workspace, 'peer')).toBe(false);
  });

  it('looks in additionalDirectories, and never outside them', async () => {
    const extra = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-session-mentions-extra-')));
    try {
      writeFileSync(join(extra, 'peer'), 'x');
      expect(await mentionNamesPath(workspace, join(extra, 'peer'))).toBe(false);
      expect(await mentionNamesPath(workspace, join(extra, 'peer'), [extra])).toBe(true);
    } finally {
      rmSync(extra, { recursive: true, force: true });
    }
  });
});

const row = (name: string, extra: Partial<PeerSessionRow> = {}): PeerSessionRow => ({
  name,
  ref: 'a1b2c3',
  socketPath: `/tmp/socks/${name}.sock`,
  kind: 'interactive',
  status: 'idle',
  startedAt: 0,
  sessionId: `session-${name}`,
  pid: 1,
  self: false,
  ...extra,
});

const noInbox = { ref: undefined, socketPath: undefined };

describe('SessionMentionSnapshot (#620)', () => {
  function messaging(available = true) {
    const handle = {
      reads: 0,
      release: undefined as undefined | (() => void),
      available: () => available,
      list: async (): Promise<PeerSessionListing> => {
        handle.reads++;
        if (handle.release === undefined) return { peers: [row('book-36')] };
        await new Promise<void>((resolve) => (handle.release = resolve));
        return { peers: [row('book-36')] };
      },
    };
    return handle;
  }

  it('reads once, answers from the snapshot for a few seconds, then reads again', async () => {
    let now = 1_000;
    const source = messaging();
    const snapshot = new SessionMentionSnapshot(source, () => now);
    expect(snapshot.peek()).toBeUndefined();
    expect((await snapshot.fresh())?.peers[0].name).toBe('book-36');
    expect(snapshot.peek()?.peers[0].name).toBe('book-36');
    now += 4_000;
    await snapshot.fresh();
    expect(source.reads).toBe(1);
    now += 2_000;
    await snapshot.fresh();
    expect(source.reads).toBe(2);
  });

  it('shares one read between callers, and an abort stops only the waiting', async () => {
    const source = messaging();
    source.release = () => {};
    const snapshot = new SessionMentionSnapshot(source);
    const controller = new AbortController();
    const waiting = snapshot.fresh(controller.signal);
    const other = snapshot.fresh();
    controller.abort();
    expect(await waiting).toBeUndefined();
    source.release();
    expect((await other)?.peers).toHaveLength(1);
    expect(source.reads).toBe(1);
    // The read the abort left running still filled the snapshot.
    expect(snapshot.peek()?.peers).toHaveLength(1);
  });

  it('reads nothing while the inbox is not listening', async () => {
    const source = messaging(false);
    const snapshot = new SessionMentionSnapshot(source);
    expect(await snapshot.fresh()).toBeUndefined();
    expect(source.reads).toBe(0);
  });
});

describe('sessionMentionCandidates (#620)', () => {
  const listing: PeerSessionListing = {
    self: row('book-1', { self: true, ref: 'ffffff' }),
    peers: [
      row('book-36', { ref: '111111', status: 'busy' }),
      row('reviewer', { ref: '222222', startedAt: 1 }),
      row('reviewer', { ref: '333333', startedAt: 2 }),
      row('quiet', noInbox),
      row('night shift', { ref: '444444' }),
      row('solo', { ref: '555555' }),
      row('solo', noInbox),
    ],
  };
  const paths = (query: string) => sessionMentionCandidates(listing, query).map((c) => c.path);

  it('offers the other sessions with an inbox, labelled as sessions, by the address to type', () => {
    const candidates = sessionMentionCandidates(listing, 'b');
    expect(candidates.map((candidate) => candidate.path)).toEqual(['book-36']);
    expect(candidates[0]).toMatchObject({ kind: 'session', desc: 'busy' });
    expect(paths('night')).toEqual(['"night shift"']);
  });

  it("adds the ref only where the name alone does not reach the session, as SessionSend's does", () => {
    expect(paths('rev')).toEqual(['reviewer [222222]', 'reviewer [333333]']);
    // A namesake without an inbox still makes the bare name ambiguous to SessionSend.
    expect(paths('solo')).toEqual(['solo [555555]']);
  });

  it('matches a prefix before a name it only contains', () => {
    expect(paths('s')).toEqual(['solo [555555]', '"night shift"']);
  });

  it('offers at most three sessions for `@` alone, and nothing without a snapshot', () => {
    expect(paths('')).toHaveLength(3);
    expect(sessionMentionCandidates(undefined, '')).toEqual([]);
  });

  it('completes the address as typed, never quoting the ref', () => {
    const input = 'ask @rev';
    expect(
      replaceActiveSessionMention(input, findActiveFileMention(input)!, 'reviewer [222222]'),
    ).toBe('ask @reviewer [222222] ');
    const quoted = 'ask @"night';
    expect(
      replaceActiveSessionMention(quoted, findActiveFileMention(quoted)!, '"night shift"'),
    ).toBe('ask @"night shift" ');
  });

  it('round-trips: a completed address reads back as the same mention', () => {
    for (const address of ['book-36', 'reviewer [222222]', '"night shift"']) {
      const text = replaceActiveSessionMention('ask @', findActiveFileMention('ask @')!, address);
      expect(findSessionMentions(`${text}to run the tests`)).toHaveLength(1);
    }
  });
});
