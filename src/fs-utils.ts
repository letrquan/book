import { lstat } from 'node:fs/promises';

/**
 * Whether anything is at `path`, asked on the thread pool rather than with `existsSync`. A symbolic
 * link counts whether or not its target exists: the question is about the path, not what it names.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}
