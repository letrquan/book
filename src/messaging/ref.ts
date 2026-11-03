/**
 * The ref of a session's address (#620): six hex digits of its socket path's hash, written after its
 * name as `name [ref]`. Read here once, for the address resolver, the permission rules and the
 * persistence guard alike, so they cannot drift apart (#653). Dependency-free, so a module as low as
 * `tools/primary-arg.ts` can read it.
 */

/** A trailing ` [ref]`, and what comes before it. */
const REF_SUFFIX = /^(.*?)\s*\[([0-9a-fA-F]{6})\]$/;

/**
 * A spelling read as a name and the ref after it, the ref lowercased: `name [ref]`, or a ref alone,
 * whose name is `''`. `undefined` for a spelling that does not end in a ref.
 */
export function splitRef(spelling: string): { name: string; ref: string } | undefined {
  const match = REF_SUFFIX.exec(spelling.trim());
  return match ? { name: match[1].trim(), ref: match[2].toLowerCase() } : undefined;
}
