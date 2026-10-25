import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
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
  liveSessionsDir,
  readLiveSessionEntries,
} from './registry.js';

const DOMAIN = 'linux:test-machine:pid:[4026531836]';

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

function writeRecord(value: LiveSessionRecord, pid = value.pid): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${pid}.json`), JSON.stringify(value));
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

describe('readLiveSessionEntries', () => {
  it('is empty when the directory does not exist', async () => {
    expect(await readLiveSessionEntries(dir)).toEqual([]);
  });

  it('reads only <pid>.json files, and leaves a torn or mismatched one unparsed', async () => {
    writeRecord(record(101));
    writeFileSync(join(dir, '102.json'), '{"pid": 102, "sessionId": "torn');
    writeRecord(record(999), 103);
    writeFileSync(join(dir, '101.json.lock'), '{}');
    writeFileSync(join(dir, '101.json.101.abc.tmp'), '{');
    writeFileSync(join(dir, 'notes.json'), '{}');

    const entries = await readLiveSessionEntries(dir);
    expect(entries.map((entry) => [entry.pid, entry.record?.name])).toEqual([
      [101, 'book-101'],
      [102, undefined],
      [103, undefined],
    ]);
  });

  it('keeps fields a later version adds', async () => {
    writeRecord({ ...record(101), messagingSocketPath: '/run/x.sock' } as LiveSessionRecord);
    const [entry] = await readLiveSessionEntries(dir);
    expect(entry?.record).toMatchObject({ messagingSocketPath: '/run/x.sock' });
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

  it('ignores a record from another pid domain and never deletes it', async () => {
    writeRecord(record(303, { pidDomain: 'linux:other-machine:pid:[4026532000]' }));
    writeRecord(record(304, { pidDomain: undefined }));
    // Neither pid is alive here, which is exactly what says nothing about another domain.
    expect(await listLiveSessions({ dir, probe: fakeProbe(new Map()) })).toEqual([]);
    expect(files()).toEqual(['303.json', '304.json']);
  });

  it('keeps a torn record, whose domain nothing can tell', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '305.json'), '{"pid": 305, "sessi');
    expect(await listLiveSessions({ dir, probe: fakeProbe(new Map()) })).toEqual([]);
    expect(files()).toEqual(['305.json']);
  });

  it("never sweeps this process's own file", async () => {
    writeRecord(record(306, { procStart: 'start-old' }));
    const live = await listLiveSessions({
      dir,
      probe: fakeProbe(new Map([[306, 'start-new']])),
      ownPid: 306,
    });
    expect(live).toEqual([]);
    expect(files()).toEqual(['306.json']);
  });

  it('reports without deleting when sweep is off', async () => {
    writeRecord(record(307));
    expect(await listLiveSessions({ dir, probe: fakeProbe(new Map()), sweep: false })).toEqual([]);
    expect(files()).toEqual(['307.json']);
  });

  it("does not sweep a file its pid's new owner rewrote after it was read", async () => {
    writeRecord(record(308, { procStart: 'start-old' }));
    const fresh = record(308, { procStart: 'start-new', sessionId: 'fresh' });
    const probe: LivenessProbe = {
      ...fakeProbe(new Map([[308, 'start-new']])),
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
