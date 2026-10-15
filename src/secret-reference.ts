/**
 * How a settings `apiKey` reads: a literal, an `{env:VAR}` reference or a `{file:path}` reference.
 *
 * One parser for the code that resolves a key (`config.ts`) and the disclosure that tells the user
 * what an approval would let Book read (`provider-approvals.ts`), so what is shown is what is
 * opened: the same pattern, and the same normalisation of the path.
 */
import { homedir } from 'os';
import { isAbsolute, join, relative, resolve } from 'path';

export type SecretReference =
  { kind: 'env'; name: string } | { kind: 'file'; path: string } | { kind: 'literal' };

/** Classify a declared key without reading anything. */
export function parseSecretReference(raw: string): SecretReference {
  const envMatch = raw.match(/^\{env:([^}]+)\}$/);
  if (envMatch) return { kind: 'env', name: envMatch[1] };
  const fileMatch = raw.match(/^\{file:([^}]+)\}$/);
  if (fileMatch) return { kind: 'file', path: fileMatch[1] };
  return { kind: 'literal' };
}

/** The file a `{file:…}` reference names, normalised, and whether Book would read it. */
export interface ResolvedSecretFile {
  /** Absolute, with `~` expanded and `.` / `..` segments resolved. */
  path: string;
  /** False for a relative path that leaves the workspace: it is refused, never opened. */
  readable: boolean;
}

/**
 * Resolve the path of a `{file:…}` reference: `~/` is the home directory, an absolute path stays
 * as written, and a relative one is rooted at the workspace and must stay inside it.
 */
export function resolveSecretFilePath(reference: string, workspace: string): ResolvedSecretFile {
  if (reference.startsWith('~/')) {
    return { path: join(homedir(), reference.slice(2)), readable: true };
  }
  if (isAbsolute(reference)) return { path: resolve(reference), readable: true };
  const root = resolve(workspace);
  const path = resolve(root, reference);
  const rel = relative(root, path);
  return { path, readable: !(rel.startsWith('..') || isAbsolute(rel)) };
}
