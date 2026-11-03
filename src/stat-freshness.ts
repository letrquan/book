/**
 * When `stat` alone may vouch for a file's bytes (#647). One rule for every cache that skips a read
 * on unchanged stat facts (the changed-on-disk tracker in `tools/file-changes.ts`, `/rewind`'s code
 * snapshots) and for the skill loaders' check against discovery, so they cannot drift apart.
 *
 * The facts are size, mtime and ctime. ctime is among them because a tool that puts mtime back
 * (`cp -p`, `touch -r`, `rsync -t`) cannot put ctime back, and a rename into place gives the file its
 * own. Equal facts still do not prove equal bytes when the file changed too close to the moment it
 * was read: a write landing in the same timestamp tick as the read (a same-size edit on a coarse
 * clock: up to FAT's 2 s) leaves every fact as it was. So equal facts are trusted only once both
 * times were a margin older than that moment: git's "racily clean" rule.
 */

/**
 * How much older than its judgment a file's mtime and ctime must be before `stat` alone is trusted:
 * timestamp granularity up to FAT's 2 s. A filesystem whose clock lags this machine's by more (some
 * network mounts) can still stamp a racy write as older, and then a same-size edit in that window
 * goes unseen until the file changes again.
 */
export const RACY_MARGIN_MS = 2_000;

/** What `stat` says of a file's bytes. */
export interface StatFacts {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
}

/** The facts a verdict about a file's bytes was keyed on, and when those bytes were judged. */
export interface StatStamp extends StatFacts {
  /**
   * When the bytes were judged, taken before they were read, by the wall clock the file's times are
   * stamped with: a write after this instant either moves the times past it or lands inside the
   * margin, and either way `stat` no longer vouches for the verdict.
   */
  readonly judgedAt: number;
}

/** The stamp for bytes read from a file whose stat was `info`, judged at `judgedAt`. */
export function statStamp(info: StatFacts, judgedAt: number): StatStamp {
  return { size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, judgedAt };
}

/**
 * Whether `stat` reports the facts recorded: as far as it can tell, nothing wrote, replaced or
 * re-stamped the file since.
 */
export function sameStatFacts(recorded: StatFacts, current: StatFacts): boolean {
  return (
    recorded.size === current.size &&
    recorded.mtimeMs === current.mtimeMs &&
    recorded.ctimeMs === current.ctimeMs
  );
}

/**
 * Whether a file whose stat is now `current` still holds the bytes a verdict stamped `stamp` was
 * taken from, without reading it again: its facts have not moved, and both times were already a
 * margin older than the judgment. A file with no useful ctime (0, or constant) falls back to its
 * mtime here; one stamped in the future (an archive from a timezone ahead) is read every time until
 * the clock has passed that mtime.
 */
export function statVouches(stamp: StatStamp, current: StatFacts): boolean {
  return (
    sameStatFacts(stamp, current) &&
    Math.max(current.mtimeMs, current.ctimeMs) + RACY_MARGIN_MS <= stamp.judgedAt
  );
}
