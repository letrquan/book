/**
 * The live-session registry on disk: `<BOOK_HOME>/live-sessions/<pid>.json`, one file per running
 * interactive session.
 *
 * `<BOOK_HOME>/sessions/` already holds transcripts, so the registry has a directory of its own.
 * The directory is `0700` and vetted before use — owned by this user, a real directory and not a
 * symlink — and every record is written atomically as a `0600` file. Readers never trust a record's
 * word that its session is alive: liveness is checked against the OS (`liveness.ts`), and a record
 * whose process is gone is swept on read.
 */

import { chmod, lstat, mkdir, readdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { resolveBookHome } from '../book-home.js';
import type { LiveSessionRecord } from '../types/messaging.js';
import { isRecordProcessLive, type LivenessProbe } from './liveness.js';

/** The registry format. A record with another number still lists; its fields may differ. */
export const LIVE_SESSION_PROTOCOL = 1;

const RECORD_FILE = /^(\d+)\.json$/;

export function liveSessionsDir(home: string = resolveBookHome()): string {
  return join(home, 'live-sessions');
}

export function liveSessionRecordPath(dir: string, pid: number): string {
  return join(dir, `${pid}.json`);
}

/**
 * What a reader requires of a record. Unknown keys are kept, so a record a later version writes
 * still parses, and so does every `nameSource` Claude Code's reader accepts.
 */
const liveSessionRecordSchema = z.looseObject({
  pid: z.number().int().positive(),
  sessionId: z.string().min(1),
  cwd: z.string(),
  startedAt: z.number(),
  procStart: z.string().optional(),
  pidDomain: z.string().optional(),
  version: z.string(),
  protocol: z.number().int().positive(),
  features: z.array(z.string()),
  kind: z.literal('interactive'),
  name: z.string().min(1),
  nameSource: z.enum(['user', 'peer', 'derived', 'collision', 'auto', 'hook']),
  status: z.enum(['busy', 'waiting', 'idle']),
  waitingFor: z.enum(['permission prompt', 'input needed']).optional(),
  statusUpdatedAt: z.number(),
  updatedAt: z.number(),
});

/** Why the registry directory cannot be used, or `ok`. `missing` is fine: nothing registered yet. */
export type LiveSessionsDirState =
  'ok' | 'missing' | 'symlink' | 'not-directory' | 'not-owner' | 'loose-mode';

const DIR_REFUSALS: Record<Exclude<LiveSessionsDirState, 'ok' | 'missing'>, string> = {
  symlink: 'is a symlink',
  'not-directory': 'is not a directory',
  'not-owner': 'is owned by another user',
  'loose-mode': 'is readable by other users',
};

export function describeLiveSessionsDirState(state: LiveSessionsDirState): string {
  if (state === 'ok') return 'ok';
  if (state === 'missing') return 'not created yet';
  return DIR_REFUSALS[state];
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/** The directory's state, without creating or changing anything. `book doctor` reports it. */
export async function inspectLiveSessionsDir(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<LiveSessionsDirState> {
  let info;
  try {
    info = await lstat(dir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing';
    throw error;
  }
  if (info.isSymbolicLink()) return 'symlink';
  if (!info.isDirectory()) return 'not-directory';
  // Windows reports neither an owner nor POSIX modes; the profile directory's ACL is the boundary.
  if (platform === 'win32') return 'ok';
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return 'not-owner';
  if ((info.mode & 0o077) !== 0) return 'loose-mode';
  return 'ok';
}

/** Thrown by {@link ensureLiveSessionsDir} when the directory is not one Book will write into. */
export class LiveSessionsDirRefusedError extends Error {
  constructor(
    readonly dir: string,
    readonly state: LiveSessionsDirState,
  ) {
    super(`Live-sessions directory ${dir} ${describeLiveSessionsDirState(state)}; not using it.`);
    this.name = 'LiveSessionsDirRefusedError';
  }
}

/**
 * Create the directory `0700`, or vet the one that exists. A directory of ours that is merely too
 * open is tightened; a symlink, a non-directory or another user's directory is refused, because a
 * record written there would go wherever it points or be readable by whoever owns it.
 */
export async function ensureLiveSessionsDir(
  dir: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    // Something other than a directory holds the name; the inspection below says what.
    if (errorCode(error) !== 'EEXIST' && errorCode(error) !== 'ENOTDIR') throw error;
  }
  let state = await inspectLiveSessionsDir(dir, platform);
  if (state === 'loose-mode') {
    await chmod(dir, 0o700);
    state = await inspectLiveSessionsDir(dir, platform);
  }
  if (state !== 'ok') throw new LiveSessionsDirRefusedError(dir, state);
}

/** One `<pid>.json` file. `record` is absent when the file is torn, foreign or unreadable. */
export interface LiveSessionEntry {
  pid: number;
  path: string;
  /** The file as read, compared again before a sweep deletes it. */
  text?: string;
  record?: LiveSessionRecord;
}

function parseRecord(text: string, pid: number): LiveSessionRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = liveSessionRecordSchema.safeParse(value);
  // The file name is the record's key: a body naming another pid is not this pid's record.
  if (!parsed.success || parsed.data.pid !== pid) return undefined;
  return parsed.data as LiveSessionRecord;
}

/**
 * Every record file in the directory, parsed. Only `<pid>.json` names are read; the writer's lock
 * and temp files, and anything a later version keeps beside the records, are left alone.
 */
export async function readLiveSessionEntries(dir: string): Promise<LiveSessionEntry[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
  const entries: LiveSessionEntry[] = [];
  for (const name of names) {
    const match = RECORD_FILE.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    const path = join(dir, name);
    let text: string | undefined;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      // Removed between the listing and the read: its session just ended.
      continue;
    }
    entries.push({ pid, path, text, record: parseRecord(text, pid) });
  }
  return entries;
}

export interface ListLiveSessionsOptions {
  dir: string;
  probe: LivenessProbe;
  /** Delete records in this pid domain whose process is gone. Default true; doctor passes false. */
  sweep?: boolean;
  /** This process's pid, whose own file is never swept: its writer owns it. */
  ownPid?: number;
}

/**
 * The records of sessions running now, in this pid domain, oldest first.
 *
 * A record is live only while its pid is alive and its start token matches. One from another pid
 * domain is skipped and kept: its pid means nothing here. A torn or unparseable file is skipped and
 * kept too, because nothing in it can say which domain it belongs to. A dead record of this domain
 * is deleted — unless the file changed since it was read, which means its pid's new owner just
 * registered over it.
 */
export async function listLiveSessions(
  options: ListLiveSessionsOptions,
): Promise<LiveSessionRecord[]> {
  const { dir, probe, sweep = true, ownPid = process.pid } = options;
  const domain = await probe.pidDomain();
  const live: LiveSessionRecord[] = [];
  for (const entry of await readLiveSessionEntries(dir)) {
    const record = entry.record;
    if (!record || record.pidDomain !== domain) continue;
    if (await isRecordProcessLive(record, probe)) {
      live.push(record);
      continue;
    }
    if (sweep && entry.pid !== ownPid) await sweepEntry(entry);
  }
  return live.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
}

async function sweepEntry(entry: LiveSessionEntry): Promise<void> {
  try {
    if ((await readFile(entry.path, 'utf8')) !== entry.text) return;
    await unlink(entry.path);
  } catch {
    // Already gone, or not ours to remove: either way there is nothing to sweep.
  }
}
