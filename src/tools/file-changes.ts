/**
 * Files the model has observed that changed on disk since (#620 4a), Claude Code's
 * `edited_text_file` notice. A user's edit, a formatter, a linter or another session can change a
 * file between turns; the next turn's `<session-state>` says so instead of waiting for a write to
 * fail on the stale-file check.
 *
 * Judged against the observation ledger (`file-provenance.ts`), so the model's own edits — which
 * re-observe the file — never count. Each change is reported once. A file whose size and mtime
 * have not moved since it was last judged is not read again, so a quiet turn costs one `stat` per
 * observed file.
 */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mapLimited } from '../async.js';
import { redactSecrets } from '../provider-secrets.js';
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
/** A bigger file is not read again to be judged: it goes unreported rather than cost a turn. */
const MAX_JUDGED_BYTES = 16 * 1024 * 1024;
/** Where the platform has it (not Windows), a read that refuses to follow a final link. */
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

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

interface Judged {
  observedSha: string;
  size: number;
  mtimeMs: number;
  /** The file's hash then, or `deleted`. */
  currentSha: string;
}

const DELETED = 'deleted';
/** A link, or a path through one, now stands where the observed file was. */
const REPLACED = 'replaced';

function samePath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

/**
 * The change as a diff of at most {@link MAX_CHANGE_SNIPPET_LINES} lines, or `undefined` when it
 * is longer. The changed span is measured first, so a large rewrite is never diffed at all.
 * Provider keys are redacted from the whole diff before a long line is cut, so a key the cut
 * would split cannot escape the redaction by half.
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
  const lines = redactSecrets(diff, secrets).split('\n');
  if (lines.length > MAX_CHANGE_SNIPPET_LINES) return undefined;
  return lines.map((line) => Array.from(line).slice(0, MAX_SNIPPET_LINE_CHARS).join(''));
}

/**
 * One session's memory of what it has reported. Lives on the session's runtime, beside the
 * observation ledger it reads, and is replaced with it on `/clear`.
 */
export class FileChangeTracker {
  private readonly judged = new Map<string, Judged>();
  /** The change last reported per key, so the same change is never reported twice. */
  private readonly reported = new Map<string, string>();
  /**
   * Text a file held when it was observed, by key, least recently observed first, with the size of
   * the bytes it was decoded from: what the budget counts, whatever the decoding made of them.
   */
  private readonly baselines = new Map<string, { sha256: string; text: string; bytes: number }>();
  private baselineBytes = 0;

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
   * The file's current hash, from the last verdict when its size and mtime have not moved, and its
   * text when it is small enough to diff. `undefined` when it cannot be judged now.
   *
   * A link is never followed. The observed path is the file's real one, so a link at it, or a
   * directory above it that became one, means something else stands there now: it is reported as
   * changed and never read, so a checkout or a peer cannot point the notice at `~/.npmrc` or a
   * denied `.env` and have its lines diffed into the prompt.
   */
  private async judge(
    key: string,
    absolutePath: string,
    observation: FileObservation,
  ): Promise<{ sha: string; text?: string } | undefined> {
    let info;
    try {
      info = await lstat(absolutePath);
      if (info.isSymbolicLink()) return { sha: REPLACED };
      if (!info.isFile()) return { sha: DELETED };
      if (!samePath(await realpath(absolutePath), absolutePath)) return { sha: REPLACED };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined;
      return { sha: DELETED };
    }
    if (info.size > MAX_JUDGED_BYTES) return undefined;
    const last = this.judged.get(key);
    if (
      last &&
      last.observedSha === observation.sha256 &&
      last.size === info.size &&
      last.mtimeMs === info.mtimeMs
    ) {
      return { sha: last.currentSha };
    }
    let bytes: Buffer;
    try {
      const handle = await open(absolutePath, constants.O_RDONLY | NO_FOLLOW);
      try {
        if (!(await handle.stat()).isFile()) return { sha: REPLACED };
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ELOOP' ? { sha: REPLACED } : undefined;
    }
    const sha = createHash('sha256').update(bytes).digest('hex');
    this.judged.set(key, {
      observedSha: observation.sha256,
      size: info.size,
      mtimeMs: info.mtimeMs,
      currentSha: sha,
    });
    const text =
      bytes.byteLength <= MAX_BASELINE_BYTES && !looksBinary(bytes)
        ? bytes.toString('utf8')
        : undefined;
    return { sha, ...(text !== undefined ? { text } : {}) };
  }
}
