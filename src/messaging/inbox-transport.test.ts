/**
 * The inbox transport between real processes (#620): two Book-side peers, each with its own inbox,
 * over real Unix sockets. Integration tier: every case spawns processes.
 *
 * Every socket stays under a temporary `BOOK_MESSAGING_SOCKET_DIR`, and every key under a
 * temporary `BOOK_HOME`, never the developer's own.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { liveSessionsDir } from './registry.js';
import { serializeFrame } from './wire.js';

const TSX_LOADER = import.meta.resolve('tsx');
const moduleUrl = (name: string) =>
  pathToFileURL(fileURLToPath(new URL(`./${name}`, import.meta.url))).href;

/**
 * A peer process: an inbox, plus a sender that takes commands on stdin. Every event goes to
 * stdout as one JSON line. `exit` leaves through `process.exit`, the way `cli/exit.ts` does, so
 * only the exit backstop can clean up.
 */
const PEER_SCRIPT = `
import { createInterface } from 'node:readline';
const { InboxServer } = await import(${JSON.stringify(moduleUrl('inbox-server.ts'))});
const { sendToInbox } = await import(${JSON.stringify(moduleUrl('inbox-client.ts'))});
const { createLivenessProbe } = await import(${JSON.stringify(moduleUrl('liveness.ts'))});
const { liveSessionsDir } = await import(${JSON.stringify(moduleUrl('registry.ts'))});
const { encodeUdsAddress } = await import(${JSON.stringify(moduleUrl('wire.ts'))});
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const inbox = new InboxServer({
  sessionId: () => 'peer-session',
  ...(process.env.PEER_PID ? { pid: Number(process.env.PEER_PID) } : {}),
  limits: { receiptTrailMs: 200 },
  onMessage: (message) => emit({ event: 'message', content: message.content, msgId: message.msgId }),
  onReceipt: (receipt) => emit({ event: 'receipt', ...receipt }),
});
const started = await inbox.start();
emit({ event: 'started', ...started, keyPath: inbox.keyPath });
const probe = createLivenessProbe();
const keysDir = liveSessionsDir();
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.cmd === 'send') {
    const results = [];
    for (let i = 0; i < command.count; i++) {
      results.push(
        await sendToInbox({
          socketPath: command.to,
          keysDir,
          probe,
          frame: {
            type: 'user',
            message: { role: 'user', content: command.content + ' ' + i },
            priority: 'next',
            from: encodeUdsAddress(inbox.socketPath),
            msg_id: command.content + '-' + i,
          },
        }),
      );
    }
    emit({ event: 'sent', results });
  } else if (command.cmd === 'queued') {
    emit({ event: 'queued', count: inbox.queued().length });
  } else if (command.cmd === 'exit') {
    process.exit(0);
  }
}
`;

interface PeerEvent {
  event: string;
  [field: string]: unknown;
}

class Peer {
  readonly events: PeerEvent[] = [];
  readonly exited: Promise<number | null>;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly child: ChildProcess) {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      try {
        this.events.push(JSON.parse(line) as PeerEvent);
      } catch {
        return;
      }
      for (const wake of this.waiters.splice(0)) wake();
    });
    this.exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
  }

  command(value: object): void {
    this.child.stdin!.write(`${JSON.stringify(value)}\n`);
  }

  async waitFor(match: (event: PeerEvent) => boolean, timeoutMs = 20_000): Promise<PeerEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find(match);
      if (found) return found;
      if (Date.now() > deadline) {
        throw new Error(`no matching event; saw ${JSON.stringify(this.events).slice(0, 2000)}`);
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 100).unref();
      });
    }
  }

  async started(): Promise<{ socketPath: string; keyPath: string; movedAside: boolean }> {
    const event = await this.waitFor((candidate) => candidate.event === 'started');
    if (event.status !== 'listening')
      throw new Error(`peer did not start: ${String(event.message)}`);
    return event as unknown as { socketPath: string; keyPath: string; movedAside: boolean };
  }
}

describe.skipIf(process.platform === 'win32')('inbox transport between processes', () => {
  let root: string;
  let home: string;
  let socketDir: string;
  let script: string;
  const peers: Peer[] = [];

  beforeAll(() => {
    root = realpathSync(
      mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'bk-it-')),
    );
    home = join(root, 'home');
    socketDir = join(root, 's');
    script = join(root, 'peer.mjs');
    writeFileSync(script, PEER_SCRIPT);
  });

  afterEach(async () => {
    for (const peer of peers.splice(0)) {
      peer.child.kill('SIGKILL');
      await peer.exited;
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function spawnPeer(env: Record<string, string> = {}): Peer {
    const child = spawn(process.execPath, ['--import', TSX_LOADER, script], {
      env: {
        ...process.env,
        BOOK_HOME: home,
        BOOK_MESSAGING_SOCKET_DIR: socketDir,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const peer = new Peer(child);
    peers.push(peer);
    return peer;
  }

  it('delivers a frame from one process into the other’s queue', async () => {
    const a = spawnPeer();
    const b = spawnPeer();
    const { socketPath: aSocket } = await a.started();
    await b.started();

    b.command({ cmd: 'send', to: aSocket, content: 'hello from b', count: 1 });
    expect(await b.waitFor((event) => event.event === 'sent')).toMatchObject({
      results: [{ status: 'sent' }],
    });
    expect(await a.waitFor((event) => event.event === 'message')).toMatchObject({
      content: 'hello from b 0',
      msgId: 'hello from b-0',
    });
  }, 60_000);

  it('closes a connection with the wrong token, and queues nothing from it', async () => {
    const a = spawnPeer();
    const { socketPath } = await a.started();
    const reply = await new Promise<string>((resolve) => {
      let text = '';
      const socket = createConnection({ path: socketPath });
      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => (text += chunk));
      socket.on('error', () => undefined);
      socket.once('connect', () =>
        socket.write(
          serializeFrame({ type: 'auth', token: 'fedcba9876543210fedcba9876543210' }) +
            serializeFrame({ type: 'user', message: { role: 'user', content: 'sneaky' } }),
        ),
      );
      // Never ended from this side: only the receiver closing it ends the wait.
      socket.once('close', () => resolve(text));
    });
    expect(reply).toBe('');
    a.command({ cmd: 'queued' });
    expect(await a.waitFor((event) => event.event === 'queued')).toMatchObject({ count: 0 });
  }, 60_000);

  it('sends dropped receipts for a flood past the bucket back to the sender’s inbox', async () => {
    const a = spawnPeer();
    const b = spawnPeer();
    const { socketPath: aSocket } = await a.started();
    await b.started();

    b.command({ cmd: 'send', to: aSocket, content: 'flood', count: 40 });
    await b.waitFor((event) => event.event === 'sent');
    const first = await b.waitFor((event) => event.event === 'receipt');
    expect(first).toMatchObject({ status: 'dropped', dropReason: 'rate-limited' });
    // The drops after the first come back batched, naming each id; the trail is 200 ms here.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const all = Array.from({ length: 40 }, (_, i) => `flood-${i}`);
    const delivered = a.events
      .filter((event) => event.event === 'message')
      .map((event) => String(event.msgId));
    const receipts = b.events.filter((event) => event.event === 'receipt');
    const dropped = receipts.flatMap((event) => [
      ...(Array.isArray(event.droppedMsgIds) && event.droppedMsgIds.length > 0
        ? (event.droppedMsgIds as string[])
        : [String(event.origMsgId)]),
    ]);
    expect(delivered.length).toBeGreaterThanOrEqual(30);
    // Fewer receipts than drops: the flood was batched, not receipted message by message.
    expect(receipts.length).toBeLessThan(dropped.length);
    expect([...delivered, ...dropped].sort()).toEqual([...all].sort());
    expect(receipts.every((event) => event.status === 'dropped')).toBe(true);
  }, 60_000);

  it('removes the socket and the key when the process exits, and a sender then gets gone', async () => {
    const a = spawnPeer();
    const b = spawnPeer();
    const { socketPath: aSocket, keyPath: aKey } = await a.started();
    await b.started();
    expect(existsSync(aSocket)).toBe(true);
    expect(existsSync(aKey)).toBe(true);

    a.command({ cmd: 'exit' });
    expect(await a.exited).toBe(0);
    expect(existsSync(aSocket)).toBe(false);
    expect(existsSync(aKey)).toBe(false);
    expect(readdirSync(liveSessionsDir(home)).some((name) => name.endsWith('.tmp'))).toBe(false);

    b.command({ cmd: 'send', to: aSocket, content: 'anyone there', count: 1 });
    expect(await b.waitFor((event) => event.event === 'sent')).toMatchObject({
      results: [{ status: 'gone' }],
    });
  }, 60_000);

  it('binds a moved-aside socket when a live session in another namespace holds its pid', async () => {
    const a = spawnPeer();
    const { socketPath: aSocket } = await a.started();
    // A second process told it has A's pid: what a container sharing the directory would be.
    const twin = spawnPeer({ PEER_PID: String(a.child.pid) });
    const { socketPath: twinSocket, movedAside } = await twin.started();
    expect(movedAside).toBe(true);
    expect(twinSocket).toMatch(new RegExp(`/${a.child.pid}-[0-9a-f]{8}\\.sock$`));
    expect(existsSync(aSocket)).toBe(true);

    // Both stay reachable, each by its own key.
    const b = spawnPeer();
    await b.started();
    b.command({ cmd: 'send', to: twinSocket, content: 'to the twin', count: 1 });
    expect(await twin.waitFor((event) => event.event === 'message')).toMatchObject({
      content: 'to the twin 0',
    });
  }, 60_000);
});
