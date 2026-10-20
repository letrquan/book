import { existsSync, lstatSync, realpathSync } from 'fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import type { ToolResult } from '../types/tools.js';
import { reachesUncPath } from '../unc-path.js';
import { toolFailure } from './result.js';

/**
 * The path semantics a containment comparison needs.
 *
 * Injectable so a caller whose paths are spelled by another `path` module — the
 * sandbox builder resolves a *test* workspace through `path.win32` or
 * `path.posix` and must judge containment in the same spelling — compares in the
 * same terms it resolved in. `sep` is part of the contract because `..` is only
 * a parent step in the separator of the module that produced the relative path.
 */
export interface PathComparison {
  relative(from: string, to: string): string;
  isAbsolute(path: string): boolean;
  sep: string;
}

const REAL_PATH_COMPARISON: PathComparison = { relative, isAbsolute, sep };

/**
 * Whether `candidate` is `root` or lies outside it — the one containment test
 * the rest of the codebase makes.
 *
 * Note what it does *not* accept: a relative path that merely starts with `..`,
 * such as `..meta`. That is a name in the root's own directory, and treating it
 * as a parent step reads a directory called `..meta` as being outside the tree
 * it is in. `relative` can only produce a real parent step as `..` on its own or
 * as `../…` with the separator of the module that produced it, and the third
 * clause covers a relative path answering to two different drives.
 */
export function isOutside(
  root: string,
  candidate: string,
  path: PathComparison = REAL_PATH_COMPARISON,
): boolean {
  const rel = path.relative(root, candidate);
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
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
  // a glob walk and ripgrep report, and reading "outside" between the two spellings of the *same*
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
  /**
   * Set when the path was served by the memory write root (`PathRoots.memoryWrite`): a `*.md` file
   * inside Book's project memory directory. A write tool must run it through
   * `checkMemoryWrite` before it changes the file.
   */
  memory?: true;
}

/** The roots a file tool may serve, in the order it tries them. */
export interface PathRoots {
  workspaceRoot: string;
  readOnlyRoots?: readonly string[];
  /**
   * Book's project memory directory as a search root (`ToolContext.memorySearchRoot`), for the
   * tools that walk a tree: a path in it is served unless a dot-entry lies between it and the root.
   */
  memorySearchRoot?: string;
  /**
   * Honored `additionalDirectories` (#300), as resolved real roots. Tried after the workspace, and
   * only for an absolute path: a relative path stays workspace-anchored.
   *
   * These are *read* roots. A write tool still resolves against the workspace alone
   * ({@link resolveWorkspacePath}), so widening this list never widens what Write, Edit,
   * MultiEdit, NotebookEdit or ApplyPatch may change.
   */
  additionalRoots?: readonly string[];
  /**
   * Book's project memory directory as a write root (`ToolContext.memoryWrite`). Only
   * {@link resolveMutationPath} reads it, and only for an absolute `*.md` path.
   */
  memoryWrite?: { root: string };
}

/**
 * Which resolved file the read tools may serve, or `unreachable` when no root contains it — the
 * refusal whose remedy is to widen the roots.
 */
export type ReadablePathDetail = { path: ResolvedReadablePath } | { reason: 'unreachable' };

/**
 * Which resolved file the read tools may serve, and why not when they may not.
 *
 * The workspace is tried first, then the read-only roots, then the honored `additionalDirectories`,
 * then the memory search root — the same order {@link resolveReadablePath} has always used, with
 * the extra roots appended. Only an absolute path reaches the roots outside the workspace, so a
 * relative path never re-anchors to one. The root that matched travels with the answer, so a
 * caller labelling or re-searching the file does not have to work out which of the roots it was
 * found under by comparing paths again.
 *
 * A call the tool cannot serve is refused instead of prompted for, and the refusal names the
 * remedy, which is why the answer says so rather than being a bare `null`.
 */
export function resolveReadablePathDetail(
  context: PathRoots,
  inputPath: string,
): ReadablePathDetail {
  const wsMatch = resolveWorkspacePath(context.workspaceRoot, inputPath);
  if (wsMatch) {
    return { path: { ...wsMatch, root: context.workspaceRoot, inWorkspace: true } };
  }

  if (!isAbsolute(inputPath)) return { reason: 'unreachable' };
  for (const root of [...(context.readOnlyRoots ?? []), ...(context.additionalRoots ?? [])]) {
    const match = resolveWorkspacePath(root, inputPath);
    if (match) return { path: { ...match, root, inWorkspace: false } };
  }
  const memory = context.memorySearchRoot
    ? resolveMemorySearchPath(context.memorySearchRoot, inputPath)
    : null;
  return memory ? { path: memory } : { reason: 'unreachable' };
}

/**
 * A path inside the memory search root, unless a dot-entry (`.format`, a backup directory) lies
 * between the root and the file, in either spelling of the path.
 */
function resolveMemorySearchPath(
  memoryRoot: string,
  inputPath: string,
): ResolvedReadablePath | null {
  const match = resolveWorkspacePath(memoryRoot, inputPath);
  if (!match) return null;
  const fromRoot = relative(canonicalizePath(resolve(memoryRoot)), match.canonicalPath);
  const segments = [...match.relativePath.split('/'), ...fromRoot.split(sep)];
  if (segments.some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..')) {
    return null;
  }
  return { ...match, root: memoryRoot, inWorkspace: false };
}

/**
 * The file an `@path` mention may inline (#567): what {@link resolveReadablePathDetail} serves for
 * `absolutePath` from the workspace and the honored `additionalDirectories`, so a mention reaches
 * exactly the files Read opens without a prompt. Read's other roots (the memory directory, clipped
 * tool output) are not a mention's to reach. Refused as `unc`, before anything resolves it, when
 * the path is, or reaches through a link, a UNC location on Windows (`reachesUncPath`). Read's own
 * resolution is unchanged.
 */
export function resolveMentionReadablePath(
  roots: Pick<PathRoots, 'workspaceRoot' | 'additionalRoots'>,
  absolutePath: string,
): ReadablePathDetail | { reason: 'unc' } {
  if (reachesUncPath(absolutePath)) return { reason: 'unc' };
  return resolveReadablePathDetail(
    { workspaceRoot: roots.workspaceRoot, additionalRoots: roots.additionalRoots },
    absolutePath,
  );
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
 *
 * The memory write root (`PathRoots.memoryWrite`) is the one other place a write may land, and it
 * is narrower than the rest: see {@link resolveMemoryWritePath}. It is tried **first**, not after
 * the workspace: a workspace that holds the memory directory (Book run from `$HOME`) would
 * otherwise serve a memory file through the plain workspace branch and skip the memory guard
 * (secret check, `learnings` ownership, provenance stamp). A path the memory rules refuse falls
 * through to the workspace and the honored roots exactly as before.
 */
export function resolveMutationPath(
  context: PathRoots,
  inputPath: string,
): ResolvedReadablePath | null {
  const memory = context.memoryWrite
    ? resolveMemoryWritePath(context.workspaceRoot, context.memoryWrite.root, inputPath)
    : null;
  if (memory) return memory;
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
 * Whether anything between the memory root and `filePath` (the file included) is a symbolic link,
 * a dangling one too. Checked with `lstat` on the path as written, because the canonical form has
 * already followed a link and would hide it.
 */
function hasLinkBelow(root: string, filePath: string): boolean {
  let current = root;
  for (const segment of relative(root, filePath).split(sep)) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Nothing exists from here down, so nothing below can be a link.
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      return true;
    }
  }
  return false;
}

/**
 * The memory write root's resolution: an **absolute** path to a `*.md` file inside the memory
 * directory, with no dot-segment below the root (`.inbox/`, `.git/`) and no symbolic link anywhere
 * on the way down. A relative path never anchors here, so a bare `notes.md` stays a workspace file.
 *
 * `relativePath` is the workspace-relative spelling, as for an honored root, so the observation
 * ledger's keys line up with a Read of the same file.
 */
function resolveMemoryWritePath(
  workspaceRoot: string,
  memoryRoot: string,
  inputPath: string,
): ResolvedReadablePath | null {
  if (!isAbsolute(inputPath)) return null;
  const filePath = resolve(inputPath);
  if (!basename(filePath).toLowerCase().endsWith('.md')) return null;
  const lexicalRoot = resolve(memoryRoot);
  const canonicalRoot = canonicalizePath(lexicalRoot);
  const canonicalPath = canonicalizePath(filePath);
  if (canonicalPath === canonicalRoot || isOutside(canonicalRoot, canonicalPath)) return null;
  // The path as written must itself sit under the root (in either spelling of it), or a link above
  // the root would be what carried it there.
  const writtenRoot = [lexicalRoot, canonicalRoot].find((root) => !isOutside(root, filePath));
  if (!writtenRoot) return null;
  const below = relative(writtenRoot, filePath).split(sep);
  if (below.some((segment) => segment.startsWith('.'))) return null;
  if (
    relative(canonicalRoot, canonicalPath)
      .split(sep)
      .some((s) => s.startsWith('.'))
  )
    return null;
  if (hasLinkBelow(writtenRoot, filePath)) return null;
  const rel = relative(resolve(workspaceRoot), filePath);
  return {
    filePath,
    canonicalPath,
    relativePath: rel.replace(/\\/g, '/'),
    root: memoryRoot,
    inWorkspace: false,
    memory: true,
  };
}

/**
 * How a mutation's file is named in its summary (the tool row and the diff): the workspace-relative
 * path, except that a memory file is `memory/<name>.md`, relative to the memory directory — its
 * workspace-relative spelling is `../home/.book/projects/<slug>/memory/x.md`.
 */
export function mutationDisplayPath(resolved: ResolvedReadablePath): string {
  if (!resolved.memory) return resolved.relativePath;
  return memoryDisplayName(resolved.root, resolved.canonicalPath);
}

function memoryDisplayName(memoryRoot: string, canonicalPath: string): string {
  const below = relative(canonicalizePath(resolve(memoryRoot)), canonicalPath);
  return `memory/${below.split(sep).join('/')}`;
}

/**
 * How the Read row names a file: `memory/<name>.md` when the file lies in the project memory
 * directory, otherwise `undefined` (the row keeps the path the model wrote).
 *
 * Decided from the memory directory itself rather than from `resolved.memory`: Read reaches memory
 * through `readOnlyRoots`, or through the workspace when Book runs from a directory that holds it,
 * and neither sets that flag.
 */
export function memoryReadDisplayPath(
  roots: Pick<PathRoots, 'memorySearchRoot' | 'memoryWrite'>,
  resolved: ResolvedReadablePath,
): string | undefined {
  const memoryRoot = roots.memorySearchRoot ?? roots.memoryWrite?.root;
  if (!memoryRoot) return undefined;
  const canonicalRoot = canonicalizePath(resolve(memoryRoot));
  if (
    resolved.canonicalPath === canonicalRoot ||
    isOutside(canonicalRoot, resolved.canonicalPath)
  ) {
    return undefined;
  }
  return memoryDisplayName(memoryRoot, resolved.canonicalPath);
}

/**
 * How a file is named in text the **model** reads (an error, a `Created …` line, a diff header).
 *
 * This is deliberately not {@link mutationDisplayPath}. That one is for the TUI row, where
 * `memory/<name>.md` is short and unambiguous. The model would take `memory/x.md` as relative to
 * the workspace and read the wrong file, so a memory file is named by its absolute path — the path
 * it can pass straight back to Read — and its workspace-relative spelling
 * (`../home/.book/projects/<slug>/memory/x.md`) is never shown. A workspace file keeps
 * `relativePath`. On Windows the absolute path stays native, as the model passes native paths there.
 */
export function messagePathFor(resolved: ResolvedReadablePath): string {
  return resolved.memory ? resolved.filePath : resolved.relativePath;
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
 * guarded read was served by. The path arrives canonical — from `realpath`, a glob walk or
 * ripgrep, or from {@link resolveWorkspacePath} — so the root has to be put in that form before
 * the two are compared. An as-given root and a canonical path are two spellings of one directory at
 * best, and two unrelated ones when the root was typed in 8.3 short form.
 */
export function isUnderRoot(canonicalPath: string, root: string): boolean {
  return !isOutside(canonicalizePath(root), canonicalPath);
}

/**
 * A path in the one spelling two *strings* are compared in, when neither is touched on disk: the
 * separator is `/`, and on Windows the case is folded (the same fold `isBookLocalSettingsPath`
 * makes, since NTFS answers to any case).
 *
 * `\` is a separator only on Windows. On POSIX it is an ordinary file-name character, and reading
 * it as a separator would let `/home/u/memory\a.md` — a file named `memory\a.md` in `/home/u` —
 * pass for one inside `/home/u/memory`. The platform is a parameter so that the Windows spelling is
 * judged on any host.
 */
export function comparablePath(
  value: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== 'win32') return value;
  return value.replaceAll('\\', '/').toLowerCase();
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
  return [
    roots.workspaceRoot,
    ...(roots.readOnlyRoots ?? []),
    ...(roots.additionalRoots ?? []),
  ].some((root) => isBookLocalSettingsPath(path, root, options));
}
