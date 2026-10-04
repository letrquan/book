import { readdir } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { FileSystemAdapter } from 'tinyglobby';

/** One path a walk asked the filesystem for and could not read. */
export interface WalkFailure {
  /** The path the walk asked for, as it asked for it. */
  path: string;
  /** The error's code (`EACCES`, `ENOTDIR`, …), or `UNKNOWN` when the error carried none. */
  code: string;
}

/** How many unreadable paths a note names before it counts the rest instead. */
const NAMED_FAILURES = 5;

/**
 * An `fs` adapter that records what a walk could not read.
 *
 * A walk reports the directories it listed and nothing else: tinyglobby hands fdir `suppressErrors`
 * (which it never offers a way to change) and fdir returns `null` for a directory `readdir` failed
 * on, so an `EACCES` directory is walked around in silence. The files below it simply do not appear,
 * and the tool that gathered the list has no way to say so: measured, a `Glob` of every file under the workspace
 * with one unreadable directory answered `a.ts` and `b.ts` as if that were the whole of it, and a
 * Grep that included it reported `0 matches` for files it never opened.
 * Handing the walk this adapter instead of `node:fs` puts the failure back in reach, so a partial
 * walk can be reported as partial. It records and passes on; it never fails a read itself, so the
 * walk behaves the same, and the cost is one closure per directory read.
 */
export interface RecordingWalkFs {
  /** Handed to the walk as its `fs` option, which fills the rest of itself from `node:fs`. */
  readonly fs: FileSystemAdapter;
  /** What the walk could not read, in the order it failed. */
  readonly failures: WalkFailure[];
}

type ReaddirCallback = (error: NodeJS.ErrnoException | null, entries?: unknown) => void;

export function recordingWalkFs(): RecordingWalkFs {
  const failures: WalkFailure[] = [];
  const readdirPassthrough = readdir as unknown as (
    path: unknown,
    options: unknown,
    callback: ReaddirCallback,
  ) => void;
  const readdirWithRecord = ((path: unknown, options: unknown, callback: ReaddirCallback): void => {
    readdirPassthrough(path, options, (error, entries) => {
      if (error) failures.push({ path: String(path), code: error.code ?? 'UNKNOWN' });
      callback(error, entries);
    });
  }) as FileSystemAdapter['readdir'];
  return { failures, fs: { readdir: readdirWithRecord } };
}

/**
 * What to tell the caller about a walk that could not read everything it searched, or '' when it did.
 *
 * Naming the directories is the point: "no matches" and "nothing here" are different answers, and
 * only the first is true of a walk that never got to read. A path inside the directory the walk
 * started from is named as the caller would write it, anything else as the filesystem spelled it.
 */
export function walkPartialNote(root: string, failures: readonly WalkFailure[]): string {
  if (failures.length === 0) return '';
  const named = failures.slice(0, NAMED_FAILURES).map((failure) => {
    const path = namedPath(root, failure.path);
    return `${path} (${failure.code})`;
  });
  const rest = failures.length - named.length;
  const count = `${failures.length} ${failures.length === 1 ? 'path' : 'paths'}`;
  const listed = [...named, ...(rest > 0 ? [`and ${rest} more`] : [])].join(', ');
  return `Note: ${count} could not be read, so these results are partial: ${listed}`;
}

/** A path as the caller wrote it when it is inside the walk's directory, else as the system spells it. */
function namedPath(root: string, path: string): string {
  const relativePath = relative(resolve(root), resolve(path));
  if (!relativePath || isAbsolute(relativePath)) return path;
  return relativePath.startsWith('..') ? path : relativePath;
}
