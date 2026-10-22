/**
 * The rule for the files Book itself writes into a workspace. Its own module, with nothing but
 * `fs`, `path` and `BOOK_HOME` behind it, so the debug logger can use it too.
 */
import { lstatSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { resolveBookHome } from './book-home.js';

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why Book will not write the workspace file at `path`, or undefined when it may: the one check
 * every one of Book's own workspace writes goes through (`.book/settings.json`,
 * `.book/settings.local.json`, `.book/migrations.json`, a project `.mcp.json`, `/export`, the
 * default `.book/debug.log`), including the read a write starts from.
 *
 * Such a file is written only while it is a regular file or does not exist yet, in a `.book`
 * folder that is a real directory or does not exist yet. Anything else (a link, a FIFO, a device,
 * a directory in the file's place) is left exactly as it is: not read for the write, not written
 * through, and not replaced. The answer is the reason, without the path or a full stop, for the
 * caller's one-line notice: `<path>: <reason>`.
 *
 * The user-global files (`<BOOK_HOME>/settings.json` and `<BOOK_HOME>/mcp.json`) keep their
 * behaviour: they are the user's own, and one kept elsewhere and linked into place is a setup this
 * must not break. Only those two paths are exempt, not the rest of `<BOOK_HOME>`, which also holds
 * checkouts of other repositories.
 */
export function projectFileWriteRefusal(path: string): string | undefined {
  const target = resolve(path);
  const home = resolve(resolveBookHome());
  if (target === join(home, 'settings.json') || target === join(home, 'mcp.json')) {
    return undefined;
  }
  try {
    const folder = dirname(target);
    // `<BOOK_HOME>` itself (a workspace at `$HOME`, where `.book` is it) is the user's own folder,
    // and a dotfiles setup often links it into place.
    if (basename(folder) === '.book' && folder !== home) {
      const folderStats = lstatSync(folder, { throwIfNoEntry: false });
      if (folderStats && !folderStats.isDirectory()) {
        return 'its .book folder is not a regular directory, so Book left it unchanged';
      }
    }
    const stats = lstatSync(target, { throwIfNoEntry: false });
    if (!stats || stats.isFile()) return undefined;
  } catch (error) {
    return `could not be inspected (${safeMessage(error)}), so Book left it unchanged`;
  }
  return 'not a regular file, so Book left it unchanged';
}
