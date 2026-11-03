/**
 * The temp directory Book creates its own trusted entries in.
 *
 * Book keeps a few entries of its own under the host temp directory and trusts them later: an
 * ephemeral rewind store (`book-rewind-*`), a managed agent's scratch index (`book-index-*`), the
 * settings preflight copy (`book-config-preflight-*`) and the messaging inbox's socket directory
 * (`book-socks-<uid>`). On macOS a sandboxed command may write the temp directories, and the
 * Seatbelt profile keeps these entries out of its reach by name (`BOOK_TEMP_PREFIXES`). A temp
 * directory that had been moved aside and replaced, by a symlink into the workspace say, would put
 * the next trusted entry where sandboxed commands can write (#652). The profile refuses that move;
 * this is the host's half of the same rule.
 *
 * The directory is resolved once, when this module loads at startup, and an entry is created only
 * while `os.tmpdir()` still resolves to it. Anything else is refused rather than worked around:
 * the path that resolved at startup is exactly where a replacement would sit.
 */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

function resolveTempRoot(): string | null {
  try {
    return realpathSync(tmpdir());
  } catch {
    return null;
  }
}

/** `os.tmpdir()` with its links followed, as it was when Book started. */
const STARTUP_TEMP_ROOT = resolveTempRoot();

/**
 * The decision {@link trustedTempRoot} makes, from the three paths it reads. Exported for testing.
 *
 * @param startup - The canonical temp directory at startup, or null when it did not resolve.
 * @param current - The canonical temp directory now, or null when it does not resolve.
 * @param spelled - `os.tmpdir()` now, as the error names it.
 */
export function checkTempRoot(
  startup: string | null,
  current: string | null,
  spelled: string,
): string {
  if (startup !== null && current === startup) return startup;
  if (startup === null) {
    // Not re-resolved later: on macOS a sandboxed command may create the path
    // (one under /private/tmp, say), so a directory that only appears after
    // startup is no more trusted than a replaced one.
    throw new Error(
      `Refusing to create Book's temporary files in ${spelled}: it did not exist when Book ` +
        'started, so there is no directory to hold it to. Create it, or point the temp ' +
        'directory at one that exists, and restart Book.',
    );
  }
  const now = current === null ? 'no longer resolves' : `resolves to ${current}`;
  throw new Error(
    `Refusing to create Book's temporary files in ${spelled}: it ${now}, and it resolved to ` +
      `${startup} when Book started. The temp directory was moved or replaced since then, so a ` +
      'file Book keeps there could land where another process controls it. Restart Book.',
  );
}

/**
 * The canonical temp directory for an entry Book creates and later trusts, or a throw when
 * `os.tmpdir()` no longer resolves to the directory it resolved to at startup.
 */
export function trustedTempRoot(): string {
  return checkTempRoot(STARTUP_TEMP_ROOT, resolveTempRoot(), tmpdir());
}
