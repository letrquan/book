import { existsSync, readdirSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { skillRoots, type DiscoverSkillsOptions } from './skills.js';

export interface SkillWatcherOptions extends DiscoverSkillsOptions {
  debounceMs?: number;
  onDirty: () => void;
  onError?: (error: Error) => void;
}

function nearestExistingDirectory(path: string): string | undefined {
  let current = resolve(path);
  while (true) {
    if (existsSync(current)) {
      try {
        if (statSync(current).isDirectory()) return current;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Windows reports directory-change events using the volume's canonical path, while libuv asserts
 * that the reported name still matches the path it was handed (`!_wcsnicmp(filename, dir, dirlen)`
 * in `src/win/fs-event.c`). Handing it a path that Windows canonicalizes differently — an 8.3 short
 * component such as `C:\Users\RUNNER~1\…`, or a junction — makes that assertion fail, and a failed
 * libuv assertion calls `abort()`, killing the process with no catchable error. Canonicalize first
 * so the two always agree. POSIX is left alone: `directoriesUnder` deliberately does not follow
 * symlinks, and resolving them here would change which directory gets watched.
 */
function watchablePath(directory: string): string {
  if (process.platform !== 'win32') return directory;
  try {
    return realpathSync.native(directory);
  } catch {
    return directory;
  }
}

function directoriesUnder(root: string): string[] {
  const directories: string[] = [];
  const visit = (directory: string, depth: number): void => {
    directories.push(directory);
    if (depth >= 6) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      visit(resolve(directory, entry.name), depth + 1);
    }
  };
  visit(root, 0);
  return directories;
}

/** Debounced cross-platform watcher for user and project skill roots. */
export class SkillWatcher {
  private readonly workspace: string;
  private readonly options: SkillWatcherOptions;
  private readonly watchers = new Map<string, FSWatcher>();
  private timer?: NodeJS.Timeout;
  private closed = false;

  constructor(workspace: string, options: SkillWatcherOptions) {
    this.workspace = resolve(workspace);
    this.options = options;
  }

  start(): void {
    if (this.closed) return;
    this.rebuild();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private rebuild(): void {
    const directories = new Set<string>();
    for (const root of skillRoots(this.workspace, this.options)) {
      const nearest = nearestExistingDirectory(root.path);
      if (!nearest) continue;
      // Compare the lexical path against the root: the canonical form can differ on Windows, which
      // would make an exactly-matching root look like an ancestor and stop the recursive walk.
      const target = watchablePath(nearest);
      if (resolve(nearest) === resolve(root.path)) {
        for (const directory of directoriesUnder(target)) directories.add(directory);
      } else {
        directories.add(target);
      }
    }
    // Keep the handles for directories that are still in scope. Closing and reopening every
    // watcher on each change churns one OS directory handle per watched directory, which is
    // enough to abort a worker process on Windows when the tree sees sustained write activity.
    for (const [directory, watcher] of this.watchers) {
      if (directories.has(directory)) continue;
      watcher.close();
      this.watchers.delete(directory);
    }
    for (const directory of directories) {
      if (!this.watchers.has(directory)) this.watchDirectory(directory);
    }
  }

  private watchDirectory(directory: string): void {
    try {
      const watcher = watch(directory, () => this.scheduleDirty());
      watcher.on('error', (error) => this.options.onError?.(error));
      this.watchers.set(directory, watcher);
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private scheduleDirty(): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.closed) return;
      this.rebuild();
      this.options.onDirty();
    }, this.options.debounceMs ?? 150);
    this.timer.unref?.();
  }
}
