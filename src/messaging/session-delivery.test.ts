/**
 * Cross-session delivery between real processes (#620 PR 3, PR 5): two sessions, each with its own
 * live-session record and messaging runtime, as the TUI's host wires them. One sends by name; the
 * other turns its queue into a `peer-message` turn and acknowledges it, or holds a message from
 * the other permission class until its user approves or denies it or it expires; the sender hears
 * each receipt as a delivery notice. Integration tier: every case spawns processes.
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
const messaging = new SessionMessaging({
  writer,
  permissionMode: process.env.PEER_MODE ?? 'default',
  ...(process.env.PEER_APPROVAL_MS ? { approvalTimeoutMs: Number(process.env.PEER_APPROVAL_MS) } : {}),
});
messaging.subscribe((event) => {
  if (event.type === 'held') {
    emit({ event: 'held', id: event.held.id, cause: event.held.cause, sender: event.held.sender });
    return;
  }
  if (event.type === 'hold-settled') {
    emit({ event: 'settled', id: event.held.id, outcome: event.outcome, by: event.by });
    return;
  }
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
  } else if (command.cmd === 'approve') {
    emit({ event: 'approved', ...messaging.approve(command.id) });
  } else if (command.cmd === 'deny') {
    emit({ event: 'denied', ok: messaging.deny(command.id) });
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

  function spawnSession(name: string, mode: string, approvalMs?: number): Session {
    const child = spawn(process.execPath, ['--import', TSX_LOADER, script], {
      env: {
        ...process.env,
        BOOK_HOME: home,
        BOOK_MESSAGING_SOCKET_DIR: socketDir,
        BOOK_SESSION_NAME: name,
        PEER_MODE: mode,
        ...(approvalMs !== undefined ? { PEER_APPROVAL_MS: String(approvalMs) } : {}),
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

  /** The notices `session` has had, flattened: each receipt's human line, in order. */
  const humanNotices = (session: Session) =>
    session.events.flatMap((event) => (event.event === 'notice' ? (event.human as string[]) : []));

  it('holds a message from the other class until its user approves, then delivers it', async () => {
    const a = spawnSession('peer-a', 'bypassPermissions');
    const b = spawnSession('peer-b', 'default');
    await a.started();
    await b.started();

    a.command({ cmd: 'send', to: 'peer-b', message: 'Run this unprompted.', mode: 'auto' });
    expect(await a.waitFor((event) => event.event === 'sent')).toMatchObject({ status: 'sent' });
    const held = await b.waitFor((event) => event.event === 'held');
    expect(held).toMatchObject({
      cause: 'mode-mismatch',
      sender: expect.stringMatching(/^peer-a \[[0-9a-f]{6}\]$/),
    });
    await a.waitFor(() => humanNotices(a).length === 1);
    expect(humanNotices(a)).toEqual([
      expect.stringMatching(/^⚠ Your message to peer-b \[[0-9a-f]{6}\] was held by that session/),
    ]);
    expect(b.events.some((event) => event.event === 'turn')).toBe(false);

    b.command({ cmd: 'approve', id: held.id });
    expect(await b.waitFor((event) => event.event === 'approved')).toMatchObject({
      outcome: 'released',
    });
    const turn = await b.waitFor((event) => event.event === 'turn');
    expect(turn.context).toContain('Run this unprompted.');
    await a.waitFor(() => humanNotices(a).length === 2);
    expect(humanNotices(a)[1]).toMatch(/was held by that session, then released and delivered\.$/);
  }, 60_000);

  it('tells the sender when a held message is denied, and when one expires', async () => {
    const a = spawnSession('peer-a', 'default');
    const b = spawnSession('peer-b', 'bypassPermissions', 1_500);
    await a.started();
    await b.started();

    a.command({ cmd: 'send', to: 'peer-b', message: 'Deny me.', mode: 'default' });
    const held = await b.waitFor((event) => event.event === 'held');
    b.command({ cmd: 'deny', id: held.id });
    expect(await b.waitFor((event) => event.event === 'denied')).toMatchObject({ ok: true });
    await a.waitFor(() => humanNotices(a).some((line) => line.includes('denied')));

    a.command({ cmd: 'send', to: 'peer-b', message: 'Let me expire.', mode: 'default' });
    await b.waitFor((event) => event.event === 'held' && event.id !== held.id);
    await b.waitFor((event) => event.event === 'settled' && event.outcome === 'expired');
    await a.waitFor(() => humanNotices(a).some((line) => line.includes('expired')));
    expect(humanNotices(a)).toEqual([
      expect.stringMatching(/was held by that session/),
      expect.stringMatching(/was denied by that session's user\.$/),
      expect.stringMatching(/was held by that session/),
      expect.stringMatching(/expired while held by that session, without being approved\.$/),
    ]);
    expect(b.events.some((event) => event.event === 'turn')).toBe(false);
  }, 60_000);
});
