/**
 * Where an interactive session's inbox socket lives, and whether that directory is safe to use.
 *
 * The socket directory is the inbox's first boundary: the directory is `0700`, so no other user
 * can reach a socket in it, and its parent is one no other user can swap it out of. Every inbox
 * frame still has to authenticate with the session's token (`inbox-server.ts`), but a directory
 * that fails these checks is not used at all.
 *
 * Resolution order (§4.2 of the messaging plan):
 * 1. `BOOK_MESSAGING_SOCKET_DIR`, for tests. Used as given or not at all: falling back from it
 *    would put a test's sockets in the developer's real directory.
 * 2. `<BOOK_HOME>/socks/`, when `BOOK_HOME` is set, so an isolated home keeps its sockets too.
 * 3. `$XDG_RUNTIME_DIR/book-socks/`.
 * 4. `<os.tmpdir()>/book-socks-<uid>/`: the per-uid fallback, also used whenever an earlier
 *    choice is refused or its socket path would not fit in a `sun_path`.
 *
 * Everything is asynchronous, and nothing is cached here: the inbox resolves once at start.
 */

import { chmod, lstat, mkdir, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { resolveBookHome } from '../book-home.js';
import type { SocketDirRefusalReason, SocketDirSource } from '../types/messaging.js';

/**
 * The longest socket path Book binds, in bytes. `sun_path` holds 104 bytes on macOS and 108 on
 * Linux, terminator included; 103 fits both.
 */
export const MAX_SOCKET_PATH_BYTES = 103;

/** The environment override for the socket directory. Tests only. */
export const SOCKET_DIR_ENV = 'BOOK_MESSAGING_SOCKET_DIR';

export interface SocketDirCandidate {
  dir: string;
  source: SocketDirSource;
}

export interface SocketDirEnvironment {
  env?: NodeJS.ProcessEnv;
  /** `os.tmpdir()` unless a test pins it. */
  tmpdir?: string;
  /** This process's uid; `process.getuid()` unless a test pins it. */
  uid?: number;
  /** The pid whose socket names the length check budgets for. */
  pid?: number;
}

/** The directories to try, in order. Pure. */
export function socketDirCandidates(options: SocketDirEnvironment = {}): SocketDirCandidate[] {
  const env = options.env ?? process.env;
  const override = env[SOCKET_DIR_ENV]?.trim();
  if (override) return [{ dir: resolve(override), source: 'env' }];
  const candidates: SocketDirCandidate[] = [];
  if (env.BOOK_HOME?.trim()) {
    candidates.push({ dir: join(resolveBookHome(env), 'socks'), source: 'book-home' });
  } else {
    const runtime = env.XDG_RUNTIME_DIR?.trim();
    if (runtime && isAbsolute(runtime)) {
      candidates.push({ dir: join(runtime, 'book-socks'), source: 'xdg-runtime' });
    }
  }
  candidates.push({
    dir: join(options.tmpdir ?? tmpdir(), `book-socks-${options.uid ?? currentUid()}`),
    source: 'tmp',
  });
  return candidates;
}

function currentUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : 0;
}

/**
 * The longest name a session binds in the directory: the moved-aside `<pid>-<8 hex>.sock`, so a
 * directory that fits `<pid>.sock` but not its moved-aside twin is not chosen.
 */
export function longestSocketName(pid: number): string {
  return `${pid}-00000000.sock`;
}

export type SocketDirVerdict =
  | {
      ok: true;
      /** The directory with its parent's symlinks resolved: the form a socket path is published in. */
      dir: string;
      /** Only when inspecting: the directory does not exist yet, and would be created `0700`. */
      missing?: boolean;
      /** Only when inspecting: a directory of ours that is too open, and would be tightened. */
      loose?: boolean;
    }
  | { ok: false; dir: string; reason: SocketDirRefusalReason; message: string };

export interface VetSocketDirOptions extends SocketDirEnvironment {
  /**
   * Create a missing directory `0700` and tighten one of ours that is too open. Off for
   * `book doctor`, which reports what a session would do and changes nothing.
   */
  create: boolean;
  platform?: NodeJS.Platform;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function refusal(
  dir: string,
  reason: SocketDirRefusalReason,
  message: string,
): Extract<SocketDirVerdict, { ok: false }> {
  return { ok: false, dir, reason, message };
}

/**
 * Whether `dir` may hold this session's inbox socket, creating it when asked.
 *
 * - The parent's symlinks are resolved (macOS's `/tmp` and `/var` are links into `/private`), and
 *   a loop among them is refused.
 * - The parent must be owned by this user or root, and not writable by others unless sticky, so
 *   no one else can rename the directory away and put their own in its place.
 * - The directory itself must not be a symlink, must be a directory, must be this user's, and must
 *   be `0700` (one of ours that is looser is tightened).
 * - The longest socket path in it must fit {@link MAX_SOCKET_PATH_BYTES}.
 */
export async function vetSocketDir(
  dir: string,
  options: VetSocketDirOptions,
): Promise<SocketDirVerdict> {
  const uid = options.uid ?? currentUid();
  const pid = options.pid ?? process.pid;
  const tooLong = (candidate: string): SocketDirVerdict | undefined => {
    const bytes = Buffer.byteLength(join(candidate, longestSocketName(pid)));
    if (bytes <= MAX_SOCKET_PATH_BYTES) return undefined;
    return refusal(
      candidate,
      'too-long',
      `a socket path in ${candidate} would be ${bytes} bytes, over the ${MAX_SOCKET_PATH_BYTES}-byte limit`,
    );
  };
  const parent = dirname(dir);
  let realParent: string;
  try {
    realParent = await realpath(parent);
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ELOOP') {
      return refusal(dir, 'symlink-loop', `${parent} is a symlink loop; remove the loop`);
    }
    if (code !== 'ENOENT') {
      return refusal(dir, 'unavailable', `${parent} cannot be read (${code ?? 'error'})`);
    }
    // Judged before anything is created: a home too deep for a socket gets no `socks/` in it.
    const lexical = tooLong(dir);
    if (lexical) return lexical;
    if (!options.create) return { ok: true, dir, missing: true };
    try {
      await mkdir(parent, { recursive: true, mode: 0o700 });
      realParent = await realpath(parent);
    } catch (inner) {
      return refusal(
        dir,
        'unavailable',
        `${parent} cannot be created (${errorCode(inner) ?? 'error'})`,
      );
    }
  }
  const canonical = join(realParent, basename(dir));
  const long = tooLong(canonical);
  if (long) return long;
  const parentInfo = await stat(realParent).catch(() => undefined);
  if (!parentInfo?.isDirectory()) {
    return refusal(canonical, 'unavailable', `${realParent} is not a directory`);
  }
  if (parentInfo.uid !== uid && parentInfo.uid !== 0) {
    return refusal(
      canonical,
      'parent-not-owner',
      `${realParent} is owned by uid ${parentInfo.uid}, neither you nor root; use a directory of your own`,
    );
  }
  if ((parentInfo.mode & 0o022) !== 0 && (parentInfo.mode & 0o1000) === 0) {
    return refusal(
      canonical,
      'parent-writable',
      `${realParent} is writable by other users without the sticky bit; run chmod go-w ${realParent}`,
    );
  }
  let info;
  try {
    info = await lstat(canonical);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      return refusal(
        canonical,
        'unavailable',
        `${canonical} cannot be read (${errorCode(error) ?? 'error'})`,
      );
    }
    if (!options.create) return { ok: true, dir: canonical, missing: true };
    try {
      await mkdir(canonical, { mode: 0o700 });
    } catch (inner) {
      // Another session created it first; the checks below judge what is there now.
      if (errorCode(inner) !== 'EEXIST') {
        return refusal(
          canonical,
          'unavailable',
          `${canonical} cannot be created (${errorCode(inner) ?? 'error'})`,
        );
      }
    }
    info = await lstat(canonical);
  }
  if (info.isSymbolicLink()) {
    return refusal(
      canonical,
      'symlink',
      `${canonical} is a symlink; remove it so Book can create the directory`,
    );
  }
  if (!info.isDirectory()) {
    return refusal(canonical, 'not-directory', `${canonical} is not a directory; remove it`);
  }
  if (info.uid !== uid) {
    return refusal(
      canonical,
      'not-owner',
      `${canonical} is owned by uid ${info.uid}, not you; remove it so Book can create its own`,
    );
  }
  if ((info.mode & 0o077) !== 0) {
    if (!options.create) return { ok: true, dir: canonical, loose: true };
    await chmod(canonical, 0o700);
    const tightened = await lstat(canonical);
    if ((tightened.mode & 0o077) !== 0) {
      return refusal(
        canonical,
        'loose-mode',
        `${canonical} cannot be made private; run chmod 700 ${canonical}`,
      );
    }
  }
  return { ok: true, dir: canonical };
}

/** One candidate that was passed over, and why. */
export interface SocketDirFallback {
  dir: string;
  source: SocketDirSource;
  reason: SocketDirRefusalReason;
  message: string;
}

export type SocketDirResolution =
  | {
      ok: true;
      dir: string;
      source: SocketDirSource;
      /** The candidates refused before this one, in order. */
      skipped: SocketDirFallback[];
      missing?: boolean;
      loose?: boolean;
    }
  | { ok: false; skipped: SocketDirFallback[] };

/** The first candidate that passes {@link vetSocketDir}, and the ones refused before it. */
export async function resolveSocketDir(options: VetSocketDirOptions): Promise<SocketDirResolution> {
  const skipped: SocketDirFallback[] = [];
  for (const candidate of socketDirCandidates(options)) {
    const verdict = await vetSocketDir(candidate.dir, options);
    if (verdict.ok) {
      return {
        ok: true,
        dir: verdict.dir,
        source: candidate.source,
        skipped,
        ...(verdict.missing ? { missing: true } : {}),
        ...(verdict.loose ? { loose: true } : {}),
      };
    }
    skipped.push({
      dir: verdict.dir,
      source: candidate.source,
      reason: verdict.reason,
      message: verdict.message,
    });
  }
  return { ok: false, skipped };
}

/**
 * The directories a reply may be addressed into: every candidate this environment resolves that
 * exists now and passes the checks, without creating or changing any. A peer's own socket can be
 * in a different one than ours (its path was too long, or its runtime directory was refused).
 */
export async function vettedReplyDirs(options: SocketDirEnvironment = {}): Promise<string[]> {
  const dirs: string[] = [];
  for (const candidate of socketDirCandidates(options)) {
    const verdict = await vetSocketDir(candidate.dir, { ...options, create: false });
    if (verdict.ok && !verdict.missing && !verdict.loose) dirs.push(verdict.dir);
  }
  return dirs;
}
