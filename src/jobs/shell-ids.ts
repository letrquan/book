import type { BackgroundShellStore } from '../types/runtime.js';

/**
 * A session background shell is `shell_<n>`. A persistent one is `shell_<uuid>`, whose first group
 * can be all digits (`shell_12345678-…`), so a match may not run on into a word character or a
 * hyphen.
 */
const SESSION_SHELL_ID = /\bshell_(\d+)(?![\w-])/g;

/**
 * The counter value that cannot collide with any `shell_<n>` id the given messages mention: one
 * past the highest, or 1 when there is none.
 *
 * `nextId` restarts at 1 for every runtime, so a resumed session's transcript ("Background shell
 * `T` (shell_1) exited.") and the first shell it starts next would otherwise share an id (#449).
 */
export function nextShellIdAfter(...sources: unknown[]): number {
  let highest = 0;
  for (const source of sources) {
    // The replacer sees every string value as written, so the ids are read from the text itself
    // rather than from its JSON escaping (`\nshell_1` has no word boundary before the `s`).
    JSON.stringify(source, (_key, value: unknown) => {
      if (typeof value === 'string') {
        for (const match of value.matchAll(SESSION_SHELL_ID)) {
          const id = Number(match[1]);
          if (Number.isSafeInteger(id) && id > highest) highest = id;
        }
      }
      return value;
    });
  }
  return highest + 1;
}

/**
 * Raise `store.nextId` past every id the sources mention. The store is changed in place: the
 * runtime's `ShellJobManager` holds it by reference, so a replacement would never be seen.
 */
export function seedShellIds(store: BackgroundShellStore, ...sources: unknown[]): void {
  store.nextId = Math.max(store.nextId, nextShellIdAfter(...sources));
}
