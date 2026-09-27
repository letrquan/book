/**
 * The directories `additionalDirectories` actually adds, and the decisions about them.
 *
 * The setting names directories the file tools may serve alongside the workspace: Read, Glob and
 * Grep reach them without a prompt, and the write tools' root check accepts them (a write there
 * still goes through the ordinary permission flow for its mode). It is honoured from the layers
 * the user controls — the user-global file, `.book/settings.local.json`, and `--settings` — and
 * withheld from the checked-in project layer until the user approves it in the user-global trust
 * store, exactly as a project-declared `permissions.allow` rule is (see `permission-approvals.ts`
 * for why, and `workspace-trust.ts` for where the decision lives).
 *
 * A decision is keyed by the directory's **real path**, never by the text the repository wrote.
 * A repository controls that text and could declare `./link` for a symlink pointing at `/etc`; a
 * user who approved the string would have approved a path they never saw. Resolving first also
 * makes the key stable: `./shared`, `shared` and `<workspace>/shared/` are one directory, and
 * retargeting a link makes the key change, so the earlier decision no longer covers it and the
 * directory is pending again.
 */
import { existsSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { isAbsolute, relative, resolve, sep } from 'path';
import { createDebugLogger } from './debug-log.js';
import { resolveBookHome } from './book-home.js';
import { realWorkspaceRoot, canonicalizePath, resolveWorkspacePath } from './tools/path-utils.js';
import type { ProjectDirectoryChoice } from './settings.js';
import { updateWorkspaceTrust } from './workspace-trust.js';

const log = createDebugLogger('additional-roots');

/** Recorded decisions, keyed by the directory's real path. */
export type ProjectDirectoryStore = Record<string, ProjectDirectoryChoice>;

export type ProjectDirectoryState = ProjectDirectoryChoice | 'unknown';

/** A project-declared directory, as the file tools will see it and as the repository wrote it. */
export interface DeclaredDirectory {
  /** The text the project layer declared, kept for display. */
  declared: string;
  /** The real path, which is also the key a decision is recorded under. */
  realPath: string;
}

/**
 * The real path a declared directory resolves to, or `undefined` when it is not usable: a path
 * that does not exist is ignored (with a debug log, since a checkout may not carry it yet), and
 * one that cannot be resolved is ignored the same way rather than trusted as written.
 *
 * Resolution follows links, so a declaration that points somewhere other than where it reads is
 * the thing the user is asked about.
 */
export function realPathOfDirectory(workspace: string, declared: string): string | undefined {
  const absolute = isAbsolute(declared) ? resolve(declared) : resolve(workspace, declared);
  if (!existsSync(absolute)) {
    log.debug('ignoring declared directory that does not exist', { declared, resolved: absolute });
    return undefined;
  }
  try {
    return realpathSync.native(absolute);
  } catch (error) {
    log.debug('ignoring declared directory that cannot be resolved', {
      declared,
      resolved: absolute,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * The project layer's declared directories, as `{declared, realPath}` pairs, deduplicated by
 * real path (two spellings of one directory are one decision) and in declaration order.
 */
export function collectDeclaredDirectories(
  workspace: string,
  declared: readonly string[] | undefined,
): DeclaredDirectory[] {
  const seen = new Set<string>();
  const out: DeclaredDirectory[] = [];
  for (const entry of declared ?? []) {
    const realPath = realPathOfDirectory(workspace, entry);
    if (!realPath || seen.has(realPath)) continue;
    seen.add(realPath);
    out.push({ declared: entry, realPath });
  }
  return out;
}

export function evaluateProjectDirectory(
  store: ProjectDirectoryStore | undefined,
  realPath: string,
): ProjectDirectoryState {
  return store?.[realPath] ?? 'unknown';
}

export interface ProjectDirectoryPartition {
  /** Approved by the user: these become honored roots. */
  approved: DeclaredDirectory[];
  /** No decision recorded: withheld until the user makes one. */
  pending: DeclaredDirectory[];
  /** Explicitly refused: withheld, and not re-offered. */
  rejected: DeclaredDirectory[];
}

export function partitionProjectDirectories(
  directories: readonly DeclaredDirectory[],
  store: ProjectDirectoryStore | undefined,
): ProjectDirectoryPartition {
  const partition: ProjectDirectoryPartition = { approved: [], pending: [], rejected: [] };
  for (const directory of directories) {
    const state = evaluateProjectDirectory(store, directory.realPath);
    if (state === 'approved') partition.approved.push(directory);
    else if (state === 'rejected') partition.rejected.push(directory);
    else partition.pending.push(directory);
  }
  return partition;
}

/**
 * Record an approve/reject decision for one project-declared directory, keyed by its real path,
 * leaving every other recorded decision untouched.
 */
export function persistProjectDirectoryChoice(
  workspace: string,
  realPath: string,
  choice: ProjectDirectoryChoice,
  options: { trustStorePath?: string } = {},
): { ok: boolean; error?: string } {
  return updateWorkspaceTrust(
    workspace,
    (trust) => {
      trust.projectDirectories[realPath] = choice;
    },
    options.trustStorePath,
  );
}

/**
 * The honored roots the file tools and the permission scope use, for one evaluation.
 *
 * `declared` is the resolved settings list, which already carries every layer's entries the
 * resolver decided to release; nothing here re-reads a file. A declared directory inside the
 * workspace adds nothing — the workspace already serves it — so it is dropped rather than
 * resolved twice, and a path that vanished between resolution and now is dropped too.
 *
 * Resolved once per run and passed down through `ToolContext` and `WorkspaceScope`, so a managed
 * child and a subagent serve exactly the roots their parent does.
 */
export function resolveAdditionalRoots(
  workspace: string,
  declared: readonly string[] | undefined,
): string[] {
  const realWorkspace = realWorkspaceRoot(workspace);
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const entry of collectDeclaredDirectories(workspace, declared)) {
    // Inside the workspace — not merely equal to it: the workspace already serves everything under
    // it, so listing a subdirectory adds a root that widens nothing. The test is `..` followed by
    // a separator rather than a bare prefix, because a sibling whose name starts with two dots
    // (`/home/u/..foo`) is *outside* the workspace and `startsWith('..')` read it as inside. An
    // empty result means equal, and equal is inside.
    const fromWorkspace = relative(realWorkspace, entry.realPath);
    if (
      !isAbsolute(fromWorkspace) &&
      fromWorkspace !== '..' &&
      !fromWorkspace.startsWith(`..${sep}`)
    ) {
      log.debug('dropping declared directory the workspace already serves', {
        declared: entry.declared,
        realPath: entry.realPath,
      });
      continue;
    }
    if (seen.has(entry.realPath)) continue;
    seen.add(entry.realPath);
    roots.push(entry.realPath);
  }
  return roots;
}

/**
 * Whether a root is, or contains, a home directory — the OS home or Book's own `BOOK_HOME`.
 *
 * A home carries SSH and provider keys and Book's trust store, so a session rooted at one keeps
 * prompting for reads. Compared as written and after following links, so a root that is a link
 * to a home, or a home reached through a link, still counts. One function for the workspace and
 * for each honored directory, so the rule reads the same wherever it applies.
 */
export function rootHoldsHome(root: string, homes: readonly string[] = homeGuards()): boolean {
  return homes.some((home) => containsPath(root, home));
}

/**
 * The home directories a read is never auto-allowed in: Book's own `BOOK_HOME` and the OS home,
 * each resolved through links once, deduplicated.
 *
 * Resolved once per run matters — a guard is consulted for every Read, Glob and Grep, and the
 * alternative is a `realpath` walk per call — and it is what lets {@link pathHoldsHome} compare
 * against a short fixed list.
 */
export function homeGuards(): string[] {
  const homes: string[] = [];
  for (const home of [resolveBookHome(), homedir()]) {
    const real = canonicalizePath(home);
    if (real && !homes.includes(real)) homes.push(real);
  }
  return homes;
}

/**
 * Whether a canonical path is a home directory or is inside one.
 *
 * Deliberately a test of the path rather than of the root that authorized it: a root may hold a
 * home as a subdirectory, or reach one through a symlink, and either way the read lands on
 * `~/.ssh/id_rsa` whatever the operator approved. Checking the resolved target catches both.
 */
export function pathHoldsHome(
  canonicalPath: string,
  homes: readonly string[] = homeGuards(),
): boolean {
  return homes.some((home) => containsPath(home, canonicalPath));
}

/**
 * Whether `root` is `target` or contains it, both sides compared after following links.
 *
 * Exported because a Grep or Glob *scope* has to be compared against a home the same way a file
 * is, and the comparison is the whole of that rule (PR #334 finding 4).
 */
export function containsPath(root: string, target: string): boolean {
  if (resolveWorkspacePath(root, target) !== null) return true;
  const fromRoot = relative(canonicalizePath(root), canonicalizePath(target));
  return !(fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot));
}
