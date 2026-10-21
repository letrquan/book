import { lstatSync, readlinkSync } from 'fs';
import { win32 } from 'path';

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

/**
 * A {@link reachesUncPath} that remembers what it probed (#579). Paths that share a prefix are
 * walked through the same components, and a link to an absolute target restarts the walk at the
 * volume root, so the same `lstat` was asked again and again; here each path is probed once, with
 * its link read once. The memo lives as long as the guard, so a caller makes one per top-level
 * call (a listing, a walk) and drops it after: a file system that changes later is probed afresh.
 */
export function createUncGuard(probe: UncProbe = {}): UncGuard {
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
    if (isUncSpelling(path)) return true;
    let { root: current, names } = components(win32.resolve(path));
    let hops = 0;
    while (names.length > 0) {
      const next = win32.join(current, names.shift()!);
      const entry = look(next);
      if (entry.kind === 'missing') return false;
      if (entry.kind === 'plain') {
        current = next;
        continue;
      }
      if (++hops > MAX_LINK_HOPS) return true;
      const target = entry.target;
      if (target === undefined || isUncSpelling(target)) return true;
      // A relative target is relative to the directory holding the link (a junction's is always
      // absolute), and Windows takes `..` in it by name, as `resolve` does.
      const resolved = win32.resolve(current, target);
      if (isUncSpelling(resolved)) return true;
      const walk = components(resolved);
      current = walk.root;
      names = [...walk.names, ...names];
    }
    return false;
  };
}
