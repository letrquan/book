import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { isolateBookHome } from '../test/isolated-book-home.js';
import type { AcceptedPeerMessage, PeerMessageReceipt } from '../types/messaging.js';
import { renderEnvelope } from './envelope.js';
import { classifySendError, findPeerKey, sendToInbox } from './inbox-client.js';
import { InboxServer, inboxStartupNotices, type InboxServerOptions } from './inbox-server.js';
import type { LivenessProbe } from './liveness.js';
import { SendPacer } from './pacer.js';
import { liveSessionKeyName, liveSessionRecordPath, liveSessionsDir } from './registry.js';
import { LiveSessionWriter } from './writer.js';
import { encodeUdsAddress, MAX_LINE_CHARS, serializeFrame, type UserFrame } from './wire.js';

const posix = process.platform !== 'win32';
const bookHome = isolateBookHome('book-inbox-home-');
const DOMAIN = 'linux:test-machine:pid:[4026531836]';
const PID_A = 4242;
const PID_B = 4343;

function probe(live = new Set([PID_A, PID_B])): LivenessProbe {
  return {
    isAlive: (pid) => live.has(pid),
    startToken: async (pid) => (live.has(pid) ? `start-${pid}` : undefined),
    pidDomain: async () => DOMAIN,
  };
}

let socketDir: string;
const open: InboxServer[] = [];
const servers: Server[] = [];

beforeEach(() => {
  // Under /tmp, so the path stays well inside the 103-byte limit on every platform.
  socketDir = realpathSync(mkdtempSync(join(posix ? '/tmp' : bookHome(), 'bk-socks-')));
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((inbox) => inbox.close()));
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  rmSync(socketDir, { recursive: true, force: true });
});

interface Recorded {
  inbox: InboxServer;
  messages: AcceptedPeerMessage[];
  receipts: PeerMessageReceipt[];
  logs: unknown[][];
  events: EventEmitter;
}

function createInbox(overrides: Partial<InboxServerOptions> = {}): Recorded {
  const messages: AcceptedPeerMessage[] = [];
  const receipts: PeerMessageReceipt[] = [];
  const logs: unknown[][] = [];
  const events = new EventEmitter();
  const inbox = new InboxServer({
    sessionId: () => 'session-a',
    env: { BOOK_MESSAGING_SOCKET_DIR: socketDir },
    home: bookHome(),
    pid: PID_A,
    probe: probe(),
    processEvents: events as unknown as InboxServerOptions['processEvents'],
    log: {
      debug: (...args: unknown[]) => logs.push(['debug', ...args]),
      warn: (...args: unknown[]) => logs.push(['warn', ...args]),
    },
    onMessage: (message) => messages.push(message),
    onReceipt: (receipt) => receipts.push(receipt),
    ...overrides,
  });
  open.push(inbox);
  return { inbox, messages, receipts, logs, events };
}

async function started(
  recorded: Recorded,
): Promise<{ socketPath: string; keyPath: string; token: string }> {
  const result = await recorded.inbox.start();
  if (result.status !== 'listening') throw new Error(`inbox did not start: ${result.message}`);
  const keyPath = recorded.inbox.keyPath!;
  const token = (JSON.parse(readFileSync(keyPath, 'utf8')) as { peerToken: string }).peerToken;
  return { socketPath: result.socketPath, keyPath, token };
}

/** Write `text` on a raw connection and resolve with what came back once the server closes it. */
function raw(
  path: string,
  text: string,
  options: { end?: boolean } = {},
): Promise<{ reply: string; elapsedMs: number }> {
  return new Promise((resolve, reject) => {
    const begun = Date.now();
    let reply = '';
    const socket = createConnection({ path });
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => (reply += chunk));
    socket.on('error', () => undefined);
    socket.once('connect', () => {
      if (text) socket.write(text);
      if (options.end ?? true) socket.end();
    });
    socket.once('close', () => resolve({ reply, elapsedMs: Date.now() - begun }));
    setTimeout(() => reject(new Error('the server never closed the connection')), 10_000).unref();
  });
}

/** A live-session record advertising `socketPath`, as a peer's writer would leave it. */
function advertise(pid: number, socketPath: string, pidDomain: string = DOMAIN): void {
  const dir = liveSessionsDir(bookHome());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    liveSessionRecordPath(dir, pid, pidDomain),
    JSON.stringify({
      pid,
      sessionId: `session-${pid}`,
      cwd: '/work',
      startedAt: 1,
      procStart: `start-${pid}`,
      pidDomain,
      version: 'test',
      protocol: 1,
      features: ['inbox'],
      kind: 'interactive',
      name: `peer-${pid}`,
      nameSource: 'derived',
      status: 'idle',
      statusUpdatedAt: 1,
      updatedAt: Date.now(),
      messagingSocketPath: socketPath,
    }),
  );
}

/** Leave a socket file at `path` that nothing listens on, as a killed session does. */
async function deadSocket(path: string): Promise<void> {
  const server = createServer();
  const temporary = join(socketDir, `tmp-${Math.random().toString(16).slice(2)}.sock`);
  await new Promise<void>((resolve) => server.listen(temporary, resolve));
  renameSync(temporary, path);
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function userFrame(content: string, extra: Partial<UserFrame> = {}): UserFrame {
  return { type: 'user', message: { role: 'user', content }, priority: 'next', ...extra };
}

function authLine(token: string): string {
  return serializeFrame({ type: 'auth', token });
}

async function eventually(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('the condition never held');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Let the server's data handlers run after the client has closed. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe.skipIf(!posix)('InboxServer', () => {
  it('binds a 0600 socket in a 0700 directory and publishes a 0600 key atomically', async () => {
    const recorded = createInbox();
    const { socketPath, keyPath, token } = await started(recorded);

    expect(socketPath).toBe(join(socketDir, `${PID_A}.sock`));
    expect(lstatSync(socketPath).isSocket()).toBe(true);
    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);
    expect(lstatSync(socketDir).mode & 0o777).toBe(0o700);

    const keysDir = liveSessionsDir(bookHome());
    expect(keyPath).toBe(join(keysDir, liveSessionKeyName(PID_A, DOMAIN, socketPath)));
    expect(lstatSync(keyPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(keyPath, 'utf8'))).toEqual({
      peerToken: token,
      procStart: `start-${PID_A}`,
      pidDomain: DOMAIN,
    });
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    // Written through a temp file and a rename: nothing but the key is left behind.
    expect(readdirSync(keysDir)).toEqual([liveSessionKeyName(PID_A, DOMAIN, socketPath)]);
  });

  it('queues a user frame that follows a correct auth line', async () => {
    const recorded = createInbox();
    const { socketPath, token } = await started(recorded);
    const { reply } = await raw(
      socketPath,
      authLine(token) + serializeFrame(userFrame('hello', { from: 'uds:/x/1.sock', msg_id: 'm1' })),
    );
    await settle();
    expect(reply).toBe('');
    expect(recorded.inbox.queued()).toEqual([
      {
        content: 'hello',
        from: 'uds:/x/1.sock',
        msgId: 'm1',
        priority: 'next',
        receivedAt: expect.any(Number),
      },
    ]);
    expect(recorded.messages).toHaveLength(1);
    expect(recorded.inbox.take()?.content).toBe('hello');
    expect(recorded.inbox.queued()).toEqual([]);
  });

  it.each([
    ['missing', () => ''],
    ['wrong', () => authLine('fedcba9876543210fedcba9876543210')],
    ['the wrong length', (token: string) => authLine(token.slice(0, 30))],
    ['not JSON', () => 'auth please\n'],
    ['blank', () => '\n'],
  ])('closes a connection whose auth line is %s, without a word', async (_name, auth) => {
    const recorded = createInbox();
    const { socketPath, token } = await started(recorded);
    const { reply } = await raw(socketPath, auth(token) + serializeFrame(userFrame('let me in')));
    await settle();
    expect(reply).toBe('');
    expect(recorded.inbox.queued()).toEqual([]);
  });

  it('closes a connection that sends no line before the deadline', async () => {
    const recorded = createInbox({ limits: { firstLineTimeoutMs: 100 } });
    const { socketPath } = await started(recorded);
    const { elapsedMs } = await raw(socketPath, '', { end: false });
    expect(elapsedMs).toBeGreaterThanOrEqual(90);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('closes a connection whose line passes the cap before its newline arrives', async () => {
    const recorded = createInbox();
    const { socketPath, token } = await started(recorded);
    const huge = `{"type":"user","message":{"content":"${'x'.repeat(MAX_LINE_CHARS)}`;
    const { reply } = await raw(socketPath, authLine(token) + huge, { end: false });
    expect(reply).toBe('');
    expect(recorded.inbox.queued()).toEqual([]);
    // A first line over the cap is closed the same way, before any auth.
    await raw(socketPath, 'a'.repeat(MAX_LINE_CHARS + 1), { end: false });
  });

  it('closes a connection whose first line passes 1 KiB, without waiting for the deadline', async () => {
    const recorded = createInbox();
    const { socketPath } = await started(recorded);
    const { elapsedMs } = await raw(socketPath, 'a'.repeat(2048), { end: false });
    expect(elapsedMs).toBeLessThan(1_000);
  });

  it('takes a frame over 1 KiB that follows the auth line in the same write', async () => {
    const recorded = createInbox();
    const { socketPath, token } = await started(recorded);
    const big = 'b'.repeat(64 * 1024);
    await raw(socketPath, authLine(token) + serializeFrame(userFrame(big)));
    await settle();
    expect(recorded.inbox.queued().map((message) => message.content.length)).toEqual([big.length]);
  });

  it('drops a frame naming another session id, and reads the id for every frame', async () => {
    let sessionId = 'session-a';
    const recorded = createInbox({ sessionId: () => sessionId });
    const { socketPath, token } = await started(recorded);
    await raw(
      socketPath,
      authLine(token) +
        serializeFrame(userFrame('for an old session', { session_id: 'session-old' })) +
        serializeFrame(userFrame('for this one', { session_id: 'session-a' })),
    );
    sessionId = 'session-b';
    await raw(
      socketPath,
      authLine(token) + serializeFrame(userFrame('after /clear', { session_id: 'session-b' })),
    );
    await settle();
    expect(recorded.inbox.queued().map((message) => message.content)).toEqual([
      'for this one',
      'after /clear',
    ]);
  });

  it('holds no more than the connection cap open at once', async () => {
    const recorded = createInbox({ limits: { maxConnections: 2 } });
    const { socketPath } = await started(recorded);
    const idle = [createConnection({ path: socketPath }), createConnection({ path: socketPath })];
    await Promise.all(
      idle.map((socket) => new Promise((resolve) => socket.once('connect', resolve))),
    );
    await settle();
    const { elapsedMs } = await raw(socketPath, '', { end: false });
    expect(elapsedMs).toBeLessThan(1_000);
    for (const socket of idle) socket.destroy();
  });

  it('never puts the token in a log line, an error or a frame it sends', async () => {
    const recorded = createInbox();
    const { socketPath, token } = await started(recorded);
    await raw(socketPath, authLine('fedcba9876543210fedcba9876543210'));
    await raw(socketPath, authLine(token) + 'garbage\n' + serializeFrame(userFrame('x')));
    for (let i = 0; i < 35; i++) {
      await raw(
        socketPath,
        authLine(token) + serializeFrame(userFrame(`flood ${i}`, { from: 'uds:/x/9.sock' })),
      );
    }
    await settle();
    await recorded.inbox.close();
    expect(recorded.logs.length).toBeGreaterThan(0);
    expect(JSON.stringify(recorded.logs)).not.toContain(token);
  });

  it('is advertised in the record the way the TUI host wires it, with no token in it', async () => {
    const writer = new LiveSessionWriter({
      cwd: bookHome(),
      sessionId: 'session-a',
      version: 'test',
      pid: PID_A,
      probe: probe(),
      processEvents: new EventEmitter() as unknown as InboxServerOptions['processEvents'],
    });
    void writer.start();
    const recorded = createInbox({ sessionId: () => writer.sessionId });
    const { socketPath, token } = await started(recorded);
    writer.setMessagingSocket(socketPath);
    await writer.flushed();
    const text = readFileSync(writer.path!, 'utf8');
    expect(JSON.parse(text)).toMatchObject({
      features: ['inbox'],
      messagingSocketPath: socketPath,
    });
    expect(text).not.toContain(token);
    await writer.close();
  });

  it('removes the socket and the key on close', async () => {
    const recorded = createInbox();
    const { socketPath, keyPath } = await started(recorded);
    await recorded.inbox.close();
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(keyPath)).toBe(false);
  });

  it('removes the socket and the key synchronously when the process exits without closing', async () => {
    const recorded = createInbox();
    const { socketPath, keyPath } = await started(recorded);
    recorded.events.emit('exit');
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(keyPath)).toBe(false);
  });

  it('binds a moved-aside socket when a live one holds its name', async () => {
    const squatter = createServer();
    servers.push(squatter);
    await new Promise<void>((resolve) =>
      squatter.listen(join(socketDir, `${PID_A}.sock`), resolve),
    );
    const recorded = createInbox({ randomBytes: (size) => Buffer.alloc(size, 0xab) });
    const result = await recorded.inbox.start();
    expect(result).toMatchObject({
      status: 'listening',
      socketPath: join(socketDir, `${PID_A}-abababab.sock`),
      movedAside: true,
    });
  });

  it('unlinks a dead socket in its way and binds the name itself', async () => {
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(join(socketDir, 'tmp.sock'), resolve));
    // Moved under the inbox's name, then closed: a socket file nothing listens on.
    renameSync(join(socketDir, 'tmp.sock'), join(socketDir, `${PID_A}.sock`));
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    expect(lstatSync(join(socketDir, `${PID_A}.sock`)).isSocket()).toBe(true);

    const result = await createInbox().inbox.start();
    expect(result).toMatchObject({
      socketPath: join(socketDir, `${PID_A}.sock`),
      movedAside: false,
    });
  });

  it('reaps the sockets of killed sessions, primary or moved aside, that nothing answers on', async () => {
    // A session killed by SIGHUP or SIGTERM leaves its socket; the pid alone cannot say so for
    // another namespace's file, so only a refused connection does.
    await deadSocket(join(socketDir, '9999.sock'));
    await deadSocket(join(socketDir, '9997-0badf00d.sock'));
    const live = createServer();
    servers.push(live);
    await new Promise<void>((resolve) => live.listen(join(socketDir, '9998.sock'), resolve));
    const liveAside = createServer();
    servers.push(liveAside);
    await new Promise<void>((resolve) =>
      liveAside.listen(join(socketDir, '9996-00c0ffee.sock'), resolve),
    );

    const { inbox } = createInbox();
    await inbox.start();
    // The reap runs in the background, after the start.
    await eventually(
      () =>
        !existsSync(join(socketDir, '9999.sock')) &&
        !existsSync(join(socketDir, '9997-0badf00d.sock')),
    );
    await inbox.close();
    expect(existsSync(join(socketDir, '9998.sock'))).toBe(true);
    expect(existsSync(join(socketDir, '9996-00c0ffee.sock'))).toBe(true);
  });

  it('starts nothing on Windows', async () => {
    const recorded = createInbox({ platform: 'win32' });
    expect(await recorded.inbox.start()).toEqual({
      status: 'failed',
      message: 'cross-session messaging is not supported on Windows yet',
    });
    expect(readdirSync(socketDir)).toEqual([]);
  });

  it('fails without throwing when no socket directory is usable', async () => {
    const file = join(socketDir, 'not-a-dir');
    writeFileSync(file, '');
    const recorded = createInbox({ env: { BOOK_MESSAGING_SOCKET_DIR: file } });
    const result = await recorded.inbox.start();
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.message).toContain('is not a directory');
    expect(existsSync(liveSessionsDir(bookHome()))).toBe(false);
  });
});

describe.skipIf(!posix)('reply addresses', () => {
  it('accepts only a socket that a live record of this pid domain advertises', async () => {
    const a = createInbox();
    await started(a);
    const b = createInbox({ pid: PID_B });
    const { socketPath: bSocket } = await started(b);
    // In a vetted directory, but no record vouches for it yet.
    expect(await a.inbox.vetReplyAddress(encodeUdsAddress(bSocket))).toBeUndefined();
    advertise(PID_B, bSocket);
    expect(await a.inbox.vetReplyAddress(encodeUdsAddress(bSocket))).toBe(bSocket);

    // A record whose process is gone, or from another pid domain, vouches for nothing.
    const c = createInbox({ pid: 5151 });
    const { socketPath: cSocket } = await started(c);
    advertise(5151, cSocket);
    expect(await a.inbox.vetReplyAddress(encodeUdsAddress(cSocket))).toBeUndefined();
    const d = createInbox({ pid: 5252 });
    const { socketPath: dSocket } = await started(d);
    advertise(5252, dSocket, 'linux:other-machine:pid:[1]');
    expect(await a.inbox.vetReplyAddress(encodeUdsAddress(dSocket))).toBeUndefined();
  });

  it("accepts a peer's socket in a directory this session would never resolve itself", async () => {
    const a = createInbox();
    await started(a);
    const elsewhere = realpathSync(mkdtempSync(join('/tmp', 'bk-elsewhere-')));
    try {
      const b = createInbox({ pid: PID_B, env: { BOOK_MESSAGING_SOCKET_DIR: elsewhere } });
      const { socketPath: bSocket } = await started(b);
      advertise(PID_B, bSocket);
      expect(await a.inbox.vetReplyAddress(encodeUdsAddress(bSocket))).toBe(bSocket);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('refuses an advertised socket whose directory fails the checks', async () => {
    const a = createInbox();
    await started(a);
    const open = realpathSync(mkdtempSync(join('/tmp', 'bk-open-')));
    try {
      const b = createInbox({ pid: PID_B, env: { BOOK_MESSAGING_SOCKET_DIR: open } });
      const { socketPath: bSocket } = await started(b);
      advertise(PID_B, bSocket);
      chmodSync(open, 0o755);
      expect(await a.inbox.vetReplyAddress(encodeUdsAddress(bSocket))).toBeUndefined();
    } finally {
      chmodSync(open, 0o700);
      rmSync(open, { recursive: true, force: true });
    }
  });

  it('refuses an advertised path that is not a plain socket', async () => {
    const a = createInbox();
    await started(a);
    const file = join(socketDir, '5555.sock');
    writeFileSync(file, '');
    advertise(5555, file);
    const b = createInbox({ pid: PID_B });
    const { socketPath: bSocket } = await started(b);
    const link = join(socketDir, '6666.sock');
    symlinkSync(bSocket, link);
    advertise(PID_B, link);
    for (const address of [
      encodeUdsAddress(file),
      encodeUdsAddress(link),
      bSocket,
      encodeUdsAddress(`${socketDir}/../${socketDir.split('/').pop()}/${PID_B}.sock`),
      encodeUdsAddress(join(socketDir, 'peer.sock')),
      'uds:relative.sock',
    ]) {
      expect(await a.inbox.vetReplyAddress(address), address).toBeUndefined();
    }
  });
});

describe.skipIf(!posix)('drop receipts', () => {
  it('sends dropped receipts for a flood back to the sender’s own inbox', async () => {
    const a = createInbox({ limits: { receiptTrailMs: 50 } });
    const { socketPath: aSocket } = await started(a);
    const b = createInbox({ pid: PID_B });
    const { socketPath: bSocket } = await started(b);
    advertise(PID_B, bSocket);
    const keysDir = liveSessionsDir(bookHome());
    for (let i = 0; i < 34; i++) {
      const result = await sendToInbox({
        socketPath: aSocket,
        keysDir,
        probe: probe(),
        frame: userFrame(`flood ${i}`, { from: encodeUdsAddress(bSocket), msg_id: `m${i}` }),
      });
      expect(result).toEqual({ status: 'sent' });
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(a.inbox.queued()).toHaveLength(30);
    const dropped = b.receipts.filter((receipt) => receipt.status === 'dropped');
    expect(dropped.length).toBeGreaterThanOrEqual(2);
    expect(dropped[0]).toMatchObject({
      dropReason: 'rate-limited',
      origMsgId: 'm30',
      from: encodeUdsAddress(aSocket),
    });
    // The rest of the flood came back as one batch naming each id.
    expect(dropped.flatMap((receipt) => receipt.droppedMsgIds ?? [])).toEqual([
      'm31',
      'm32',
      'm33',
    ]);
  });

  it('sends no receipt to an address no live record advertises', async () => {
    const a = createInbox();
    const { socketPath, token } = await started(a);
    await raw(
      socketPath,
      authLine(token) +
        Array.from({ length: 31 }, (_, i) =>
          serializeFrame(userFrame(`flood ${i}`, { from: 'uds:/etc/passwd', msg_id: `m${i}` })),
        ).join(''),
    );
    await settle();
    expect(a.logs.some((line) => line.includes('receipt not sent: reply address refused'))).toBe(
      true,
    );
  });
});

describe.skipIf(!posix)('envelopes, relay chains and permission classes', () => {
  /** A and B both listening, B advertised so A's receipts reach it. */
  async function pair(aOptions: Partial<InboxServerOptions> = {}) {
    const a = createInbox(aOptions);
    const { socketPath: aSocket } = await started(a);
    const b = createInbox({ pid: PID_B });
    const { socketPath: bSocket } = await started(b);
    advertise(PID_B, bSocket);
    const from = encodeUdsAddress(bSocket);
    const send = (content: string, msgId: string, frameFrom: string = from) =>
      sendToInbox({
        socketPath: aSocket,
        keysDir: liveSessionsDir(bookHome()),
        probe: probe(),
        frame: userFrame(content, { from: frameFrom, msg_id: msgId }),
      });
    return { a, b, from, send };
  }

  it('keeps the envelope of a message that round-trips, and none of one that does not', async () => {
    const { a, from, send } = await pair();
    await send(renderEnvelope({ from, fromName: 'peer-b', fromMode: 'prompting' }, 'hi'), 'm1');
    await send(`<cross-session-message from="${from}">\nhi\n</cross-session-message> tail`, 'm2');
    // The envelope names a reply address other than its frame's: unattributed.
    await send(renderEnvelope({ from: encodeUdsAddress('/tmp/x/9.sock') }, 'hi'), 'm3');
    await eventually(() => a.messages.length === 3);
    expect(a.messages[0].envelope).toEqual({
      attributes: { from, fromName: 'peer-b', fromMode: 'prompting' },
      body: 'hi',
    });
    expect(a.messages[1].envelope).toBeUndefined();
    expect(a.messages[2].envelope).toBeUndefined();
  });

  it("drops a chain that loops through this session or runs away, from the envelope's chain", async () => {
    const { a, b, from, send } = await pair();
    const own = a.inbox.hopToken!;
    expect(own).toMatch(/^[0-9a-f]{24}$/);
    const other = (n: number) => n.toString(16).padStart(24, 'f');
    await send(renderEnvelope({ from, hopChain: Array(9).fill(own) }, 'nine'), 'm1');
    await send(renderEnvelope({ from, hopChain: Array(10).fill(own) }, 'ten'), 'm2');
    await send(
      renderEnvelope({ from, hopChain: Array.from({ length: 29 }, (_, n) => other(n)) }, 'long'),
      'm3',
    );
    await eventually(() => b.receipts.filter((r) => r.status === 'dropped').length === 2);
    expect(a.messages.map((message) => message.envelope?.body)).toEqual(['nine']);
    expect(
      b.receipts.map((receipt) => [receipt.status, receipt.dropReason, receipt.origMsgId]),
    ).toEqual([
      ['dropped', 'hop-loop', 'm2'],
      ['dropped', 'hop-runaway', 'm3'],
    ]);
  });

  it('lets the receive policy take what the guard admitted, and queues the rest', async () => {
    const screened: string[] = [];
    let holdOrRefuse: (message: AcceptedPeerMessage) => void = () => undefined;
    const { a, b, from, send } = await pair({
      screen: (message) => {
        screened.push(message.msgId ?? '');
        if (message.envelope?.attributes.fromMode !== 'bypass') return 'queue';
        holdOrRefuse(message);
        return 'taken';
      },
    });
    holdOrRefuse = (message) => a.inbox.acknowledge(message, 'held', 'mode-mismatch');
    await send(renderEnvelope({ from, fromMode: 'bypass' }, 'steer'), 'm1');
    await send(renderEnvelope({ from, fromMode: 'prompting' }, 'same class'), 'm2');
    // A loop the guard drops never reaches the policy.
    await send(renderEnvelope({ from, hopChain: Array(10).fill(a.inbox.hopToken!) }, 'x'), 'm3');
    await eventually(() => b.receipts.length === 2 && a.messages.length === 1);
    expect(screened).toEqual(['m1', 'm2']);
    expect(a.inbox.queued().map((message) => message.msgId)).toEqual(['m2']);
    expect(
      b.receipts
        .map((receipt) => [receipt.status, receipt.origMsgId])
        .sort((x, y) => (x[1]! < y[1]! ? -1 : 1)),
    ).toEqual([
      ['held', 'm1'],
      ['dropped', 'm3'],
    ]);
  });

  it('queues a message the session releases, and refuses it when the queue is full', async () => {
    const { a } = await pair();
    const released = { content: 'held back', receivedAt: 1 };
    expect(a.inbox.enqueue(released)).toBe(true);
    expect(a.inbox.queued()).toEqual([released]);
    expect(a.messages).toEqual([released]);
    for (let index = 1; index < 50; index++)
      a.inbox.enqueue({ content: `${index}`, receivedAt: 1 });
    expect(a.inbox.enqueue({ content: 'one too many', receivedAt: 1 })).toBe(false);
    expect(a.inbox.queued()).toHaveLength(50);
  });

  it.each(['held', 'denied', 'expired', 'released', 'refused'] as const)(
    'sends the %s receipt when the session says so',
    async (status) => {
      const { a, b, from, send } = await pair();
      await send(renderEnvelope({ from }, 'hello'), 'm1');
      await eventually(() => a.messages.length === 1);
      a.inbox.acknowledge(a.inbox.take()!, status, 'why');
      await eventually(() => b.receipts.length === 1);
      expect(b.receipts[0]).toMatchObject({ status, origMsgId: 'm1', reason: 'why' });
    },
  );

  it('sends a delivered receipt when the session acknowledges a message', async () => {
    const { a, b, from, send } = await pair();
    await send(renderEnvelope({ from }, 'hello'), 'm1');
    await eventually(() => a.messages.length === 1);
    a.inbox.acknowledge(a.inbox.take()!, 'delivered');
    await eventually(() => b.receipts.length === 1);
    expect(b.receipts[0]).toMatchObject({ status: 'delivered', origMsgId: 'm1' });
  });
});

describe.skipIf(!posix)('sendToInbox', () => {
  it('refuses a frame over the line cap before connecting', async () => {
    const result = await sendToInbox({
      socketPath: '/nowhere/1.sock',
      keysDir: '/nowhere',
      probe: probe(),
      frame: userFrame('x'.repeat(MAX_LINE_CHARS)),
    });
    expect(result.status).toBe('message_too_large');
  });

  it('is gone when nothing listens, and gives the pacer its token back', async () => {
    const pacer = new SendPacer();
    const result = await sendToInbox({
      socketPath: join(socketDir, '1.sock'),
      keysDir: liveSessionsDir(bookHome()),
      probe: probe(),
      pacer,
      frame: userFrame('hello'),
    });
    expect(result.status).toBe('gone');
    expect(pacer.available(join(socketDir, '1.sock'))).toBe(30);
  });

  it('paces a sender that would empty the receiver’s bucket', async () => {
    const a = createInbox();
    const { socketPath } = await started(a);
    const pacer = new SendPacer();
    const send = (i: number) =>
      sendToInbox({
        socketPath,
        keysDir: liveSessionsDir(bookHome()),
        probe: probe(),
        pacer,
        frame: userFrame(`m ${i}`),
      });
    for (let i = 0; i < 30; i++) expect((await send(i)).status).toBe('sent');
    expect(await send(30)).toMatchObject({ status: 'sender_paced' });
  });

  it('is gone, and sends nothing, when the only key is a stale one of a reused pid', async () => {
    const path = join(socketDir, '4444.sock');
    let connected = false;
    const listener = createServer((socket) => {
      connected = true;
      socket.destroy();
    });
    servers.push(listener);
    await new Promise<void>((resolve) => listener.listen(path, resolve));
    const keysDir = liveSessionsDir(bookHome());
    mkdirSync(keysDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(keysDir, liveSessionKeyName(4444, DOMAIN, path)),
      JSON.stringify({ peerToken: 'e'.repeat(32), procStart: 'start-old', pidDomain: DOMAIN }),
    );
    const reused: LivenessProbe = {
      isAlive: (pid) => pid === 4444,
      startToken: async () => 'start-new',
      pidDomain: async () => DOMAIN,
    };
    const result = await sendToInbox({
      socketPath: path,
      keysDir,
      probe: reused,
      frame: userFrame('x'),
    });
    expect(result.status).toBe('gone');
    expect(connected).toBe(false);
  });

  it.each([
    ['ECONNRESET', false, 'busy'],
    ['EPIPE', false, 'busy'],
    ['ECONNRESET', true, 'gone'],
    ['EPIPE', true, 'gone'],
    ['ECONNREFUSED', false, 'gone'],
    ['EAGAIN', false, 'busy'],
    ['EACCES', false, 'failed'],
  ])('classifies %s (socket gone: %s) as %s', (code, socketGone, status) => {
    expect(classifySendError(code, { socketGone }).status).toBe(status);
  });

  it("finds the key of the live owner in this session's own pid domain only", async () => {
    const a = createInbox();
    const { socketPath, keyPath } = await started(a);
    const keysDir = liveSessionsDir(bookHome());
    expect((await findPeerKey({ keysDir, socketPath, probe: probe() }))?.path).toBe(keyPath);
    // Another domain's key for the same path is never this session's to use.
    const foreignProbe = { ...probe(), pidDomain: async () => 'linux:other:pid:[1]' };
    expect(await findPeerKey({ keysDir, socketPath, probe: foreignProbe })).toBeUndefined();
    // A stale key of a dead earlier owner of the pid loses to the live one.
    const stale = join(keysDir, liveSessionKeyName(1, DOMAIN, socketPath));
    writeFileSync(
      stale,
      JSON.stringify({ peerToken: 'f'.repeat(32), procStart: 'start-1', pidDomain: DOMAIN }),
    );
    expect((await findPeerKey({ keysDir, socketPath, probe: probe() }))?.path).toBe(keyPath);
  });
});

describe('inboxStartupNotices', () => {
  it('is one notice for a start that failed, one per refused directory, and none otherwise', async () => {
    expect(
      await inboxStartupNotices(
        Promise.resolve({ status: 'failed', message: 'no usable socket directory' }),
      ),
    ).toEqual([expect.stringContaining('inbox did not start: no usable socket directory')]);
    expect(
      await inboxStartupNotices(
        Promise.resolve({
          status: 'listening',
          socketPath: '/tmp/book-socks-1/1.sock',
          movedAside: false,
          refusedDirs: ['/run/user/1/book-socks is a symlink; remove it'],
        }),
      ),
    ).toEqual([expect.stringContaining('Using /tmp/book-socks-1 instead.')]);
    expect(
      await inboxStartupNotices(
        Promise.resolve({
          status: 'listening',
          socketPath: '/tmp/book-socks-1/1.sock',
          movedAside: false,
          refusedDirs: [],
        }),
      ),
    ).toEqual([]);
  });
});
