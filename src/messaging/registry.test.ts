import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LiveSessionRecord } from '../types/messaging.js';
import { createLivenessProbe, type LivenessProbe } from './liveness.js';
import {
  ensureLiveSessionsDir,
  inspectLiveSessionsDir,
  listLiveSessions,
  LiveSessionsDirRefusedError,
  liveSessionKeyName,
  liveSessionRecordName,
  liveSessionsDir,
  parseLiveSessionKeyName,
  readLiveSessionEntries,
} from './registry.js';

const DOMAIN = 'linux:test-machine:pid:[4026531836]';
const OTHER_DOMAIN = 'linux:other-machine:pid:[4026532000]';
const HOUR = 60 * 60 * 1000;

let root: string;
let dir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'book-live-sessions-'));
  dir = liveSessionsDir(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function record(pid: number, overrides: Partial<LiveSessionRecord> = {}): LiveSessionRecord {
  return {
    pid,
    sessionId: `session-${pid}`,
    cwd: '/work/book',
    startedAt: 1_000 + pid,
    procStart: `start-${pid}`,
    pidDomain: DOMAIN,
    version: '0.0.0-test',
    protocol: 1,
    features: [],
    kind: 'interactive',
    name: `book-${pid}`,
    nameSource: 'derived',
    status: 'idle',
    statusUpdatedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

/** Write a record body under the file name its own pid and domain give it, or under `name`. */
function writeRecord<T extends { pid: number; pidDomain?: string }>(
  value: T,
  name?: string,
): string {
  mkdirSync(dir, { recursive: true });
  const fileName = name ?? liveSessionRecordName(value.pid, value.pidDomain);
  writeFileSync(join(dir, fileName), JSON.stringify(value));
  return fileName;
}

/** A copy of `value` without `keys`. */
function without<T extends object>(
  value: T,
  ...keys: Array<keyof T>
): Partial<T> & { pid: number } {
  const copy: Partial<T> = { ...value };
  for (const key of keys) delete copy[key];
  return copy as Partial<T> & { pid: number };
}

/** A probe where `processes` maps each live pid to its start token. */
function fakeProbe(processes: Map<number, string | undefined>, domain = DOMAIN): LivenessProbe {
  return {
    isAlive: (pid) => processes.has(pid),
    startToken: async (pid) => processes.get(pid),
    pidDomain: async () => domain,
  };
}

function files(): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

describe('ensureLiveSessionsDir', () => {
  it.skipIf(process.platform === 'win32')('creates the directory 0700', async () => {
    await ensureLiveSessionsDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(await inspectLiveSessionsDir(dir)).toBe('ok');
  });

  it.skipIf(process.platform === 'win32')(
    'tightens a directory of ours that other users can read',
    async () => {
      mkdirSync(dir, { recursive: true, mode: 0o755 });
      chmodSync(dir, 0o755);
      expect(await inspectLiveSessionsDir(dir)).toBe('loose-mode');
      await ensureLiveSessionsDir(dir);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    },
  );

  it.skipIf(process.platform === 'win32')('refuses a symlink, wherever it points', async () => {
    const target = join(root, 'elsewhere');
    mkdirSync(target, { mode: 0o700 });
    symlinkSync(target, dir);
    expect(await inspectLiveSessionsDir(dir)).toBe('symlink');
    const refusal = await ensureLiveSessionsDir(dir).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(LiveSessionsDirRefusedError);
    expect((refusal as LiveSessionsDirRefusedError).state).toBe('symlink');
  });

  it('refuses a file where the directory should be', async () => {
    writeFileSync(dir, 'not a directory');
    expect(await inspectLiveSessionsDir(dir)).toBe('not-directory');
    await expect(ensureLiveSessionsDir(dir)).rejects.toBeInstanceOf(LiveSessionsDirRefusedError);
  });

  it('reports a missing directory without creating it', async () => {
    expect(await inspectLiveSessionsDir(dir)).toBe('missing');
    expect(existsSync(dir)).toBe(false);
  });
});

describe('liveSessionRecordName', () => {
  it('tags the file with its pid domain, so pid namespaces sharing a home never share a file', () => {
    const tag = createHash('sha256').update(DOMAIN).digest('hex').slice(0, 12);
    expect(liveSessionRecordName(23, DOMAIN)).toBe(`23.${tag}.json`);
    expect(liveSessionRecordName(23, OTHER_DOMAIN)).not.toBe(liveSessionRecordName(23, DOMAIN));
  });

  it('is the bare pid where the platform has no pid domain', () => {
    expect(liveSessionRecordName(23)).toBe('23.json');
  });
});

describe('readLiveSessionEntries', () => {
  it('is empty when the directory does not exist', async () => {
    expect(await readLiveSessionEntries(dir)).toEqual([]);
  });

  it('reads only record files, and leaves a torn or mismatched one unparsed', async () => {
    const live = writeRecord(record(101));
    writeFileSync(join(dir, liveSessionRecordName(102, DOMAIN)), '{"pid": 102, "sessionId": "torn');
    // A body naming another pid than its file.
    writeRecord(record(999), liveSessionRecordName(103, DOMAIN));
    // A body naming another domain than its file's tag.
    writeRecord(record(104, { pidDomain: OTHER_DOMAIN }), liveSessionRecordName(104, DOMAIN));
    // A body with a domain in a file without a tag.
    writeRecord(record(105), '105.json');
    writeFileSync(join(dir, `${live}.lock`), '{}');
    writeFileSync(join(dir, `${live}.101.abc.tmp`), '{');
    writeFileSync(join(dir, 'notes.json'), '{}');

    const entries = await readLiveSessionEntries(dir);
    expect(entries.map((entry) => [entry.pid, entry.record?.name])).toEqual([
      [101, 'book-101'],
      [102, undefined],
      [103, undefined],
      [104, undefined],
      [105, undefined],
    ]);
  });

  it('parses a record a later version writes: new values and new fields are kept', async () => {
    writeRecord({
      ...record(106),
      kind: 'headless',
      status: 'compacting',
      waitingFor: 'a review',
      nameSource: 'rename',
      messagingSocketPath: '/run/x.sock',
    });
    const [entry] = await readLiveSessionEntries(dir);
    expect(entry?.record).toMatchObject({
      pid: 106,
      kind: 'headless',
      status: 'compacting',
      waitingFor: 'a review',
      nameSource: 'rename',
      messagingSocketPath: '/run/x.sock',
    });
  });

  it('counts a record as torn only when an essential field is missing', async () => {
    writeRecord(without(record(107), 'name'));
    writeRecord(without(record(108), 'startedAt'));
    writeRecord({ ...without(record(109), 'version', 'features', 'cwd'), status: 42 });
    const entries = await readLiveSessionEntries(dir);
    expect(entries.map((entry) => [entry.pid, entry.record?.name])).toEqual([
      [107, undefined],
      [108, undefined],
      [109, 'book-109'],
    ]);
  });
});

describe('listLiveSessions', () => {
  it('lists records whose pid is alive with a matching start token, oldest first', async () => {
    writeRecord(record(202, { startedAt: 5 }));
    writeRecord(record(201, { startedAt: 9 }));
    const live = await listLiveSessions({
      dir,
      probe: fakeProbe(
        new Map([
          [201, 'start-201'],
          [202, 'start-202'],
        ]),
      ),
    });
    expect(live.map((entry) => entry.pid)).toEqual([202, 201]);
  });

  it('sweeps a record whose pid is dead', async () => {
    writeRecord(record(301));
    expect(await listLiveSessions({ dir, probe: fakeProbe(new Map()) })).toEqual([]);
    expect(files()).toEqual([]);
  });

  it('sweeps a record whose pid was reused by a later process', async () => {
    writeRecord(record(302, { procStart: 'start-old' }));
    const live = await listLiveSessions({ dir, probe: fakeProbe(new Map([[302, 'start-new']])) });
    expect(live).toEqual([]);
    expect(files()).toEqual([]);
  });

  it('keeps a fresh record from another pid domain, whatever its pid looks like here', async () => {
    const now = 100 * HOUR;
    const foreign = writeRecord(record(303, { pidDomain: OTHER_DOMAIN, updatedAt: now - HOUR }));
    const unscoped = writeRecord(record(304, { pidDomain: undefined, updatedAt: now - HOUR }));
    // Neither pid is alive here, which says nothing about another domain.
    expect(await listLiveSessions({ dir, probe: fakeProbe(new Map()), now: () => now })).toEqual(
      [],
    );
    expect(files()).toEqual([foreign, unscoped].sort());
  });

  it('sweeps a record from another pid domain once nothing has refreshed it for a day', async () => {
    const now = 100 * HOUR;
    writeRecord(record(305, { pidDomain: OTHER_DOMAIN, updatedAt: now - 25 * HOUR }));
    writeRecord(record(306, { pidDomain: undefined, updatedAt: now - 25 * HOUR }));
    expect(await listLiveSessions({ dir, probe: fakeProbe(new Map()), now: () => now })).toEqual(
      [],
    );
    expect(files()).toEqual([]);
  });

  it('judges a record of this domain by its process alone, never by its age', async () => {
    const now = 100 * HOUR;
    writeRecord(record(307, { updatedAt: now - 90 * HOUR }));
    const live = await listLiveSessions({
      dir,
      probe: fakeProbe(new Map([[307, 'start-307']])),
      now: () => now,
    });
    expect(live.map((entry) => entry.pid)).toEqual([307]);
  });

  it('keeps a torn record, whose domain nothing can tell', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '308.json'), '{"pid": 308, "sessi');
    expect(await listLiveSessions({ dir, probe: fakeProbe(new Map()) })).toEqual([]);
    expect(files()).toEqual(['308.json']);
  });

  it('sweeps lock and temp files a crashed writer left over an hour ago, and no younger ones', async () => {
    mkdirSync(dir, { recursive: true });
    const stem = liveSessionRecordName(309, DOMAIN);
    const old = [`${stem}.lock`, `${stem}.309.abc.def.tmp`, '310.json.lock'];
    const young = [`${liveSessionRecordName(311, DOMAIN)}.lock`, '312.json.312.a.b.tmp'];
    const unrelated = ['notes.txt.lock', 'README.tmp'];
    const now = Date.now();
    for (const name of [...old, ...young, ...unrelated]) writeFileSync(join(dir, name), '{}');
    for (const name of [...old, ...unrelated]) {
      const then = new Date(now - 2 * HOUR);
      utimesSync(join(dir, name), then, then);
    }
    await listLiveSessions({ dir, probe: fakeProbe(new Map()), now: () => now });
    expect(files()).toEqual([...young, ...unrelated].sort());
  });

  it("never sweeps this process's own file", async () => {
    writeRecord(record(313, { procStart: 'start-old' }));
    const live = await listLiveSessions({
      dir,
      probe: fakeProbe(new Map([[313, 'start-new']])),
      ownPid: 313,
    });
    expect(live).toEqual([]);
    expect(files()).toEqual([liveSessionRecordName(313, DOMAIN)]);
  });

  it('reports without deleting when sweep is off', async () => {
    const now = 100 * HOUR;
    const dead = writeRecord(record(314));
    const stale = writeRecord(record(315, { pidDomain: OTHER_DOMAIN, updatedAt: 0 }));
    const lock = `${dead}.lock`;
    writeFileSync(join(dir, lock), '{}');
    utimesSync(join(dir, lock), new Date(0), new Date(0));
    expect(
      await listLiveSessions({ dir, probe: fakeProbe(new Map()), sweep: false, now: () => now }),
    ).toEqual([]);
    expect(files()).toEqual([dead, lock, stale].sort());
  });

  it("does not sweep a file its pid's new owner rewrote after it was read", async () => {
    writeRecord(record(316, { procStart: 'start-old' }));
    const fresh = record(316, { procStart: 'start-new', sessionId: 'fresh' });
    const probe: LivenessProbe = {
      ...fakeProbe(new Map([[316, 'start-new']])),
      // The new owner registers between the read and the sweep.
      startToken: async () => {
        writeRecord(fresh);
        return 'start-new';
      },
    };
    expect(await listLiveSessions({ dir, probe })).toEqual([]);
    const [entry] = await readLiveSessionEntries(dir);
    expect(entry?.record?.sessionId).toBe('fresh');
  });

  it('leaves a dead record alone while a writer holds its lock', async () => {
    const name = writeRecord(record(317));
    writeFileSync(join(dir, `${name}.lock`), '{}');
    expect(await listLiveSessions({ dir, probe: fakeProbe(new Map()) })).toEqual([]);
    expect(files()).toEqual([name, `${name}.lock`]);
    rmSync(join(dir, `${name}.lock`));
    await listLiveSessions({ dir, probe: fakeProbe(new Map()) });
    expect(files()).toEqual([]);
  });

  it('counts, sweeps and lists a record a later version wrote', async () => {
    writeRecord({ ...record(318), kind: 'headless', status: 'compacting' });
    writeRecord({ ...record(319), kind: 'headless', status: 'compacting' });
    const live = await listLiveSessions({ dir, probe: fakeProbe(new Map([[318, 'start-318']])) });
    expect(live.map((entry) => [entry.pid, entry.name])).toEqual([[318, 'book-318']]);
    expect(files()).toEqual([liveSessionRecordName(318, DOMAIN)]);
  });

  it('checks records in parallel, a few at a time', async () => {
    const pids = Array.from({ length: 20 }, (_, index) => 400 + index);
    for (const pid of pids) writeRecord(record(pid));
    let inFlight = 0;
    let most = 0;
    const probe: LivenessProbe = {
      isAlive: () => true,
      startToken: async (pid) => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return `start-${pid}`;
      },
      pidDomain: async () => DOMAIN,
    };
    const live = await listLiveSessions({ dir, probe });
    expect(live).toHaveLength(pids.length);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(8);
  });

  it('stops early when its signal is aborted', async () => {
    for (const pid of [501, 502, 503]) writeRecord(record(pid));
    const controller = new AbortController();
    controller.abort();
    expect(
      await listLiveSessions({ dir, probe: fakeProbe(new Map()), signal: controller.signal }),
    ).toEqual([]);
    expect(files()).toHaveLength(3);
  });
});

describe('inbox keys (#620)', () => {
  const SOCKET = '/run/user/1000/book-socks/401.sock';
  const TOKEN = '0123456789abcdef0123456789abcdef';

  function writeKey(
    pid: number,
    pidDomain: string | undefined,
    procStart?: string,
    ageMs = 0,
  ): string {
    mkdirSync(dir, { recursive: true });
    const name = liveSessionKeyName(pid, pidDomain, `/socks/${pid}.sock`);
    const path = join(dir, name);
    writeFileSync(
      path,
      JSON.stringify({
        peerToken: TOKEN,
        ...(procStart !== undefined ? { procStart } : {}),
        ...(pidDomain !== undefined ? { pidDomain } : {}),
      }),
    );
    if (ageMs > 0) {
      const then = new Date(Date.now() - ageMs);
      utimesSync(path, then, then);
    }
    return name;
  }

  it('names a key after its pid, its domain and the full hash of its socket path', () => {
    const hash = createHash('sha256').update(SOCKET).digest('hex');
    const tag = createHash('sha256').update(DOMAIN).digest('hex').slice(0, 12);
    expect(liveSessionKeyName(401, DOMAIN, SOCKET)).toBe(`401.${tag}.${hash}.key`);
    expect(liveSessionKeyName(401, undefined, SOCKET)).toBe(`401.${hash}.key`);
    expect(parseLiveSessionKeyName(`401.${tag}.${hash}.key`)).toEqual({ pid: 401, tag, hash });
    expect(parseLiveSessionKeyName(`401.${hash}.key`)).toEqual({ pid: 401, hash });
    expect(parseLiveSessionKeyName(`401.${hash.slice(1)}.key`)).toBeUndefined();
    // A record is not a key.
    expect(parseLiveSessionKeyName(liveSessionRecordName(401, DOMAIN))).toBeUndefined();
  });

  it("sweeps a key of this domain once its owner is gone, with its record's sweep", async () => {
    writeRecord(record(402));
    writeKey(402, DOMAIN, 'start-402');
    await listLiveSessions({ dir, probe: fakeProbe(new Map()) });
    expect(files()).toEqual([]);
  });

  it('sweeps a key whose pid a later process reuses', async () => {
    writeKey(403, DOMAIN, 'start-old');
    await listLiveSessions({ dir, probe: fakeProbe(new Map([[403, 'start-new']])) });
    expect(files()).toEqual([]);
  });

  it('keeps the key of a live owner, record or not, whatever its age', async () => {
    const name = writeKey(404, DOMAIN, 'start-404', 5 * HOUR);
    await listLiveSessions({ dir, probe: fakeProbe(new Map([[404, 'start-404']])) });
    expect(files()).toEqual([name]);
  });

  it('keeps a key from another domain while its record is there', async () => {
    const now = Date.now();
    const recordName = writeRecord(record(405, { pidDomain: OTHER_DOMAIN, updatedAt: now }));
    const keyName = writeKey(405, OTHER_DOMAIN, 'start-405', 5 * HOUR);
    await listLiveSessions({ dir, probe: fakeProbe(new Map()), now: () => now });
    expect(files()).toEqual([keyName, recordName].sort());
  });

  it("sweeps a key from another domain with its record's day-old sweep", async () => {
    const now = Date.now();
    writeRecord(record(406, { pidDomain: OTHER_DOMAIN, updatedAt: now - 25 * HOUR }));
    writeKey(406, OTHER_DOMAIN, 'start-406', 25 * HOUR);
    await listLiveSessions({ dir, probe: fakeProbe(new Map()), now: () => now });
    expect(files()).toEqual([]);
  });

  it('sweeps an orphan key nothing can judge once it is over an hour old, and no younger', async () => {
    const now = Date.now();
    writeKey(407, OTHER_DOMAIN, 'start-407', 2 * HOUR);
    writeKey(408, undefined, undefined, 2 * HOUR);
    const young = writeKey(409, OTHER_DOMAIN, 'start-409', 10 * 60 * 1000);
    mkdirSync(dir, { recursive: true });
    const torn = liveSessionKeyName(410, DOMAIN, '/socks/410.sock');
    writeFileSync(join(dir, torn), '{"peerTok');
    await listLiveSessions({ dir, probe: fakeProbe(new Map()), now: () => now });
    expect(files()).toEqual([young, torn].sort());
  });

  it("never sweeps this process's own key", async () => {
    const name = writeKey(process.pid, DOMAIN, 'start-old');
    await listLiveSessions({ dir, probe: fakeProbe(new Map()), ownPid: process.pid });
    expect(files()).toEqual([name]);
  });

  it("sweeps a key writer's leftover lock and temp files", async () => {
    mkdirSync(dir, { recursive: true });
    const stem = liveSessionKeyName(411, DOMAIN, '/socks/411.sock');
    const now = Date.now();
    for (const name of [`${stem}.lock`, `${stem}.411.abc.def.tmp`]) {
      writeFileSync(join(dir, name), '{}');
      const then = new Date(now - 2 * HOUR);
      utimesSync(join(dir, name), then, then);
    }
    await listLiveSessions({ dir, probe: fakeProbe(new Map()), now: () => now });
    expect(files()).toEqual([]);
  });

  it('leaves keys alone when sweep is off', async () => {
    const name = writeKey(412, DOMAIN, 'start-412');
    await listLiveSessions({ dir, probe: fakeProbe(new Map()), sweep: false });
    expect(files()).toEqual([name]);
  });
});

describe('a real child process', () => {
  it('is live while it runs and is swept once it exits', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    try {
      const pid = child.pid!;
      const probe = createLivenessProbe();
      const procStart = await probe.startToken(pid);
      if (process.platform === 'linux' || process.platform === 'darwin') {
        expect(procStart).toBeDefined();
      }
      const pidDomain = await probe.pidDomain();
      writeRecord(record(pid, { procStart, pidDomain }));

      const live = await listLiveSessions({ dir, probe });
      expect(live.map((entry) => entry.pid)).toEqual([pid]);

      child.kill();
      await exited;
      expect(await listLiveSessions({ dir, probe })).toEqual([]);
      expect(files()).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  });
});
