import { access, chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/**
 * Durability seam for the run evidence ledger.
 *
 * Phase 2 shipped a single JSONL writer whose durability status was a module
 * constant, so `directorySync: 'unavailable'` was baked into every seal and no
 * observe-mode evidence could ever reach `evidenceEligibility: 'eligible'`.
 * That is a property of Node's API surface, not of any particular host, so the
 * ledger had no passing path at all.
 *
 * The backend now owns the durability claim and reports it honestly. A backend
 * that cannot prove a guarantee reports `unavailable` or `failed` and the seal
 * stays ineligible, exactly as before. A backend that can prove every guarantee
 * makes eligible evidence reachable without any change to record framing, the
 * monotonic sequence, or the hash chain — those stay identical across backends
 * so a stream verifies the same way regardless of who wrote it.
 */

export const DURABILITY_POLICY_VERSION = 'group-synced-v1';

export type DurabilityGuarantee = 'verified' | 'unavailable' | 'failed';

export interface DurabilityStatus {
  readonly policy: string;
  readonly fileDataSync: DurabilityGuarantee;
  readonly fileMetadataSync: DurabilityGuarantee;
  readonly atomicReplace: DurabilityGuarantee;
  readonly directorySync: DurabilityGuarantee;
}

/**
 * True only when every guarantee in the status is verified. `policy` is an
 * identity field rather than a guarantee and is excluded.
 *
 * This is the single definition of "durable enough to be promotion-eligible".
 * Callers must not re-derive it, so a new guarantee added to the status is
 * enforced everywhere at once instead of being silently ignored by one branch.
 */
export function durabilityIsVerified(status: DurabilityStatus): boolean {
  return Object.entries(status).every(([key, value]) => key === 'policy' || value === 'verified');
}

export interface LedgerDurabilityBackend {
  /** Stable backend identity, recorded as evidence provenance. */
  readonly id: string;
  /** Location of the append-only record stream. */
  readonly path: string;
  /** Location of the seal written beside the stream. */
  readonly sealPath: string;
  /** Append one already-framed canonical record. Not durable until `sync`. */
  append(line: string): Promise<void>;
  /** Durability barrier: resolves only once previously appended bytes are durable. */
  sync(): Promise<void>;
  /** Write the seal so a torn write cannot produce a partially readable seal. */
  writeSeal(line: string): Promise<void>;
  /** The backend's own report. Never assumed by the caller. */
  status(): DurabilityStatus;
  close(): Promise<void>;
}

export interface LedgerBackendOpenInput {
  /** Directory that will hold this root run's stream and seal. */
  readonly runDir: string;
  readonly randomUUID: () => string;
}

export type LedgerDurabilityBackendFactory = (
  input: LedgerBackendOpenInput,
) => Promise<LedgerDurabilityBackend>;

/**
 * Append-only JSONL backend. This is the Phase 2 behavior, unchanged: one line
 * per record, `fsync` on the data file, and an atomic rename for the seal.
 *
 * It reports `directorySync: 'unavailable'` because Node exposes no portable
 * directory fsync, so a rename of the seal into its directory cannot be proven
 * durable here. Every seal it produces therefore remains ineligible. That is
 * deliberate and unchanged; what changed is that the claim now belongs to the
 * backend making it.
 */
class JsonlDurabilityBackend implements LedgerDurabilityBackend {
  readonly id = 'jsonl-fsync-v1';
  readonly path: string;
  readonly sealPath: string;
  private readonly fd: FileHandle;
  private readonly randomUUID: () => string;
  private dataSync: DurabilityGuarantee = 'unavailable';
  private atomicReplace: DurabilityGuarantee = 'unavailable';

  private constructor(fd: FileHandle, path: string, sealPath: string, randomUUID: () => string) {
    this.fd = fd;
    this.path = path;
    this.sealPath = sealPath;
    this.randomUUID = randomUUID;
  }

  static async open(input: LedgerBackendOpenInput): Promise<JsonlDurabilityBackend> {
    await mkdir(input.runDir, { recursive: true, mode: 0o700 });
    await assertNoExistingLedger(input.runDir);
    const path = join(input.runDir, JSONL_LEDGER_FILENAME);
    const sealPath = join(input.runDir, 'seal.json');
    let fd: FileHandle;
    try {
      fd = await open(path, 'wx', 0o600);
    } catch (error) {
      throw new Error(
        `Harness run collision or open failure: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return new JsonlDurabilityBackend(fd, path, sealPath, input.randomUUID);
  }

  async append(line: string): Promise<void> {
    await this.fd.write(line, undefined, 'utf8');
  }

  async sync(): Promise<void> {
    try {
      await this.fd.sync();
    } catch (error) {
      // A failed barrier is latched: a later success cannot retroactively make
      // the earlier bytes durable, so the run must not claim that it did.
      this.dataSync = 'failed';
      throw error;
    }
    if (this.dataSync !== 'failed') this.dataSync = 'verified';
  }

  async writeSeal(line: string): Promise<void> {
    const temp = `${this.sealPath}.tmp-${this.randomUUID()}`;
    const sealFd = await open(temp, 'wx', 0o600);
    try {
      await sealFd.write(line, undefined, 'utf8');
      await sealFd.sync();
    } finally {
      await sealFd.close().catch(() => undefined);
    }
    try {
      await rename(temp, this.sealPath);
    } catch (error) {
      this.atomicReplace = 'failed';
      // Otherwise a failed replace orphans the temp file inside the evidence
      // directory, one per attempt.
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
    if (this.atomicReplace !== 'failed') this.atomicReplace = 'verified';
  }

  status(): DurabilityStatus {
    return {
      policy: DURABILITY_POLICY_VERSION,
      fileDataSync: this.dataSync,
      fileMetadataSync: this.dataSync,
      // `status()` is read while building the seal, before the seal's own
      // rename has happened, so this is `unavailable` until one succeeds.
      // Reporting `verified` here would assert a replace that was never
      // attempted — harmless while `directorySync` fails the check anyway, but
      // a trap for any host backend that wraps this one and overrides only
      // `directorySync`.
      atomicReplace: this.atomicReplace,
      // Node has no portable directory fsync. Fail closed rather than assume.
      directorySync: 'unavailable',
    };
  }

  async close(): Promise<void> {
    await this.fd.close();
  }
}

export const openJsonlDurabilityBackend: LedgerDurabilityBackendFactory = (input) =>
  JsonlDurabilityBackend.open(input);

export const SQLITE_LEDGER_FILENAME = 'events.db';
export const JSONL_LEDGER_FILENAME = 'events.jsonl';

interface SqliteStatement {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}
type SqliteDatabaseCtor = new (path: string, options?: { readOnly?: boolean }) => SqliteDatabase;

/**
 * `node:sqlite` landed in Node 22.5.0 and stopped requiring
 * `--experimental-sqlite` in 22.13.0, which is why the package floor is
 * `>=22.13.0` rather than `>=22`. It is imported lazily so a host on an older
 * runtime fails when it selects this backend, not at module load, and the
 * failure names the required version instead of surfacing a bare module error.
 */
async function loadSqlite(): Promise<SqliteDatabaseCtor> {
  let mod: { DatabaseSync?: SqliteDatabaseCtor };
  try {
    mod = (await import('node:sqlite')) as unknown as { DatabaseSync?: SqliteDatabaseCtor };
  } catch (error) {
    throw new Error(
      `node:sqlite is unavailable on this runtime (Node 22.13.0 or newer is required): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!mod.DatabaseSync) {
    throw new Error('node:sqlite DatabaseSync unavailable (Node 22.13.0 or newer is required)');
  }
  return mod.DatabaseSync;
}

/** Owner-only, matching every other evidence artifact in the store. */
async function restrictLedgerPermissions(path: string): Promise<void> {
  // SQLite creates the database and its sidecars with 0644 & ~umask; there is
  // no permission option on the constructor, so tighten them after the fact.
  await Promise.all(
    [path, `${path}-wal`, `${path}-shm`].map((candidate) =>
      chmod(candidate, 0o600).catch(() => undefined),
    ),
  );
}

async function assertNoExistingLedger(runDir: string): Promise<void> {
  // Collision detection must be per run directory, not per format: the two
  // backends cannot see each other's files, and two ledgers for one run id
  // would surface as two contradictory index entries for the same run.
  for (const name of LEDGER_FILENAMES) {
    try {
      await access(join(runDir, name));
    } catch {
      continue;
    }
    throw new Error(`Harness run collision or open failure: ${name} already exists`);
  }
}

/**
 * SQLite-backed ledger.
 *
 * The point of this backend is durability, not a new record format. It stores
 * the byte-identical canonical line the JSONL backend would have written, one
 * row per record, so the hash chain, sequence, and `byteLength` accounting are
 * unchanged and a stream verifies the same way regardless of who wrote it.
 *
 * It can claim `directorySync: 'verified'` where the JSONL backend cannot,
 * because SQLite in WAL mode with `synchronous = FULL` fsyncs the WAL and owns
 * the directory-entry durability that Node's API cannot reach. Both the record
 * and the seal live in one database file, so no rename into a directory is
 * needed to publish either.
 */
class SqliteDurabilityBackend implements LedgerDurabilityBackend {
  readonly id = 'sqlite-wal-full-v1';
  readonly path: string;
  readonly sealPath: string;
  private readonly db: SqliteDatabase;
  private readonly insert: SqliteStatement;
  private readonly putSeal: SqliteStatement;
  /** Set only when the runtime confirmed WAL + FULL; never assumed. */
  private readonly pragmasVerified: boolean;
  private failed = false;
  private closed = false;
  private inTransaction = false;
  private sequence = 0;

  private constructor(db: SqliteDatabase, path: string, pragmasVerified: boolean) {
    this.db = db;
    this.path = path;
    this.pragmasVerified = pragmasVerified;
    // The seal is a row in the same database; the path is retained so callers
    // and evidence records keep a stable, addressable identity for it.
    this.sealPath = sqliteSealPath(path);
    this.insert = db.prepare('INSERT INTO records (sequence, line) VALUES (?, ?)');
    this.putSeal = db.prepare('INSERT OR REPLACE INTO seal (id, line) VALUES (1, ?)');
  }

  static async open(input: LedgerBackendOpenInput): Promise<SqliteDurabilityBackend> {
    await mkdir(input.runDir, { recursive: true, mode: 0o700 });
    await assertNoExistingLedger(input.runDir);
    const path = join(input.runDir, SQLITE_LEDGER_FILENAME);
    const DatabaseSync = await loadSqlite();
    const db = new DatabaseSync(path);
    try {
      await restrictLedgerPermissions(path);
      // WAL + FULL is the durable pairing: a commit fsyncs before returning,
      // which is the guarantee "append resolves only after durability" needs
      // and the one the JSONL path cannot make.
      //
      // `exec` does not throw when SQLite refuses the mode — journal_mode
      // reports the mode actually in effect, and network, FUSE, and some
      // container filesystems silently refuse WAL. Read both pragmas back and
      // let the result, not the request, decide what this backend may claim.
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = FULL');
      const journalMode = (
        db.prepare('PRAGMA journal_mode').all() as Array<{
          journal_mode?: unknown;
        }>
      )[0]?.journal_mode;
      const synchronous = (
        db.prepare('PRAGMA synchronous').all() as Array<{
          synchronous?: unknown;
        }>
      )[0]?.synchronous;
      const pragmasVerified =
        String(journalMode).toLowerCase() === 'wal' &&
        Number(synchronous) === SQLITE_SYNCHRONOUS_FULL;
      db.exec(
        'CREATE TABLE IF NOT EXISTS records (sequence INTEGER PRIMARY KEY, line TEXT NOT NULL) STRICT',
      );
      db.exec(
        'CREATE TABLE IF NOT EXISTS seal (id INTEGER PRIMARY KEY, line TEXT NOT NULL) STRICT',
      );
      const existing = db.prepare('SELECT COUNT(*) AS n FROM records').all() as Array<{
        n: number;
      }>;
      if ((existing[0]?.n ?? 0) > 0) {
        throw new Error('Harness run collision or open failure: ledger already has records');
      }
      return new SqliteDurabilityBackend(db, path, pragmasVerified);
    } catch (error) {
      // Without this the handle plus its -wal/-shm sidecars leak for the
      // process lifetime, which also blocks deleteRun on Windows.
      try {
        db.close();
      } catch {
        /* the open already failed; closing is best-effort */
      }
      throw error;
    }
  }

  /**
   * Records accumulate in one explicit transaction and become durable at
   * `sync`. Autocommit would fsync on every event — a blocking main-thread
   * fsync per turn, tool call, and usage record — which also defeats the
   * group-commit policy `RunLedgerWriter` already implements above this seam.
   */
  append(line: string): Promise<void> {
    if (this.closed || this.failed) return Promise.reject(this.deadError());
    try {
      if (!this.inTransaction) {
        this.db.exec('BEGIN IMMEDIATE');
        this.inTransaction = true;
      }
      this.insert.run(++this.sequence, line);
    } catch (error) {
      this.sequence -= 1;
      this.failed = true;
      return Promise.reject(asError(error));
    }
    return Promise.resolve();
  }

  sync(): Promise<void> {
    if (this.closed || this.failed) return Promise.reject(this.deadError());
    if (!this.inTransaction) return Promise.resolve();
    try {
      this.db.exec('COMMIT');
      this.inTransaction = false;
    } catch (error) {
      this.failed = true;
      return Promise.reject(asError(error));
    }
    return Promise.resolve();
  }

  async writeSeal(line: string): Promise<void> {
    if (this.closed || this.failed) throw this.deadError();
    // Publish every pending record before the seal so a seal can never describe
    // records that are not yet durable.
    await this.sync();
    try {
      this.db.exec('BEGIN IMMEDIATE');
      this.putSeal.run(line);
      this.db.exec('COMMIT');
    } catch (error) {
      this.failed = true;
      throw asError(error);
    }
  }

  status(): DurabilityStatus {
    // Anything unproven is `unavailable`, anything broken is `failed`. A
    // guarantee is only claimed when the runtime confirmed the pragmas that
    // provide it, because this status is the sole gate on promotion
    // eligibility and an unearned `verified` promotes evidence the JSONL path
    // deliberately refuses to promote.
    const guarantee: DurabilityGuarantee = this.failed
      ? 'failed'
      : this.pragmasVerified
        ? 'verified'
        : 'unavailable';
    return {
      policy: DURABILITY_POLICY_VERSION,
      fileDataSync: guarantee,
      fileMetadataSync: guarantee,
      // Publishing a record or a seal is a transaction, not a rename.
      atomicReplace: guarantee,
      // SQLite owns directory-entry durability for its own files.
      directorySync: guarantee,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      if (this.inTransaction) {
        // Uncommitted records were never durable and must not be published by
        // the act of closing.
        this.db.exec('ROLLBACK');
        this.inTransaction = false;
        this.failed = true;
      }
    } catch {
      this.failed = true;
    }
    // `db.close()` throws ERR_INVALID_STATE synchronously on an already-closed
    // handle. This method must be `async` so such a throw becomes a rejection
    // that callers' `.catch()` guards can absorb, rather than escaping through
    // `finalize()` and reaching users as raw exception text.
    this.db.close();
  }

  private deadError(): Error {
    return Object.assign(new Error('ledger-durability-unavailable'), {
      code: this.closed ? 'ECONNABORTED' : 'EIO',
      syscall: 'commit',
    });
  }
}

const SQLITE_SYNCHRONOUS_FULL = 2;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function sqliteSealPath(path: string): string {
  return `${path}#seal`;
}

export const openSqliteDurabilityBackend: LedgerDurabilityBackendFactory = (input) =>
  SqliteDurabilityBackend.open(input);

/**
 * Read side of the seam. A backend owns its own storage format, so reading is
 * resolved by format and then handed to the shared verifier as bytes. The
 * verifier is never duplicated per backend: chain, sequence, and canonical
 * checks must behave identically or cross-backend evidence is not comparable.
 */
export interface LedgerSource {
  readRecordBytes(): Promise<Buffer>;
  /** Rejects with a `code: 'ENOENT'` error when no seal exists yet. */
  readSealText(): Promise<string>;
}

function missingSeal(): Error & { code: string } {
  return Object.assign(new Error('seal-missing'), { code: 'ENOENT' });
}

export function isSqliteLedgerPath(path: string): boolean {
  return basename(path) === SQLITE_LEDGER_FILENAME;
}

export function openLedgerSource(path: string, sealPath: string): LedgerSource {
  if (!isSqliteLedgerPath(path)) {
    return {
      readRecordBytes: () => readFile(path),
      readSealText: () => readFile(sealPath, 'utf8'),
    };
  }
  // One read, one connection, one snapshot: records and the seal must describe
  // the same instant, and opening twice could straddle a concurrent commit.
  let pending: Promise<{ bytes: Buffer; seal?: string }> | undefined;
  const load = (): Promise<{ bytes: Buffer; seal?: string }> => {
    pending ??= (async () => {
      // `new DatabaseSync(path)` CREATES a missing database. A read path must
      // never write into the append-only evidence tree, and a missing ledger
      // must stay distinguishable from a corrupt one, so require the file and
      // open read-only.
      try {
        await access(path);
      } catch {
        throw missingSeal();
      }
      const DatabaseSync = await loadSqlite();
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const rows = db.prepare('SELECT line FROM records ORDER BY sequence ASC').all() as Array<{
          line: string;
        }>;
        // Reconstruct the exact framing the JSONL backend produces so byte
        // offsets, `byteLength`, and truncation accounting stay comparable.
        // Concatenated as buffers rather than one joined string, which would
        // hit V8's string cap on a large ledger where `readFile` would not.
        const bytes = Buffer.concat(rows.map((row) => Buffer.from(row.line, 'utf8')));
        const sealRows = db.prepare('SELECT line FROM seal WHERE id = 1').all() as Array<{
          line: string;
        }>;
        return { bytes, seal: sealRows[0]?.line };
      } finally {
        db.close();
      }
    })();
    return pending;
  };
  return {
    async readRecordBytes(): Promise<Buffer> {
      return (await load()).bytes;
    },
    async readSealText(): Promise<string> {
      const seal = (await load()).seal;
      if (seal === undefined) throw missingSeal();
      return seal;
    },
  };
}

/** Run-directory ledger filenames, most durable first. */
export const LEDGER_FILENAMES = [SQLITE_LEDGER_FILENAME, JSONL_LEDGER_FILENAME] as const;

export function defaultSealPath(recordPath: string): string {
  return isSqliteLedgerPath(recordPath)
    ? sqliteSealPath(recordPath)
    : join(dirname(recordPath), 'seal.json');
}
