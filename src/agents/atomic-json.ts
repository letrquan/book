import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import {
  open as openAsync,
  rename as renameAsync,
  stat as statAsync,
  unlink as unlinkAsync,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { basename, dirname, join } from 'node:path';
import { FILE_CONTENTION_CODES, sleepSync } from '../fs-contention.js';

export type AtomicWriteOperation = 'lock' | 'serialize' | 'write' | 'fsync' | 'rename';

export type AtomicWriteResult =
  | {
      status: 'ok';
      target: string;
      /**
       * How many times this write tried: 1 for a clean write, plus 1 for each contended retry of
       * either the lock step or the rename step.
       */
      attempts: number;
      elapsedMs: number;
    }
  | {
      status: 'busy';
      target: string;
      tempPath?: string;
      operation: 'lock' | 'rename';
      /**
       * How many times this write tried: 1 for a clean write, plus 1 for each contended retry of
       * either the lock step or the rename step. Failures that return before the rename step
       * report the lock tries only.
       */
      attempts: number;
      elapsedMs: number;
    }
  | {
      status: 'unavailable';
      target: string;
      tempPath?: string;
      operation: AtomicWriteOperation;
      errorCode?: string;
      message: string;
      /**
       * How many times this write tried: 1 for a clean write, plus 1 for each contended retry of
       * either the lock step or the rename step. Failures that return before the rename step
       * report the lock tries only.
       */
      attempts: number;
      elapsedMs: number;
    }
  | {
      /**
       * The caller withdrew this write before it landed, through
       * {@link AtomicAsyncWriteOptions.canCommit}. Not a failure: the target is left exactly as it
       * was, which is what the caller withdrawing a write is asking for.
       */
      status: 'cancelled';
      target: string;
      /**
       * How many times this write tried: 1 for a clean write, plus 1 for each contended retry of
       * either the lock step or the rename step.
       */
      attempts: number;
      elapsedMs: number;
    };

/** What one {@link AtomicJsonWriter.writeAsync} call is allowed to decide for itself. */
export interface AtomicAsyncWriteOptions {
  /**
   * Asked immediately before the rename, which is the only step of the write that changes the
   * target.
   *
   * A write that has begun is not one whose result the caller still wants: a lease heartbeat that
   * was already running when the store was disposed has a caller that no longer exists, and landing
   * would put back the very file that dispose removed. The question is asked at the last moment that
   * can still be answered `no` — everything before the rename has only ever touched a temp file —
   * and the temp file is removed rather than left, so a withdrawn write leaves nothing behind.
   */
  canCommit?: () => boolean;
}

export interface AtomicLockOwner {
  schemaVersion: 1;
  instanceId: string;
  pid: number;
  hostname: string;
  createdAt: number;
}

export interface AtomicJsonWriterOptions {
  instanceId: string;
  pid?: number;
  hostname: string;
  deadlineMs?: number;
  now?: () => number;
  randomId?: () => string;
  sleep?: (milliseconds: number) => void;
  isLockOwnerAlive?: (owner: AtomicLockOwner) => boolean;
  staleLockMs?: number;
  onStaleLock?: (target: string) => void;
  fs?: Partial<AtomicJsonFileSystem>;
  /**
   * The asynchronous filesystem {@link AtomicJsonWriter.writeAsync} uses. Injected for the same
   * reason `fs` is: a test needs to make a write slow or fail without a real disk doing it.
   */
  fsAsync?: Partial<AtomicJsonAsyncFileSystem>;
  /** How {@link AtomicJsonWriter.writeAsync} waits out a contended lock, instead of `sleep`. */
  sleepAsync?: (milliseconds: number) => Promise<void>;
}

export interface AtomicJsonFileSystem {
  closeSync: typeof closeSync;
  existsSync: typeof existsSync;
  fsyncSync: typeof fsyncSync;
  openSync: typeof openSync;
  readFileSync: typeof readFileSync;
  renameSync: typeof renameSync;
  statSync: typeof statSync;
  unlinkSync: typeof unlinkSync;
  writeFileSync: typeof writeFileSync;
}

/**
 * The asynchronous half of the same filesystem, for the calls that must not block the thread that
 * schedules them.
 *
 * A `fsync` is a disk round trip, so the synchronous path in {@link AtomicJsonWriter.write} costs
 * whatever the disk takes — 200ms and up on a busy one — and every caller pays it inside whatever
 * scheduled it. That is the right trade for a write a caller is waiting on and the wrong one for a
 * heartbeat nobody is waiting on.
 */
export interface AtomicJsonAsyncFileSystem {
  open: (path: string, flags: string, mode?: number) => Promise<FileHandle>;
  rename: (oldPath: string, newPath: string) => Promise<void>;
  stat: (path: string) => Promise<{ mtimeMs: number }>;
  unlink: (path: string) => Promise<void>;
}

const LOCK_CONTENTION_CODES = new Set(['EEXIST', ...FILE_CONTENTION_CODES]);
const DEFAULT_DEADLINE_MS = 500;
const DEFAULT_STALE_LOCK_MS = 30_000;
const BACKOFF_MS = [5, 10, 20, 40, 80];

const defaultFileSystem: AtomicJsonFileSystem = {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
};

const defaultAsyncFileSystem: AtomicJsonAsyncFileSystem = {
  open: openAsync,
  rename: renameAsync,
  stat: statAsync,
  unlink: unlinkAsync,
};

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function safeMessage(error: unknown): string {
  const code = errorCode(error);
  return code ? `Agent state storage operation failed (${code}).` : 'Agent state storage failed.';
}

function closeQuietly(fs: AtomicJsonFileSystem, descriptor: number | undefined): void {
  if (descriptor === undefined) return;
  try {
    fs.closeSync(descriptor);
  } catch {
    // A close failure must not mask the persistence result.
  }
}

function unlinkQuietly(fs: AtomicJsonFileSystem, path: string | undefined): void {
  if (!path) return;
  try {
    fs.unlinkSync(path);
  } catch {
    // Best effort cleanup; complete temp files are intentionally preserved after rename failure.
  }
}

/** A close failure must not mask the persistence result, asynchronously either. */
async function closeQuietlyAsync(handle: FileHandle | undefined): Promise<void> {
  if (handle === undefined) return;
  try {
    await handle.close();
  } catch {
    // A close failure must not mask the persistence result.
  }
}

async function unlinkQuietlyAsync(fs: AtomicJsonAsyncFileSystem, path: string | undefined) {
  if (!path) return;
  try {
    await fs.unlink(path);
  } catch {
    // Best effort cleanup, as in the synchronous path.
  }
}

async function readFileAsync(path: string, encoding: 'utf8'): Promise<string> {
  const handle = await openAsync(path, 'r');
  try {
    return await handle.readFile(encoding);
  } finally {
    await closeQuietlyAsync(handle);
  }
}

/**
 * Whether a lock file's contents name an owner Book can reason about.
 *
 * A lock with a valid owner is reclaimed only when that owner is gone; a lock without one is
 * reclaimed once it is older than the stale window, because there is nobody to ask.
 */
function validLockOwner(owner: AtomicLockOwner | undefined): boolean {
  return (
    owner?.schemaVersion === 1 &&
    typeof owner.instanceId === 'string' &&
    typeof owner.pid === 'number' &&
    typeof owner.hostname === 'string'
  );
}

export class AtomicJsonWriter {
  private readonly fs: AtomicJsonFileSystem;
  private readonly asyncFs: AtomicJsonAsyncFileSystem;
  private readonly instanceId: string;
  private readonly pid: number;
  private readonly hostname: string;
  private readonly deadlineMs: number;
  private readonly staleLockMs: number;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly sleep: (milliseconds: number) => void;
  private readonly sleepAsync: (milliseconds: number) => Promise<void>;
  private readonly isLockOwnerAlive?: (owner: AtomicLockOwner) => boolean;
  private readonly onStaleLock?: (target: string) => void;

  constructor(options: AtomicJsonWriterOptions) {
    this.fs = { ...defaultFileSystem, ...options.fs };
    this.asyncFs = { ...defaultAsyncFileSystem, ...options.fsAsync };
    this.instanceId = options.instanceId;
    this.pid = options.pid ?? process.pid;
    this.hostname = options.hostname;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? randomUUID;
    this.sleep = options.sleep ?? sleepSync;
    this.sleepAsync = options.sleepAsync ?? ((milliseconds) => delay(milliseconds));
    this.isLockOwnerAlive = options.isLockOwnerAlive;
    this.onStaleLock = options.onStaleLock;
  }

  /**
   * `cancelled` is excluded from the return type because it cannot happen here: a withdrawal is
   * something a caller asks for through {@link AtomicAsyncWriteOptions.canCommit}, and a caller
   * blocking on this call has nothing to withdraw it with. The union is what the caller can
   * actually observe.
   */
  write(
    target: string,
    value: unknown,
    preparedTemp?: string,
  ): Exclude<AtomicWriteResult, { status: 'cancelled' }> {
    const startedAt = this.now();
    const deadline = startedAt + this.deadlineMs;
    const lockPath = `${target}.lock`;
    let attempts = 0;
    let ladderAttempts = 0;
    let lockDescriptor: number | undefined;
    let ownsLock = false;
    let tempPath = preparedTemp;

    try {
      while (!ownsLock) {
        attempts++;
        ladderAttempts++;
        try {
          lockDescriptor = this.fs.openSync(lockPath, 'wx', 0o600);
          ownsLock = true;
          const owner: AtomicLockOwner = {
            schemaVersion: 1,
            instanceId: this.instanceId,
            pid: this.pid,
            hostname: this.hostname,
            createdAt: this.now(),
          };
          this.fs.writeFileSync(lockDescriptor, `${JSON.stringify(owner)}\n`, 'utf8');
          this.fs.fsyncSync(lockDescriptor);
          closeQuietly(this.fs, lockDescriptor);
          lockDescriptor = undefined;
        } catch (error) {
          closeQuietly(this.fs, lockDescriptor);
          lockDescriptor = undefined;
          const code = errorCode(error);
          if (ownsLock) {
            unlinkQuietly(this.fs, lockPath);
            ownsLock = false;
          }
          if (!LOCK_CONTENTION_CODES.has(code ?? '')) {
            return {
              status: 'unavailable',
              target,
              operation: 'lock',
              errorCode: code,
              message: safeMessage(error),
              attempts,
              elapsedMs: this.now() - startedAt,
            };
          }
          if (code === 'EEXIST' && this.reclaimStaleLock(lockPath, target)) continue;
          if (this.now() >= deadline) {
            return {
              status: 'busy',
              target,
              operation: 'lock',
              attempts,
              elapsedMs: this.now() - startedAt,
            };
          }
          this.pause(ladderAttempts, deadline);
        }
      }

      if (!tempPath) {
        try {
          JSON.stringify(value);
        } catch (error) {
          return {
            status: 'unavailable',
            target,
            operation: 'serialize',
            message: safeMessage(error),
            attempts,
            elapsedMs: this.now() - startedAt,
          };
        }

        tempPath = join(
          dirname(target),
          `${basename(target)}.${this.pid}.${this.instanceId}.${this.randomId()}.tmp`,
        );
        let tempDescriptor: number | undefined;
        try {
          tempDescriptor = this.fs.openSync(tempPath, 'wx', 0o600);
          this.fs.writeFileSync(tempDescriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
          try {
            this.fs.fsyncSync(tempDescriptor);
          } catch (error) {
            closeQuietly(this.fs, tempDescriptor);
            tempDescriptor = undefined;
            unlinkQuietly(this.fs, tempPath);
            return {
              status: 'unavailable',
              target,
              operation: 'fsync',
              errorCode: errorCode(error),
              message: safeMessage(error),
              attempts,
              elapsedMs: this.now() - startedAt,
            };
          }
          closeQuietly(this.fs, tempDescriptor);
          tempDescriptor = undefined;
        } catch (error) {
          closeQuietly(this.fs, tempDescriptor);
          unlinkQuietly(this.fs, tempPath);
          return {
            status: 'unavailable',
            target,
            operation: 'write',
            errorCode: errorCode(error),
            message: safeMessage(error),
            attempts,
            elapsedMs: this.now() - startedAt,
          };
        }
      }

      let renameRetries = 0;
      while (true) {
        ladderAttempts++;
        const currentAttempts = attempts + renameRetries;
        try {
          this.fs.renameSync(tempPath, target);
          return {
            status: 'ok',
            target,
            attempts: currentAttempts,
            elapsedMs: this.now() - startedAt,
          };
        } catch (error) {
          const code = errorCode(error);
          if (!FILE_CONTENTION_CODES.has(code ?? '')) {
            return {
              status: 'unavailable',
              target,
              tempPath,
              operation: 'rename',
              errorCode: code,
              message: safeMessage(error),
              attempts: currentAttempts,
              elapsedMs: this.now() - startedAt,
            };
          }
          if (this.now() >= deadline) {
            return {
              status: 'busy',
              target,
              tempPath,
              operation: 'rename',
              attempts: currentAttempts,
              elapsedMs: this.now() - startedAt,
            };
          }
          renameRetries++;
          this.pause(ladderAttempts, deadline);
        }
      }
    } finally {
      closeQuietly(this.fs, lockDescriptor);
      if (ownsLock) unlinkQuietly(this.fs, lockPath);
    }
  }

  /**
   * {@link write}, with every filesystem operation on the thread pool instead of the caller's.
   *
   * The protocol is the same one, and deliberately so: an exclusive lock whose owner is recorded
   * and fsynced, a unique temp file written and fsynced, and an atomic rename over the target. What
   * changes is only who waits — a caller that has asked for nothing and would rather not block a
   * UI thread on a disk round trip, such as the lease heartbeat, which runs on a timer for as long
   * as the process is alive and is never read by the process that writes it.
   *
   * The deadline and the retry ladder are the synchronous ones, and the result is the same
   * {@link AtomicWriteResult}, so a caller reads a `busy` or `unavailable` here the way it reads
   * one from {@link write}.
   *
   * {@link AtomicAsyncWriteOptions.canCommit} is the one thing this path has that the synchronous
   * one does not, and it exists because this path is the one a caller can no longer wait for.
   */
  async writeAsync(
    target: string,
    value: unknown,
    options: AtomicAsyncWriteOptions = {},
  ): Promise<AtomicWriteResult> {
    const startedAt = this.now();
    const deadline = startedAt + this.deadlineMs;
    const lockPath = `${target}.lock`;
    let attempts = 0;
    let ladderAttempts = 0;
    let ownsLock = false;
    let lockHandle: FileHandle | undefined;

    try {
      while (!ownsLock) {
        attempts++;
        ladderAttempts++;
        try {
          lockHandle = await this.asyncFs.open(lockPath, 'wx', 0o600);
          ownsLock = true;
          const owner: AtomicLockOwner = {
            schemaVersion: 1,
            instanceId: this.instanceId,
            pid: this.pid,
            hostname: this.hostname,
            createdAt: this.now(),
          };
          await lockHandle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
          await lockHandle.sync();
          await closeQuietlyAsync(lockHandle);
          lockHandle = undefined;
        } catch (error) {
          await closeQuietlyAsync(lockHandle);
          lockHandle = undefined;
          const code = errorCode(error);
          if (ownsLock) {
            await unlinkQuietlyAsync(this.asyncFs, lockPath);
            ownsLock = false;
          }
          if (!LOCK_CONTENTION_CODES.has(code ?? '')) {
            return {
              status: 'unavailable',
              target,
              operation: 'lock',
              errorCode: code,
              message: safeMessage(error),
              attempts,
              elapsedMs: this.now() - startedAt,
            };
          }
          if (code === 'EEXIST' && (await this.reclaimStaleLockAsync(lockPath, target))) continue;
          if (this.now() >= deadline) {
            return {
              status: 'busy',
              target,
              operation: 'lock',
              attempts,
              elapsedMs: this.now() - startedAt,
            };
          }
          await this.pauseAsync(ladderAttempts, deadline);
        }
      }

      let serialized: string;
      try {
        serialized = `${JSON.stringify(value, null, 2)}\n`;
      } catch (error) {
        return {
          status: 'unavailable',
          target,
          operation: 'serialize',
          message: safeMessage(error),
          attempts,
          elapsedMs: this.now() - startedAt,
        };
      }

      const tempPath = join(
        dirname(target),
        `${basename(target)}.${this.pid}.${this.instanceId}.${this.randomId()}.tmp`,
      );
      let tempHandle: FileHandle | undefined;
      try {
        tempHandle = await this.asyncFs.open(tempPath, 'wx', 0o600);
        await tempHandle.writeFile(serialized, 'utf8');
        // Durability is the point of the temp file: the rename is atomic, but a rename that lands
        // before the content is on disk leaves a lease file that reads as empty after a crash.
        try {
          await tempHandle.sync();
        } catch (error) {
          await closeQuietlyAsync(tempHandle);
          tempHandle = undefined;
          await unlinkQuietlyAsync(this.asyncFs, tempPath);
          return {
            status: 'unavailable',
            target,
            operation: 'fsync',
            errorCode: errorCode(error),
            message: safeMessage(error),
            attempts,
            elapsedMs: this.now() - startedAt,
          };
        }
        await closeQuietlyAsync(tempHandle);
        tempHandle = undefined;
      } catch (error) {
        await closeQuietlyAsync(tempHandle);
        await unlinkQuietlyAsync(this.asyncFs, tempPath);
        return {
          status: 'unavailable',
          target,
          operation: 'write',
          errorCode: errorCode(error),
          message: safeMessage(error),
          attempts,
          elapsedMs: this.now() - startedAt,
        };
      }

      let renameRetries = 0;
      while (true) {
        if (options.canCommit && !options.canCommit()) {
          // Asked once per attempt, so a write whose caller gave up while it waited out a
          // contended rename does not land on the attempt after that.
          await unlinkQuietlyAsync(this.asyncFs, tempPath);
          return {
            status: 'cancelled',
            target,
            attempts: attempts + renameRetries,
            elapsedMs: this.now() - startedAt,
          };
        }
        ladderAttempts++;
        const currentAttempts = attempts + renameRetries;
        try {
          await this.asyncFs.rename(tempPath, target);
          return {
            status: 'ok',
            target,
            attempts: currentAttempts,
            elapsedMs: this.now() - startedAt,
          };
        } catch (error) {
          const code = errorCode(error);
          if (!FILE_CONTENTION_CODES.has(code ?? '')) {
            return {
              status: 'unavailable',
              target,
              tempPath,
              operation: 'rename',
              errorCode: code,
              message: safeMessage(error),
              attempts: currentAttempts,
              elapsedMs: this.now() - startedAt,
            };
          }
          if (this.now() >= deadline) {
            return {
              status: 'busy',
              target,
              tempPath,
              operation: 'rename',
              attempts: currentAttempts,
              elapsedMs: this.now() - startedAt,
            };
          }
          renameRetries++;
          await this.pauseAsync(ladderAttempts, deadline);
        }
      }
    } finally {
      await closeQuietlyAsync(lockHandle);
      if (ownsLock) await unlinkQuietlyAsync(this.asyncFs, lockPath);
    }
  }

  private pause(attempt: number, deadline: number): void {
    const requested = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? 80;
    this.sleep(Math.max(0, Math.min(requested, deadline - this.now())));
  }

  private async pauseAsync(attempt: number, deadline: number): Promise<void> {
    const requested = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? 80;
    await this.sleepAsync(Math.max(0, Math.min(requested, deadline - this.now())));
  }

  private async reclaimStaleLockAsync(lockPath: string, target: string): Promise<boolean> {
    let owner: AtomicLockOwner | undefined;
    let age = 0;
    try {
      age = this.now() - (await this.asyncFs.stat(lockPath)).mtimeMs;
      owner = JSON.parse(await readFileAsync(lockPath, 'utf8')) as AtomicLockOwner;
    } catch {
      owner = undefined;
    }
    const validOwner = validLockOwner(owner);
    if (validOwner && this.isLockOwnerAlive?.(owner!)) return false;
    if (!validOwner && age < this.staleLockMs) return false;
    try {
      await this.asyncFs.unlink(lockPath);
      this.onStaleLock?.(target);
      return true;
    } catch {
      return false;
    }
  }

  private reclaimStaleLock(lockPath: string, target: string): boolean {
    let owner: AtomicLockOwner | undefined;
    let age = 0;
    try {
      age = this.now() - this.fs.statSync(lockPath).mtimeMs;
      owner = JSON.parse(this.fs.readFileSync(lockPath, 'utf8')) as AtomicLockOwner;
    } catch {
      owner = undefined;
    }
    const validOwner = validLockOwner(owner);
    if (validOwner && this.isLockOwnerAlive?.(owner!)) return false;
    if (!validOwner && age < this.staleLockMs) return false;
    try {
      this.fs.unlinkSync(lockPath);
      this.onStaleLock?.(target);
      return true;
    } catch {
      return false;
    }
  }
}
