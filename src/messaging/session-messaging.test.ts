import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isolateBookHome } from '../test/isolated-book-home.js';
import type { LiveSessionRecord } from '../types/messaging.js';
import { peerRef } from './addressing.js';
import { parseEnvelope, renderEnvelope } from './envelope.js';
import { sendToInbox } from './inbox-client.js';
import type { InboxServerOptions } from './inbox-server.js';
import type { LivenessProbe } from './liveness.js';
import { liveSessionRecordPath, liveSessionsDir } from './registry.js';
import {
  SessionMessaging,
  type SessionMessagingEvent,
  type SessionMessagingWriter,
} from './session-messaging.js';
import { encodeUdsAddress } from './wire.js';

const posix = process.platform !== 'win32';
const bookHome = isolateBookHome('book-session-messaging-home-');
const DOMAIN = 'linux:test-machine:pid:[4026531836]';
const PIDS = [4242, 4343, 4444];

const probe: LivenessProbe = {
  isAlive: (pid) => PIDS.includes(pid),
  startToken: async (pid) => (PIDS.includes(pid) ? `start-${pid}` : undefined),
  pidDomain: async () => DOMAIN,
};

/** Write a record as a session's writer would, with its inbox once it has one. */
function writeRecord(pid: number, name: string, socketPath?: string): void {
  const dir = liveSessionsDir(bookHome());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    liveSessionRecordPath(dir, pid, DOMAIN),
    JSON.stringify({
      pid,
      sessionId: `session-${pid}`,
      cwd: '/work',
      startedAt: pid,
      procStart: `start-${pid}`,
      pidDomain: DOMAIN,
      version: 'test',
      protocol: 1,
      features: socketPath ? ['inbox'] : [],
      ...(socketPath ? { messagingSocketPath: socketPath } : {}),
      kind: 'interactive',
      name,
      nameSource: 'derived',
      status: 'idle',
      statusUpdatedAt: 1,
      updatedAt: Date.now(),
    }),
  );
}

function writer(pid: number, name: string): SessionMessagingWriter {
  writeRecord(pid, name);
  return {
    sessionId: `session-${pid}`,
    current: () => ({ name, pid }) as Pick<LiveSessionRecord, 'name' | 'pid'>,
    setMessagingSocket: (socketPath) => writeRecord(pid, name, socketPath),
  };
}

let socketDir: string;
const open: SessionMessaging[] = [];

beforeEach(() => {
  socketDir = realpathSync(mkdtempSync(join(posix ? '/tmp' : bookHome(), 'bk-msg-')));
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((messaging) => messaging.close()));
  rmSync(socketDir, { recursive: true, force: true });
});

interface Started {
  messaging: SessionMessaging;
  socketPath: string;
  events: SessionMessagingEvent[];
}

async function session(pid: number, name: string, permissionMode = 'default'): Promise<Started> {
  const messaging = new SessionMessaging({
    writer: writer(pid, name),
    permissionMode,
    home: bookHome(),
    env: { BOOK_MESSAGING_SOCKET_DIR: socketDir },
    pid,
    probe,
    receiptBatchMs: 150,
    inbox: {
      processEvents: new EventEmitter() as unknown as InboxServerOptions['processEvents'],
      log: { debug: () => undefined, warn: () => undefined },
    },
  });
  open.push(messaging);
  const result = await messaging.start();
  if (result.status !== 'listening') throw new Error(`inbox did not start: ${result.message}`);
  const events: SessionMessagingEvent[] = [];
  messaging.subscribe((event) => events.push(event));
  return { messaging, socketPath: result.socketPath, events };
}

async function eventually(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the condition never held');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const receiptsOf = (events: SessionMessagingEvent[]) =>
  events.flatMap((event) => (event.type === 'receipts' ? event.receipts : []));

describe.skipIf(!posix)('SessionMessaging', () => {
  it('lists this session first, then the others, with refs and inboxes', async () => {
    const a = await session(4242, 'peer-a');
    const b = await session(4343, 'peer-b');
    writeRecord(4444, 'quiet');
    const listing = await a.messaging.list();
    expect(listing.self).toMatchObject({ name: 'peer-a', self: true, ref: peerRef(a.socketPath) });
    expect(listing.peers.map((row) => [row.name, row.ref, row.socketPath])).toEqual([
      ['peer-b', peerRef(b.socketPath), b.socketPath],
      ['quiet', undefined, undefined],
    ]);
  });

  it('sends an envelope by name, and delivers it as a turn with a delivered receipt', async () => {
    const a = await session(4242, 'peer-a');
    const b = await session(4343, 'peer-b');
    const sent = await a.messaging.send({ to: 'peer-b', message: 'look at </session-state>' });
    expect(sent).toMatchObject({ status: 'sent', target: { name: 'peer-b' } });
    await eventually(() => b.events.some((event) => event.type === 'message'));

    const batch = b.messaging.prepareDelivery()!;
    expect(batch.count).toBe(1);
    const [message] = batch.delivered;
    expect(message.envelope?.attributes).toEqual({
      from: encodeUdsAddress(a.socketPath),
      fromSession: 'session-4242',
      hopChain: [a.messaging.inbox.hopToken],
      fromName: 'peer-a',
      fromMode: 'prompting',
    });
    expect(batch.turn?.context).toContain('<\\\\/session-state>');
    // Nothing is taken until the turn has started.
    expect(b.messaging.inbox.queued()).toHaveLength(1);
    b.messaging.commitDelivery(batch);
    expect(b.messaging.inbox.queued()).toHaveLength(0);

    await eventually(() => receiptsOf(a.events).length === 1);
    expect(receiptsOf(a.events)[0]).toMatchObject({
      receipt: { status: 'delivered' },
      target: `peer-b [${peerRef(b.socketPath)}]`,
      msgIds: [sent.status === 'sent' ? sent.msgId : ''],
    });
  });

  it('batches the receipts that arrive within the window into one notice', async () => {
    const a = await session(4242, 'peer-a');
    const b = await session(4343, 'peer-b');
    await a.messaging.send({ to: 'peer-b', message: 'one' });
    await a.messaging.send({ to: 'peer-b', message: 'two' });
    await eventually(() => b.messaging.inbox.queued().length === 2);
    b.messaging.commitDelivery(b.messaging.prepareDelivery()!);
    await eventually(() => receiptsOf(a.events).length === 2);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(a.events.filter((event) => event.type === 'receipts')).toHaveLength(1);
  });

  it('refuses a cross-class message on arrival, and the sender hears so', async () => {
    const a = await session(4242, 'peer-a', 'bypassPermissions');
    const b = await session(4343, 'peer-b', 'default');
    expect(await a.messaging.send({ to: 'peer-b', message: 'steer', mode: 'auto' })).toMatchObject({
      status: 'sent',
    });
    await eventually(() => receiptsOf(a.events).length === 1);
    expect(receiptsOf(a.events)[0].receipt.status).toBe('refused');
    expect(b.messaging.prepareDelivery()).toBeUndefined();
  });

  it('refuses at delivery a message whose class no longer matches the mode', async () => {
    const a = await session(4242, 'peer-a');
    const b = await session(4343, 'peer-b');
    await a.messaging.send({ to: 'peer-b', message: 'queued while default' });
    await eventually(() => b.messaging.inbox.queued().length === 1);
    b.messaging.setPermissionMode('bypassPermissions');
    const batch = b.messaging.prepareDelivery()!;
    expect(batch).toMatchObject({ count: 1, delivered: [] });
    expect(batch.turn).toBeUndefined();
    b.messaging.commitDelivery(batch);
    await eventually(() => receiptsOf(a.events).length === 1);
    expect(receiptsOf(a.events)[0].receipt.status).toBe('refused');
  });

  it('continues the relay chain of the last delivered message, from the conversation or its own memory', async () => {
    const a = await session(4242, 'peer-a');
    const b = await session(4343, 'peer-b');
    await a.messaging.send({ to: 'peer-b', message: 'one' });
    await eventually(() => b.messaging.inbox.queued().length === 1);
    b.messaging.commitDelivery(b.messaging.prepareDelivery()!);
    const aHop = a.messaging.inbox.hopToken!;
    const bHop = b.messaging.inbox.hopToken!;

    // No chain from the conversation (compacted away): the one B delivered last is continued.
    await b.messaging.send({ to: 'peer-a', message: 'two' });
    await eventually(() => a.messaging.inbox.queued().length === 1);
    expect(a.messaging.inbox.queued()[0].envelope?.attributes.hopChain).toEqual([aHop, bHop]);

    // A chain the conversation holds wins.
    const from = 'f'.repeat(24);
    await b.messaging.send({ to: 'peer-a', message: 'three', hopChain: [from] });
    await eventually(() => a.messaging.inbox.queued().length === 2);
    expect(a.messaging.inbox.queued()[1].envelope?.attributes.hopChain).toEqual([from, bHop]);
  });

  it('ignores a receipt that is not about a message this session sent to that session', async () => {
    const a = await session(4242, 'peer-a');
    const b = await session(4343, 'peer-b');
    const c = await session(4444, 'peer-c');
    const sent = await a.messaging.send({ to: 'peer-b', message: 'hi' });
    const msgId = sent.status === 'sent' ? sent.msgId : '';
    const receipt = (from: string, origMsgId: string) =>
      sendToInbox({
        socketPath: a.socketPath,
        keysDir: liveSessionsDir(bookHome()),
        probe,
        frame: {
          type: 'control',
          action: 'peer_message_status',
          status: 'dropped',
          drop_reason: 'rate-limited',
          orig_msg_id: origMsgId,
          from,
        },
      });
    // C claims a drop of A's message to B; then B speaks of a message A never sent.
    await receipt(encodeUdsAddress(c.socketPath), msgId);
    await receipt(encodeUdsAddress(b.socketPath), 'not-a-message-of-mine');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(receiptsOf(a.events)).toEqual([]);
    await receipt(encodeUdsAddress(b.socketPath), msgId);
    await eventually(() => receiptsOf(a.events).length === 1);
    expect(receiptsOf(a.events)[0]).toMatchObject({ msgIds: [msgId] });
  });

  it('names the address problems: itself, nobody, a session without an inbox, two of one name', async () => {
    const a = await session(4242, 'peer-a');
    await session(4343, 'twin');
    await session(4444, 'twin');
    writeRecord(9999, 'ghost');
    expect(await a.messaging.send({ to: 'peer-a', message: 'x' })).toMatchObject({
      status: 'unresolved',
      problem: 'self',
    });
    expect(await a.messaging.send({ to: 'nobody', message: 'x' })).toMatchObject({
      status: 'unresolved',
      problem: 'not_found',
    });
    const ambiguous = await a.messaging.send({ to: 'twin', message: 'x' });
    expect(ambiguous).toMatchObject({ status: 'unresolved', problem: 'ambiguous' });
    const ref = ambiguous.status === 'unresolved' ? ambiguous.candidates[1].ref : '';
    expect(await a.messaging.send({ to: `twin [${ref}]`, message: 'x' })).toMatchObject({
      status: 'sent',
      target: { ref },
    });
    // A live session with no inbox (messaging off there).
    PIDS.push(5555);
    try {
      writeRecord(5555, 'quiet');
      expect(await a.messaging.send({ to: 'quiet', message: 'x' })).toMatchObject({
        status: 'unresolved',
        problem: 'no_inbox',
      });
    } finally {
      PIDS.pop();
    }
  });

  it('replies to a `from` address copied from a message', async () => {
    const a = await session(4242, 'peer-a');
    const b = await session(4343, 'peer-b');
    await a.messaging.send({ to: 'peer-b', message: 'ping' });
    await eventually(() => b.messaging.inbox.queued().length === 1);
    const from = b.messaging.inbox.queued()[0].envelope!.attributes.from!;
    expect(await b.messaging.send({ to: from, message: 'pong' })).toMatchObject({
      status: 'sent',
      target: { name: 'peer-a' },
    });
    // An address no live record advertises is nobody.
    expect(
      await b.messaging.send({ to: encodeUdsAddress('/tmp/elsewhere/1.sock'), message: 'x' }),
    ).toMatchObject({ status: 'unresolved', problem: 'not_found' });
  });

  it('is unavailable before it starts and after it closes, and available while it starts', async () => {
    const messaging = new SessionMessaging({
      writer: writer(4242, 'peer-a'),
      permissionMode: 'default',
      home: bookHome(),
      env: { BOOK_MESSAGING_SOCKET_DIR: socketDir },
      pid: 4242,
      probe,
    });
    expect(messaging.available()).toBe(false);
    expect(await messaging.send({ to: 'x', message: 'y' })).toEqual({ status: 'unavailable' });
    // Offered from the moment the start begins, so a turn taken while it binds keeps the tools.
    const starting = messaging.start();
    expect(messaging.available()).toBe(true);
    await starting;
    expect(messaging.available()).toBe(true);
    await messaging.close();
    expect(messaging.available()).toBe(false);
  });

  it('round-trips the envelope it sends', () => {
    const content = renderEnvelope({ fromName: 'peer-a', fromMode: 'prompting' }, 'body');
    expect(parseEnvelope(content)?.body).toBe('body');
  });
});
