/**
 * Filesystem-contention helpers shared by the agent state store and the persistent job store.
 *
 * Both write a small JSON document atomically, through a temporary file and a rename, and both can
 * find the target already held: Windows will not replace a file another process has open, so a
 * rename there fails with a code that means "try again" rather than "never". These are the shared
 * pieces for telling those codes apart and for waiting between retries, kept here so that neither
 * store has to reach into the other for them.
 */

/** Codes Windows returns while another process has a file open: retried, never fatal on first sight. */
export const FILE_CONTENTION_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** Block the calling thread for `milliseconds`. */
export function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
