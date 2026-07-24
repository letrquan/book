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
import { basename, dirname, join } from 'node:path';

export type AtomicWriteOperation = 'lock' | 'serialize' | 'write' | 'fsync' | 'rename';

export type AtomicWriteResult =
  | {
      status: 'ok';
      target: string;
      attempts: number;
      elapsedMs: number;
    }
  | {
      status: 'busy';
      target: string;
      tempPath?: string;
      operation: 'lock' | 'rename';
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
      attempts: number;
      elapsedMs: number;
    };

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

const CONTENTION_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const LOCK_CONTENTION_CODES = new Set(['EEXIST', ...CONTENTION_CODES]);
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

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as NodeJS.ErrnoException).code)
    : undefined;
}

function safeMessage(error: unknown): string {
  const code = errorCode(error);
  return code ? `Agent state storage operation failed (${code}).` : 'Agent state storage failed.';
}

function defaultSleep(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
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

export class AtomicJsonWriter {
  private readonly fs: AtomicJsonFileSystem;
  private readonly instanceId: string;
  private readonly pid: number;
  private readonly hostname: string;
  private readonly deadlineMs: number;
  private readonly staleLockMs: number;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly sleep: (milliseconds: number) => void;
  private readonly isLockOwnerAlive?: (owner: AtomicLockOwner) => boolean;
  private readonly onStaleLock?: (target: string) => void;

  constructor(options: AtomicJsonWriterOptions) {
    this.fs = { ...defaultFileSystem, ...options.fs };
    this.instanceId = options.instanceId;
    this.pid = options.pid ?? process.pid;
    this.hostname = options.hostname;
    this.deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
    this.now = options.now ?? Date.now;
    this.randomId = options.randomId ?? randomUUID;
    this.sleep = options.sleep ?? defaultSleep;
    this.isLockOwnerAlive = options.isLockOwnerAlive;
    this.onStaleLock = options.onStaleLock;
  }

  write(target: string, value: unknown, preparedTemp?: string): AtomicWriteResult {
    const startedAt = this.now();
    const deadline = startedAt + this.deadlineMs;
    const lockPath = `${target}.lock`;
    let attempts = 0;
    let lockDescriptor: number | undefined;
    let ownsLock = false;
    let tempPath = preparedTemp;

    try {
      while (!ownsLock) {
        attempts++;
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
          this.pause(attempts, deadline);
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

      while (true) {
        attempts++;
        try {
          this.fs.renameSync(tempPath, target);
          return {
            status: 'ok',
            target,
            attempts,
            elapsedMs: this.now() - startedAt,
          };
        } catch (error) {
          const code = errorCode(error);
          if (!CONTENTION_CODES.has(code ?? '')) {
            return {
              status: 'unavailable',
              target,
              tempPath,
              operation: 'rename',
              errorCode: code,
              message: safeMessage(error),
              attempts,
              elapsedMs: this.now() - startedAt,
            };
          }
          if (this.now() >= deadline) {
            return {
              status: 'busy',
              target,
              tempPath,
              operation: 'rename',
              attempts,
              elapsedMs: this.now() - startedAt,
            };
          }
          this.pause(attempts, deadline);
        }
      }
    } finally {
      closeQuietly(this.fs, lockDescriptor);
      if (ownsLock) unlinkQuietly(this.fs, lockPath);
    }
  }

  private pause(attempt: number, deadline: number): void {
    const requested = BACKOFF_MS[Math.min(attempt - 1, BACKOFF_MS.length - 1)] ?? 80;
    this.sleep(Math.max(0, Math.min(requested, deadline - this.now())));
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
    const validOwner =
      owner?.schemaVersion === 1 &&
      typeof owner.instanceId === 'string' &&
      typeof owner.pid === 'number' &&
      typeof owner.hostname === 'string';
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
