/**
 * Files the model has observed that changed on disk since (#620 4a), Claude Code's
 * `edited_text_file` notice. A user's edit, a formatter, a linter or another session can change a
 * file between turns; the next turn's `<session-state>` says so instead of waiting for a write to
 * fail on the stale-file check.
 *
 * Judged against the observation ledger (`file-provenance.ts`), so the model's own edits — which
 * re-observe the file — never count. Each change is reported once. A file is not read again while
 * `stat` vouches for its last verdict (`stat-freshness.ts`: its size, mtime and ctime have not moved,
 * and both times were safely older than that judgment), so a quiet turn costs one `stat` per
 * observed file.
 */

import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mapLimited } from '../async.js';
import { plainSpan } from '../messaging/peer-text.js';
import { redactSecrets } from '../provider-secrets.js';
import { statStamp, statVouches, type StatStamp } from '../stat-freshness.js';
import type { FileObservation } from '../types/tools.js';
import { renderDiff } from './diff.js';
import { normalizeObservedPath, workspaceIdentity } from './file-provenance.js';
import { canonicalizePath } from './path-utils.js';

/**
 * Changed files one turn names. The rest are counted and not reported again: a branch switch that
 * changes fifty observed files is one notice, not five turns of them.
 */
export const MAX_CHANGED_FILES_PER_TURN = 10;
/** The most recently observed files a turn checks: a long session's oldest reads are skipped. */
export const MAX_CHANGE_SCAN_FILES = 256;
/** Files checked at once. */
const CHANGE_SCAN_CONCURRENCY = 8;
/** A diff longer than this, header lines included, is left out: the notice names the file only. */
export const MAX_CHANGE_SNIPPET_LINES = 20;
/** A snippet line is cut to this many code points. */
const MAX_SNIPPET_LINE_CHARS = 160;
/** Only a file this small keeps the text a snippet is diffed against. */
const MAX_BASELINE_BYTES = 64 * 1024;
/** All the remembered texts together, least recently observed dropped first. */
const MAX_BASELINE_TOTAL_BYTES = 2 * 1024 * 1024;
/**
 * A bigger file is not read again to be judged: it goes unreported rather than cost a turn. Checked
 * on the opened handle too, so a file that grows after its `lstat` is not read whole.
 */
export const MAX_JUDGED_BYTES = 16 * 1024 * 1024;
/** Where the platform has it (not Windows), a read that refuses to follow a final link. */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
/** Where the platform has it, an open that does not wait for a writer when a FIFO stands there. */
const NO_BLOCK = constants.O_NONBLOCK ?? 0;

export interface ChangedObservedFile {
  /** The ledger key. */
  key: string;
  /** Workspace-relative, as the file was observed. */
  path: string;
  absolutePath: string;
  /** When the model last observed the file. */
  observedAt: number;
  /** The file is gone, or is no longer a file. */
  deleted?: true;
  /** A short diff from the observed text to the current one, secrets redacted. */
  snippet?: string[];
}

export interface CollectChangedFilesOptions {
  ledger: ReadonlyMap<string, FileObservation>;
  workspace: string;
  /** Paths (`normalizeObservedPath`) another line of the block already reports. */
  exclude?: ReadonlySet<string>;
  /** Provider keys to redact from a snippet. */
  secrets?: readonly string[];
  limit?: number;
  signal?: AbortSignal;
}

export interface ChangedObservedFiles {
  /** Newest observation first, at most the limit. */
  files: ChangedObservedFile[];
  /** Changed files beyond the limit: counted only. */
  unlisted: number;
  /**
   * Mark every change found as reported. Called once the block naming them is rendered: a turn
   * cancelled before that leaves them to be reported by the next one.
   */
  commit(): void;
}

/** A verdict: the file's hash when it was read, keyed on the stat facts of the handle read. */
interface Judged extends StatStamp {
  observedSha: string;
  /** The file's hash then, or `deleted`. */
  currentSha: string;
}

const DELETED = 'deleted';
/** A link, or a path through one, now stands where the observed file was. */
const REPLACED = 'replaced';

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

/**
 * Whether an opened handle holds the file the checks before the open vetted, and the path still
 * names that file, with no link on the way, once it is open. The checks go by path, so they cannot
 * be atomic with the open: `O_NOFOLLOW` guards only the last component (and Windows has no such
 * flag), so a directory above the file swapped for a link in between, or on Windows the file
 * itself, leaves the handle on another file, and its identity then differs from the vetted one or
 * from what the path names now. A process that swaps a workspace directory back and forth several
 * times inside one check can still slip past; that needs a writer already in the workspace.
 */
async function holdsVettedFile(path: string, vetted: Stats, held: Stats): Promise<boolean> {
  if (!sameFile(vetted, held)) return false;
  return sameFile(await lstat(path), held) && samePath(await realpath(path), path);
}

/**
 * The `size` bytes an opened file holds, or `undefined` when it grew or shrank while it was read
 * (it is judged again next turn). Never reads more than one byte past `size`, which tells growth
 * apart from the end of the file.
 */
async function readExactly(handle: FileHandle, size: number): Promise<Buffer | undefined> {
  const buffer = Buffer.allocUnsafe(size + 1);
  let total = 0;
  while (total < buffer.length) {
    const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return total === size ? buffer.subarray(0, size) : undefined;
}

/**
 * The change as a diff of at most {@link MAX_CHANGE_SNIPPET_LINES} lines, or `undefined` when it
 * is longer. The changed span is measured first, so a large rewrite is never diffed at all.
 * Each line is made plain first, as the prompt will show it (`plainSpan`), and only then are
 * provider keys redacted, before a long line is cut: a key with a zero-width space inside does not
 * match the redaction, and removing that space later would join it back up; a key the cut would
 * split cannot escape the redaction by half.
 */
export function changeSnippet(
  before: string,
  after: string,
  secrets: readonly string[] = [],
): string[] | undefined {
  const a = before.split('\n');
  const b = after.split('\n');
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const changed = a.length + b.length - 2 * (prefix + suffix);
  if (changed === 0 || changed >= MAX_CHANGE_SNIPPET_LINES) return undefined;
  const diff = renderDiff(before, after, 1);
  if (!diff) return undefined;
  const plain = diff.split('\n').map(plainSpan).join('\n');
  const lines = redactSecrets(plain, secrets).split('\n');
  if (lines.length > MAX_CHANGE_SNIPPET_LINES) return undefined;
  return lines.map((line) => Array.from(line).slice(0, MAX_SNIPPET_LINE_CHARS).join(''));
}

export interface FileChangeTrackerOptions {
  /** The wall clock a verdict is stamped with; a test moves it. */
  now?: () => number;
}

/**
 * One session's memory of what it has reported. Lives on the session's runtime, beside the
 * observation ledger it reads, and is replaced with it on `/clear`.
 */
export class FileChangeTracker {
  private readonly now: () => number;
  private readonly judged = new Map<string, Judged>();
  /** The change last reported per key, so the same change is never reported twice. */
  private readonly reported = new Map<string, string>();
  /**
   * Text a file held when it was observed, by key, least recently observed first, with the size of
   * the bytes it was decoded from: what the budget counts, whatever the decoding made of them.
   */
  private readonly baselines = new Map<string, { sha256: string; text: string; bytes: number }>();
  private baselineBytes = 0;

  constructor(options: FileChangeTrackerOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** The bytes the remembered texts hold, against their 2 MiB budget. */
  get rememberedBytes(): number {
    return this.baselineBytes;
  }

  /**
   * Keep the text the model just observed, so a later change can be shown as a diff. Called by
   * `observeFile` with the bytes it hashed; a large or binary file is not kept.
   */
  remember(key: string, sha256: string, bytes: Uint8Array): void {
    this.dropBaseline(key);
    if (bytes.byteLength > MAX_BASELINE_BYTES || looksBinary(bytes)) return;
    this.baselines.set(key, {
      sha256,
      text: Buffer.from(bytes).toString('utf8'),
      bytes: bytes.byteLength,
    });
    this.baselineBytes += bytes.byteLength;
    for (const [oldest, baseline] of this.baselines) {
      if (this.baselineBytes <= MAX_BASELINE_TOTAL_BYTES) break;
      this.baselines.delete(oldest);
      this.baselineBytes -= baseline.bytes;
    }
  }

  /**
   * Forget a file this session's own tool deleted: its observation leaves the ledger with it, so
   * there is nothing left to judge it against.
   */
  forget(key: string): void {
    this.dropBaseline(key);
    this.judged.delete(key);
    this.reported.delete(key);
  }

  private dropBaseline(key: string): void {
    const baseline = this.baselines.get(key);
    if (!baseline) return;
    this.baselines.delete(key);
    this.baselineBytes -= baseline.bytes;
  }

  /**
   * The observed files that changed on disk since, newest observation first, at most `limit` of
   * them named and the rest counted, each change once: `commit` marks them reported.
   */
  async collect(options: CollectChangedFilesOptions): Promise<ChangedObservedFiles> {
    const workspaceId = workspaceIdentity(options.workspace);
    const root = canonicalizePath(resolve(options.workspace));
    const candidates = [...options.ledger.entries()]
      .filter(
        ([, observation]) =>
          observation.workspaceId === workspaceId &&
          observation.operation !== 'outline' &&
          !options.exclude?.has(normalizeObservedPath(observation.path)),
      )
      .sort(([, a], [, b]) => b.timestamp - a.timestamp)
      .slice(0, MAX_CHANGE_SCAN_FILES);

    const checked = await mapLimited(
      candidates,
      CHANGE_SCAN_CONCURRENCY,
      async ([key, observation]) => {
        if (options.signal?.aborted) return undefined;
        const absolutePath = resolve(root, observation.path);
        const current = await this.judge(key, absolutePath, observation);
        if (!current) return undefined;
        if (current.sha === observation.sha256) {
          // Back to what the model saw: a later change to any content is news again.
          this.reported.delete(key);
          return undefined;
        }
        if (this.reported.get(key) === current.sha) return undefined;
        return { key, observation, absolutePath, current };
      },
    );

    const changed = checked.filter(
      (entry): entry is NonNullable<typeof entry> => entry !== undefined,
    );
    const limit = options.limit ?? MAX_CHANGED_FILES_PER_TURN;
    const files = changed.slice(0, limit).map(({ key, observation, absolutePath, current }) => {
      const deleted = current.sha === DELETED;
      const baseline = this.baselines.get(key);
      const snippet =
        !deleted && current.text !== undefined && baseline?.sha256 === observation.sha256
          ? changeSnippet(baseline.text, current.text, options.secrets)
          : undefined;
      return {
        key,
        path: observation.path,
        absolutePath,
        observedAt: observation.timestamp,
        ...(deleted ? { deleted: true as const } : {}),
        ...(snippet ? { snippet } : {}),
      };
    });
    return {
      files,
      unlisted: Math.max(0, changed.length - limit),
      commit: () => {
        for (const { key, current } of changed) this.reported.set(key, current.sha);
      },
    };
  }

  /**
   * The file's current hash, from the last verdict while `stat` vouches for it, and its text when
   * it is small enough to diff. `undefined` when it cannot be judged now.
   *
   * A link is never followed. The observed path is the file's real one, so a link at it, or a
   * directory above it that became one, means something else stands there now: it is reported as
   * changed and never read, so a checkout or a peer cannot point the notice at `~/.npmrc` or a
   * denied `.env` and have its lines diffed into the prompt. A handle that turns out to hold
   * another file than the one checked is not read either (`holdsVettedFile`), and a file with
   * another name (a hard link, which may be any file on this filesystem) is reported without its
   * lines.
   */
  private async judge(
    key: string,
    absolutePath: string,
    observation: FileObservation,
  ): Promise<{ sha: string; text?: string } | undefined> {
    let vetted: Stats;
    try {
      vetted = await lstat(absolutePath);
      if (vetted.isSymbolicLink()) return { sha: REPLACED };
      if (!vetted.isFile()) return { sha: DELETED };
      if (!samePath(await realpath(absolutePath), absolutePath)) return { sha: REPLACED };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      return { sha: DELETED };
    }
    if (vetted.size > MAX_JUDGED_BYTES) return undefined;
    const last = this.judged.get(key);
    if (last && last.observedSha === observation.sha256 && statVouches(last, vetted)) {
      return { sha: last.currentSha };
    }
    // Taken before the read, as `StatStamp.judgedAt` must be.
    const judgedAt = this.now();
    let bytes: Buffer;
    let held: Stats;
    try {
      const handle = await open(absolutePath, constants.O_RDONLY | NO_FOLLOW | NO_BLOCK);
      try {
        // The verdict is keyed on the stat of the handle the bytes come from, not the `lstat` above:
        // a write between the two must not be cached under the times of the file it replaced.
        held = await handle.stat();
        if (!held.isFile()) return { sha: REPLACED };
        // Another file than the one checked, or one past the cap: not read, and judged next turn.
        if (!(await holdsVettedFile(absolutePath, vetted, held))) return undefined;
        if (held.size > MAX_JUDGED_BYTES) return undefined;
        const read = await readExactly(handle, held.size);
        if (!read) return undefined;
        bytes = read;
      } finally {
        await handle.close();
      }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ELOOP' ? { sha: REPLACED } : undefined;
    }
    const sha = createHash('sha256').update(bytes).digest('hex');
    this.judged.set(key, {
      ...statStamp(held, judgedAt),
      observedSha: observation.sha256,
      currentSha: sha,
    });
    const text =
      held.nlink <= 1 && bytes.byteLength <= MAX_BASELINE_BYTES && !looksBinary(bytes)
        ? bytes.toString('utf8')
        : undefined;
    return { sha, ...(text !== undefined ? { text } : {}) };
  }
}
