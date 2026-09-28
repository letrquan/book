import { existsSync, realpathSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import type { ReadOnlyRoot, ToolResult } from '../types/tools.js';
import { toolFailure } from './result.js';

function isOutside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

function nearestExistingPath(inputPath: string): string | null {
  let candidate = inputPath;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
  return candidate;
}

export function resolveWorkspacePath(
  workspaceRoot: string,
  inputPath: string,
): { filePath: string; canonicalPath: string; relativePath: string } | null {
  const lexicalRoot = resolve(workspaceRoot);
  const filePath = resolve(isAbsolute(inputPath) ? inputPath : resolve(lexicalRoot, inputPath));
  // Containment is decided on the canonical pair — both sides after following links, and in one
  // separator — because one directory has more than one spelling. A root the user typed in 8.3
  // short form (`C:\Users\RUNNER~1\…`) is a different string from the long form `realpath`,
  // fast-glob and ripgrep report, and reading "outside" between the two spellings of the *same*
  // directory is what let a `.book/settings.local.json` inside the workspace look like a file
  // somewhere else (#264). The canonical path is the one a read opens and a write lands on, so it
  // is the one that decides, and a link pointing out of a root still resolves outside it.
  const canonicalRoot = canonicalizePath(lexicalRoot);
  const canonicalPath = canonicalizePath(filePath);
  if (isOutside(canonicalRoot, canonicalPath)) return null;

  // The spelling shown to the model is relative to the root as written whenever the path was
  // written inside it, so a symlinked spelling keeps naming the file the way the caller reached it
  // (`link/notes.txt`) rather than by its real name.
  const asWrittenInside = !isOutside(lexicalRoot, filePath);
  const rel = asWrittenInside
    ? relative(lexicalRoot, filePath)
    : relative(canonicalRoot, canonicalPath);
  return { filePath, canonicalPath, relativePath: rel.replace(/\\/g, '/') };
}

export interface ResolvedReadablePath {
  filePath: string;
  canonicalPath: string;
  relativePath: string;
  /**
   * The root that served this path, as the caller spelled it — the same string the file tools
   * glob and ripgrep from, and the one a result label should keep using, since it is the spelling
   * `Read` accepts back.
   */
  root: string;
  /**
   * Whether `root` is the workspace, which is what makes `relativePath` the workspace-relative
   * spelling rather than one relative to some other root.
   */
  inWorkspace: boolean;
}

/** The roots a file tool may serve, in the order it tries them. */
export interface PathRoots {
  workspaceRoot: string;
  readOnlyRoots?: readonly (string | ReadOnlyRoot)[];
  /**
   * Honored `additionalDirectories` (#300), as resolved real roots. Tried after the workspace, and
   * only for an absolute path: a relative path stays workspace-anchored.
   *
   * These are *read* roots. A write tool still resolves against the workspace alone
   * ({@link resolveWorkspacePath}), so widening this list never widens what Write, Edit,
   * MultiEdit, NotebookEdit or ApplyPatch may change.
   */
  additionalRoots?: readonly string[];
}

/** The entries of a read-only root list, which carry exclusions, as a plain array. */
function readOnlyEntries(roots: PathRoots): Array<string | ReadOnlyRoot> {
  return [...(roots.readOnlyRoots ?? []), ...(roots.additionalRoots ?? [])];
}

/**
 * Why a path no tool may serve it: `excluded` when it fell under a root that hides it (Book's
 * memory inbox, `.book/settings.local.json`'s directory), or `unreachable` when no root contains
 * it at all. Only the second is a refusal whose remedy is to widen the roots; the first has a
 * narrower one, and a prompt is the right answer for it.
 */
export type UnreachablePathReason = 'excluded' | 'unreachable';

export type ReadablePathDetail = { path: ResolvedReadablePath } | { reason: UnreachablePathReason };

/**
 * Which resolved file the read tools may serve, and why not when they may not.
 *
 * The workspace is tried first, then the read-only roots, then the honored `additionalDirectories`
 * — the same order {@link resolveReadablePath} has always used, with the extra roots appended.
 * Only an absolute path reaches the roots outside the workspace, so a relative path never
 * re-anchors to one.
 *
 * The distinction the single `null` used to hide matters now that a call the tool cannot serve is
 * refused instead of prompted for: a path under a hidden subpath keeps its prompt, while a path
 * no root contains is refused outright and the refusal names the remedy.
 */
export function resolveReadablePathDetail(
  context: PathRoots,
  inputPath: string,
): ReadablePathDetail {
  const entries = readOnlyEntries(context);
  const rejected = (match: ResolvedReadablePath): ReadablePathDetail =>
    isExcludedPath(match.canonicalPath, entries) ? { reason: 'excluded' } : { path: match };

  // The exclusion applies whichever root matched: a memory directory inside the workspace
  // (running in $HOME) must not expose its inbox through the workspace branch. The root that
  // matched travels with the answer, so a caller labelling or re-searching the file does not have
  // to work out which of the roots it was found under by comparing paths again.
  const wsMatch = resolveWorkspacePath(context.workspaceRoot, inputPath);
  if (wsMatch) {
    return rejected({ ...wsMatch, root: context.workspaceRoot, inWorkspace: true });
  }

  if (!isAbsolute(inputPath)) return { reason: 'unreachable' };
  for (const entry of entries) {
    const root = typeof entry === 'string' ? entry : entry.root;
    const match = resolveWorkspacePath(root, inputPath);
    if (match) return rejected({ ...match, root, inWorkspace: false });
  }
  return { reason: 'unreachable' };
}

export function resolveReadablePath(
  context: PathRoots,
  inputPath: string,
): ResolvedReadablePath | null {
  const detail = resolveReadablePathDetail(context, inputPath);
  return 'path' in detail ? detail.path : null;
}

/**
 * Where a write tool may put a file: the workspace, then the honored directories.
 *
 * A write to an absolute path inside an honored directory is served exactly the way the same write
 * inside the workspace is served — same permission verdict, same `.book/settings.local.json` guard,
 * same fresh-observation requirement — and a relative path stays anchored to the workspace, so a
 * bare `./notes.txt` cannot be re-anchored to a root the caller never named. Read-only roots are
 * deliberately not consulted: they are roots a *read* may cross, not a write target.
 *
 * A match under an honored root reports the **workspace**-relative spelling of its path, not the
 * root-relative one its own resolution produced. That is the spelling the observation ledger is
 * keyed on (`observeFile` derives it from the absolute path, so a file in an honored root and a
 * workspace file of the same name can never collide), and the fresh-observation check looks the
 * write up under it. Reporting the root-relative form instead would make the Read that licensed
 * the write and the write itself consult two different keys, and every honored write would report
 * `file_not_observed`.
 */
export function resolveMutationPath(
  context: PathRoots,
  inputPath: string,
): ResolvedReadablePath | null {
  const inWorkspace = resolveWorkspacePath(context.workspaceRoot, inputPath);
  if (inWorkspace) return { ...inWorkspace, root: context.workspaceRoot, inWorkspace: true };
  if (!isAbsolute(inputPath)) return null;
  for (const root of context.additionalRoots ?? []) {
    const match = resolveWorkspacePath(root, inputPath);
    if (!match) continue;
    const rel = relative(resolve(context.workspaceRoot), match.filePath);
    return { ...match, relativePath: rel.replace(/\\/g, '/'), root, inWorkspace: false };
  }
  return null;
}

/**
 * Whether a resolved path falls under an excluded subpath of a read-only root (the memory
 * inbox). Checked on the canonical path — after symlinks — and case-folded where the file
 * system folds case, so `.INBOX/` or a link into `.inbox` cannot slip past it.
 */
function isExcludedPath(
  canonicalPath: string,
  roots: readonly (string | ReadOnlyRoot)[] | undefined,
): boolean {
  const fold = (p: string) => (process.platform === 'linux' ? p : p.toLowerCase());
  const target = fold(canonicalPath);
  for (const entry of roots ?? []) {
    if (typeof entry === 'string' || !entry.exclude?.length) continue;
    const base = fold(canonicalizePath(entry.root));
    for (const sub of entry.exclude) {
      const dir = fold(join(base, sub));
      if (target === dir || target.startsWith(`${dir}${sep}`)) return true;
    }
  }
  return false;
}

/**
 * The refusal a read tool gives a path no root serves.
 *
 * The message names the directory list as well as the workspace: after #300 the workspace is not
 * the only root a read may cross, so "outside workspace" alone sent the model looking for a rule
 * that would never work. The code is unchanged, so a caller that classifies refusals by code
 * (the agent loop's streak remedy, the managed-child notice) is unaffected.
 */
export function pathOutsideWorkspaceResult(inputPath: unknown): ToolResult {
  return toolFailure(`Path outside workspace and additionalDirectories: ${inputPath}`, {
    code: 'path_outside_workspace',
    remediation:
      'Add its directory to additionalDirectories, or start Book in a directory that contains it. ' +
      'No permission rule and no permission mode can change which roots a read may cross.',
  });
}

/** The workspace root after following links, or the root as given when it cannot be resolved. */
export function realWorkspaceRoot(root: string): string {
  try {
    return realpathSync.native(root);
  } catch {
    return resolve(root);
  }
}

/**
 * A path with its links followed, the way {@link resolveWorkspacePath} canonicalises one: the
 * nearest existing ancestor is resolved and the rest of the path re-appended, so a path that
 * does not exist yet still comes back through a link above it.
 *
 * `realWorkspaceRoot` alone is not enough for a comparison against a *file* path — a read target
 * that has been deleted, or one named before it is written, would fall back to its lexical form
 * and quietly fail to see through the link that reaches it.
 */
export function canonicalizePath(inputPath: string): string {
  const absolute = resolve(inputPath);
  const existing = nearestExistingPath(absolute);
  if (!existing) return absolute;
  try {
    return resolve(realpathSync.native(existing), relative(existing, absolute));
  } catch {
    return absolute;
  }
}

/**
 * Whether a canonical path is a root or under it, both sides in one canonical form.
 *
 * The comparison every "is this path inside that root" test outside a resolution makes: which
 * root served a resolved file, whether a Glob label belongs to the workspace, which root a
 * guarded read was served by. The path arrives canonical — from `realpath`, fast-glob or ripgrep,
 * or from {@link resolveWorkspacePath} — so the root has to be put in that form before the two
 * are compared. An as-given root and a canonical path are two spellings of one directory at
 * best, and two unrelated ones when the root was typed in 8.3 short form.
 */
export function isUnderRoot(canonicalPath: string, root: string): boolean {
  return !isOutside(canonicalizePath(root), canonicalPath);
}

/**
 * Whether a path has the *shape* of a root's Book-local settings file or directory, whatever root
 * is being asked about: the last segment is `.book`, or `settings.local.json` under one.
 *
 * The cheap half of {@link isBookLocalSettingsPath}, and the half worth running for every file a
 * Grep lists, because the rest of that answer costs a `realpath` per root. Sound rather than
 * exact — a `.book` somewhere below a root has the shape without being that root's — which is
 * what a prefilter has to be.
 */
function hasBookLocalSettingsShape(
  canonicalPath: string,
  options: { directory?: boolean },
): boolean {
  const parts = canonicalPath.toLowerCase().split(/[\\/]/);
  if (parts[parts.length - 1] === '.book') return options.directory === true;
  return parts[parts.length - 2] === '.book' && parts[parts.length - 1] === 'settings.local.json';
}

/**
 * Whether a path is Book's project-local settings file, `<root>/.book/settings.local.json`, which
 * can hold an API key; with `directory`, also the `.book` directory that holds it.
 *
 * Both sides are put in one canonical form before they are compared, and compared
 * case-insensitively on every platform: on a case-sensitive file system that only makes the check
 * stricter, while a case-insensitive Linux mount (WSL on /mnt/c) serves any spelling from the same
 * file. The root is canonicalized because it is the side a caller spells freely — 8.3 short form,
 * a lowercase drive letter, forward slashes — and the path because this is the guard that leaked
 * an API key when a root's spelling and a resolved path's spelling disagreed, and a check that
 * silently stops matching when a caller hands it a path in another form is the same failure with
 * a smaller blast radius. Callers that check every file a Grep listed run
 * {@link hasBookLocalSettingsShape} first, which is what keeps this off the per-file path.
 */
export function isBookLocalSettingsPath(
  path: string,
  root: string,
  options: { directory?: boolean } = {},
): boolean {
  if (!hasBookLocalSettingsShape(path, options)) return false;
  const target = canonicalizePath(path).toLowerCase();
  const bookDir = join(canonicalizePath(root), '.book').toLowerCase();
  return (
    target === join(bookDir, 'settings.local.json') ||
    (options.directory === true && target === bookDir)
  );
}

/**
 * Whether a path is Book's own local settings under *any* root a read may cross.
 *
 * After #300 a read can cross a directory the workspace does not contain, and that directory can
 * carry its own `.book/settings.local.json` with an API key in it — the same file, with the same
 * reason to stay closed, reached by a path the workspace-root check would not recognize. One
 * function so the read tools and the permission scope agree on which paths are guarded. The shape
 * test comes first, so the roots are only put in canonical form for a file that could be one,
 * which is what keeps this free for the per-file call a Grep makes.
 */
export function isBookLocalSettingsUnderRoots(
  path: string,
  roots: PathRoots,
  options: { directory?: boolean } = {},
): boolean {
  if (!hasBookLocalSettingsShape(path, options)) return false;
  return [roots.workspaceRoot, ...readOnlyEntries(roots)].some((root) => {
    const entryRoot = typeof root === 'string' ? root : root.root;
    return isBookLocalSettingsPath(path, entryRoot, options);
  });
}
