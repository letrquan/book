import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { AtomicJsonWriter } from '../agents/atomic-json.js';
import { isolateBookHome } from '../test/isolated-book-home.js';
import type { LiveSessionRecord } from '../types/messaging.js';
import type { LivenessProbe } from './liveness.js';
import { listLiveSessions, liveSessionsDir, readLiveSessionEntries } from './registry.js';
import { liveSessionStateOf, LiveSessionWriter, type LiveSessionWriterOptions } from './writer.js';

const bookHome = isolateBookHome('book-live-writer-');
const DOMAIN = 'linux:test-machine:pid:[4026531836]';
const PID = 4242;

/** Every pid in `processes` is alive with that start token; so is the writer's own pid. */
function probe(processes = new Map<number, string>()): LivenessProbe {
  const all = new Map([[PID, 'own-start'], ...processes]);
  return {
    isAlive: (pid) => all.has(pid),
    startToken: async (pid) => all.get(pid),
    pidDomain: async () => DOMAIN,
  };
}

/** A real atomic writer that counts the writes asked of it. */
function countingWriter(fsAsync?: ConstructorParameters<typeof AtomicJsonWriter>[0]['fsAsync']) {
  const real = new AtomicJsonWriter({ instanceId: 'test', pid: PID, hostname: 'test', fsAsync });
  const writes: LiveSessionRecord[] = [];
  return {
    writes,
    writeAsync: ((target: string, value: unknown, options?: object) => {
      writes.push(value as LiveSessionRecord);
      return real.writeAsync(target, value, options ?? {});
    }) as AtomicJsonWriter['writeAsync'],
  };
}

function createWriter(overrides: Partial<LiveSessionWriterOptions> = {}) {
  const atomic = countingWriter();
  const events = new EventEmitter();
  let clock = 1_000;
  const writer = new LiveSessionWriter({
    cwd: join('work', 'Book Repo'),
    sessionId: 'session-1',
    version: '9.9.9-test',
    pid: PID,
    probe: probe(),
    now: () => clock++,
    randomByte: () => 0x3f,
    atomicWriter: atomic,
    processEvents: events as unknown as LiveSessionWriterOptions['processEvents'],
    ...overrides,
  });
  return { writer, writes: atomic.writes, events };
}

function readRecord(path: string): LiveSessionRecord {
  return JSON.parse(readFileSync(path, 'utf8')) as LiveSessionRecord;
}

describe('liveSessionStateOf', () => {
  it('puts a pending prompt above a running turn, and names what it waits for', () => {
    expect(
      liveSessionStateOf({ running: true, permissionPending: true, inputPending: true }),
    ).toEqual({ status: 'waiting', waitingFor: 'permission prompt' });
    expect(
      liveSessionStateOf({ running: true, permissionPending: false, inputPending: true }),
    ).toEqual({ status: 'waiting', waitingFor: 'input needed' });
    expect(
      liveSessionStateOf({ running: true, permissionPending: false, inputPending: false }),
    ).toEqual({ status: 'busy' });
    expect(
      liveSessionStateOf({ running: false, permissionPending: false, inputPending: false }),
    ).toEqual({ status: 'idle' });
  });
});

describe('LiveSessionWriter', () => {
  it('registers under BOOK_HOME with every field the registry promises', async () => {
    const { writer } = createWriter();
    await writer.start();

    expect(writer.path).toBe(join(liveSessionsDir(bookHome()), `${PID}.json`));
    expect(readRecord(writer.path)).toEqual({
      pid: PID,
      sessionId: 'session-1',
      cwd: join('work', 'Book Repo'),
      startedAt: expect.any(Number),
      procStart: 'own-start',
      pidDomain: DOMAIN,
      version: '9.9.9-test',
      protocol: 1,
      features: [],
      kind: 'interactive',
      name: 'book-repo-3f',
      nameSource: 'derived',
      status: 'idle',
      statusUpdatedAt: expect.any(Number),
      updatedAt: expect.any(Number),
    });
    expect(writer.current()?.name).toBe('book-repo-3f');
    // The first status took effect when the session started, not before.
    expect(writer.current()?.statusUpdatedAt).toBe(writer.current()?.startedAt);
    if (process.platform !== 'win32') {
      expect(statSync(writer.path).mode & 0o777).toBe(0o600);
      expect(statSync(writer.dir).mode & 0o777).toBe(0o700);
    }
    await writer.close();
  });

  it('re-rolls a name a live session already holds', async () => {
    const dir = liveSessionsDir(bookHome());
    mkdirSync(dir, { recursive: true });
    const other = new LiveSessionWriter({
      cwd: join('elsewhere', 'book repo'),
      sessionId: 'other',
      version: 'x',
      pid: 77,
      probe: probe(new Map([[77, 'other-start']])),
      randomByte: () => 0x3f,
      processEvents: new EventEmitter() as unknown as LiveSessionWriterOptions['processEvents'],
    });
    await other.start();
    expect(other.current()?.name).toBe('book-repo-3f');

    const bytes = [0x3f, 0x40];
    const { writer } = createWriter({
      probe: probe(new Map([[77, 'other-start']])),
      randomByte: () => bytes.shift() ?? 0,
    });
    await writer.start();
    expect(writer.current()).toMatchObject({ name: 'book-repo-40', nameSource: 'collision' });
    await writer.close();
    await other.close();
  });

  it('writes only when the status, its reason or the session id changes', async () => {
    const { writer, writes } = createWriter();
    await writer.start();
    expect(writes).toHaveLength(1);

    writer.setState({ status: 'idle' });
    writer.setSessionId('session-1');
    await writer.flushed();
    expect(writes).toHaveLength(1);

    writer.setState({ status: 'busy' });
    await writer.flushed();
    writer.setState({ status: 'busy' });
    await writer.flushed();
    expect(writes.map((record) => record.status)).toEqual(['idle', 'busy']);

    writer.setState({ status: 'waiting', waitingFor: 'permission prompt' });
    await writer.flushed();
    writer.setState({ status: 'waiting', waitingFor: 'input needed' });
    await writer.flushed();
    writer.setState({ status: 'idle' });
    writer.setSessionId('session-2');
    await writer.flushed();

    expect(writes.map((record) => [record.status, record.waitingFor, record.sessionId])).toEqual([
      ['idle', undefined, 'session-1'],
      ['busy', undefined, 'session-1'],
      ['waiting', 'permission prompt', 'session-1'],
      ['waiting', 'input needed', 'session-1'],
      ['idle', undefined, 'session-2'],
    ]);
    expect(readRecord(writer.path)).toMatchObject({ status: 'idle', sessionId: 'session-2' });
    expect(readRecord(writer.path)).not.toHaveProperty('waitingFor');
    await writer.close();
  });

  it('coalesces changes made while a write is in flight into one write of the latest', async () => {
    const { writer, writes } = createWriter();
    await writer.start();
    writer.setState({ status: 'busy' });
    writer.setState({ status: 'waiting', waitingFor: 'permission prompt' });
    writer.setState({ status: 'busy' });
    writer.setState({ status: 'idle' });
    writer.setState({ status: 'busy' });
    await writer.flushed();
    expect(writes.map((record) => record.status)).toEqual(['idle', 'busy']);

    // A flip that ends where the record already is writes nothing at all.
    writer.setState({ status: 'idle' });
    writer.setState({ status: 'busy' });
    await writer.flushed();
    expect(writes).toHaveLength(2);
    await writer.close();
  });

  it('keeps a change made before the first write', async () => {
    const { writer, writes } = createWriter();
    writer.setState({ status: 'busy' });
    writer.setSessionId('session-early');
    await writer.start();
    expect(writes.map((record) => [record.status, record.sessionId])).toEqual([
      ['busy', 'session-early'],
    ]);
    await writer.close();
  });

  it('keeps the last good record when a write is torn before it lands', async () => {
    let failRename = false;
    const atomic = countingWriter({
      rename: async (from, to) => {
        if (failRename) throw Object.assign(new Error('disk gone'), { code: 'EIO' });
        const { rename } = await import('node:fs/promises');
        await rename(from, to);
      },
    });
    const { writer } = createWriter({ atomicWriter: atomic });
    await writer.start();

    failRename = true;
    writer.setState({ status: 'busy' });
    await writer.flushed();
    // The failed write's temp file is not a record, and the record on disk is the last whole one.
    const [entry] = await readLiveSessionEntries(writer.dir);
    expect(entry?.record).toMatchObject({ pid: PID, status: 'idle' });
    expect(await listLiveSessions({ dir: writer.dir, probe: probe(), ownPid: PID })).toHaveLength(
      1,
    );

    failRename = false;
    writer.setState({ status: 'idle' });
    writer.setState({ status: 'busy' });
    await writer.flushed();
    expect(readRecord(writer.path).status).toBe('busy');
    await writer.close();
  });

  it('removes the record on close', async () => {
    const { writer } = createWriter();
    await writer.start();
    expect(existsSync(writer.path)).toBe(true);
    await writer.close();
    expect(existsSync(writer.path)).toBe(false);
    writer.setState({ status: 'busy' });
    await writer.flushed();
    expect(readdirSync(writer.dir)).toEqual([]);
  });

  it('withdraws a write already in flight at close, so it cannot put the record back', async () => {
    const real = countingWriter();
    let entered!: () => void;
    const inFlight = new Promise<void>((resolve) => (entered = resolve));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const gated = {
      writeAsync: (async (target: string, value: unknown, options?: object) => {
        if (++calls === 2) {
          entered();
          await gate;
        }
        return real.writeAsync(target, value, options);
      }) as AtomicJsonWriter['writeAsync'],
    };
    const { writer } = createWriter({ atomicWriter: gated });
    await writer.start();
    writer.setState({ status: 'busy' });
    await inFlight;
    const closed = writer.close();
    release();
    await closed;
    expect(existsSync(writer.path)).toBe(false);
    expect(readdirSync(writer.dir)).toEqual([]);
  });

  it('removes the record synchronously when the process exits without closing', async () => {
    const { writer, events } = createWriter();
    await writer.start();
    expect(events.listenerCount('exit')).toBe(1);
    events.emit('exit', 0);
    expect(existsSync(writer.path)).toBe(false);
    writer.setState({ status: 'busy' });
    await writer.flushed();
    expect(existsSync(writer.path)).toBe(false);
  });

  it('drops its exit listener on close', async () => {
    const { writer, events } = createWriter();
    await writer.start();
    await writer.close();
    expect(events.listenerCount('exit')).toBe(0);
  });

  it.skipIf(process.platform === 'win32')(
    'writes nothing into, and removes nothing from, a directory it refuses',
    async () => {
      const target = join(bookHome(), 'elsewhere');
      mkdirSync(target, { mode: 0o700 });
      symlinkSync(target, liveSessionsDir(bookHome()));
      const { writer, writes, events } = createWriter();
      await writer.start();
      expect(writes).toEqual([]);
      expect(readdirSync(target)).toEqual([]);
      expect(events.listenerCount('exit')).toBe(0);
      writer.setState({ status: 'busy' });
      await writer.flushed();
      await writer.close();
      expect(readdirSync(target)).toEqual([]);
    },
  );
});
