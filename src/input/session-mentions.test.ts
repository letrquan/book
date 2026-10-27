import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mentionNamesPath } from './input-expansion.js';
import { findActiveFileMention } from './file-mentions.js';
import {
  findSessionMentions,
  getSessionMentionCandidates,
  replaceActiveSessionMention,
  type SessionMentionSource,
} from './session-mentions.js';
import type { PeerSessionListing, PeerSessionRow } from '../types/messaging.js';

let workspace: string;

beforeEach(() => {
  workspace = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-session-mentions-')));
});

afterEach(() => rmSync(workspace, { recursive: true, force: true }));

const nothingOnDisk = () => false;

describe('findSessionMentions (#620)', () => {
  it('reads @name and @name [ref], with or without the space before the ref', () => {
    expect(findSessionMentions('ask @book-36 to run the tests', nothingOnDisk)).toEqual([
      { name: 'book-36' },
    ]);
    expect(findSessionMentions('ask @book-36 [A1B2C3] to run them', nothingOnDisk)).toEqual([
      { name: 'book-36', ref: 'a1b2c3' },
    ]);
    expect(findSessionMentions('ask @book-36[a1b2c3], then stop', nothingOnDisk)).toEqual([
      { name: 'book-36', ref: 'a1b2c3' },
    ]);
  });

  it('reads a quoted name, and leaves trailing punctuation off the name', () => {
    expect(findSessionMentions('tell @"night shift" [0f0f0f] hi', nothingOnDisk)).toEqual([
      { name: 'night shift', ref: '0f0f0f' },
    ]);
    expect(findSessionMentions('is @book-36, or @peer.', nothingOnDisk)).toEqual([
      { name: 'book-36' },
      { name: 'peer' },
    ]);
  });

  it('never reads a mention inside backtick code', () => {
    expect(findSessionMentions('run `@book-36` and', nothingOnDisk)).toEqual([]);
    expect(findSessionMentions('```\n@book-36\n```\nok', nothingOnDisk)).toEqual([]);
  });

  it('leaves a mention that names something on disk to the file mention', () => {
    const onDisk = (path: string) => path === 'book-36';
    expect(findSessionMentions('ask @book-36 [a1b2c3] and @peer', onDisk)).toEqual([
      { name: 'peer' },
    ]);
  });

  it('reads one mention once, and never a uds: address or an e-mail address', () => {
    expect(
      findSessionMentions(
        '@peer then @peer, mail me@example.com or @uds:/tmp/x.sock',
        nothingOnDisk,
      ),
    ).toEqual([{ name: 'peer' }]);
  });
});

describe('mentionNamesPath (#620)', () => {
  it('is true for a file or a directory in the workspace, and false for a missing path', () => {
    writeFileSync(join(workspace, 'book-36'), 'x');
    mkdirSync(join(workspace, 'src'));
    expect(mentionNamesPath(workspace, 'book-36')).toBe(true);
    expect(mentionNamesPath(workspace, 'src')).toBe(true);
    expect(mentionNamesPath(workspace, 'peer')).toBe(false);
  });

  it('looks in additionalDirectories, and never outside them', () => {
    const extra = realpathSync.native(mkdtempSync(join(tmpdir(), 'book-session-mentions-extra-')));
    try {
      writeFileSync(join(extra, 'peer'), 'x');
      expect(mentionNamesPath(workspace, join(extra, 'peer'))).toBe(false);
      expect(mentionNamesPath(workspace, join(extra, 'peer'), [extra])).toBe(true);
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

function source(
  listing: PeerSessionListing,
  available = true,
): SessionMentionSource & {
  lists: number;
} {
  const handle = {
    lists: 0,
    available: () => available,
    list: async () => {
      handle.lists++;
      return listing;
    },
  };
  return handle;
}

describe('getSessionMentionCandidates (#620)', () => {
  const listing: PeerSessionListing = {
    self: row('book-1', { self: true, ref: 'ffffff' }),
    peers: [
      row('book-36', { ref: '111111', status: 'busy' }),
      row('reviewer', { ref: '222222', startedAt: 1 }),
      row('reviewer', { ref: '333333', startedAt: 2 }),
      row('quiet', { ref: undefined, socketPath: undefined }),
      row('night shift', { ref: '444444' }),
    ],
  };

  it('offers the other sessions with an inbox, labelled as sessions, by the address to type', async () => {
    const candidates = await getSessionMentionCandidates(source(listing), '');
    expect(candidates.map((candidate) => candidate.path)).toEqual([
      'book-36',
      '"night shift"',
      'reviewer [222222]',
      'reviewer [333333]',
    ]);
    expect(candidates.every((candidate) => candidate.kind === 'session')).toBe(true);
    expect(candidates[0].desc).toContain('busy');
  });

  it('filters by the query, and offers nothing while messaging is unavailable', async () => {
    expect((await getSessionMentionCandidates(source(listing), 'REV')).map((c) => c.path)).toEqual([
      'reviewer [222222]',
      'reviewer [333333]',
    ]);
    const off = source(listing, false);
    expect(await getSessionMentionCandidates(off, '')).toEqual([]);
    expect(off.lists).toBe(0);
    expect(await getSessionMentionCandidates(undefined, '')).toEqual([]);
  });

  it('offers nothing when the registry cannot be read', async () => {
    const broken: SessionMentionSource = {
      available: () => true,
      list: async () => {
        throw new Error('EACCES');
      },
    };
    expect(await getSessionMentionCandidates(broken, '')).toEqual([]);
  });

  it('completes the address as typed, never quoting the ref', () => {
    const input = 'ask @rev';
    const mention = findActiveFileMention(input)!;
    expect(replaceActiveSessionMention(input, mention, 'reviewer [222222]')).toBe(
      'ask @reviewer [222222] ',
    );
    const quoted = 'ask @"night';
    expect(
      replaceActiveSessionMention(quoted, findActiveFileMention(quoted)!, '"night shift"'),
    ).toBe('ask @"night shift" ');
  });

  it('round-trips: a completed address reads back as the same mention', () => {
    for (const address of ['book-36', 'reviewer [222222]', '"night shift"']) {
      const text = replaceActiveSessionMention('ask @', findActiveFileMention('ask @')!, address);
      expect(findSessionMentions(`${text}to run the tests`, nothingOnDisk)).toHaveLength(1);
    }
  });
});
