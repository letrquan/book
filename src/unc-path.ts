import { lstatSync, readdir, readlinkSync, realpath } from 'fs';
import { isAbsolute, resolve, win32 } from 'path';
import type { FileSystemAdapter } from 'tinyglobby';

/**
 * The UNC guard every containment check asks before it resolves a path (#567).
 *
 * On Windows, resolving a path that is, or reaches through a link, `\\host\share\…` opens that
 * share: `realpath` can send an SMB request, and with it the user's NTLM credentials, to `host`
 * before the path is ever compared with a root. A repository can commit such a link
 * (`docs/x.md -> \\host\share\y.md`), so the answer has to come from reading each link, never from
 * following one: each component of the path is `lstat`ed, and a link's target is read with
 * `readlink` and walked in its place. Nothing here exists on other platforms, where a path that
 * starts with two slashes is an ordinary local path.
 */

/** The file-system calls the walk makes, injectable so a Windows walk can run on any host. */
export interface UncProbe {
  platform?: NodeJS.Platform;
  lstat?: (path: string) => { isSymbolicLink(): boolean };
  readlink?: (path: string) => string;
}

/** Links followed before the walk gives up and refuses: a cycle, or a chain no file needs. */
const MAX_LINK_HOPS = 40;

/**
 * A path that starts with two separators: `\\host\share`, `//host/share`, and the `\\?\UNC\…` and
 * `\\.\…` namespaces. All of them are refused, not only the ones naming a host, since a namespace
 * prefix can name one too.
 */
export function isUncSpelling(path: string): boolean {
  return /^[\\/]{2}/.test(path);
}

function components(path: string): { root: string; names: string[] } {
  const { root } = win32.parse(path);
  return {
    root,
    names: path
      .slice(root.length)
      .split(/[\\/]+/)
      .filter(Boolean),
  };
}

/**
 * Whether resolving `path` on Windows could reach a UNC location: the path is spelled as one, or a
 * link on the way to it (the path itself included) points at one. `true` is also the answer for a
 * link that cannot be read and for a chain longer than any file needs, so a caller that refuses on
 * `true` fails closed. A component that does not exist ends the walk: nothing past it can be
 * resolved, so nothing past it is reached. Always `false` off Windows.
 *
 * Each call probes a path at most once (see {@link createUncGuard}); a caller asking about many
 * paths makes one guard and asks it instead.
 */
export function reachesUncPath(path: string, probe: UncProbe = {}): boolean {
  return createUncGuard(probe)(path);
}

/** {@link reachesUncPath} for one top-level call, answering from what it already probed. */
export type UncGuard = (path: string) => boolean;

/** What probing one path found: a link carries its target, `undefined` when it cannot be read. */
type Probed =
  { kind: 'missing' } | { kind: 'plain' } | { kind: 'link'; target: string | undefined };

/** What a {@link createUncGuard} takes as given. */
export interface UncGuardOptions {
  /**
   * Roots the user chose, such as an `additionalDirectories` entry or the memory directory. Each
   * is taken as given, on a share or not, with the directories above it: only what lies below is
   * walked. A link there to a UNC location outside every such root is judged as any other.
   */
  trusted?: readonly string[];
}

/** Whether `path` is `root` or lies below it, both as Windows reads them. */
function isWithinWindowsPath(root: string, path: string): boolean {
  const rel = win32.relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith('..\\') && !win32.isAbsolute(rel));
}

/**
 * A {@link reachesUncPath} that remembers what it probed (#579). Paths that share a prefix are
 * walked through the same components, and a link to an absolute target restarts the walk at the
 * volume root, so the same `lstat` was asked again and again; here each path is probed once, with
 * its link read once. The memo lives as long as the guard, so a caller makes one per top-level
 * call (a listing, a walk) and drops it after: a file system that changes later is probed afresh.
 * With `trusted` roots ({@link UncGuardOptions}) a location inside one of them is not a refusal.
 */
export function createUncGuard(probe: UncProbe = {}, options: UncGuardOptions = {}): UncGuard {
  const trusted = (options.trusted ?? []).map((root) => win32.resolve(root));
  // A UNC location the user chose: one inside a trusted root.
  const chosen = (path: string) => trusted.some((root) => isWithinWindowsPath(root, path));
  // A trusted root, or a directory above one: taken as given, never probed.
  const given = (path: string) => trusted.some((root) => isWithinWindowsPath(path, root));
  const refused = (spelled: string, resolved: string) =>
    isUncSpelling(spelled) && !chosen(resolved);
  const lstat = probe.lstat ?? ((entry: string) => lstatSync(entry));
  const readlink = probe.readlink ?? ((entry: string) => readlinkSync(entry));
  const probed = new Map<string, Probed>();
  const look = (entry: string): Probed => {
    const known = probed.get(entry);
    if (known) return known;
    let found: Probed;
    try {
      if (lstat(entry).isSymbolicLink()) {
        let target: string | undefined;
        try {
          target = readlink(entry);
        } catch {
          target = undefined;
        }
        found = { kind: 'link', target };
      } else {
        found = { kind: 'plain' };
      }
    } catch {
      found = { kind: 'missing' };
    }
    probed.set(entry, found);
    return found;
  };

  return (path) => {
    if ((probe.platform ?? process.platform) !== 'win32') return false;
    if (refused(path, win32.resolve(path))) return true;
    let { root: current, names } = components(win32.resolve(path));
    let hops = 0;
    while (names.length > 0) {
      const next = win32.join(current, names.shift()!);
      if (given(next)) {
        current = next;
        continue;
      }
      const entry = look(next);
      if (entry.kind === 'missing') return false;
      if (entry.kind === 'plain') {
        current = next;
        continue;
      }
      if (++hops > MAX_LINK_HOPS) return true;
      const target = entry.target;
      if (target === undefined) return true;
      // A relative target is relative to the directory holding the link (a junction's is always
      // absolute), and Windows takes `..` in it by name, as `resolve` does.
      const resolved = win32.resolve(current, target);
      if (refused(target, resolved) || refused(resolved, resolved)) return true;
      const walk = components(resolved);
      current = walk.root;
      names = [...walk.names, ...names];
    }
    return false;
  };
}

type Callback = (error: NodeJS.ErrnoException | null, ...results: unknown[]) => void;

/** The calls {@link uncGuardedWalkFs} wraps; each defaults to `fs`'s own. */
export type WalkFsBase = Pick<FileSystemAdapter, 'readdir' | 'realpath'>;

/**
 * The `fs` a tinyglobby walk under `root` is handed on Windows so that it never opens a UNC
 * location (#579), or `undefined` elsewhere, where the guard is always `false`.
 *
 * tinyglobby follows links: fdir `realpath`s each link entry, then `stat`s and lists what that
 * resolved to. It also picks where to start from the pattern, so a pattern can name a share as
 * the directory to list. Two calls therefore ask `reachesUnc` first and, when the answer is yes,
 * fail the way an unreadable entry does, which fdir passes over:
 *
 * - `realpath`, for every link entry;
 * - `readdir`, for a directory the walk did not reach by listing its parent. A directory entry is
 *   never a link (Windows reports every reparse point as one), so a directory listed from a
 *   checked one is local and needs no probe. What is left to check is where the walk starts and
 *   the targets of the links it follows.
 *
 * `stat` only ever sees what an approved `realpath` resolved to, so it is not wrapped. Calls that
 * pass go to `base` (a recording adapter, say) or to `fs`; `onRefused` hears of each one that
 * did not, so a walk can say its answer is partial. A path the walk hands over relative is taken
 * from `root`.
 */
export function uncGuardedWalkFs(
  root: string,
  reachesUnc: UncGuard,
  base: WalkFsBase = {},
  onRefused?: (path: string) => void,
): FileSystemAdapter | undefined {
  if (process.platform !== 'win32') return undefined;
  const keyOf = (path: unknown) => {
    const asked = String(path);
    return win32.resolve(isAbsolute(asked) ? asked : resolve(root, asked));
  };
  // The directories this walk listed, and the links it followed: what is under them is local.
  const checked = new Set<string>();
  const refuse = (path: unknown, rest: unknown[]): void => {
    onRefused?.(String(path));
    const callback = rest[rest.length - 1] as Callback;
    const error = Object.assign(
      new Error(`Not opened, it reaches a UNC location: ${String(path)}`),
      {
        code: 'EUNC',
      },
    );
    // Asynchronously, as `fs` answers: the walk counts its pending calls around this one.
    process.nextTick(callback, error);
  };
  const readdirBase = (base.readdir ?? readdir) as (...args: unknown[]) => void;
  const realpathBase = (base.realpath ?? realpath) as (...args: unknown[]) => void;
  const readdirGuarded = ((path: unknown, ...rest: unknown[]): void => {
    const key = keyOf(path);
    if (!checked.has(win32.dirname(key)) && !checked.has(key) && reachesUnc(key)) {
      refuse(path, rest);
      return;
    }
    checked.add(key);
    readdirBase(path, ...rest);
  }) as typeof readdir;
  const realpathGuarded = ((path: unknown, ...rest: unknown[]): void => {
    const key = keyOf(path);
    if (reachesUnc(key)) {
      refuse(path, rest);
      return;
    }
    // fdir lists a linked directory's entries under the link's own spelling.
    checked.add(key);
    realpathBase(path, ...rest);
  }) as typeof realpath;
  return { readdir: readdirGuarded, realpath: realpathGuarded };
}
