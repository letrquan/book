/**
 * The live-session registry on disk: `<BOOK_HOME>/live-sessions/`, one file per running
 * interactive session, named `<pid>.<domain tag>.json` (`<pid>.json` where the platform has no pid
 * domain).
 *
 * `<BOOK_HOME>/sessions/` already holds transcripts, so the registry has a directory of its own.
 * The directory is `0700` and vetted before use — owned by this user, a real directory and not a
 * symlink — and every record is written atomically as a `0600` file. Readers never trust a record's
 * word that its session is alive: liveness is checked against the OS (`liveness.ts`), and a record
 * whose process is gone is swept on read.
 *
 * With messaging on (#620), a session's inbox key sits beside its record, named after the record's
 * pid and domain and the socket it unlocks (`<pid>.<domain tag>.<sha256(socket)>.key`). The sweep
 * removes a key once its session is gone.
 */

import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, readFile, stat, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { AtomicLockOwner } from '../agents/atomic-json.js';
import { resolveBookHome } from '../book-home.js';
import type { ReadLiveSessionRecord } from '../types/messaging.js';
import { isRecordProcessLive, type LivenessProbe } from './liveness.js';

/** The registry format. A record with another number still lists; its fields may differ. */
export const LIVE_SESSION_PROTOCOL = 1;

/**
 * How long a record from another pid domain may go unrefreshed before a sweep removes it. Its pid
 * cannot be checked from here, but a live writer refreshes its record every ten minutes or so, so a
 * day of silence means the container or boot that wrote it is gone.
 */
export const FOREIGN_RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** How old a writer's lock or temp file must be before a sweep removes it as a crash's leftover. */
export const ORPHAN_FILE_MAX_AGE_MS = 60 * 60 * 1000;

/** Records checked at once: on macOS each check is a `ps` spawn. */
const CHECK_CONCURRENCY = 8;

const DOMAIN_TAG_LENGTH = 12;
const RECORD_FILE = /^(\d+)(?:\.([0-9a-f]{12}))?\.json$/;
/**
 * An inbox key (#620): `<pid>.<domain tag>.<sha256 of the socket path>.key`, or
 * `<pid>.<sha256>.key` where the platform has no pid domain.
 */
const KEY_FILE = /^(\d+)(?:\.([0-9a-f]{12}))?\.([0-9a-f]{64})\.key$/;
/**
 * A record or key writer's lock (`<file>.lock`) or temp file (`<file>.<pid>.<instance>.<id>.tmp`).
 */
const WRITER_FILE = /^\d+(?:\.[0-9a-f]{12})?(?:\.json|\.[0-9a-f]{64}\.key)\.(?:lock|[^/\\]+\.tmp)$/;

export function liveSessionsDir(home: string = resolveBookHome()): string {
  return join(home, 'live-sessions');
}

/** The first 12 hex digits of the domain's SHA-256: what tells two domains' files apart. */
export function pidDomainTag(pidDomain: string): string {
  return createHash('sha256').update(pidDomain).digest('hex').slice(0, DOMAIN_TAG_LENGTH);
}

/**
 * The record's file name. Pids repeat across pid namespaces — two containers sharing a home can
 * both run Book as pid 23 — so the name carries the domain, and no session ever writes over or
 * removes another domain's record.
 */
export function liveSessionRecordName(pid: number, pidDomain?: string): string {
  return pidDomain === undefined ? `${pid}.json` : `${pid}.${pidDomainTag(pidDomain)}.json`;
}

export function liveSessionRecordPath(dir: string, pid: number, pidDomain?: string): string {
  return join(dir, liveSessionRecordName(pid, pidDomain));
}

/** The full SHA-256 of an inbox socket path, as its key file is named. */
export function socketPathHash(socketPath: string): string {
  return createHash('sha256').update(socketPath).digest('hex');
}

/**
 * The inbox key's file name, beside the session's record. The domain tag keeps two pid namespaces
 * that share a home apart even when both bind the same socket path string on different
 * filesystems (the same `/run/user/1000` in two containers).
 */
export function liveSessionKeyName(
  pid: number,
  pidDomain: string | undefined,
  socketPath: string,
): string {
  const hash = socketPathHash(socketPath);
  return pidDomain === undefined
    ? `${pid}.${hash}.key`
    : `${pid}.${pidDomainTag(pidDomain)}.${hash}.key`;
}

/** One key file's name, parsed: the owner's pid, its domain tag, and the socket hash. */
export function parseLiveSessionKeyName(
  name: string,
): { pid: number; tag?: string; hash: string } | undefined {
  const match = KEY_FILE.exec(name);
  if (!match) return undefined;
  return { pid: Number(match[1]), ...(match[2] ? { tag: match[2] } : {}), hash: match[3]! };
}

/** What a key file holds. The token is the inbox's only secret; nothing else may carry it. */
const liveSessionKeySchema = z.looseObject({
  peerToken: z.string().regex(/^[0-9a-f]{32}$/),
  procStart: z.string().optional().catch(undefined),
  pidDomain: z.string().optional().catch(undefined),
});

export type LiveSessionKey = z.infer<typeof liveSessionKeySchema>;

/** A key file's contents, or undefined when it is torn, malformed or unreadable. */
export function parseLiveSessionKey(text: string): LiveSessionKey | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = liveSessionKeySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/**
 * What a reader requires of a record: the essentials, and nothing else. Every other field is kept
 * as written, and a malformed optional one reads as absent, so a record a later version writes —
 * a new `kind`, a new `status` — still counts as a session rather than as a torn file.
 */
const liveSessionRecordSchema = z.looseObject({
  pid: z.number().int().positive(),
  sessionId: z.string().min(1),
  name: z.string().min(1),
  startedAt: z.number(),
  procStart: z.string().optional().catch(undefined),
  pidDomain: z.string().optional().catch(undefined),
  updatedAt: z.number().optional().catch(undefined),
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

/** One record file. `record` is absent when the file is torn, mismatched or unreadable. */
export interface LiveSessionEntry {
  pid: number;
  path: string;
  /** The file as read, compared again before a sweep deletes it. */
  text?: string;
  record?: ReadLiveSessionRecord;
}

function parseRecord(
  text: string,
  pid: number,
  tag: string | undefined,
): ReadLiveSessionRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = liveSessionRecordSchema.safeParse(value);
  // The file name is the record's key: a body naming another pid or domain is not this file's.
  if (!parsed.success || parsed.data.pid !== pid) return undefined;
  const domain = parsed.data.pidDomain;
  if ((domain === undefined ? undefined : pidDomainTag(domain)) !== tag) return undefined;
  return parsed.data as ReadLiveSessionRecord;
}

/** `fn` over `items`, at most `limit` at a time, results in input order. */
async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function listNames(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw error;
  }
}

/**
 * Every record file in the directory, parsed. Only record names are read; the writer's lock and
 * temp files, and anything a later version keeps beside the records, are left alone.
 */
export async function readLiveSessionEntries(
  dir: string,
  /** The directory's listing, when the caller already has it. */
  listing?: readonly string[],
): Promise<LiveSessionEntry[]> {
  const files = (listing ?? (await listNames(dir)))
    .map((name) => ({ name, match: RECORD_FILE.exec(name) }))
    .filter((file): file is { name: string; match: RegExpExecArray } => file.match !== null)
    .sort((a, b) => Number(a.match[1]) - Number(b.match[1]) || a.name.localeCompare(b.name));
  const entries = await mapLimited(files, CHECK_CONCURRENCY, async ({ name, match }) => {
    const pid = Number(match[1]);
    const path = join(dir, name);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      // Removed between the listing and the read: its session just ended.
      return undefined;
    }
    return { pid, path, text, record: parseRecord(text, pid, match[2]) };
  });
  return entries.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
}

export interface ListLiveSessionsOptions {
  dir: string;
  probe: LivenessProbe;
  /** Delete records whose process is gone, and crashed writers' leftovers. Default true. */
  sweep?: boolean;
  /** This process's pid, whose own file is never swept: its writer owns it. */
  ownPid?: number;
  now?: () => number;
  /** Stops the listing early: whatever is left unchecked is neither listed nor swept. */
  signal?: AbortSignal;
}

/**
 * The records of sessions running now, in this pid domain, oldest first.
 *
 * A record of this domain is live while its pid is alive and its start token matches, and is
 * swept once it is not; its age never matters. A record of another domain is never judged by its
 * pid, which means nothing here: it is kept until a day passes without its writer refreshing it.
 * A torn file is kept, because nothing in it says whose it is. Leftover writer locks and temp
 * files over an hour old are swept too.
 */
export async function listLiveSessions(
  options: ListLiveSessionsOptions,
): Promise<ReadLiveSessionRecord[]> {
  const { dir, probe, sweep = true, ownPid = process.pid, now = Date.now, signal } = options;
  if (signal?.aborted) return [];
  const domain = await probe.pidDomain();
  // One listing serves the records and both sweeps after them.
  const listing = await listNames(dir);
  const swept = new Set<string>();
  const sweepRecord = async (entry: LiveSessionEntry) => {
    if (await sweepEntry(entry)) swept.add(basename(entry.path));
  };
  const checked = await mapLimited(
    await readLiveSessionEntries(dir, listing),
    CHECK_CONCURRENCY,
    async (entry) => {
      const record = entry.record;
      if (!record || signal?.aborted) return undefined;
      if (record.pidDomain !== domain) {
        const refreshedAt = record.updatedAt ?? record.startedAt;
        if (sweep && now() - refreshedAt > FOREIGN_RECORD_MAX_AGE_MS) await sweepRecord(entry);
        return undefined;
      }
      if (await isRecordProcessLive(record, probe)) return record;
      if (sweep && entry.pid !== ownPid && !signal?.aborted) await sweepRecord(entry);
      return undefined;
    },
  );
  if (sweep && !signal?.aborted) {
    const remaining = listing.filter((name) => !swept.has(name));
    await sweepLiveSessionKeys(dir, remaining, { probe, domain, ownPid, now: now() });
    await sweepOrphanedWriterFiles(dir, remaining, now());
  }
  return checked
    .filter((record): record is ReadLiveSessionRecord => record !== undefined)
    .sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
}

/** What a sweep writes in the record's lock: the shape `AtomicJsonWriter` reads to judge it. */
function lockOwnerDocument(): string {
  const owner: AtomicLockOwner = {
    schemaVersion: 1,
    instanceId: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    createdAt: Date.now(),
  };
  return `${JSON.stringify(owner)}\n`;
}

/**
 * Delete a dead record, under the same `<record>.lock` the writer takes for every write. Holding it
 * across the re-read and the unlink is what keeps a new owner of the pid from renaming its record
 * in between and losing it. A lock someone else holds means a write is under way: the record is
 * left for a later sweep.
 */
async function sweepEntry(entry: LiveSessionEntry): Promise<boolean> {
  const lockPath = `${entry.path}.lock`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch {
    return false;
  }
  try {
    await handle.writeFile(lockOwnerDocument(), 'utf8');
    await handle.close();
    handle = undefined;
    if ((await readFile(entry.path, 'utf8')) !== entry.text) return false;
    await unlink(entry.path);
    return true;
  } catch {
    // Already gone, or not ours to remove: either way there is nothing to sweep.
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
  }
}

/**
 * Remove inbox keys whose session is gone (#620). A key of this pid domain goes once its owner —
 * the pid, and the start token the key holds — is not alive, whatever its age; one whose owner is
 * alive stays, record or not, because a record can be missing for moments between rewrites. A key
 * from another domain cannot be judged by its pid, so it goes with its record: once no record of
 * the same pid and domain is left and the key is over an hour old. Deleted under the key's own
 * lock, like a record, so a session publishing a key of the same name is never undone.
 */
async function sweepLiveSessionKeys(
  dir: string,
  names: readonly string[],
  options: { probe: LivenessProbe; domain: string | undefined; ownPid: number; now: number },
): Promise<void> {
  const records = new Set(names.filter((name) => RECORD_FILE.test(name)));
  const ownTag = options.domain === undefined ? undefined : pidDomainTag(options.domain);
  const keys = names.flatMap((name) => {
    const parsed = parseLiveSessionKeyName(name);
    return parsed ? [{ name, ...parsed }] : [];
  });
  await mapLimited(keys, CHECK_CONCURRENCY, async ({ name, pid, tag }) => {
    if (pid === options.ownPid && tag === ownTag) return;
    const path = join(dir, name);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      return;
    }
    const key = parseLiveSessionKey(text);
    if (tag === ownTag && key) {
      const live = await isRecordProcessLive({ pid, procStart: key.procStart }, options.probe);
      if (!live) await sweepEntry({ pid, path, text });
      return;
    }
    const recordName = tag === undefined ? `${pid}.json` : `${pid}.${tag}.json`;
    if (records.has(recordName)) return;
    try {
      if (options.now - (await stat(path)).mtimeMs <= ORPHAN_FILE_MAX_AGE_MS) return;
    } catch {
      return;
    }
    await sweepEntry({ pid, path, text });
  });
}

/** Remove writer locks and temp files a crash left behind; a live writer holds one for moments. */
async function sweepOrphanedWriterFiles(
  dir: string,
  listing: readonly string[],
  now: number,
): Promise<void> {
  const names = listing.filter((name) => WRITER_FILE.test(name));
  await mapLimited(names, CHECK_CONCURRENCY, async (name) => {
    const path = join(dir, name);
    try {
      if (now - (await stat(path)).mtimeMs > ORPHAN_FILE_MAX_AGE_MS) await unlink(path);
    } catch {
      // Gone already.
    }
  });
}
