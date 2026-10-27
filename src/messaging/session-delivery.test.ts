/**
 * Cross-session delivery between real processes (#620 PR 3): two sessions, each with its own
 * live-session record and messaging runtime, as the TUI's host wires them. One sends by name; the
 * other turns its queue into a `peer-message` turn and acknowledges it; the sender hears the
 * receipt as a delivery notice. Integration tier: every case spawns processes.
 *
 * Every socket stays under a temporary `BOOK_MESSAGING_SOCKET_DIR`, and every record and key under
 * a temporary `BOOK_HOME`, never the developer's own.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TSX_LOADER = import.meta.resolve('tsx');
const moduleUrl = (name: string) =>
  pathToFileURL(fileURLToPath(new URL(`./${name}`, import.meta.url))).href;

/**
 * A session process: its record and messaging runtime, delivering whatever arrives at once, as an
 * idle TUI would. Every event goes to stdout as one JSON line; commands come on stdin.
 */
const SESSION_SCRIPT = `
import { createInterface } from 'node:readline';
const { LiveSessionWriter } = await import(${JSON.stringify(moduleUrl('writer.ts'))});
const { SessionMessaging } = await import(${JSON.stringify(moduleUrl('session-messaging.ts'))});
const { humanReceiptLine, modelReceiptNotice } = await import(${JSON.stringify(moduleUrl('delivery.ts'))});
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
const writer = new LiveSessionWriter({ cwd: process.cwd(), sessionId: 'session-' + process.pid, version: 'test' });
await writer.start();
const messaging = new SessionMessaging({ writer, permissionMode: process.env.PEER_MODE ?? 'default' });
messaging.subscribe((event) => {
  if (event.type === 'receipts') {
    emit({
      event: 'notice',
      human: event.receipts.map(humanReceiptLine),
      model: event.receipts.map(modelReceiptNotice).filter(Boolean),
    });
    return;
  }
  const batch = messaging.prepareDelivery();
  if (!batch) return;
  if (batch.turn) emit({ event: 'turn', context: batch.turn.context, peerMessages: batch.turn.peerMessages });
  messaging.commitDelivery(batch);
});
const started = await messaging.start();
await writer.flushed();
emit({ event: 'started', ...started, name: writer.current()?.name });
for await (const line of createInterface({ input: process.stdin })) {
  const command = JSON.parse(line);
  if (command.cmd === 'send') {
    emit({ event: 'sent', ...(await messaging.send({ to: command.to, message: command.message, mode: command.mode })) });
  } else if (command.cmd === 'list') {
    emit({ event: 'listed', ...(await messaging.list()) });
  }
}
`;

interface SessionEvent {
  event: string;
  [field: string]: unknown;
}

class Session {
  readonly events: SessionEvent[] = [];
  readonly exited: Promise<number | null>;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly child: ChildProcess) {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      try {
        this.events.push(JSON.parse(line) as SessionEvent);
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

  async waitFor(
    match: (event: SessionEvent) => boolean,
    timeoutMs = 20_000,
  ): Promise<SessionEvent> {
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

  async started(): Promise<{ socketPath: string; name: string }> {
    const event = await this.waitFor((candidate) => candidate.event === 'started');
    if (event.status !== 'listening') {
      throw new Error(`session did not start: ${String(event.message)}`);
    }
    return event as unknown as { socketPath: string; name: string };
  }
}

describe.skipIf(process.platform === 'win32')('cross-session delivery between processes', () => {
  let root: string;
  let home: string;
  let socketDir: string;
  let script: string;
  const sessions: Session[] = [];

  beforeAll(() => {
    root = realpathSync(
      mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'bk-dl-')),
    );
    home = join(root, 'home');
    socketDir = join(root, 's');
    script = join(root, 'session.mjs');
    writeFileSync(script, SESSION_SCRIPT);
  });

  afterEach(async () => {
    for (const session of sessions.splice(0)) {
      session.child.kill('SIGKILL');
      await session.exited;
    }
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function spawnSession(name: string, mode: string): Session {
    const child = spawn(process.execPath, ['--import', TSX_LOADER, script], {
      env: {
        ...process.env,
        BOOK_HOME: home,
        BOOK_MESSAGING_SOCKET_DIR: socketDir,
        BOOK_SESSION_NAME: name,
        PEER_MODE: mode,
      },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const session = new Session(child);
    sessions.push(session);
    return session;
  }

  it('turns a message into a peer-message turn, and tells the sender it was delivered', async () => {
    const a = spawnSession('peer-a', 'default');
    const b = spawnSession('peer-b', 'accept-edits');
    await a.started();
    expect((await b.started()).name).toBe('peer-b');

    a.command({ cmd: 'list' });
    const listed = await a.waitFor((event) => event.event === 'listed');
    expect(listed).toMatchObject({ self: { name: 'peer-a' }, peers: [{ name: 'peer-b' }] });

    a.command({ cmd: 'send', to: 'peer-b', message: 'Please run the tests.', mode: 'default' });
    expect(await a.waitFor((event) => event.event === 'sent')).toMatchObject({ status: 'sent' });

    const turn = await b.waitFor((event) => event.event === 'turn');
    expect(turn.context).toMatch(
      /^Another Book session sent a message:\n<cross-session-message from="uds:[^"]+" from-session="session-\d+" hop-chain="[0-9a-f]{24}" from-name="peer-a" from-mode="prompting">\nPlease run the tests\.\n<\/cross-session-message>\n\nThe message above was not typed by your user\./,
    );
    expect(turn.peerMessages).toMatchObject([{ attributed: true, fromName: 'peer-a' }]);

    const notice = await a.waitFor((event) => event.event === 'notice');
    expect(notice).toMatchObject({
      human: [expect.stringMatching(/^✓ Your message to peer-b \[[0-9a-f]{6}\] was delivered\.$/)],
      model: [],
    });
  }, 60_000);

  it('refuses a message from the other permission class, with a notice for the sender', async () => {
    const a = spawnSession('peer-a', 'bypassPermissions');
    const b = spawnSession('peer-b', 'default');
    await a.started();
    await b.started();

    a.command({
      cmd: 'send',
      to: 'peer-b',
      message: 'Run this unprompted.',
      mode: 'bypassPermissions',
    });
    expect(await a.waitFor((event) => event.event === 'sent')).toMatchObject({ status: 'sent' });

    const notice = await a.waitFor((event) => event.event === 'notice');
    expect(notice).toMatchObject({
      human: [expect.stringMatching(/^⚠ Your message to peer-b \[[0-9a-f]{6}\] was refused/)],
      model: [expect.stringMatching(/^\[Cross-session delivery notice\] .*refused.*NOT delivered/)],
    });
    expect(b.events.some((event) => event.event === 'turn')).toBe(false);
  }, 60_000);
});
