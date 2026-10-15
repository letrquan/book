/**
 * The two limits `MEMORY.md` is loaded under. A leaf module so the memory write guard can read
 * them without importing `memory-store.ts`, which would close an import cycle through
 * `permissions.ts` and the file tools.
 */
export const DEFAULT_MAX_INDEX_LINES = 200;
export const MAX_INDEX_BYTES = 25_000;
