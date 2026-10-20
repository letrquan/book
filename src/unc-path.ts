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
 */
export function reachesUncPath(path: string, probe: UncProbe = {}): boolean {
  if ((probe.platform ?? process.platform) !== 'win32') return false;
  if (isUncSpelling(path)) return true;
  const lstat = probe.lstat ?? ((entry: string) => lstatSync(entry));
  const readlink = probe.readlink ?? ((entry: string) => readlinkSync(entry));

  let { root: current, names } = components(win32.resolve(path));
  let hops = 0;
  while (names.length > 0) {
    const next = win32.join(current, names.shift()!);
    let isLink: boolean;
    try {
      isLink = lstat(next).isSymbolicLink();
    } catch {
      return false;
    }
    if (!isLink) {
      current = next;
      continue;
    }
    if (++hops > MAX_LINK_HOPS) return true;
    let target: string;
    try {
      target = readlink(next);
    } catch {
      return true;
    }
    if (isUncSpelling(target)) return true;
    // A relative target is relative to the directory holding the link (a junction's is always
    // absolute), and Windows takes `..` in it by name, as `resolve` does.
    const resolved = win32.resolve(current, target);
    if (isUncSpelling(resolved)) return true;
    const walk = components(resolved);
    current = walk.root;
    names = [...walk.names, ...names];
  }
  return false;
}
