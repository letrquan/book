/**
 * Peer awareness (#620 PR 4): what this session knows of the other live Book sessions working in
 * its git worktree, from their live-session records, without the model having to ask.
 *
 * - The `<session-state>` block names the peers in this worktree (at most three, with their
 *   recorded edits) and counts the ones in other worktrees of the same repository (4c).
 * - A changed-on-disk notice and a `stale_file_observation` refusal name the peer whose recorded
 *   edit matches the file (4d).
 * - The TUI warns the user when this session and a peer both recorded edits to one path within ten
 *   minutes (4e), whatever the model does.
 *
 * It works whether or not messaging is on: the registry is written whenever the TUI runs. Every
 * read is bounded — one directory listing and at most {@link MAX_PEER_RECORDS} records of this pid
 * domain — and never sweeps; `SessionList` and the writer's start do that. Everything a peer wrote
 * is its own word: names, branches and paths are sanitized and capped before they reach the model
 * or the screen, and an edit is a claim the notices hedge.
 */

import { readdir } from 'node:fs/promises';
import { relative } from 'node:path';
import { mapLimited } from '../async.js';
import { resolveBookHome } from '../book-home.js';
import { foldControlCharacters } from '../control-characters.js';
import { canonicalizePath, isOutside } from '../tools/path-utils.js';
import type {
  LiveSessionEdit,
  PeerAwarenessHandle,
  PeerAwarenessSnapshot,
  PeerEditAttribution,
  PeerSessionNote,
  PeerSessionsNotice,
  ReadLiveSessionRecord,
} from '../types/messaging.js';
import { peerLabel, peerSessionRow } from './addressing.js';
import { createLivenessProbe, isRecordProcessLive, type LivenessProbe } from './liveness.js';
import { promptAgo } from './peer-text.js';
import {
  liveSessionsDir,
  MAX_RECORD_BYTES,
  parseLiveSessionRecordName,
  pidDomainTag,
  readLiveSessionEntries,
} from './registry.js';
import type { LiveSessionWriter } from './writer.js';

/** Record files one read parses, at most: a record is a few hundred bytes. */
const MAX_REGISTRY_FILES = 256;
/** Records in this repository one read checks for liveness (on macOS, a `ps` spawn each). */
export const MAX_PEER_RECORDS = 8;
/** Peers the worktree line names; the rest are counted. */
export const MAX_PEER_NOTES = 3;
/** Recorded edits the line shows per peer, newest first. */
const MAX_NOTE_EDITS = 3;
/** A recorded edit older than this is not shown in the worktree line. */
const NOTE_EDIT_WINDOW_MS = 60 * 60 * 1000;
/** Both sessions recorded an edit to one path within this long: the user is warned (4e). */
export const OVERLAP_WINDOW_MS = 10 * 60 * 1000;
/** How often an idle session looks for a peer's overlapping edit while its own edits are recent. */
const OVERLAP_POLL_MS = 15_000;
/** A snapshot is reused for this long, so one turn's lines and refusals share a read. */
const SNAPSHOT_TTL_MS = 1_000;
/** A peer's recorded edits read, at most, and how long a path may be. */
const MAX_PEER_EDITS = 20;
const MAX_PEER_PATH_CHARS = 512;
/** Code points a branch keeps. */
const MAX_BRANCH_CHARS = 64;
/** Code points a path keeps in the line and the warning. */
const MAX_SHOWN_PATH_CHARS = 160;

/** A live peer of this session, every field sanitized. */
interface PeerView {
  pid: number;
  sessionId: string;
  /** What the model and the user call it: `name [ref]` when this session can message it. */
  label: string;
  messaging: boolean;
  status: string;
  branch?: string;
  /** Valid recorded edits, newest first. */
  edits: LiveSessionEdit[];
  sameWorktree: boolean;
}

export interface PeerAwarenessOptions {
  /** This session's own record: its worktree, repository and recorded edits. */
  writer: Pick<LiveSessionWriter, 'location' | 'recentEdits' | 'recordEdits'>;
  /** Whether this session can message peers now (`SessionSend`). */
  messaging?: () => boolean;
  /** BOOK_HOME; resolved from `env` when absent. */
  home?: string;
  env?: NodeJS.ProcessEnv;
  pid?: number;
  probe?: LivenessProbe;
  now?: () => number;
}

function cut(text: string, max: number): string {
  return Array.from(foldControlCharacters(text)).slice(0, max).join('');
}

/**
 * A peer's `recentEdits`, kept only where it is what a writer writes: an array of worktree-relative
 * paths with times. An absolute path, a `..` segment or an oversized entry is dropped, so a record
 * can never point this session outside the worktree it shares.
 */
export function validPeerEdits(value: unknown): LiveSessionEdit[] {
  if (!Array.isArray(value)) return [];
  const edits: LiveSessionEdit[] = [];
  for (const entry of value.slice(-MAX_PEER_EDITS)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { path: raw, at } = entry as { path?: unknown; at?: unknown };
    if (typeof raw !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) continue;
    // Separators are normalized first, so a `\\host\share` UNC path or a `\rooted` one is
    // judged as the absolute path it is.
    const path = raw.replace(/\\/g, '/');
    if (!path || path.length > MAX_PEER_PATH_CHARS || path.startsWith('/')) continue;
    if (/^[A-Za-z]:/.test(path) || path.split('/').some((part) => part === '..')) continue;
    edits.push({ path, at });
  }
  return edits.sort((a, b) => b.at - a.at);
}

/** The worktree-relative spelling of `absolutePath`, or `undefined` outside `worktree`. */
function worktreePath(worktree: string, absolutePath: string): string | undefined {
  let canonical: string;
  try {
    canonical = canonicalizePath(absolutePath);
  } catch {
    return undefined;
  }
  if (canonical === worktree || isOutside(worktree, canonical)) return undefined;
  return relative(worktree, canonical).replace(/\\/g, '/');
}

export class PeerAwareness implements PeerAwarenessHandle {
  private readonly writer: PeerAwarenessOptions['writer'];
  private readonly messaging: () => boolean;
  private readonly dir: string;
  private readonly pid: number;
  private readonly probe: LivenessProbe;
  private readonly now: () => number;
  private cached?: { at: number; peers: Promise<PeerView[]> };
  private readonly listeners = new Set<(warning: string) => void>();
  /** When each (peer session, path) overlap was last shown. */
  private readonly warned = new Map<string, number>();
  private poll?: NodeJS.Timeout;
  private checking = false;
  /** A check was asked for while one ran: it runs again as soon as that one ends. */
  private recheck = false;
  private closed = false;

  constructor(options: PeerAwarenessOptions) {
    const env = options.env ?? process.env;
    this.writer = options.writer;
    this.messaging = options.messaging ?? (() => false);
    this.dir = liveSessionsDir(options.home ?? resolveBookHome(env));
    this.pid = options.pid ?? process.pid;
    this.probe = options.probe ?? createLivenessProbe(process.platform, env);
    this.now = options.now ?? Date.now;
  }

  async snapshot(): Promise<PeerAwarenessSnapshot> {
    const location = this.writer.location;
    if (!location) return { attribute: () => undefined };
    const peers = await this.peers();
    const now = this.now();
    return {
      notice: this.notice(peers, now),
      attribute: (absolutePath, since) => {
        const path = worktreePath(location.worktree, absolutePath);
        if (path === undefined) return undefined;
        let best: { peer: PeerView; at: number } | undefined;
        for (const peer of peers) {
          if (!peer.sameWorktree) continue;
          const edit = peer.edits.find((candidate) => candidate.path === path);
          if (edit && edit.at >= since && (!best || edit.at > best.at))
            best = { peer, at: edit.at };
        }
        return best
          ? ({
              peer: best.peer.label,
              ageMs: Math.max(0, now - best.at),
              messaging: best.peer.messaging,
            } satisfies PeerEditAttribution)
          : undefined;
      },
    };
  }

  recordEdits(workspace: string, paths: readonly string[]): void {
    if (this.closed || paths.length === 0) return;
    this.writer.recordEdits(workspace, paths);
    void this.checkOverlaps();
    this.armPoll();
  }

  /** Hear each new overlap warning (4e): one line, ready to show the user. */
  subscribe(listener: (warning: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    this.closed = true;
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
    this.listeners.clear();
  }

  /**
   * Warn about every path this session and a live peer in its worktree both recorded an edit to
   * within {@link OVERLAP_WINDOW_MS}, once per (peer session, path) per window. Never rejects.
   */
  async checkOverlaps(): Promise<string[]> {
    if (this.closed) return [];
    if (this.checking) {
      this.recheck = true;
      return [];
    }
    this.checking = true;
    try {
      const now = this.now();
      const own = new Map(
        this.writer
          .recentEdits()
          .filter((edit) => now - edit.at <= OVERLAP_WINDOW_MS)
          .map((edit) => [edit.path, edit.at]),
      );
      if (own.size === 0) return [];
      const warnings: string[] = [];
      for (const peer of await this.peers(true)) {
        if (!peer.sameWorktree) continue;
        for (const edit of peer.edits) {
          const ownAt = own.get(edit.path);
          if (ownAt === undefined || now - edit.at > OVERLAP_WINDOW_MS) continue;
          const key = `${peer.pid}:${peer.sessionId}:${edit.path}`;
          const last = this.warned.get(key);
          if (last !== undefined && now - last < OVERLAP_WINDOW_MS) continue;
          this.warned.set(key, now);
          warnings.push(
            `⚠ ${peer.label} also recorded an edit to ${cut(edit.path, MAX_SHOWN_PATH_CHARS)} ${promptAgo(now - edit.at)}, and this session edited it ${promptAgo(now - ownAt)}. Check that neither change overwrote the other.`,
          );
        }
      }
      for (const [key, at] of this.warned) {
        if (now - at >= OVERLAP_WINDOW_MS) this.warned.delete(key);
      }
      if (!this.closed) for (const warning of warnings) this.emit(warning);
      return warnings;
    } catch {
      return [];
    } finally {
      this.checking = false;
      if (this.recheck) {
        this.recheck = false;
        void this.checkOverlaps();
      }
    }
  }

  private emit(warning: string): void {
    for (const listener of this.listeners) {
      try {
        listener(warning);
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /** Poll for a peer's overlapping edit while this session's own are recent; stop after. */
  private armPoll(): void {
    if (this.closed || this.poll) return;
    this.poll = setInterval(() => {
      const now = this.now();
      if (this.writer.recentEdits().some((edit) => now - edit.at <= OVERLAP_WINDOW_MS)) {
        void this.checkOverlaps();
        return;
      }
      clearInterval(this.poll);
      this.poll = undefined;
    }, OVERLAP_POLL_MS);
    this.poll.unref?.();
  }

  private notice(peers: readonly PeerView[], now: number): PeerSessionsNotice | undefined {
    const same = peers
      .filter((peer) => peer.sameWorktree)
      .sort((a, b) => (b.edits[0]?.at ?? 0) - (a.edits[0]?.at ?? 0));
    const otherWorktrees = peers.length - same.length;
    if (same.length === 0 && otherWorktrees === 0) return undefined;
    return {
      sameWorktree: same.slice(0, MAX_PEER_NOTES).map((peer): PeerSessionNote => ({
        name: peer.label,
        status: peer.status,
        ...(peer.branch !== undefined ? { branch: peer.branch } : {}),
        edits: peer.edits
          .filter((edit) => now - edit.at <= NOTE_EDIT_WINDOW_MS)
          .slice(0, MAX_NOTE_EDITS)
          .map((edit) => ({
            path: cut(edit.path, MAX_SHOWN_PATH_CHARS),
            ageMs: Math.max(0, now - edit.at),
          })),
      })),
      moreSameWorktree: Math.max(0, same.length - MAX_PEER_NOTES),
      otherWorktrees,
    };
  }

  /** The live peers in this repository, read at most once a {@link SNAPSHOT_TTL_MS}. */
  private peers(fresh = false): Promise<PeerView[]> {
    const now = this.now();
    if (!fresh && this.cached && now - this.cached.at < SNAPSHOT_TTL_MS) return this.cached.peers;
    const peers = this.readPeers().catch(() => []);
    this.cached = { at: now, peers };
    return peers;
  }

  private async readPeers(): Promise<PeerView[]> {
    const location = this.writer.location;
    if (!location) return [];
    const domain = await this.probe.pidDomain();
    const tag = domain === undefined ? undefined : pidDomainTag(domain);
    let listing: string[];
    try {
      listing = await readdir(this.dir);
    } catch {
      return [];
    }
    const names = listing
      .map((name) => ({ name, parsed: parseLiveSessionRecordName(name) }))
      .filter(({ parsed }) => parsed && parsed.tag === tag && parsed.pid !== this.pid)
      .sort((a, b) => b.parsed!.pid - a.parsed!.pid)
      .slice(0, MAX_REGISTRY_FILES)
      .map(({ name }) => name);
    // Every record is read (they are small) and judged by where it works before any liveness
    // check, so sessions elsewhere on the machine cannot crowd out a peer in this worktree. Only
    // the records in this repository are checked, the most recently written first.
    const candidates = (await readLiveSessionEntries(this.dir, names, MAX_RECORD_BYTES))
      .map((entry) => entry.record)
      .filter(
        (record): record is ReadLiveSessionRecord =>
          record !== undefined &&
          record.pidDomain === domain &&
          (record.worktree === location.worktree || record.repository === location.repository),
      )
      .sort((a, b) => (b.updatedAt ?? b.startedAt) - (a.updatedAt ?? a.startedAt) || b.pid - a.pid)
      .slice(0, MAX_PEER_RECORDS);
    const live = await mapLimited(candidates, MAX_PEER_RECORDS, async (record) =>
      (await isRecordProcessLive(record, this.probe)) ? record : undefined,
    );
    const messagingHere = this.messaging();
    return live
      .filter((record): record is ReadLiveSessionRecord => record !== undefined)
      .flatMap((record) => {
        const sameWorktree = record.worktree === location.worktree;
        const row = peerSessionRow(record, false);
        const messaging = messagingHere && row.ref !== undefined;
        return [
          {
            pid: record.pid,
            sessionId: record.sessionId,
            label: messaging ? peerLabel(row) : row.name,
            messaging,
            status: row.waitingFor ? `${row.status}, ${row.waitingFor}` : row.status,
            ...(typeof record.branch === 'string' && record.branch
              ? { branch: cut(record.branch, MAX_BRANCH_CHARS) }
              : {}),
            edits: sameWorktree ? validPeerEdits(record.recentEdits) : [],
            sameWorktree,
          } satisfies PeerView,
        ];
      });
  }
}
