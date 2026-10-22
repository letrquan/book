import { win32 } from 'node:path';
import { vi } from 'vitest';

/**
 * Windows links on any host, for the `*.win32.test.ts` suites that check a walk asks the UNC
 * guard (`src/unc-path.ts`) before it follows a link. A suite declares the links the guard is to
 * see, keyed by their Windows spelling, and mocks `fs` (and `node:fs`, which some modules import)
 * with {@link withWindowsLinks}:
 *
 * ```ts
 * const links = vi.hoisted(() => ({ map: new Map<string, string>(), posixHost: process.platform !== 'win32' }));
 * vi.mock('fs', async (importOriginal) =>
 *   (await import('./test/windows-links.js')).withWindowsLinks(await importOriginal(), links),
 * );
 * ```
 *
 * The walk itself runs over a real directory; only `lstatSync` and `readlinkSync` answer from the
 * map, and the calls that follow a link are spied, so a test can assert none reached a link's
 * target and that a local path, the control, still did. This module imports no `fs` itself.
 */
export interface WindowsLinks {
  /** A path's Windows spelling, to the target the guard is told it links to. */
  map: Map<string, string>;
  /** Whether the host is POSIX, read before any test stubs `process.platform`. */
  posixHost: boolean;
}

/** A path in the spelling the guard asks about it: `win32.resolve`d. */
export const windowsSpelling = (path: string): string => win32.resolve(path);

/**
 * The host's own spelling of a path the guard asks about. On a POSIX host it asks about `\tmp\…`,
 * the Windows spelling of `/tmp/…`; on Windows the two are the same.
 */
function onHost(links: WindowsLinks, path: string): string {
  return links.posixHost && /^\\(?!\\)/.test(path) ? path.replace(/\\/g, '/') : path;
}

const linkStats = {
  isSymbolicLink: () => true,
  isDirectory: () => false,
  isFile: () => false,
  size: 0,
  mtimeMs: 0,
  uid: 0,
};

/** `actual` with the map's links visible to `lstatSync`/`readlinkSync`, and the following calls spied. */
export function withWindowsLinks<T extends typeof import('node:fs')>(
  actual: T,
  links: WindowsLinks,
): T {
  const realpathSync = Object.assign(vi.fn(actual.realpathSync), {
    native: vi.fn(actual.realpathSync.native),
  });
  return {
    ...actual,
    lstatSync: vi.fn((path: string, ...rest: unknown[]) =>
      links.map.has(path)
        ? linkStats
        : (actual.lstatSync as (...args: unknown[]) => unknown)(onHost(links, path), ...rest),
    ),
    readlinkSync: vi.fn(
      (path: string, ...rest: unknown[]) =>
        links.map.get(path) ??
        (actual.readlinkSync as (...args: unknown[]) => unknown)(onHost(links, path), ...rest),
    ),
    existsSync: vi.fn(actual.existsSync),
    statSync: vi.fn(actual.statSync),
    readdirSync: vi.fn(actual.readdirSync),
    openSync: vi.fn(actual.openSync),
    readFileSync: vi.fn(actual.readFileSync),
    realpathSync,
    readdir: vi.fn(actual.readdir),
    realpath: Object.assign(vi.fn(actual.realpath), { native: actual.realpath.native }),
  } as T;
}

/** The paths a spied call was handed, in their Windows spelling. */
export function calledWith(spy: unknown): string[] {
  return (spy as { mock: { calls: unknown[][] } }).mock.calls.map(([path]) =>
    windowsSpelling(String(path)),
  );
}

/** Whether a spied call was handed `path` or anything under it. */
export function touches(spy: unknown, path: string): boolean {
  // A share's root resolves with a trailing separator (`\\host\share\`).
  const target = windowsSpelling(path).replace(/\\$/, '');
  return calledWith(spy).some((called) => called === target || called.startsWith(`${target}\\`));
}

/** Clear every spy {@link withWindowsLinks} made in `fs`, so a test counts only its own calls. */
export function clearSpies(fs: object): void {
  for (const value of Object.values(fs)) {
    if (vi.isMockFunction(value)) value.mockClear();
    const native = (value as { native?: unknown } | undefined)?.native;
    if (vi.isMockFunction(native)) native.mockClear();
  }
}
