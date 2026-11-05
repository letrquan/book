import {
  accessSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  statSync,
} from 'fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { homedir, platform, tmpdir } from 'os';
import { resolveBookHome } from './book-home.js';
import type { ResolvedSettings } from './settings.js';
import {
  SANDBOX_EXEC_PATH,
  seatbeltExecution,
  type SeatbeltPathFilter,
  type SeatbeltPolicy,
  type SeatbeltRule,
} from './sandbox-seatbelt.js';
import { isOutside, resolveWorkspacePath, type PathComparison } from './tools/path-utils.js';
import type { CommandExecution } from './types/runtime.js';
import { globToRegex } from './tools/glob-regex.js';

export interface Sandbox {
  /** Of a command's notices, the ones this sandbox has not shown the user yet. */
  unseenNotices?(notices: readonly string[]): readonly string[];
  /**
   * Resolve a shell command into a sandboxed argv spawn.
   *
   * `workspaceRoot` is the only directory bound writable by default, and it is
   * deliberately not the command's working directory: `workdir` is a
   * model-supplied tool argument, and binding it would let the model widen its
   * own sandbox to any path — `workdir: "/"` would shadow every other mount and
   * hand back the whole host filesystem, read-write. Callers must keep the
   * working directory inside the workspace; extra paths go through
   * `sandbox.filesystem.allowWrite`.
   *
   * Returns null if the sandbox is unavailable.
   */
  wrap(
    command: string,
    workspaceRoot: string,
    protectedPaths?: ProtectedWorkspacePaths,
  ): CommandExecution | null;
  /** One-line description of the policy actually enforced, for diagnostics. */
  describe(): string;
}

/**
 * Try to detect bubblewrap (bwrap) on the system PATH.
 * Returns the bwrap binary path or null if not found.
 */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The Seatbelt runner, which macOS ships at one fixed, SIP-protected path. It is
 * not searched for on PATH: a `sandbox-exec` earlier on PATH is not the system's.
 */
function detectSandboxExec(): string | null {
  return isExecutableFile(SANDBOX_EXEC_PATH) ? SANDBOX_EXEC_PATH : null;
}

/** Which backend confines a command on a platform: Seatbelt on macOS, bubblewrap elsewhere. */
export type SandboxBackendKind = 'bubblewrap' | 'seatbelt';

export function sandboxBackendFor(os: NodeJS.Platform = platform()): SandboxBackendKind | null {
  if (os === 'win32') return null;
  return os === 'darwin' ? 'seatbelt' : 'bubblewrap';
}

/** The backend this platform uses, named for `book doctor`. */
export function describeSandboxBackend(os: NodeJS.Platform = platform()): string {
  const backend = sandboxBackendFor(os);
  if (backend === 'seatbelt') return `Seatbelt (macOS sandbox-exec, ${SANDBOX_EXEC_PATH})`;
  if (backend === 'bubblewrap') return 'bubblewrap (bwrap)';
  return 'none (no sandbox backend on Windows)';
}

function detectBwrap(): string | null {
  const candidates = [
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter(Boolean)
      .map((dir) => join(dir, 'bwrap')),
    '/usr/local/bin/bwrap',
    '/opt/homebrew/bin/bwrap',
    '/usr/bin/bwrap',
  ];
  return candidates.find(isExecutableFile) ?? null;
}

/**
 * Why a specific command will not run inside a real sandbox boundary.
 *
 * These are the only three ways a Bash command escapes the sandbox, and both
 * settings that depend on "is this command actually sandboxed?"
 * (`allowUnsandboxedCommands` and `autoAllowBashIfSandboxed`) are decided from
 * this one enumeration so they can never disagree about a given command.
 */
export type SandboxSkipReason = 'disabled' | 'excluded' | 'unavailable';

export interface SandboxCoverage {
  /** True only when this exact command will execute inside the sandbox backend. */
  sandboxed: boolean;
  /** Set whenever `sandboxed` is false. */
  reason?: SandboxSkipReason;
}

/**
 * Does a command match one of the `sandbox.excludedCommands` escape patterns?
 *
 * The whole command string is matched, not just its first line: the permission
 * path and the execution path must agree about the same text, and
 * `getPrimaryArg` truncates a multi-line command to its first line.
 */
export function matchesExcludedCommand(command: string, patterns: string[] = []): boolean {
  return patterns.some((pattern) => globToRegex(pattern).test(command));
}

/**
 * Is this platform's sandbox backend usable on this machine at all? Independent
 * of settings, so callers can distinguish "turned off" from "cannot be turned
 * on". The permission path (`sandboxCoverage`) and `createSandbox` both decide
 * from the same detectors, so they cannot disagree about a host.
 */
export function sandboxBackendAvailable(): boolean {
  const backend = sandboxBackendFor();
  if (backend === 'seatbelt') return detectSandboxExec() !== null;
  return backend === 'bubblewrap' && detectBwrap() !== null;
}

/**
 * Decide whether one specific command genuinely executes inside the sandbox.
 *
 * Ordering is deliberate. `enabled` is checked first because "sandboxing is
 * off" is the actionable diagnosis even on a host with no bwrap installed, and
 * because it is false by default — the common path never touches the
 * filesystem. `excludedCommands` is checked before the backend probe for the
 * same reason: an excluded command is unsandboxed regardless of what is
 * installed, so probing PATH for it would be wasted work.
 *
 * `backendAvailable` is injectable purely so tests can exercise the
 * missing-bwrap branch on a host that has bwrap installed.
 */
export function sandboxCoverage(
  command: string,
  settings: ResolvedSettings['sandbox'],
  backendAvailable: () => boolean = sandboxBackendAvailable,
): SandboxCoverage {
  if (!settings.enabled) return { sandboxed: false, reason: 'disabled' };
  if (matchesExcludedCommand(command, settings.excludedCommands))
    return { sandboxed: false, reason: 'excluded' };
  if (!backendAvailable()) return { sandboxed: false, reason: 'unavailable' };
  return { sandboxed: true };
}

const SKIP_REASON_DETAIL: Record<SandboxSkipReason, string> = {
  disabled: 'sandboxing is turned off (sandbox.enabled is false)',
  excluded: 'the command matches a sandbox.excludedCommands pattern, which runs it unsandboxed',
  unavailable:
    'the bubblewrap (bwrap) sandbox backend is unavailable on this platform or is not installed',
};

const SKIP_REASON_REMEDY: Record<SandboxSkipReason, string> = {
  disabled: 'Set sandbox.enabled to true',
  excluded: 'Remove the matching pattern from sandbox.excludedCommands',
  unavailable: 'Install bubblewrap (bwrap)',
};

/** The macOS wording of the one reason that names the backend. */
const SEATBELT_UNAVAILABLE_DETAIL = `the macOS Seatbelt sandbox backend is unavailable: ${SANDBOX_EXEC_PATH} is missing`;
const SEATBELT_UNAVAILABLE_REMEDY = `${SANDBOX_EXEC_PATH} ships with macOS; restore it to enable sandboxing.`;

/**
 * Where a `sandbox.*` key has to be written to be honoured.
 *
 * Named in every refusal because the obvious fix does not work: from
 * `.book/settings.json` or `.book/settings.local.json` the loader honours these
 * keys only in the tightening direction, so a user who "solved" the refusal by
 * editing the project's own settings would see it reported as successful and stay
 * refused (#373).
 */
const SANDBOX_SETTINGS_LOCATION = 'in ~/.book/settings.json, or with a --settings file';

/**
 * The refusal shown when `sandbox.allowUnsandboxedCommands` is false and a
 * command would otherwise have run outside the sandbox. It names the setting
 * that caused the refusal, the specific reason the command could not be
 * sandboxed, and what to do about it.
 *
 * The settings location is attached to the *alternative* rather than to every
 * reason, because it is only part of that alternative: `allowUnsandboxedCommands`
 * and `excludedCommands` are loader-ignored in a workspace file, so "set it
 * there" is the instruction for them. A missing `bwrap` is fixed by installing
 * bubblewrap, and telling a user to edit `~/.book/settings.json` about it sends
 * them to look for a package name that is not in the file.
 */
export function unsandboxedRefusalMessage(
  reason: SandboxSkipReason,
  os: NodeJS.Platform = platform(),
): string {
  const seatbelt = reason === 'unavailable' && sandboxBackendFor(os) === 'seatbelt';
  const remedy = seatbelt
    ? SEATBELT_UNAVAILABLE_REMEDY
    : reason === 'unavailable'
      ? 'Install bubblewrap (bwrap) to enable sandboxing.'
      : `${SKIP_REASON_REMEDY[reason]} ${SANDBOX_SETTINGS_LOCATION}, or set ` +
        'sandbox.allowUnsandboxedCommands to true there to allow this command to run unsandboxed.';
  return [
    'Refused to run this command outside the sandbox:',
    `${seatbelt ? SEATBELT_UNAVAILABLE_DETAIL : SKIP_REASON_DETAIL[reason]}.`,
    'sandbox.allowUnsandboxedCommands is false, so unsandboxed commands are not permitted.',
    remedy,
  ].join(' ');
}

/**
 * Everything outside `sandbox.*` that decides whether the two policy switches
 * can actually bite. Passed as one object rather than as trailing booleans so a
 * new condition cannot be added to the permission path and forgotten here —
 * which is how `book doctor` starts reporting a policy stronger than the
 * enforced one.
 */
export interface SandboxPolicyState {
  /** A sandbox was really created, so some command can genuinely be confined. */
  sandboxActive: boolean;
  /**
   * The user configured `permissions.deny` / `permissions.ask` rules. See
   * `sandboxAutoAllows` in permissions.ts: any such rule keeps the default ask,
   * because a shell line evades a glob far too easily for the matched rules to
   * be the whole protection.
   */
  adjudicationConfigured: boolean;
}

/**
 * Effective (not merely configured) state of the two policy switches, for
 * `book doctor`. A setting whose configured value cannot bite is reported as
 * inert rather than as enabled, so the reported policy matches the enforced one.
 */
export function sandboxPolicySummary(
  settings: ResolvedSettings['sandbox'],
  state: SandboxPolicyState,
): { unsandboxedCommands: string; autoAllowBash: string; gitDirectories: string } {
  const gitDirectories = settings.filesystem.allowGitWrites
    ? 'writable; hooks, config and pointer files read-only (sandbox.filesystem.allowGitWrites=true)'
    : 'read-only (sandbox.filesystem.allowGitWrites=false)';
  return {
    unsandboxedCommands: settings.allowUnsandboxedCommands
      ? 'allowed (sandbox.allowUnsandboxedCommands=true)'
      : 'refused (sandbox.allowUnsandboxedCommands=false)',
    autoAllowBash: !settings.autoAllowBashIfSandboxed
      ? 'off — every Bash call goes through the normal permission path (sandbox.autoAllowBashIfSandboxed=false)'
      : !state.sandboxActive
        ? 'inert — no command is sandboxed here, so nothing is auto-allowed (sandbox.autoAllowBashIfSandboxed=true)'
        : state.adjudicationConfigured
          ? 'inert — permissions.deny/ask rules are configured, so every Bash call still goes through the normal permission path (sandbox.autoAllowBashIfSandboxed=true)'
          : 'on for genuinely sandboxed commands (sandbox.autoAllowBashIfSandboxed=true)',
    gitDirectories,
  };
}

/**
 * The host facts the argv builder depends on: which paths exist, whether they
 * are directories, what a small file says, and the path semantics used to
 * resolve configured entries.
 *
 * Injectable so the generated argv can be pinned by tests on any platform.
 * The unit suite runs on Windows CI, where probing the real filesystem finds
 * none of the POSIX system mounts (`resolve('/usr')` lands on `C:\usr`), so a
 * test against the real host would be asserting on binds that were never
 * emitted. Production always uses the real host below.
 */
export interface SandboxHost {
  /** Path semantics for configured entries; tests inject path.win32/path.posix. */
  path: PathComparison & {
    resolve(...segments: string[]): string;
    join(...segments: string[]): string;
    dirname(path: string): string;
    basename(path: string): string;
  };
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  /**
   * File contents, or null when the file is missing or unreadable. The read is
   * capped at `maxBytes` — a workspace-controlled file must not be able to make
   * the host read without bound — and the cap is per call because the files
   * differ by orders of magnitude: a `gitdir:` pointer is one line, a repository
   * config is a page or more and a `hooksPath` can sit anywhere in it.
   */
  readFile(path: string, maxBytes?: number): string | null;
  /** The size of a regular file in bytes, or null for anything else. */
  fileSize(path: string): number | null;
  /** Entry names of a directory; empty when it is absent, unreadable, or not one. */
  readDir(path: string): string[];
  /** What a path is *without* following a final symlink, or null when nothing is there. */
  entryKind(path: string): SandboxEntryKind | null;
  /** The path a symlink names, as written; null when the path is not a symlink. */
  linkTarget(path: string): string | null;
  /** A path with its links followed, or null when it cannot be resolved. */
  realpath(path: string): string | null;
  homedir(): string;
}

/** What a path is, as `lstat` sees it: a symlink is not yet what it points at. */
export type SandboxEntryKind = 'file' | 'directory' | 'symlink' | 'other';

/**
 * The most bytes read out of a workspace-controlled control file. These files
 * carry one line — a `gitdir:` pointer, a `commondir` — and a workspace that can
 * make the host read anything at all can make it read gigabytes, so the read is
 * bounded rather than the file trusted to be small.
 */
const MAX_CONTROL_FILE_BYTES = 4096;

/**
 * The cap for a repository config, which is the exception: it is a document, not
 * a pointer, and a busy one is a few hundred kilobytes of remotes before the
 * `[core]` stanza that says where the hooks live. At 4 KiB a `hooksPath` declared
 * late in a real config was simply not seen, and the directory it named stayed
 * writable. A config past *this* cap is refused instead of truncated — a
 * half-read config reads as one with no `hooksPath`, which is the unsafe answer.
 */
const MAX_GIT_CONFIG_BYTES = 1024 * 1024;

/**
 * How deep the two workspace-controlled walks below go: `modules/<a>/<b>/…` for a
 * submodule path with segments, and `include` chains. Both are bounded by the
 * filesystem rather than by anything the walk can check, and both are
 * cycle-guarded by the sets they record what they have already visited.
 */
const MAX_WALK_DEPTH = 8;

function entryKind(path: string): SandboxEntryKind | null {
  try {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) return 'symlink';
    if (stats.isDirectory()) return 'directory';
    if (stats.isFile()) return 'file';
    return 'other';
  } catch {
    return null;
  }
}

/**
 * The production host: the real filesystem and the real path module.
 *
 * Exported so the contract it has to keep — a bounded read of a regular file,
 * and no throw for a path that is not there — is tested directly rather than
 * inferred from the argv it happens to produce.
 */
export const realSandboxHost: SandboxHost = {
  path: { resolve, join, relative, isAbsolute, sep, dirname, basename },
  exists: existsSync,
  // A path that vanished between the probe and the spawn is absent as far as the
  // mount list is concerned. `statSync` throws for it, and a throw here would
  // abort the whole bwrap invocation over a race, not a protection failure.
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  readFile: (path, maxBytes = MAX_CONTROL_FILE_BYTES) => {
    // `lstat` first, and only a regular file. An unguarded readFileSync blocks
    // for ever on a FIFO (a workspace that plants one at `.git` would hang
    // every later sandboxed command) and never ends on a character device such
    // as `/dev/zero`.
    if (entryKind(path) !== 'file') return null;
    let fd: number | undefined;
    try {
      fd = openSync(path, 'r');
      const buffer = Buffer.alloc(maxBytes);
      const bytes = readSync(fd, buffer, 0, maxBytes, 0);
      return buffer.subarray(0, bytes).toString('utf-8');
    } catch {
      return null;
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Nothing to do: the read result stands either way.
        }
      }
    }
  },
  fileSize: (path) => {
    // A size is only meaningful for a regular file. A directory, a link and a
    // path that is not there are all "no size to compare against the cap".
    if (entryKind(path) !== 'file') return null;
    try {
      return statSync(path).size;
    } catch {
      return null;
    }
  },
  readDir: (path) => {
    try {
      return readdirSync(path);
    } catch {
      return [];
    }
  },
  entryKind,
  linkTarget: (path) => {
    try {
      return readlinkSync(path);
    } catch {
      return null;
    }
  },
  realpath: (path) => {
    try {
      return realpathSync(path);
    } catch {
      return null;
    }
  },
  homedir,
};

/**
 * Resolve a configured sandbox path. `~` is expanded the same way the rest of
 * the codebase expands it; a relative entry stays relative to the process cwd,
 * which `unbindablePaths` reports so it does not pass silently.
 */
function expandPath(path: string, host: SandboxHost): string {
  if (path === '~') return host.homedir();
  if (path.startsWith('~/')) return host.path.join(host.homedir(), path.slice(2));
  return host.path.resolve(path);
}

/** bwrap fails the whole invocation if a bind source does not exist. */
function bindIfPresent(args: string[], flag: string, path: string, host: SandboxHost): void {
  const target = expandPath(path, host);
  if (host.exists(target)) args.push(flag, target, target);
}

/**
 * Configured filesystem paths that cannot be applied because nothing exists at
 * them. bwrap aborts the whole invocation on a missing bind source, so these
 * have to be skipped — but a skipped rule is unenforced policy the user
 * believes is active, so it is reported rather than dropped quietly.
 */
export function unbindablePaths(
  settings: ResolvedSettings['sandbox'],
  host: SandboxHost = realSandboxHost,
): string[] {
  return [
    ...settings.filesystem.allowWrite,
    ...settings.filesystem.denyWrite,
    ...settings.filesystem.denyRead,
  ].filter((path) => !host.exists(expandPath(path, host)));
}

/**
 * True when the declared network policy asks for something finer than
 * all-or-nothing. bwrap has no DNS or domain awareness, so a per-domain policy
 * cannot be honoured as written.
 */
export function hasDomainPolicy(settings: ResolvedSettings['sandbox']): boolean {
  return settings.network.allowedDomains.length > 0 || settings.network.deniedDomains.length > 0;
}

/**
 * A path with its links followed, in the caller's own path semantics.
 *
 * The nearest existing ancestor is what gets resolved and the rest of the path
 * re-appended, so a path that does not exist yet — an absent `.book/`, the
 * `hooks/` of a repository that has none — still comes back through a link
 * above it. Containment is decided on the canonical pair for the same reason
 * `resolveWorkspacePath` decides it there (#264): one directory has more than
 * one spelling, and a lexical comparison reads a path inside the workspace as
 * being outside it, or the reverse.
 */
function canonicalPath(path: string, host: SandboxHost): string {
  const absolute = host.path.resolve(path);
  let existing = absolute;
  for (;;) {
    const real = host.realpath(existing);
    if (real !== null) return host.path.resolve(real, host.path.relative(existing, absolute));
    const parent = host.path.dirname(existing);
    if (parent === existing) return absolute;
    existing = parent;
  }
}

/**
 * True when `candidate` is the workspace root or something below it.
 *
 * Both sides are canonicalised first, and the comparison itself is
 * {@link isOutside} — the same predicate the file tools use — so a directory
 * called `..meta` is inside the tree it is in rather than outside it on the
 * strength of its first two characters.
 *
 * A path outside the root is not bound writable — it is not bound at all — so
 * there is nothing to protect there, and mounting it would hand the command a
 * view of a repository the user never opened.
 */
function insideWorkspace(candidate: string, workspaceRoot: string, host: SandboxHost): boolean {
  return !isOutside(canonicalPath(workspaceRoot, host), canonicalPath(candidate, host), host.path);
}

/**
 * Path components of `path` strictly below `workspaceRoot`, in root-to-leaf order.
 * Returns empty array when `path` is not inside `workspaceRoot` or is the root itself.
 */
function workspaceComponents(path: string, workspaceRoot: string, host: SandboxHost): string[] {
  const root = host.path.resolve(workspaceRoot);
  const resolved = host.path.resolve(path);
  const rel = host.path.relative(root, resolved);
  if (
    isOutside(root, resolved, host.path) ||
    !rel ||
    rel === '..' ||
    rel.startsWith('..' + host.path.sep)
  )
    return [];
  const segments = rel.split(host.path.sep).filter(Boolean);
  const components: string[] = [];
  let current = root;
  for (const segment of segments) {
    current = host.path.join(current, segment);
    components.push(current);
  }
  return components;
}

/** A git directory git itself would act on, and the work tree it serves. */
interface GitDirRef {
  dir: string;
  /**
   * The work tree a relative `core.hooksPath` in this directory's config is
   * resolved against — the root git resolves it against, which is the work tree
   * root and not the git dir.
   */
  workTree: string;
}

interface WorkspaceGitDirsResult {
  gitDirs: GitDirRef[];
  pointerPaths: string[];
  refusals: ControlPathRefusal[];
}

function looksLikeGitDir(dir: string, host: SandboxHost): boolean {
  if (!host.isDirectory(dir)) return false;
  const head = host.path.join(dir, 'HEAD');
  if (!host.exists(head)) return false;
  const objects = host.path.join(dir, 'objects');
  if (host.isDirectory(objects)) return true;
  const commondir = host.path.join(dir, 'commondir');
  if (host.exists(commondir)) return true;
  return false;
}

/**
 * The git directories a workspace's `.git` names, in the order they apply.
 *
 * `.git` is usually the directory itself, but a worktree or submodule carries a
 * one-line `.git` file (`gitdir: <path>`; relative to the workspace when it is
 * not absolute), and that directory can itself name a `commondir` — the shared
 * part of the repository, where `hooks/` and `config` actually live for a
 * linked worktree. Under a repository sit `<gitdir>/worktrees/<name>` for every
 * linked worktree and `<gitdir>/modules/<path>` for every submodule, and a
 * submodule of a submodule nests again, so the walk is a breadth-first one over
 * directories already accepted.
 *
 * Only directories inside the workspace are returned, and only ones that are
 * directories at all: `gitdir:` and `commondir` are workspace-controlled text
 * and can name a plain file, which `<dir>/hooks` is not a directory bubblewrap
 * can mount.
 */
function workspaceGitDirs(workspaceRoot: string, host: SandboxHost): WorkspaceGitDirsResult {
  const root = host.path.resolve(workspaceRoot);
  const canonicalRoot = canonicalPath(root, host);
  const found: GitDirRef[] = [];
  const pointerPaths: string[] = [];
  const refusals: ControlPathRefusal[] = [];
  const dotGit = host.path.join(root, '.git');
  const add = (candidate: string, workTree: string): void => {
    const dir = host.path.resolve(candidate);
    if (found.some((entry) => entry.dir === dir)) return;
    if (!host.isDirectory(dir) || !insideWorkspace(dir, root, host)) return;
    if (dir !== dotGit && !looksLikeGitDir(dir, host)) return;
    if (canonicalPath(dir, host) === canonicalRoot) {
      if (!refusals.some((r) => r.path === dir)) {
        refusals.push({ path: dir, reason: 'workspace-root-is-git-dir' });
      }
      return;
    }
    found.push({ dir, workTree: host.path.resolve(workTree) });
  };
  if (!host.exists(dotGit)) return { gitDirs: found, pointerPaths, refusals };
  if (host.isDirectory(dotGit)) {
    add(dotGit, root);
  } else {
    const target = /^gitdir:\s*(.+)$/m.exec(host.readFile(dotGit) ?? '')?.[1]?.trim();
    if (!target) return { gitDirs: found, pointerPaths, refusals };
    const resolvedTarget = host.path.isAbsolute(target) ? target : host.path.join(root, target);
    pointerPaths.push(resolvedTarget);
    add(resolvedTarget, root);
  }
  // A linked worktree's own dir holds only `config.worktree`, `HEAD` and the
  // `gitdir` naming its work tree; the hooks and the shared config live in the
  // common dir.
  for (let index = 0; index < found.length; index++) {
    const { dir, workTree } = found[index];
    const common = host.readFile(host.path.join(dir, 'commondir'))?.trim();
    if (common) {
      const resolvedCommon = host.path.isAbsolute(common) ? common : host.path.join(dir, common);
      pointerPaths.push(resolvedCommon);
      add(resolvedCommon, workTree);
    }
    for (const name of host.readDir(host.path.join(dir, 'worktrees'))) {
      const linked = host.path.join(dir, 'worktrees', name);
      // `gitdir` inside a linked worktree's dir names the work tree's own
      // `.git` file, so its directory is the work tree root — what a relative
      // `core.hooksPath` in that worktree's config is resolved against.
      const workTreeGitdir = host.readFile(host.path.join(linked, 'gitdir'))?.trim();
      // Relative to the worktree's own directory (git 2.48's relative worktree
      // paths), not to wherever Book runs.
      const resolvedGitdir = workTreeGitdir
        ? host.path.isAbsolute(workTreeGitdir)
          ? workTreeGitdir
          : host.path.join(linked, workTreeGitdir)
        : null;
      if (resolvedGitdir) pointerPaths.push(resolvedGitdir);
      add(linked, resolvedGitdir ? host.path.dirname(resolvedGitdir) : root);
    }
    // `<gitdir>/modules/<path>` holds the git dir of the submodule at `<path>`,
    // and `<path>` is the submodule's own path in the work tree — which can have
    // segments, so `git submodule add url libs/deep` puts the git dir at
    // `modules/libs/deep` and `modules/libs` holds no `HEAD` and no `config`. It
    // is a container, and its own entries are the candidates. `HEAD` or `config`
    // is what tells the two apart, and the walk is depth-bounded because the tree
    // is workspace-controlled.
    const addModules = (modulesRoot: string, prefix: string, depth: number): void => {
      for (const name of host.readDir(modulesRoot)) {
        const moduleDir = host.path.join(modulesRoot, name);
        const workTreePath = prefix ? `${prefix}/${name}` : name;
        const isGitDir = ['HEAD', 'config'].some((file) =>
          host.exists(host.path.join(moduleDir, file)),
        );
        if (isGitDir) add(moduleDir, host.path.join(root, workTreePath));
        else if (depth < MAX_WALK_DEPTH) addModules(moduleDir, workTreePath, depth + 1);
      }
    };
    addModules(host.path.join(dir, 'modules'), '', 0);
  }
  // Every work tree the walk found carries its own `.git` pointer file, and the
  // pointer is what the host reads to decide *which* git dir those control files
  // are: `sub/.git` says `gitdir: ../.git/modules/sub`, which resolves against
  // the work tree holding it and not against the workspace root.
  for (const { workTree } of [...found]) {
    if (!insideWorkspace(workTree, root, host)) continue;
    const pointer = host.path.join(workTree, '.git');
    if (host.isDirectory(pointer)) continue;
    const target = /^gitdir:\s*(.+)$/m.exec(host.readFile(pointer) ?? '')?.[1]?.trim();
    if (!target) continue;
    const resolvedTarget = host.path.isAbsolute(target) ? target : host.path.join(workTree, target);
    pointerPaths.push(resolvedTarget);
    add(resolvedTarget, workTree);
  }
  return { gitDirs: found, pointerPaths, refusals };
}

/**
 * The part of a git config line after the `=`, as git reads it.
 *
 * Two rules the raw text does not show: a `;` or `#` outside quotes ends the
 * value (so `hooksPath = .husky ; note` is `.husky`, and the directory named by
 * a path that kept the comment never exists), and a quoted value carries
 * backslash escapes. Without the first, the protection lands at a path the
 * repository chose and never fires; the second is rare in a path and cheap.
 */
function parseConfigValue(raw: string): string {
  const text = raw.trim();
  if (!text.startsWith('"')) {
    let quoted = false;
    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      if (character === '"') quoted = !quoted;
      else if (!quoted && (character === ';' || character === '#'))
        return text.slice(0, index).trim();
    }
    return text;
  }
  let value = '';
  for (let index = 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') break;
    if (character !== '\\') {
      value += character;
      continue;
    }
    const escaped = text[index + 1];
    index += 1;
    value +=
      escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'b' ? '\b' : (escaped ?? '');
  }
  return value;
}

/**
 * The section a `[header]` line names, or undefined when the line carries a
 * subsection. `[core "x"]` is not `[core]`, and counting it as one protects a
 * directory git never reads hooks from.
 */
function configSectionName(line: string): string | undefined {
  const header = /^\[\s*([A-Za-z0-9.-]+)(\s[^\]]*)?\]$/.exec(line.trim());
  if (!header || header[2]) return undefined;
  return header[1].toLowerCase();
}

/**
 * Every `core.hooksPath` a git config file states, or none.
 *
 * A deliberately small `[core]` parser rather than a git-config dependency: the
 * key is the one setting that moves `hooks/` out of the git dir, and it is read
 * from a file a workspace can rewrite. Git takes the *last* value for a key, so
 * a parser that stops at the first is protecting a directory git ignores; every
 * value is returned instead, which also makes the answer independent of which
 * one git would have chosen — the safer of the two mistakes to make.
 */
export function readCoreHooksPaths(configText: string): string[] {
  const found: string[] = [];
  let inCore = false;
  for (const line of configText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      inCore = configSectionName(trimmed) === 'core';
      continue;
    }
    if (!inCore) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    if (trimmed.slice(0, separator).trim().toLowerCase() !== 'hookspath') continue;
    const value = parseConfigValue(trimmed.slice(separator + 1));
    if (value && !found.includes(value)) found.push(value);
  }
  return found;
}

/**
 * The files a git config pulls in, from `[include]` and `[includeIf "…"]`.
 *
 * An included file is part of the same config as far as git is concerned: a
 * `core.hooksPath` set in one is the directory git runs hooks from, and one
 * left writable inside the workspace is a control file the host reads on its next
 * commit. An `includeIf` condition is not evaluated here — only a file that
 * exists can be included, and a file the sandbox creates later is the case this
 * cannot reach.
 */
export function readGitConfigIncludes(configText: string): string[] {
  const found: string[] = [];
  let include = false;
  for (const line of configText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[')) {
      // An `includeIf` header carries the condition as its subsection, so the
      // section name is matched on the text up to it rather than exactly.
      include = configSectionName(trimmed) === 'include' || /^\[includeif\b/i.test(trimmed);
      continue;
    }
    if (!include) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    if (trimmed.slice(0, separator).trim().toLowerCase() !== 'path') continue;
    const value = parseConfigValue(trimmed.slice(separator + 1));
    if (value) found.push(value);
  }
  return found;
}

/**
 * One workspace path the namespace must shield, and how.
 *
 * - `directory` — a directory the host reads after the command exits. Bound
 *   read-only when it exists, masked with an empty read-only tmpfs when it does
 *   not, which both hides any contents the host grows there later and makes
 *   creating it fail.
 * - `file` — a file the host reads after the command exits. Bound read-only
 *   when it exists: bubblewrap aborts the whole invocation on a tmpfs mounted
 *   over a file path ("Not a directory"), so an absent file cannot be masked at
 *   all.
 * - `hidden-file` — a file whose *contents* must not reach the command, bound
 *   over with `/dev/null`. A read-only bind of `.book/` still serves what is in
 *   it, and the namespace shares the host network, so a key the user stored
 *   there would be one `cat` away from a sandboxed command.
 */
export type ProtectedMountKind = 'directory' | 'file' | 'hidden-file';

export interface ProtectedMount {
  /**
   * The path the namespace mounts at, in the workspace's own spelling;
   * containment is decided on canonical paths.
   */
  path: string;
  kind: ProtectedMountKind;
  /** False when nothing exists at it, which for a directory becomes a mask. */
  present: boolean;
}

export interface ProtectedWorkspacePaths {
  /**
   * Directories the namespace must pin as mount points in their own right.
   *
   * A read-only child mount is not enough: the directory that holds it can still
   * be renamed away and replaced, and rename(2) on a path that is not a mount
   * point succeeds. `--bind <dir> <dir>` pins it, which is what makes
   * `mv .git .git.old` fail with EBUSY instead of redirecting the host's git.
   *
   * Only the workspace's own top-level `.git` is pinned, and only in the opt-out
   * mode (`allowGitWrites: true`) where git directories stay writable. Read-only
   * mode has no pin because the git directory is already a mount point through
   * its own `--ro-bind`, and the half-done `git worktree remove` it describes
   * (deleting the work tree and failing on the read-only admin directory) now
   * happens by design in read-only mode.
   */
  pinnedDirectories: string[];
  mounts: ProtectedMount[];
  /**
   * Control paths this namespace cannot protect at all. A refusal rather than a
   * mount: bwrap aborts the whole invocation on the shapes that could be
   * mistaken for one, and guessing would leave a control file writable while
   * reporting a sandbox.
   */
  refusals: ControlPathRefusal[];
  /**
   * Control mounts inside read-only git dirs (hooks, config, etc.), preserved in
   * read-only mode so an allowWrite opt-in on a git dir can re-apply them.
   */
  gitDirControlMounts: ProtectedMount[];
}

/**
 * Why a workspace cannot be sandboxed, and which path says so.
 *
 * Both are shapes a repository controls and no mount can cover. The run is
 * refused with the path named, because the fix — replace the link, trim the
 * config — is a change to the workspace, not to a Book setting.
 */
export type ControlPathRefusalReason =
  'symlinked-control-path' | 'oversized-git-config' | 'workspace-root-is-git-dir';

export interface ControlPathRefusal {
  path: string;
  reason: ControlPathRefusalReason;
}

/** A refusal in the words the model is told, which name the path to change. */
export function describeControlPathRefusal(refusal: ControlPathRefusal): string {
  if (refusal.reason === 'oversized-git-config') {
    return (
      `Refused to run this command in the sandbox: ${refusal.path} is larger than the ` +
      `${MAX_GIT_CONFIG_BYTES / 1024 / 1024} MiB read limit for a git config file, so the ` +
      'core.hooksPath it may declare cannot be found and the hooks directory it names cannot ' +
      'be made read-only. Trim the config, or run this command without the sandbox.'
    );
  }
  if (refusal.reason === 'workspace-root-is-git-dir') {
    return (
      `Refused to run this command in the sandbox: ${refusal.path} is the workspace root and ` +
      'a git directory, so the sandbox cannot make it read-only without making the whole ' +
      'workspace read-only. Run this command without the sandbox.'
    );
  }
  return (
    `Refused to run this command in the sandbox: ${refusal.path} is a symlink, and the ` +
    'sandbox cannot protect a symlinked control path. The link itself sits in the writable ' +
    'workspace, so a command could remove it, put a directory or file in its place, and write ' +
    'the settings, hooks or repository config the host then reads through it. Replace the ' +
    'symlink with the file or directory it names, or run this command without the sandbox.'
  );
}

/**
 * The workspace control files a sandboxed command must not be able to rewrite.
 *
 * Each one is read by the *host* after the command exits, which is what makes a
 * write to it an escape rather than a scratch file: `.book/settings.local.json`
 * is resolved on the host from the next session (it can switch the sandbox off
 * or add `Bash(*)`), a `.git/hooks/*` script runs on the next host `git commit`,
 * and `core.hooksPath` / `core.fsmonitor` in `.git/config` redirect both. The
 * permission layer asks before a file tool touches `.book/`, but a prompt is one
 * approval the model can ask for — and a shell command is not a file tool (#373).
 *
 * What this cannot cover in the default mode is stated in the docs rather than
 * implied here: a sandboxed command can still *create* a pointer file outside
 * every git dir it found (`.git/commondir` in a workspace with no `.git`, an
 * `[includeIf]` target that appears later), because the mounts are built from
 * the files that are there.
 */
export interface ProtectedWorkspacePathsOptions {
  /**
   * `false` (the default) binds every git directory the workspace names
   * read-only, which is what closes the pointer-file redirect: a command that
   * cannot write the git dir cannot create `.git/commondir` in it either
   * (#373). Sandboxed git writes fail, and the user opts back out with
   * `sandbox.filesystem.allowGitWrites`. `true` restores the previous shape —
   * git dirs writable with their control files protected one by one and the
   * top-level `.git` pinned — and reopens that gap, which is why only a trusted
   * layer may set it.
   */
  allowGitWrites?: boolean;
  denyDirectories?: string[];
}

export function protectedWorkspacePaths(
  workspaceRoot: string,
  host: SandboxHost = realSandboxHost,
  options: ProtectedWorkspacePathsOptions = {},
): ProtectedWorkspacePaths {
  const root = host.path.resolve(workspaceRoot);
  const canonicalRoot = canonicalPath(root, host);
  const allowGitWrites = options.allowGitWrites ?? false;
  const result: ProtectedWorkspacePaths = {
    pinnedDirectories: [],
    mounts: [],
    refusals: [],
    gitDirControlMounts: [],
  };
  const seen = new Set<string>();

  const safeDenyDirs = (options.denyDirectories ?? [])
    .filter((d) => host.isDirectory(d))
    .map((d) => canonicalPath(d, host));

  /**
   * The mount one control path needs, or null when it needs none.
   *
   * A symlink is refused rather than resolved. Protecting the link's *target* is
   * not protection, because the link itself sits in the writable workspace:
   * `rm .book && mkdir .book && …` replaces it, and the target protection then
   * guards a file nothing reads any more. There is no mount that pins a symlink,
   * and a mount shaped for one aborts the whole bwrap invocation, so a repository
   * shipping one is a workspace Book declines to sandbox.
   *
   * A path that is neither a regular file nor a directory — a FIFO, a socket, a
   * device — is skipped instead: nothing reads it as a control file, and there is
   * no mount bwrap can make over it.
   */
  const target = (path: string, kind: ProtectedMountKind): ProtectedMount | null => {
    const resolved = host.path.resolve(path);
    if (seen.has(resolved)) return null;
    const describe = (present: boolean): ProtectedMount => {
      seen.add(resolved);
      return { path: resolved, kind, present };
    };
    const first = host.entryKind(resolved);
    if (first === 'symlink') {
      const parentCanonical = canonicalPath(host.path.dirname(resolved), host);
      const symlinkLivePath = host.path.join(parentCanonical, host.path.basename(resolved));
      const isSafe = safeDenyDirs.some(
        (dir) => !isOutside(dir, symlinkLivePath, host.path) && dir !== symlinkLivePath,
      );
      if (!isSafe && !result.refusals.some((entry) => entry.path === resolved)) {
        result.refusals.push({ path: resolved, reason: 'symlinked-control-path' });
      }
      return null;
    }
    if (first === null) {
      // Absent: only a directory has a mask, and only a directory needs one —
      // an absent file has nothing to protect and nothing to create that git or
      // the settings resolver would read as one.
      return kind === 'directory' ? describe(false) : null;
    }
    if (first === 'directory') {
      // A mask is `--ro-bind /dev/null <dir>`, which bwrap rejects as "Is a
      // directory" — and one aborts the whole invocation, so a repository that
      // ships `.book/settings.local.json` as a directory would otherwise break
      // every sandboxed command in the workspace, not only its own.
      return kind === 'hidden-file' ? null : describe(true);
    }
    return first === 'file' ? describe(true) : null;
  };

  const addDirectory = (path: string): void => {
    const mount = target(path, 'directory');
    if (mount) result.mounts.push(mount);
  };
  const addFile = (path: string): void => {
    const mount = target(path, 'file');
    if (mount) result.mounts.push(mount);
  };
  const addMaskedFile = (path: string): void => {
    const mount = target(path, 'hidden-file');
    if (mount) result.mounts.push(mount);
  };

  const { gitDirs, pointerPaths, refusals: gitDirRefusals } = workspaceGitDirs(root, host);
  result.refusals.push(...gitDirRefusals);
  const boundCanonical: string[] = [];
  const gitDirMounts = new Set<ProtectedMount>();

  // The read-only mode binds every git dir the walk found, ahead of the other
  // mounts, at the path the sandbox sees: decide containment and dedupe on
  // canonical paths, but emit each bind at
  // `root + relative(canonicalPath(root), canonicalPath(dir))`.
  // Outermost first, and a dir inside one already bound is skipped: the outer
  // bind already covers it, and a second mount inside a mount point is noise.
  // Deliberately not through `target()`: a nested git dir that is a symlink is
  // bound at the path the sandbox sees rather than refused, because the whole
  // directory is covered by the bind — there is no path left through the link for a
  // replaced one to matter. A symlinked *top-level* `.git` is still refused, by
  // the pointer check below.
  if (!allowGitWrites) {
    const canonicalDirs = [...new Set(gitDirs.map((gitDir) => canonicalPath(gitDir.dir, host)))];
    canonicalDirs.sort(
      (left, right) => left.split(host.path.sep).length - right.split(host.path.sep).length,
    );
    for (const canonicalDir of canonicalDirs) {
      if (boundCanonical.some((outer) => !isOutside(outer, canonicalDir, host.path))) continue;
      if (!host.exists(canonicalDir)) continue;
      boundCanonical.push(canonicalDir);
      const rel = host.path.relative(canonicalRoot, canonicalDir);
      const bindPath = rel ? host.path.resolve(root, rel) : root;
      const mount: ProtectedMount = { path: bindPath, kind: 'directory', present: true };
      gitDirMounts.add(mount);
      result.mounts.push(mount);
    }
  }

  // The settings directory, which holds both workspace layers plus the trust
  // store writes and `migrations.json`.
  addDirectory(host.path.join(root, '.book'));
  // ...and the one file in it that can hold a provider credential. Read-only is
  // not enough: the namespace shares the host network, so the value has to be
  // unreadable inside it, not merely unwritable.
  addMaskedFile(host.path.join(root, '.book', 'settings.local.json'));
  // The legacy config file the host reads on the next launch, where its
  // `baseUrl` wins over every settings layer (src/config.ts).
  addFile(host.path.join(root, '.bookrc.json'));

  const dotGit = host.path.join(root, '.git');
  // Only a real directory inside the workspace is pinned, and only in the
  // opt-out mode where it stays writable: in the read-only mode the git dir is
  // a mount point through its own `--ro-bind`, which fails `mv .git elsewhere`
  // the same way, so `pinnedDirectories` stays empty there.
  if (host.entryKind(dotGit) === 'directory') {
    if (allowGitWrites) {
      result.pinnedDirectories.push(dotGit);
    }
  } else {
    // A worktree's `.git` is a file naming its git dir. Read-only, so the
    // pointer itself cannot be rewritten at another git directory. In the
    // read-only mode a real `.git` directory is already covered by the
    // git-dir binds above; calling `addFile` on a directory would emit a second
    // `--ro-bind` because `target()` describes any existing path when kind is
    // `file`. A symlinked `.git` is not a directory, so it is passed to
    // `addFile` and refused by `target()` in both modes.
    addFile(dotGit);
  }

  // A path a file's contents named (an `[include]`, a work tree from a `gitdir`
  // file) at the workspace's own spelling, where its mount has to land, when its
  // directory is inside the workspace. The last component keeps its own spelling,
  // so a symlink there is still refused rather than followed.
  const spelledInWorkspace = (path: string): string => {
    const resolved = host.path.resolve(path);
    const directory = canonicalPath(host.path.dirname(resolved), host);
    if (isOutside(canonicalRoot, directory, host.path)) return resolved;
    const rel = host.path.relative(canonicalRoot, directory);
    return host.path.join(rel ? host.path.resolve(root, rel) : root, host.path.basename(resolved));
  };

  // Config files already read, so an `include` chain that names one of them ends
  // at the file rather than descending for ever.
  const configsRead = new Set<string>();
  const readConfig = (file: string, workTree: string, depth: number): void => {
    const at = spelledInWorkspace(file);
    if (configsRead.has(at)) return;
    configsRead.add(at);
    const size = host.fileSize(at);
    if (size !== null && size > MAX_GIT_CONFIG_BYTES) {
      // Truncating a config reads as one with no `hooksPath` in it, which is the
      // answer that leaves the hooks directory writable. Refusing says so instead.
      result.refusals.push({ path: at, reason: 'oversized-git-config' });
      return;
    }
    const text = host.readFile(at, MAX_GIT_CONFIG_BYTES);
    if (text === null) return;
    addFile(at);
    for (const hooksPath of readCoreHooksPaths(text)) {
      const directory = host.path.isAbsolute(hooksPath)
        ? hooksPath
        : host.path.join(workTree, hooksPath);
      if (insideWorkspace(directory, root, host)) addDirectory(directory);
    }
    if (depth >= MAX_WALK_DEPTH) return;
    for (const included of readGitConfigIncludes(text)) {
      // As git resolves it: `~/` from the home directory, an absolute path as
      // written, and anything else against the including file's directory.
      const target = included.startsWith('~/')
        ? host.path.join(host.homedir(), included.slice(2))
        : host.path.isAbsolute(included)
          ? host.path.resolve(included)
          : host.path.join(host.path.dirname(at), included);
      readConfig(target, workTree, depth + 1);
    }
  };

  for (const gitDir of gitDirs) {
    // The analysis runs in both modes so refusals (a symlinked `hooks/`,
    // an oversized config) and a `core.hooksPath` outside the git dirs stay
    // exact. In read-only mode, redundant mounts inside the bound git dirs are
    // filtered out below.
    addDirectory(host.path.join(gitDir.dir, 'hooks'));
    for (const name of ['config', 'config.worktree', 'commondir', 'gitdir']) {
      addFile(host.path.join(gitDir.dir, name));
    }
    // The work tree's own `.git`: a directory is the git dir itself, already
    // covered by its own bind or pin, and a file is the pointer the host reads
    // to find the git dir. It is read-only in both modes for the same reason —
    // rewriting it to `gitdir: ../evil` moves every control path above onto a
    // repository the command built.
    const workTreePointer = spelledInWorkspace(host.path.join(gitDir.workTree, '.git'));
    if (host.entryKind(workTreePointer) === 'file') addFile(workTreePointer);
    // `core.hooksPath` moves the hook directory out of the git dir entirely —
    // husky v9 points it at `.husky/_` — so a config this namespace leaves
    // writable is a hooks directory it never looked at. An `[include]`d file is
    // part of that config, and is followed to the same depth.
    for (const name of ['config', 'config.worktree']) {
      readConfig(host.path.join(gitDir.dir, name), gitDir.workTree, 0);
    }
  }

  // Drop every directory or file mount whose canonical path lies strictly inside
  // a present read-only directory mount (a bound git dir, .book/, a protected
  // hooksPath directory). Hiding a file's contents (hidden-file) is not redundant
  // with a read-only parent, so keep every hidden-file mask.
  // In read-only mode, keep the per-file control mounts that lie inside a bound
  // git dir in gitDirControlMounts so an allowWrite opt-in on a git dir can
  // re-apply them.
  const presentReadOnlyDirs = result.mounts
    .filter((mount) => mount.kind === 'directory' && mount.present)
    .map((mount) => canonicalPath(mount.path, host));

  const filteredMounts: ProtectedMount[] = [];
  const gitDirControlMounts: ProtectedMount[] = [];

  const settingsDirectoryPath = host.path.resolve(host.path.join(root, '.book'));
  for (const mount of result.mounts) {
    // `.book` is kept even inside a read-only directory mount (a `core.hooksPath`
    // naming the workspace root makes the root one): bubblewrap builds the
    // settings directory's view from this mount, and without it the local
    // settings would be one host save away from a running command (#633).
    if (mount.kind === 'hidden-file' || mount.path === settingsDirectoryPath) {
      filteredMounts.push(mount);
      continue;
    }
    const mountCanonical = canonicalPath(mount.path, host);
    const strictlyInsidePresentReadOnlyDir = presentReadOnlyDirs.some(
      (dir) => !isOutside(dir, mountCanonical, host.path) && dir !== mountCanonical,
    );
    if (strictlyInsidePresentReadOnlyDir) {
      if (!allowGitWrites) {
        const strictlyInsideBoundGitDir = boundCanonical.some(
          (dir) => !isOutside(dir, mountCanonical, host.path) && dir !== mountCanonical,
        );
        if (strictlyInsideBoundGitDir) {
          gitDirControlMounts.push(mount);
        }
      }
    } else {
      filteredMounts.push(mount);
    }
  }

  result.mounts = filteredMounts;
  result.gitDirControlMounts = gitDirControlMounts;

  // In read-only mode, pin each ancestor directory strictly between the workspace root
  // and every protected mount whose path lies strictly below the workspace root and is not
  // inside a present read-only directory mount. A writable self-bind (--bind <dir> <dir>)
  // makes renaming the ancestor fail with EBUSY instead of moving the protected mount away.
  if (!allowGitWrites) {
    for (const mount of result.mounts) {
      const mountCanonical = canonicalPath(mount.path, host);
      if (isOutside(canonicalRoot, mountCanonical, host.path) || mountCanonical === canonicalRoot) {
        continue;
      }
      const isInsidePresentReadOnly = presentReadOnlyDirs.some(
        (dir) => !isOutside(dir, mountCanonical, host.path) && dir !== mountCanonical,
      );
      if (isInsidePresentReadOnly) continue;

      const ancestors = workspaceComponents(mount.path, root, host).slice(0, -1);
      for (const anc of ancestors) {
        if (!host.isDirectory(anc)) continue;
        const ancCanonical = canonicalPath(anc, host);
        if (presentReadOnlyDirs.some((dir) => !isOutside(dir, ancCanonical, host.path))) continue;
        if (!result.pinnedDirectories.includes(anc)) {
          result.pinnedDirectories.push(anc);
        }
      }
    }
  }

  const safeDirs = [...presentReadOnlyDirs, ...safeDenyDirs];

  // For every protected mount (pointer files, hooksPath directories, included config files),
  // discovered git dir, and pointer target, check each component strictly below workspace root.
  // A symlink is safe only if it lives inside a directory the host cannot see changed:
  // a present read-only directory mount, or a denyWrite / denyRead directory.
  const candidatesToCheck = new Set<string>([
    ...gitDirs.map((g) => g.dir),
    ...pointerPaths,
    ...result.mounts.map((m) => m.path),
    ...result.gitDirControlMounts.map((m) => m.path),
  ]);
  const checkedComponents = new Set<string>();
  for (const cand of candidatesToCheck) {
    for (const comp of workspaceComponents(cand, root, host)) {
      if (checkedComponents.has(comp)) continue;
      checkedComponents.add(comp);
      if (host.entryKind(comp) === 'symlink') {
        const parentCanonical = canonicalPath(host.path.dirname(comp), host);
        const symlinkLivePath = host.path.join(parentCanonical, host.path.basename(comp));
        const isSafe = safeDirs.some(
          (dir) => !isOutside(dir, symlinkLivePath, host.path) && dir !== symlinkLivePath,
        );
        if (!isSafe && !result.refusals.some((r) => r.path === comp)) {
          result.refusals.push({ path: comp, reason: 'symlinked-control-path' });
        }
      }
    }
  }

  return result;
}

/**
 * One mount bubblewrap applies from the workspace bind on: the path it lands
 * on, in the namespace's own spelling; what it leaves there; and its argv.
 *
 * Recorded rather than pushed straight onto the argv, because bwrap resolves
 * every bind source on the host: a later bind at or above a path covers every
 * mount the namespace already made below it. The settings directory is settled
 * after all of them for that reason ({@link settleSettingsDirectory}).
 */
interface NamespaceMount {
  at: string;
  access: 'writable' | 'read-only' | 'masked';
  args: string[];
}

function writableBind(at: string): NamespaceMount {
  return { at, access: 'writable', args: ['--bind', at, at] };
}

function readOnlyBind(at: string): NamespaceMount {
  return { at, access: 'read-only', args: ['--ro-bind', at, at] };
}

function protectedMount(mount: ProtectedMount, host: SandboxHost): NamespaceMount | null {
  const target = host.path.resolve(mount.path);
  if (mount.kind === 'hidden-file') {
    return mount.present
      ? { at: target, access: 'masked', args: ['--ro-bind', '/dev/null', target] }
      : null;
  }
  if (mount.kind === 'file') return mount.present ? readOnlyBind(target) : null;
  if (mount.present) return readOnlyBind(target);
  // `--tmpfs` creates the mount point, and bwrap does that *through* the
  // workspace bind: a sandboxed command in a workspace with no `.book/` leaves
  // an empty `.book/` directory on the host as a side effect. It is recorded in
  // docs/guide/configuration.md; the alternative would be a writable hole.
  return { at: target, access: 'masked', args: ['--tmpfs', target, '--remount-ro', target] };
}

/**
 * True for an entry of the workspace's `.book/` that no sandboxed command may
 * see: the local settings file, which can hold a provider key, and every other
 * name that carries it. Book's settings writer holds the key in
 * `.settings.local.json.<pid>.<uuid>.tmp` until it renames it into place, takes
 * `settings.local.json.lock` beside it, and an editor's swap or backup copy
 * holds whatever the file did.
 */
export function isHiddenSettingsEntry(name: string): boolean {
  return name.includes('settings.local.json');
}

/**
 * The most entries `.book/` may hold for a command to run in the sandbox. Each
 * one is a bind of its own, and bwrap rereads the mount table for every bind,
 * so a repository that shipped thousands would stall every sandboxed command.
 */
export const MAX_SETTINGS_DIRECTORY_ENTRIES = 256;

/**
 * The workspace's settings directory as a sandboxed command sees it (#633): an
 * empty tmpfs at `at` with `entries` bound back into it.
 */
interface SettingsDirectoryView {
  at: string;
  /** A symlink keeps its target as written: it is recreated, never followed. */
  entries: Array<{ name: string; linkTarget?: string }>;
}

/**
 * The entries `.book/` holds now, less the hidden ones, when it is a directory
 * the namespace protects; none when it is absent, so its mask is settled the
 * same way; null otherwise (a regular file, or a symlink a deny entry made safe
 * to accept, which keep the mounts they had). Throws, which refuses the
 * command, when it holds more than {@link MAX_SETTINGS_DIRECTORY_ENTRIES}.
 */
function settingsDirectoryView(
  workspaceRoot: string,
  paths: ProtectedWorkspacePaths,
  host: SandboxHost,
): SettingsDirectoryView | null {
  const at = host.path.join(host.path.resolve(workspaceRoot), '.book');
  const mount = paths.mounts.find((candidate) => candidate.path === at);
  if (!mount || mount.kind !== 'directory') return null;
  // Absent: an empty view. The mask alone would be covered by a later
  // read-only bind of the workspace (a `denyWrite` entry for it), which shows
  // the `.book` the host creates on a first save, local settings and all.
  if (!mount.present) return { at, entries: [] };
  if (host.entryKind(at) !== 'directory') return null;
  const entries: SettingsDirectoryView['entries'] = [];
  for (const name of [...host.readDir(at)].sort()) {
    if (isHiddenSettingsEntry(name)) continue;
    const path = host.path.join(at, name);
    const kind = host.entryKind(path);
    // A name lstat cannot find, gone since the listing or one the listing could
    // not spell, is left out: a bind of a missing source aborts the whole
    // invocation, and nothing can be read through it anyway.
    if (kind === null) continue;
    if (kind !== 'symlink') {
      entries.push({ name });
      continue;
    }
    const linkTarget = host.linkTarget(path);
    if (linkTarget !== null) entries.push({ name, linkTarget });
  }
  if (entries.length > MAX_SETTINGS_DIRECTORY_ENTRIES) {
    throw new Error(
      `Refused to run this command in the sandbox: ${at} holds ${entries.length} entries, more ` +
        `than the ${MAX_SETTINGS_DIRECTORY_ENTRIES} the sandbox binds into the command one by ` +
        'one so that the local settings file stays hidden from it. Move entries into ' +
        'subdirectories, or run this command without the sandbox.',
    );
  }
  return { at, entries };
}

/**
 * The settings directory as an empty tmpfs with each entry bound back in, then
 * made read-only (#633).
 *
 * A mask on `settings.local.json` itself is a bind on the file's dentry, and a
 * rename over the path installs a new one the mask does not cover — which the
 * host's own settings writer does on every save, temp file and rename. Here the
 * file has no name in the namespace at all, whatever the host does to it. The
 * entries are the ones the directory held when the command started, so one the
 * host adds later is not there either.
 *
 * Each entry gets `access`, the access the directory itself had: read-only, or
 * writable under an `allowWrite` entry naming `.book`. The directory stays
 * read-only either way, so an entry cannot be added, removed or renamed in it.
 */
function settingsDirectoryMounts(
  view: SettingsDirectoryView,
  access: NamespaceMount['access'],
  host: SandboxHost,
): NamespaceMount[] {
  if (access === 'masked') {
    return [{ at: view.at, access, args: ['--tmpfs', view.at, '--remount-ro', view.at] }];
  }
  const mounts: NamespaceMount[] = [{ at: view.at, access: 'masked', args: ['--tmpfs', view.at] }];
  for (const entry of view.entries) {
    const at = host.path.join(view.at, entry.name);
    if (entry.linkTarget !== undefined) {
      // Recreated, not bound: bwrap follows a bind source's links on the host,
      // so a repository's `.book/x -> ~/.ssh` would put that directory in the
      // namespace. The copy resolves inside the namespace, as the link itself
      // did when the directory was bound whole.
      mounts.push({ at, access, args: ['--symlink', entry.linkTarget, at] });
    } else {
      // `-try`: an entry gone since the listing (the settings writer's temp file
      // for `settings.json`, say) is left out, instead of aborting the command on
      // a bind source that is not there.
      const flag = access === 'writable' ? '--bind-try' : '--ro-bind-try';
      mounts.push({ at, access, args: [flag, at, at] });
    }
  }
  mounts.push({ at: view.at, access: 'read-only', args: ['--remount-ro', view.at] });
  return mounts;
}

/** True when `path` is strictly inside the view's directory. */
function insideView(view: SettingsDirectoryView, path: string, host: SandboxHost): boolean {
  return path !== view.at && !isOutside(view.at, path, host.path);
}

/** True when `path`, strictly inside the view's directory, lies under an entry it bound back. */
function boundInView(view: SettingsDirectoryView, path: string, host: SandboxHost): boolean {
  const first = host.path.relative(view.at, path).split(host.path.sep)[0];
  return view.entries.some((entry) => entry.name === first);
}

/**
 * Put the settings directory's view after every mount that could cover it.
 *
 * A bind whose source is the real `.book`, or a directory above it, shows the
 * live directory again, local settings included: the workspace under a
 * `denyWrite` entry, `.book` itself under one or under an `allowWrite` opt-in.
 * So the view goes after the last mount at or above `.book`, with that mount's
 * access, and the mounts strictly inside `.book` that came after that one follow
 * it in their order. The ones before it are dropped, as that mount had already
 * covered them; so is one at a hidden name or under a name the view did not
 * bind back, whose mount point bwrap could not even create in the read-only
 * tmpfs.
 */
function settleSettingsDirectory(
  mounts: NamespaceMount[],
  view: SettingsDirectoryView | null,
  host: SandboxHost,
): NamespaceMount[] {
  if (!view) return mounts;
  let last = -1;
  mounts.forEach((mount, index) => {
    if (!isOutside(mount.at, view.at, host.path)) last = index;
  });
  if (last === -1) return mounts;
  // The earlier mounts at `.book` stay where they were: an absent directory's
  // mask is what creates its mount point on the host before a later read-only
  // bind of the workspace. The last one, if it is at `.book`, is what the view
  // replaces.
  const replaced = mounts[last].at === view.at ? last : -1;
  return [
    ...mounts.filter((mount, index) => index !== replaced && !insideView(view, mount.at, host)),
    ...settingsDirectoryMounts(view, mounts[last].access, host),
    ...mounts.filter(
      (mount, index) =>
        index > last && insideView(view, mount.at, host) && boundInView(view, mount.at, host),
    ),
  ];
}

/** A host path bound writable, and which of the two writable layers binds it. */
interface WritableRoot {
  /** The spelling the namespace sees it at. */
  at: string;
  canonical: string;
  /**
   * `base`: the workspace, its pins and the `allowWrite` roots, bound before the
   * protected mounts. `opt-in`: an `allowWrite` entry on a protected path, bound
   * after them so it reopens what it names.
   */
  layer: 'base' | 'opt-in';
}

/** Shallowest first, in the given order otherwise (the sort is stable). */
function shallowestFirst(paths: string[], host: SandboxHost): string[] {
  const depth = (path: string): number => path.split(host.path.sep).filter(Boolean).length;
  return [...paths].sort((left, right) => depth(left) - depth(right));
}

/**
 * The directories to pin for the `denyWrite` entries, by the layer of the
 * writable root each entry lies in (#634).
 *
 * A read-only bind makes the entry itself un-renameable, but renaming a
 * directory above it carries the mount away, and a fresh directory takes the
 * old path. A writable self-bind of each directory strictly between the root
 * and the entry makes that rename fail with `EBUSY`, as `pinnedDirectories`
 * does for the control files. Nothing is pinned inside a read-only protected
 * directory, where nothing can be renamed, or at a path already bound. The
 * caller emits each layer shallowest first, so no later bind covers a pin.
 */
function denyWritePins(
  denied: string[],
  roots: WritableRoot[],
  paths: ProtectedWorkspacePaths,
  host: SandboxHost,
): Record<WritableRoot['layer'], string[]> {
  const readOnly = paths.mounts
    .filter((mount) => mount.kind === 'directory' && mount.present)
    .map((mount) => canonicalPath(mount.path, host));
  const pins: Record<WritableRoot['layer'], string[]> = { base: [], 'opt-in': [] };
  const bound = new Set(roots.map((root) => root.at));
  for (const target of denied) {
    const container = roots
      .filter((root) => !isOutside(root.canonical, target, host.path))
      .sort((left, right) => right.canonical.length - left.canonical.length)[0];
    if (!container) continue;
    const between = host.path
      .relative(container.canonical, target)
      .split(host.path.sep)
      .filter(Boolean)
      .slice(0, -1);
    let at = container.at;
    let canonical = container.canonical;
    for (const segment of between) {
      at = host.path.join(at, segment);
      canonical = host.path.join(canonical, segment);
      const inReadOnly = readOnly.some(
        (dir) =>
          dir !== container.canonical &&
          !isOutside(container.canonical, dir, host.path) &&
          !isOutside(dir, canonical, host.path),
      );
      if (inReadOnly || !host.isDirectory(at)) break;
      if (bound.has(at)) continue;
      bound.add(at);
      pins[container.layer].push(at);
    }
  }
  return pins;
}

/** The system directories every command gets, read-only. */
const SYSTEM_DIRECTORIES = ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc', '/opt'];

/**
 * Where every symlink on a path's way to its target lives: the link's own
 * directory, resolved, plus its name. A link's target can hold more links, so a
 * chain is followed to its end.
 */
function linksAlong(path: string, host: SandboxHost, seen = new Set<string>()): string[] {
  const resolved = host.path.resolve(path);
  const locations: string[] = [];
  for (const current of [resolved, ...ancestorsOf(resolved, host)].reverse()) {
    if (host.entryKind(current) !== 'symlink') continue;
    const directory = canonicalPath(host.path.dirname(current), host);
    const location = host.path.join(directory, host.path.basename(current));
    if (seen.has(location)) continue;
    seen.add(location);
    locations.push(location);
    const target = host.linkTarget(current);
    if (target !== null) {
      locations.push(...linksAlong(host.path.resolve(directory, target), host, seen));
    }
  }
  return locations;
}

/**
 * The `allowWrite` entries spelled through a link in a writable directory, each
 * with the notice that says so, by the entry's expanded path. Such a link can
 * change, so Book does not follow it: the entry is not bound. Both backends
 * apply this. `writableRoots` are the canonical roots besides the entries.
 */
function entriesThroughWritableLinks(
  allowWrite: string[],
  writableRoots: string[],
  host: SandboxHost,
): Map<string, string> {
  const entries = allowWrite
    .map((entry) => expandPath(entry, host))
    .filter((entry) => host.exists(entry));
  const writable = [...writableRoots, ...entries.map((entry) => canonicalPath(entry, host))];
  const notices = new Map<string, string>();
  for (const entry of entries) {
    const link = linksAlong(entry, host).find((location) =>
      writable.some((root) => !isOutside(root, location, host.path)),
    );
    if (link === undefined) continue;
    notices.set(
      entry,
      `sandbox.filesystem.allowWrite entry ${entry} is not bound: it is spelled through the link ` +
        `${link}, in a writable directory. Such a link can change, so Book does not follow it. ` +
        `Spell the entry without that link; it leads to ${canonicalPath(entry, host)} now.`,
    );
  }
  return notices;
}

/**
 * The spelling of a directory above the workspace that shows the workspace at
 * the workspace's own spelling, which is where every protection is (#682). When
 * the workspace is open at its real path, that is the directory's real path.
 * Null when there is none: the workspace is opened through a link that does not
 * run through this directory (`<base>/opened -> <base>/real/ws`, with
 * `<base>/real` the entry), so any bind of it shows the workspace a second time,
 * at a path no protection names.
 */
function spellingAboveWorkspace(
  canonical: string,
  workspace: string,
  canonicalWorkspace: string,
  host: SandboxHost,
): string | null {
  const below = host.path.relative(canonical, canonicalWorkspace);
  const up = below.split(host.path.sep).map(() => '..');
  const at = host.path.resolve(workspace, ...up);
  const fits = canonicalPath(at, host) === canonical && host.path.resolve(at, below) === workspace;
  return fits ? at : null;
}

/** Where each `allowWrite` entry is bound. An entry in neither map is not bound. */
interface AllowWriteSpellings {
  at: Map<string, string>;
  /** An entry outside the workspace bound elsewhere, by its spelling: see {@link spellingLinks}. */
  moved: Map<string, string>;
  /** An entry above the workspace that no spelling lines up with it: why it is not bound. */
  notices: string[];
}

/**
 * Bind every `allowWrite` entry so that the namespace has one path to the
 * workspace, the one the protections are emitted at. bwrap follows a bind
 * source's links on the host and creates the destination as written, so a root
 * spelled through a link is a second view of whatever it holds.
 *
 * An entry inside the workspace goes to the workspace's own spelling, and one
 * above it to the spelling that shows the workspace there. An entry inside one
 * of those roots moves with it: left at its own spelling it would be a view of
 * its own, which the `denyWrite` entries and protected files, each applied in
 * one root only, would not all cover. Anything else cannot reach the workspace
 * and stays as spelled.
 */
function allowWriteSpellings(
  entries: string[],
  workspace: string,
  canonicalWorkspace: string | null,
  host: SandboxHost,
): AllowWriteSpellings {
  const at = new Map<string, string>();
  const moved = new Map<string, string>();
  const notices: string[] = [];
  if (canonicalWorkspace === null) {
    for (const entry of entries) at.set(entry, entry);
    return { at, moved, notices };
  }
  const isAbove = (canonical: string): boolean =>
    canonical !== canonicalWorkspace && !isOutside(canonical, canonicalWorkspace, host.path);
  const above: Array<{ canonical: string; at: string }> = [];
  for (const entry of entries) {
    const canonical = canonicalPath(entry, host);
    if (!isAbove(canonical)) continue;
    const spelling = spellingAboveWorkspace(canonical, workspace, canonicalWorkspace, host);
    if (spelling !== null) {
      above.push({ canonical, at: spelling });
      continue;
    }
    const view = host.path.resolve(canonical, host.path.relative(canonical, canonicalWorkspace));
    notices.push(
      `sandbox.filesystem.allowWrite entry ${entry} is not bound: it holds the workspace, open at ` +
        `${workspace}, and would show it a second time at ${view}, where the workspace's ` +
        `protections do not apply. Open the workspace at its real path (${canonicalWorkspace}) ` +
        'to use this entry.',
    );
  }
  for (const entry of entries) {
    const canonical = canonicalPath(entry, host);
    if (!isOutside(canonicalWorkspace, canonical, host.path)) {
      const rest = host.path.relative(canonicalWorkspace, canonical);
      at.set(entry, rest ? host.path.resolve(workspace, rest) : workspace);
      continue;
    }
    const root = above.find((candidate) => !isOutside(candidate.canonical, canonical, host.path));
    if (root) {
      const rest = host.path.relative(root.canonical, canonical);
      const bound = rest ? host.path.resolve(root.at, rest) : root.at;
      at.set(entry, bound);
      if (bound !== entry) moved.set(entry, bound);
    } else if (!isAbove(canonical)) {
      at.set(entry, entry);
    }
  }
  return { at, moved, notices };
}

/**
 * Keep a moved entry working at the spelling the user wrote, which is the one
 * `$HOME` and the user's scripts use: a link there, in the namespace's own
 * filesystem, resolves to the one view of the directory and changes nothing on
 * the host.
 *
 * bwrap aborts the whole invocation on a link that collides with a mount, so a
 * spelling at or above one, or below one, gets none. Below a bind of a system
 * directory, the host's own link is already there and resolves the same way.
 * `/tmp` is a private tmpfs: it takes links below it, but cannot itself be one.
 */
function spellingLinks(moved: Map<string, string>, mounted: string[], host: SandboxHost): string[] {
  const args: string[] = [];
  const linked: string[] = [];
  for (const spelling of shallowestFirst([...moved.keys()], host)) {
    const collides = (path: string): boolean =>
      !isOutside(path, spelling, host.path) || !isOutside(spelling, path, host.path);
    if (mounted.some(collides) || !isOutside(spelling, '/tmp', host.path)) continue;
    // Already reached through the link above it.
    if (linked.some((above) => !isOutside(above, spelling, host.path))) continue;
    linked.push(spelling);
    args.push('--symlink', moved.get(spelling) as string, spelling);
  }
  return args;
}

/**
 * Build the bubblewrap argument vector for one command.
 *
 * Mount order is significant: bwrap applies operations in sequence and a later
 * mount shadows an earlier one covering the same path. The workspace bind
 * therefore comes *after* the system read-only binds and the /tmp tmpfs (a
 * workspace under /usr/local or /tmp would otherwise be silently shadowed), and
 * explicit filesystem policy comes after the workspace so it can override it.
 *
 * The workspace control files are the exception to "policy comes after the
 * workspace": their read-only mounts come after the workspace bind, so the
 * workspace does not shadow them, and before `denyWrite`/`denyRead`, which stay
 * free to be stricter still. The one `allowWrite` entry that is applied after
 * them is one that names a protected path or something under it, which is the
 * user asking for that path to be writable again; a broader root stays before,
 * so it cannot reopen what the protections just closed. The settings
 * directory's view (an empty tmpfs with its entries bound back, the local
 * settings left out) is the one thing applied after `denyWrite` as well: a
 * read-only bind of the directory, or of one above it, would show the local
 * settings again. `denyWrite` itself is applied only where the command could
 * write, so it never shows a path the namespace did not already show.
 *
 * Exported for testing: it does not require bwrap to be installed, and with an
 * injected `host` its output is fully determined by its arguments.
 */
export function buildSandboxExecution(
  bwrapPath: string,
  command: string,
  workspaceRoot: string,
  settings: ResolvedSettings['sandbox'],
  host: SandboxHost = realSandboxHost,
  protectedPaths?: ProtectedWorkspacePaths,
): CommandExecution {
  const args: string[] = [];

  // Fresh PID/IPC/UTS namespaces, and the sandbox dies if the spawning process
  // does.
  //
  // Deliberately NOT --new-session: it makes bwrap call setsid(), which moves
  // the sandboxed tree into its own process group. Every teardown path here
  // (KillShell, foreground timeout, Ctrl-C) signals the group Node created with
  // `detached: true` and confirms death with `kill(-pgid, 0)`, so the group
  // would read as empty while the command kept running — a kill that reports
  // success and does nothing. The TIOCSTI hardening --new-session buys is moot
  // anyway: all three spawn sites pipe stdio and never hand over a tty.
  args.push('--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent');
  args.push('--proc', '/proc');
  args.push('--dev', '/dev');

  // Minimal system directories, read-only.
  for (const dir of SYSTEM_DIRECTORIES) {
    bindIfPresent(args, '--ro-bind', dir, host);
  }

  args.push('--tmpfs', '/tmp');

  // Declared filesystem policy overrides the defaults below.
  //
  // The control files are computed first, because where an `allowWrite` entry
  // lands in the sequence depends on them. An entry *at or under* a protected
  // path is the user asking for exactly that path to be writable again — a hook
  // installer that has to write `.git/hooks/pre-commit`, a cache under
  // `.book/cache` — so it is applied after the protected mounts and wins. An
  // entry *above* them (a parent directory, `/home`, the workspace itself) stays
  // before, because a broad root that reopened `.book/` or a hooks directory on
  // its way down would not be an opt-in but the default back the protections
  // exist to remove. Only a trusted layer can hold one: a workspace layer's
  // `allowWrite` entries are dropped by the loader (#373).
  const paths =
    protectedPaths ??
    protectedWorkspacePaths(workspaceRoot, host, {
      allowGitWrites: settings.filesystem.allowGitWrites,
      denyDirectories: [...settings.filesystem.denyWrite, ...settings.filesystem.denyRead].map(
        (p) => expandPath(p, host),
      ),
    });
  const isProtectedArea = (path: string): boolean => {
    const canonical = canonicalPath(expandPath(path, host), host);
    return paths.mounts.some(
      (mount) => !isOutside(canonicalPath(mount.path, host), canonical, host.path),
    );
  };
  const present = (entries: string[]): string[] =>
    entries.map((path) => expandPath(path, host)).filter((target) => host.exists(target));
  const view = settingsDirectoryView(workspaceRoot, paths, host);

  // Every host path bound writable below, at the spelling the namespace sees,
  // with its canonical form for containment. `denyWrite` is applied against
  // these and nothing else.
  const workspace = expandPath(workspaceRoot, host);
  const canonicalWorkspace = host.exists(workspace) ? canonicalPath(workspace, host) : null;
  const throughLinks = entriesThroughWritableLinks(
    settings.filesystem.allowWrite,
    canonicalWorkspace !== null ? [canonicalWorkspace] : [],
    host,
  );
  const spellings = allowWriteSpellings(
    present(settings.filesystem.allowWrite).filter((entry) => !throughLinks.has(entry)),
    workspace,
    canonicalWorkspace,
    host,
  );
  const boundAt = (entries: string[]): string[] => [
    ...new Set(present(entries).flatMap((entry) => spellings.at.get(entry) ?? [])),
  ];
  const pinned = paths.pinnedDirectories.map((dir) => host.path.resolve(dir));
  const allowWriteRoots = boundAt(
    settings.filesystem.allowWrite.filter((p) => !isProtectedArea(p)),
  );
  const optInRoots = boundAt(settings.filesystem.allowWrite.filter(isProtectedArea));
  const root = (at: string, layer: WritableRoot['layer']): WritableRoot => ({
    at,
    canonical: canonicalPath(at, host),
    layer,
  });
  const writableRoots: WritableRoot[] = [
    ...(canonicalWorkspace !== null ? [root(workspace, 'base')] : []),
    ...pinned.map((at) => root(at, 'base')),
    ...allowWriteRoots.map((at) => root(at, 'base')),
    ...optInRoots.map((at) => root(at, 'opt-in')),
  ];
  const deniedWrites = present(settings.filesystem.denyWrite).map((target) =>
    canonicalPath(target, host),
  );
  const pins = denyWritePins(deniedWrites, writableRoots, paths, host);
  // Where the namespace shows a canonical path: the spelling of the deepest
  // writable root holding it plus the rest, or null when no root holds it.
  const inWritableRoot = (canonical: string): string | null => {
    const container = writableRoots
      .filter((candidate) => !isOutside(candidate.canonical, canonical, host.path))
      .sort((left, right) => right.canonical.length - left.canonical.length)[0];
    if (!container) return null;
    const rest = host.path.relative(container.canonical, canonical);
    return rest ? host.path.resolve(container.at, rest) : container.at;
  };
  // A protected file is bound only where the command could write it: inside the
  // workspace or a writable root, and at that root's own spelling plus the rest,
  // as `denyWrite` is applied. Anywhere else (a config an `[include]` names, a
  // linked work tree's `.git` pointer) it is not in the namespace at all, so
  // there is nothing there to protect, and a bind would only add it. The host
  // still reads it for `core.hooksPath`.
  const protectedAt = (mount: ProtectedMount): ProtectedMount | null => {
    if (mount.kind !== 'file') return mount;
    const at = inWritableRoot(canonicalPath(mount.path, host));
    return at === null ? null : { ...mount, path: at };
  };

  const mounts: NamespaceMount[] = [];

  // The workspace is writable. Bound after /tmp so a workspace inside /tmp
  // (every mkdtemp-based test run, among others) survives the tmpfs. With it
  // go the pins and the `allowWrite` roots, and the control files the host acts
  // on after this command exits come after all of them, so none of them shadows
  // a protection.
  //
  // Each of these binds is a bind from the host, so it covers whatever the
  // namespace mounted below it before. They are emitted shallowest first: an
  // `allowWrite` root above the workspace then comes before the workspace
  // itself, which stays a mount point (`mv <workspace> …` fails with `EBUSY`),
  // and so does every pin below it (#634); an `allowWrite` entry under a pin
  // comes after the pin rather than being shadowed by it, and silently doing
  // nothing. In the read-only git-dirs mode there is no git-dir pin: the git
  // dir is a protected mount, so an `allowWrite` entry naming it reopens what it
  // names, while control paths strictly below it (hooks, config, pointer files)
  // stay read-only unless an entry names them directly.
  const base = [
    ...(canonicalWorkspace !== null ? [workspace] : []),
    ...pinned,
    ...allowWriteRoots,
    ...pins.base,
  ];
  for (const at of shallowestFirst(base, host)) mounts.push(writableBind(at));
  // The credential masks are left for the end, after everything that could
  // bind the directory holding one.
  for (const mount of paths.mounts) {
    const bound = mount.kind === 'hidden-file' ? null : protectedAt(mount);
    const applied = bound ? protectedMount(bound, host) : null;
    if (applied) mounts.push(applied);
  }
  // ...and only now the opt-ins for the protected areas themselves, with the
  // pins below them, shallowest first again.
  const deferredOptInCanonicals = optInRoots.map((target) => canonicalPath(target, host));
  for (const at of shallowestFirst([...optInRoots, ...pins['opt-in']], host)) {
    mounts.push(writableBind(at));
  }

  // An allowWrite opt-in on a git dir reopens what it names, but not the control
  // paths strictly below it (hooks, config, pointer files). Emit each of those
  // control mounts whose canonical path is strictly below a deferred opt-in entry,
  // unless an entry exactly at that control path reopens it.
  for (const mount of paths.gitDirControlMounts) {
    const mountCanonical = canonicalPath(mount.path, host);
    const strictlyBelowDeferredOptIn = deferredOptInCanonicals.some(
      (optIn) => !isOutside(optIn, mountCanonical, host.path) && optIn !== mountCanonical,
    );
    if (!strictlyBelowDeferredOptIn || deferredOptInCanonicals.includes(mountCanonical)) continue;
    const bound = protectedAt(mount);
    const applied = bound ? protectedMount(bound, host) : null;
    if (applied) mounts.push(applied);
  }

  // `denyWrite` only ever takes write access away. A read-only bind of the real
  // path would also *show* it, and outside the writable roots nothing is shown:
  // `denyWrite: ["~"]` bound the whole home directory into the namespace,
  // `["/"]` the host's /proc, /dev and /tmp over the private ones — and a
  // workspace layer may add deny entries, so a repository could ask for either
  // (#625). So an entry is applied only where the command could write: bound
  // read-only when it lies inside a writable root, and every writable root
  // inside it bound read-only in its turn. Anything else is already invisible or
  // already read-only, and is left alone.
  //
  // The bind goes where the namespace already shows the path: the containing
  // root's own spelling plus the rest. The entry's spelling can differ (a home
  // reached through a symlink, a relative entry against a physical cwd), and a
  // bind at that spelling would create a second view of the real directory that
  // the credential masks, emitted at the workspace's spelling, do not cover.
  const readOnlyBinds = new Set<string>();
  for (const denied of deniedWrites) {
    const at = inWritableRoot(denied);
    if (at !== null) readOnlyBinds.add(at);
    for (const writable of writableRoots) {
      if (!isOutside(denied, writable.canonical, host.path)) readOnlyBinds.add(writable.at);
    }
  }
  for (const at of readOnlyBinds) mounts.push(readOnlyBind(at));

  // A mask hides a file's *contents*, and a later bind of the directory that
  // holds it undoes that: an opt-in such as `allowWrite: ["<workspace>/.book"]`
  // puts the whole directory back in reach, provider credential included, and so
  // does a `denyWrite` entry at or above it, which is a read-only bind of the
  // real directory (#625). The masks are therefore emitted once, after every
  // opt-in and every `denyWrite` bind, so the last mount of a masked path is
  // `/dev/null` whichever entry named its parent. A hidden file inside the
  // settings directory gets no mask at all: the directory's view, settled after
  // the same mounts, leaves it out (#633).
  for (const mount of paths.mounts) {
    if (mount.kind !== 'hidden-file') continue;
    if (view && insideView(view, host.path.resolve(mount.path), host)) continue;
    const applied = protectedMount(mount, host);
    if (applied) mounts.push(applied);
  }
  for (const mount of settleSettingsDirectory(mounts, view, host)) args.push(...mount.args);

  // bwrap cannot unmount a subpath, so a denied path is masked instead. The
  // mask has to match the kind: --tmpfs needs to mkdir its target, so pointing
  // it at a file aborts the entire invocation with "Not a directory" — and a
  // credentials *file* is the most natural thing to deny. Files are masked with
  // /dev/null instead, which makes reads fail outright. One inside the settings
  // directory is applied only under an entry the view bound back: anything else
  // there is already gone, and has no mount point left in the read-only tmpfs,
  // so bwrap would abort the whole invocation trying to create one. Decided on
  // canonical paths, since a workspace layer may add a deny entry spelled
  // through a link into `.book`. The mask goes where the namespace shows the
  // path, as a `denyWrite` entry does: at the entry's own spelling it would hide
  // nothing from a root that shows the path at another.
  const viewCanonical = view ? { ...view, at: canonicalPath(view.at, host) } : null;
  const masked: string[] = [];
  for (const target of present(settings.filesystem.denyRead)) {
    const canonical = canonicalPath(target, host);
    if (
      viewCanonical &&
      insideView(viewCanonical, canonical, host) &&
      !boundInView(viewCanonical, canonical, host)
    ) {
      continue;
    }
    const at = inWritableRoot(canonical) ?? target;
    masked.push(at);
    if (host.isDirectory(target)) args.push('--tmpfs', at);
    else args.push('--ro-bind', '/dev/null', at);
  }

  args.push(
    ...spellingLinks(
      spellings.moved,
      [...SYSTEM_DIRECTORIES, '/proc', '/dev', ...mounts.map((mount) => mount.at), ...masked],
      host,
    ),
  );

  // bwrap can only share or unshare the network wholesale. A declared
  // per-domain policy cannot be enforced as written, so fail closed rather
  // than hand out the unrestricted host network the caller did not ask for.
  args.push(hasDomainPolicy(settings) ? '--unshare-net' : '--share-net');

  args.push('--cap-drop', 'ALL');

  // The command string is a single argv element: bash inside the sandbox
  // parses it, and nothing outside the sandbox ever does.
  args.push('--', '/bin/bash', '-c', command);

  const notices = [...throughLinks.values(), ...spellings.notices];
  return { file: bwrapPath, args, ...(notices.length > 0 ? { notices } : {}) };
}

/** Every directory above `path`, nearest first, ending at the root. */
function ancestorsOf(path: string, host: SandboxHost): string[] {
  const ancestors: string[] = [];
  let current = path;
  for (;;) {
    const parent = host.path.dirname(current);
    if (parent === current) return ancestors;
    ancestors.push(parent);
    current = parent;
  }
}

/**
 * The temp directories a sandboxed command on macOS can use: `os.tmpdir()`
 * (the per-user `/var/folders/…/T`) and `/tmp`, canonicalised, because Seatbelt
 * matches the resolved path and both are reached through symlinks (`/var`,
 * `/tmp` → `/private/…`).
 *
 * They are the host's own, not private ones as under bubblewrap: macOS tools
 * write to the per-user temp directory whatever `TMPDIR` says — `mktemp` and the
 * `xcrun` shim behind `/usr/bin/git` among them — so a private directory breaks
 * them instead of isolating them. Book's own entries in them stay out of reach
 * (`BOOK_TEMP_PREFIXES`).
 */
export function seatbeltTempRoots(host: SandboxHost = realSandboxHost): string[] {
  // A temp root is only ever a scratch directory. One that is, or holds, the home
  // directory (`TMPDIR=$HOME`, `TMPDIR=/`) would hand the command the whole home,
  // so it is dropped — and the temp writes with it, which fails closed. A
  // `BOOK_HOME` inside a temp root needs no such drop: `buildSeatbeltPolicy`
  // denies it by path after the temp roots.
  const home = canonicalPath(host.homedir(), host);
  const roots = [tmpdir(), '/tmp']
    .map((root) => host.realpath(root))
    .filter((root): root is string => root !== null && isOutside(root, home, host.path));
  return [...new Set(roots)];
}

/**
 * The Seatbelt policy for one workspace, from the same inputs and in the same
 * order as {@link buildSandboxExecution}: the workspace, then `allowWrite`, then
 * the protected control paths, then the opt-ins that reopen them, then the
 * credential masks, then `denyWrite` / `denyRead`. Seatbelt applies the last
 * rule that matches, which is the same precedence bubblewrap's mount order
 * gives. `denyWrite` only denies writes, so nothing after the masks can reopen
 * one: on both backends it never shows a path that was not already shown.
 *
 * What bubblewrap gets from mounting and Seatbelt has to state:
 *
 * - **Reads.** bubblewrap shows the command the system directories, the
 *   workspace and the writable declared paths, and nothing else — the home
 *   directory is not there. The profile reads the same set
 *   (`SEATBELT_SYSTEM_READ_ROOTS` plus the paths below), and directory
 *   *metadata* only of their ancestors, so
 *   a path can be resolved without its parents being listed.
 * - **Pins.** A bind mount is a mount point, so renaming it fails with `EBUSY`;
 *   Seatbelt rules are by path, so a renamed directory takes its contents out
 *   from under them. The workspace root and the directories bubblewrap pins are
 *   kept from being renamed or removed; every directory above a protected path
 *   is kept from being *created*, so one moved away cannot come back as a
 *   symlink to a tree the command built; and the directories above a hidden or
 *   `denyRead` path are kept in place, since moving one would carry the hidden
 *   file to a path nothing hides. The pins are specific-operation denies, which
 *   no later wildcard allow reopens.
 *
 * Paths are canonical, because Seatbelt matches the path a lookup resolves to.
 * Exported for testing; with an injected `host` its output depends on its
 * arguments only.
 */
export function buildSeatbeltPolicy(
  workspaceRoot: string,
  settings: ResolvedSettings['sandbox'],
  host: SandboxHost = realSandboxHost,
  protectedPaths?: ProtectedWorkspacePaths,
  tempRoots: string[] = [],
  bookHome?: string,
): SeatbeltPolicy {
  // One command canonicalises the same mount paths many times over; each is a
  // walk of realpath calls, so they are computed once per policy.
  const canonical = new Map<string, string>();
  const canon = (path: string): string => {
    let resolved = canonical.get(path);
    if (resolved === undefined) {
      resolved = canonicalPath(path, host);
      canonical.set(path, resolved);
    }
    return resolved;
  };
  const subpath = (path: string): SeatbeltPathFilter => ({ match: 'subpath', path });
  const literal = (path: string): SeatbeltPathFilter => ({ match: 'literal', path });
  const READ_WRITE = ['file-read*', 'file-write*'] as const;

  const paths =
    protectedPaths ??
    protectedWorkspacePaths(workspaceRoot, host, {
      allowGitWrites: settings.filesystem.allowGitWrites,
      denyDirectories: [...settings.filesystem.denyWrite, ...settings.filesystem.denyRead].map(
        (p) => expandPath(p, host),
      ),
    });
  const isProtectedArea = (path: string): boolean => {
    const target = canon(expandPath(path, host));
    return paths.mounts.some((mount) => !isOutside(canon(mount.path), target, host.path));
  };
  /** A configured entry's canonical path, or null when nothing is there (bwrap skips it too). */
  const present = (path: string): string | null => {
    const target = expandPath(path, host);
    return host.exists(target) ? canon(target) : null;
  };
  const presentAll = (entries: string[]): string[] =>
    entries.map(present).filter((path): path is string => path !== null);

  const workspace = host.exists(workspaceRoot) ? canon(workspaceRoot) : null;
  // Book's own home holds the provider key and every session. It is unreadable
  // here mostly because it sits in the home directory; this states it outright,
  // for a `BOOK_HOME` anywhere else.
  const bookHomePath = bookHome ? canon(bookHome) : null;
  const workspaceInBookHome =
    workspace !== null && bookHomePath !== null && !isOutside(bookHomePath, workspace, host.path);
  const throughLinks = entriesThroughWritableLinks(
    settings.filesystem.allowWrite,
    [...(workspace ? [workspace] : []), ...tempRoots],
    host,
  );
  const entries = settings.filesystem.allowWrite.filter(
    (entry) => !throughLinks.has(expandPath(entry, host)),
  );
  const allowWrite = presentAll(entries.filter((p) => !isProtectedArea(p)));
  const optIns = presentAll(entries.filter(isProtectedArea));
  const denyWrite = presentAll(settings.filesystem.denyWrite);
  const denyReadEntries = settings.filesystem.denyRead
    .map((path) => expandPath(path, host))
    .filter((target) => host.exists(target))
    .map((target) => ({ path: canon(target), directory: host.isDirectory(target) }));

  /** The rule one protected control path needs: the mount bwrap would emit, as a deny. */
  const protectedRule = (mount: ProtectedMount): SeatbeltRule | null => {
    const path = canon(mount.path);
    if (mount.kind === 'hidden-file') {
      return mount.present
        ? { action: 'deny', operations: READ_WRITE, filters: [literal(path)] }
        : null;
    }
    if (mount.kind === 'file') {
      return mount.present
        ? { action: 'deny', operations: ['file-write*'], filters: [literal(path)] }
        : null;
    }
    // A directory, present or not: an absent one is denied by path, so the
    // command cannot create it — where bwrap has to mount over it, and leaves the
    // empty directory on the host as a side effect.
    return { action: 'deny', operations: ['file-write*'], filters: [subpath(path)] };
  };
  // The local settings: denied by name, every name in `.book/` that carries
  // `settings.local.json`, whether or not one exists yet. A rule for the file
  // alone, and only when it was there as the profile was built, left a first save
  // made while a command ran readable, and so were the settings writer's
  // `.settings.local.json.<pid>.<uuid>.tmp`, its lock and an editor's copy (#633).
  const settingsDirectory = workspace ? canon(host.path.join(workspace, '.book')) : null;
  const localSettingsRule: SeatbeltRule | null = settingsDirectory
    ? {
        action: 'deny',
        operations: READ_WRITE,
        filters: [subpath(settingsDirectory)],
        localSettingsEntries: true,
      }
    : null;
  const inSettingsDirectory = (mount: ProtectedMount): boolean =>
    settingsDirectory !== null && !isOutside(settingsDirectory, canon(mount.path), host.path);
  const hiddenFiles = paths.mounts.filter(
    (mount) => mount.kind === 'hidden-file' && mount.present && !inSettingsDirectory(mount),
  );

  const readableRoots = [...tempRoots, ...(workspace ? [workspace] : []), ...allowWrite, ...optIns];
  const rules: SeatbeltRule[] = [];

  // Directory metadata above every readable root, so a path inside one resolves
  // (`realpath`, `pwd -P`, git's own discovery) without its parents being listed.
  // First, so every deny below still wins over it.
  rules.push({
    action: 'allow',
    operations: ['file-read-metadata'],
    filters: [...new Set(readableRoots.flatMap((root) => ancestorsOf(root, host)))].map(literal),
  });
  rules.push({ action: 'allow', operations: READ_WRITE, filters: tempRoots.map(subpath) });
  rules.push({
    action: 'deny',
    operations: READ_WRITE,
    filters: tempRoots.map(subpath),
    bookTempEntries: true,
  });
  // A managed agent's worktree is a workspace inside Book's home: deny the home
  // first so the workspace allow reopens it. Otherwise the deny comes after the
  // workspace, so a `BOOK_HOME` inside the workspace stays unreadable.
  const bookHomeRule: SeatbeltRule | null = bookHomePath
    ? { action: 'deny', operations: READ_WRITE, filters: [subpath(bookHomePath)] }
    : null;
  if (bookHomeRule && workspaceInBookHome) rules.push(bookHomeRule);
  // After the temp roots, so a workspace inside one is writable whatever it is called.
  if (workspace)
    rules.push({ action: 'allow', operations: READ_WRITE, filters: [subpath(workspace)] });
  if (bookHomeRule && !workspaceInBookHome) rules.push(bookHomeRule);
  rules.push({ action: 'allow', operations: READ_WRITE, filters: allowWrite.map(subpath) });
  for (const mount of paths.mounts) {
    if (mount.kind === 'hidden-file' && inSettingsDirectory(mount)) continue;
    const rule = protectedRule(mount);
    if (rule) rules.push(rule);
  }
  rules.push({ action: 'allow', operations: READ_WRITE, filters: optIns.map(subpath) });
  // As in bwrap: an opt-in on a git dir reopens what it names, not the control
  // paths strictly below it, unless an entry names that control path itself.
  for (const mount of paths.gitDirControlMounts) {
    const mountCanonical = canon(mount.path);
    const strictlyBelowOptIn = optIns.some(
      (optIn) => !isOutside(optIn, mountCanonical, host.path) && optIn !== mountCanonical,
    );
    if (strictlyBelowOptIn && !optIns.includes(mountCanonical)) {
      const rule = protectedRule(mount);
      if (rule) rules.push(rule);
    }
  }
  // The masks once more, after every opt-in that could name their directory,
  // and the local settings with them, after every allow there is.
  for (const mount of hiddenFiles) {
    const rule = protectedRule(mount);
    if (rule) rules.push(rule);
  }
  if (localSettingsRule) rules.push(localSettingsRule);
  // `denyWrite` takes write access away and gives nothing: no read allow, no
  // socket root. A workspace layer may add deny entries, so one that made a path
  // readable would let a repository open `~` with `denyWrite: ["~"]` (#625).
  rules.push({ action: 'deny', operations: ['file-write*'], filters: denyWrite.map(subpath) });
  rules.push({
    action: 'deny',
    operations: READ_WRITE,
    filters: denyReadEntries.map((entry) =>
      entry.directory ? subpath(entry.path) : literal(entry.path),
    ),
  });

  // Pins, last: specific-operation denies no wildcard allow above can reopen.
  const deniedPaths = [
    ...paths.mounts.map((mount) => canon(mount.path)),
    ...paths.gitDirControlMounts.map((mount) => canon(mount.path)),
    ...denyWrite,
    ...denyReadEntries.map((entry) => entry.path),
  ];
  const hiddenPaths = [
    ...hiddenFiles.map((mount) => canon(mount.path)),
    // `.book` and everything above it stay in place, opt-in or not: the local
    // settings carried to another name would be out from under the rule.
    ...(settingsDirectory ? [host.path.join(settingsDirectory, 'settings.local.json')] : []),
    ...denyReadEntries.map((entry) => entry.path),
    ...(bookHomePath && !workspaceInBookHome ? [bookHomePath] : []),
  ];
  // In place: the workspace root and every directory above it (a workspace
  // under a temp root or an `allowWrite` root could otherwise be moved, taking
  // its protected paths with it to a path no rule names), the temp roots (#652),
  // the directories bubblewrap pins, and the directories above every hidden or
  // read-only path.
  const keptInPlace = new Set([
    ...(workspace ? [workspace, ...ancestorsOf(workspace, host)] : []),
    ...tempRoots,
    ...paths.pinnedDirectories.map(canon),
    ...[...hiddenPaths, ...denyWrite].flatMap((path) => ancestorsOf(path, host)),
  ]);
  const notCreatable = new Set(
    [...(workspace ? [workspace] : []), ...deniedPaths].flatMap((path) => ancestorsOf(path, host)),
  );
  for (const path of keptInPlace) notCreatable.delete(path);
  // A temp root's contents are writable, the root itself is not: `subpath`
  // matches the root as well, and the per-user `T` sits in a directory the user
  // owns, so a command could move it aside and put a symlink into the workspace
  // in its place. Book builds its own entries from `os.tmpdir()`, and their deny
  // holds only under the root's real path, so the next one would land where
  // sandboxed commands write (#652). Last, after every allow that could name a
  // root (the workspace, an `allowWrite` entry), and on top of the pins.
  rules.push({ action: 'deny', operations: ['file-write*'], filters: tempRoots.map(literal) });
  rules.push({
    action: 'deny',
    operations: ['file-write-unlink', 'file-write-create'],
    filters: [...keptInPlace].map(literal),
  });
  rules.push({
    action: 'deny',
    operations: ['file-write-create'],
    filters: [...notCreatable].map(literal),
  });

  return {
    rules,
    // Seatbelt has no per-domain filtering either, so a domain policy fails
    // closed to no network rather than to the whole host network.
    network: hasDomainPolicy(settings) ? 'none' : 'host',
    unixSocketRoots: [...(workspace ? [workspace] : []), ...allowWrite, ...optIns],
    unixSocketDenied: denyReadEntries.map((entry) => entry.path),
    ...(throughLinks.size > 0 ? { notices: [...throughLinks.values()] } : {}),
  };
}

/**
 * The `sandbox-exec` argv for one command: {@link buildSeatbeltPolicy} rendered
 * by `sandbox-seatbelt.ts`. Exported for testing, like {@link buildSandboxExecution}.
 */
export function buildSeatbeltExecution(
  sandboxExecPath: string,
  command: string,
  workspaceRoot: string,
  settings: ResolvedSettings['sandbox'],
  host: SandboxHost = realSandboxHost,
  protectedPaths?: ProtectedWorkspacePaths,
  tempRoots: string[] = [],
  bookHome?: string,
): CommandExecution {
  const policy = buildSeatbeltPolicy(
    workspaceRoot,
    settings,
    host,
    protectedPaths,
    tempRoots,
    bookHome,
  );
  return {
    ...seatbeltExecution(sandboxExecPath, policy, command),
    ...(policy.notices ? { notices: policy.notices } : {}),
  };
}

/**
 * The context facts the sandbox decision reads. Structural rather than
 * `ToolContext` so this stays free of the tool layer: `Bash` and the `Check`
 * tool both pass one, and neither type is imported here.
 */
export interface SandboxDecisionContext {
  sandbox?: ResolvedSettings['sandbox'];
  workspaceRoot: string;
  /** The session's sandbox, built once per distinct settings object. */
  runtime?: { sandbox(settings: ResolvedSettings['sandbox']): Sandbox | null };
  /** Where a notice for the user goes; the console, when the host has no sink. */
  onNotice?: (notice: string) => void;
}

/**
 * How one command is to be run, or why it may not run at all.
 *
 * `exec` is set only on the sandboxed outcome, and is what the caller spawns
 * instead of the command. `reason` is set when a sandbox was asked for and
 * skipped, which is what `allowUnsandboxedCommands` governs; it is absent when
 * no sandbox was configured at all. `error` means do not run anything.
 */
export interface SandboxDecision {
  sandboxed: boolean;
  exec?: CommandExecution;
  reason?: SandboxSkipReason;
  error?: string;
  gitDirReadOnly?: boolean;
}

/**
 * Decide how `command` is to be run, and refuse it when it must not run at all.
 *
 * One function, because the order of these checks is the policy:
 *
 * 1. no sandbox configured, or the command is excluded → run unsandboxed,
 *    unless `allowUnsandboxedCommands` is false, which refuses it;
 * 2. a workdir outside the workspace → refused, since the sandbox binds the
 *    workspace and the command would run somewhere the caller did not ask for;
 * 3. a control path the namespace cannot protect → refused, since every mount
 *    that could stand in for one either aborts bwrap or leaves the control file
 *    writable;
 * 4. otherwise wrap it, and report the wrapped argv.
 *
 * A path that ends with the command running outside a bubblewrap namespace all
 * funnels through here, so `allowUnsandboxedCommands: false` cannot be enforced
 * on one escape and quietly missed on another. `Bash` and the `Check` tool both
 * call this, so a check cannot run unsandboxed in a session that refuses
 * unsandboxed commands (#373).
 *
 * The refusal and failure messages are the ones `Bash` has always returned; they
 * are part of the tool contract, not an implementation detail.
 */
export function decideSandboxExecution(
  ctx: SandboxDecisionContext,
  command: string,
  workdir: string,
): SandboxDecision {
  // Every path that ends with the command running outside a bubblewrap
  // namespace funnels through here.
  const unsandboxed = (reason: SandboxSkipReason): SandboxDecision =>
    ctx.sandbox && !ctx.sandbox.allowUnsandboxedCommands
      ? { sandboxed: false, reason, error: unsandboxedRefusalMessage(reason) }
      : { sandboxed: false, reason };

  if (!ctx.sandbox?.enabled) return unsandboxed('disabled');
  if (matchesExcludedCommand(command, ctx.sandbox.excludedCommands)) return unsandboxed('excluded');

  // The sandbox binds the workspace, not this workdir. A workdir outside it
  // would leave the command with no working directory inside the namespace,
  // and silently running it against the workspace root instead would execute
  // somewhere the caller did not ask for.
  if (!resolveWorkspacePath(ctx.workspaceRoot, workdir)) {
    return {
      sandboxed: false,
      error: `workdir is outside the sandboxed workspace: ${workdir}. Add it to sandbox.filesystem.allowWrite, or run without the sandbox.`,
    };
  }
  // createSandbox emits one-time diagnostics, so reuse the session's instance
  // rather than rebuilding it per command.
  //
  // Its `failIfUnavailable` refusal is a throw, and this decision is the only
  // thing between that throw and a tool exception worded in terms of `Bash`
  // whichever tool happened to be running. It is caught here and returned as the
  // decision's own error, so `Check` and `Bash` report it the same way and the
  // message is the one the settings author has to act on.
  let sandbox: Sandbox | null;
  try {
    sandbox = ctx.runtime ? ctx.runtime.sandbox(ctx.sandbox) : createSandbox(ctx.sandbox);
  } catch (error) {
    return { sandboxed: false, error: error instanceof Error ? error.message : String(error) };
  }
  // A control path the namespace cannot protect is refused, not worked around,
  // and only once a sandbox is actually in hand: with none, the command runs
  // unsandboxed under the policy the settings author chose, which is not this
  // decision to tighten.
  let protectedPaths: ProtectedWorkspacePaths | undefined;
  if (sandbox) {
    const denyDirectories = [
      ...ctx.sandbox.filesystem.denyWrite,
      ...ctx.sandbox.filesystem.denyRead,
    ].map((p) => expandPath(p, realSandboxHost));

    protectedPaths = protectedWorkspacePaths(ctx.workspaceRoot, realSandboxHost, {
      allowGitWrites: ctx.sandbox.filesystem.allowGitWrites,
      denyDirectories,
    });
    const refusal = protectedPaths.refusals[0];
    if (refusal) return { sandboxed: false, error: describeControlPathRefusal(refusal) };
  }
  // A wrap that cannot build its policy refuses the command rather than
  // returning null, which would read as "no sandbox" and could run it outside.
  let exec: CommandExecution | null | undefined;
  try {
    exec = sandbox?.wrap(command, ctx.workspaceRoot, protectedPaths);
  } catch (error) {
    return { sandboxed: false, error: error instanceof Error ? error.message : String(error) };
  }
  if (exec) {
    if (exec.notices) {
      for (const notice of sandbox?.unseenNotices?.(exec.notices) ?? exec.notices) {
        if (ctx.onNotice) ctx.onNotice(notice);
        else console.warn(`⚠  ${notice}`);
      }
    }
    return {
      sandboxed: true,
      exec,
      gitDirReadOnly: !ctx.sandbox.filesystem.allowGitWrites,
    };
  }
  if (ctx.sandbox.failIfUnavailable) {
    return { sandboxed: false, error: 'Sandbox unavailable and failIfUnavailable is set' };
  }
  return unsandboxed('unavailable');
}

/**
 * A command's output with the notices for the `allowWrite` entries its sandbox
 * left out, so the model learns why a path it was told about is not writable.
 */
export function withSandboxNotices(text: string, exec?: CommandExecution): string {
  return exec?.notices ? `${text}\n\n${exec.notices.join('\n')}` : text;
}

/**
 * The line a sandboxed git command needs when it cannot write in the git dir.
 *
 * Which file is read-only depends on the mode. With
 * `sandbox.filesystem.allowGitWrites=false` (the default) every git directory
 * of the workspace is bound read-only (issue 373), so `git commit`, `git add`,
 * `git stash`, `git checkout` and `git fetch` fail on the index lock, on
 * `FETCH_HEAD`, on the object database — errors that say nothing about a
 * read-only bind. With it true, only the git dir's `config` and the pointer
 * files are, so `git commit` still works but `git remote add` and `git config`
 * fail with "could not write config file" / "could not lock config file".
 * Either way the error names no cause, so the model retries the same command or
 * rewrites it to route around the file instead of running it outside.
 *
 * Returned as a line the caller appends to the output that carried the error,
 * and only for a sandboxed command: unsandboxed git has no read-only git dir,
 * and an unrelated file that happens to be called `config` is not this. The
 * note is appended once, however many streams the error reached the caller in.
 *
 * `command` is what rules out `git config --global`. That writes `~/.gitconfig`,
 * which the namespace binds read-only only if the user listed it in
 * `denyWrite` — a different remedy, and pointing this note at the repository's
 * git dir for it would send the model after the wrong file.
 */
export function withGitConfigReadOnlyNotice(
  text: string,
  output: string,
  sandboxed: boolean,
  command = '',
  gitDirReadOnly?: boolean,
  os: NodeJS.Platform = platform(),
): string {
  if (!sandboxed) return text;

  const isConfigFileFailure = /could not (?:write|lock) config file/.test(output);
  if (isConfigFileFailure) {
    if (writesAGlobalConfig(command)) return text;
    return gitDirReadOnly ? withReadOnlyGitDirNote(text) : withLegacyGitConfigNote(text);
  }

  if (gitDirReadOnly) {
    // bubblewrap's read-only binds fail with EROFS. Seatbelt's denies fail with
    // EPERM, which is also what every other refused path there reports — the
    // unreadable home directory, a file outside the workspace — so an EPERM line
    // counts only where Seatbelt is the backend, and only when it names a `.git`
    // path.
    const dotGit = /(?:^|[/\s'"`])\.git(?=[/\\s'":`]|[\r\n]|$)/;
    const lines = output.split('\n');
    const linesWithRo = lines.filter((line) => /\bRead-only file system\b/i.test(line));
    const runsGit = /(?:^|[;&|(\s])git\b/.test(command);
    const hasDotGitSegment = linesWithRo.some((line) => dotGit.test(line));
    const seatbeltGitDenial =
      sandboxBackendFor(os) === 'seatbelt' &&
      lines.some((line) => /\bOperation not permitted\b/i.test(line) && dotGit.test(line));
    const roFailure =
      (linesWithRo.length > 0 && (runsGit || hasDotGitSegment)) || seatbeltGitDenial;

    if (roFailure) {
      return withReadOnlyGitDirNote(text);
    }
  }

  return text;
}

function withLegacyGitConfigNote(text: string): string {
  return (
    `${text}\n` +
    'Note: .git/config is read-only inside the sandbox, so git cannot update repository ' +
    'configuration there. Run this command outside the sandbox.'
  );
}

function withReadOnlyGitDirNote(text: string): string {
  return (
    `${text}\n` +
    "Note: the repository's git directory is read-only inside the sandbox " +
    '(sandbox.filesystem.allowGitWrites is off), so git cannot write to it here. Do not retry the ' +
    'command or change sandbox settings yourself; tell the user it has to run outside the sandbox: ' +
    'they can run it, or allow it in their own ~/.book/settings.json, where ' +
    'sandbox.excludedCommands runs matching commands unsandboxed while ' +
    'sandbox.allowUnsandboxedCommands is true and sandbox.filesystem.allowGitWrites lets sandboxed ' +
    'git write again; workspace settings cannot enable either.'
  );
}

/** Whether a `git config` invocation targets the user's or the system's config. */
function writesAGlobalConfig(command: string): boolean {
  return /(?:^|[;&|(\s])git\s+[^|;&]*\bconfig\b[^|;&]*\s--(?:global|system)\b/.test(command);
}

/** The one-line policy summary both backends share after their own first part. */
function describePolicy(settings: ResolvedSettings['sandbox'], unbindable: string[]): string[] {
  return [
    settings.filesystem.allowGitWrites
      ? 'git directories writable (hooks, config and pointer files read-only)'
      : 'git directories read-only',
    `${settings.filesystem.allowWrite.length} extra writable path(s)`,
    `${settings.filesystem.denyWrite.length} read-only path(s)`,
    `${settings.filesystem.denyRead.length} masked path(s)`,
    unbindable.length > 0 ? `${unbindable.length} skipped (missing)` : 'all paths resolved',
  ];
}

/** Warn once about declared policy the backend cannot apply as written. */
function warnUnenforceablePolicy(settings: ResolvedSettings['sandbox'], backend: string): string[] {
  if (hasDomainPolicy(settings)) {
    console.warn(
      `⚠  sandbox.network domain rules cannot be enforced by ${backend}, which has no per-domain filtering. Network access is disabled entirely for sandboxed commands.`,
    );
  }
  const unbindable = unbindablePaths(settings);
  if (unbindable.length > 0) {
    console.warn(
      `⚠  sandbox.filesystem rules skipped — nothing exists at: ${unbindable.join(', ')}. These paths are not protected.`,
    );
  }
  return unbindable;
}

/**
 * Which of a command's notices this sandbox has not shown yet. The check runs on
 * every command, as an entry can stop qualifying during a session, and the model
 * reads the notices each time in the output; the user needs each one only once.
 */
function unseenNoticesFilter(): (notices: readonly string[]) => readonly string[] {
  const shown = new Set<string>();
  return (notices) => {
    const unseen = notices.filter((notice) => !shown.has(notice));
    for (const notice of unseen) shown.add(notice);
    return unseen;
  };
}

/**
 * The macOS sandbox: `sandbox-exec` with a Seatbelt profile generated per
 * command from the same resolved policy the bubblewrap argv is built from.
 * A missing `sandbox-exec` follows `failIfUnavailable` exactly as a missing
 * `bwrap` does; a profile `sandbox-exec` rejects fails the command without
 * running it, never falls back to running it unsandboxed.
 */
function createSeatbeltSandbox(settings: ResolvedSettings['sandbox']): Sandbox | null {
  const sandboxExec = detectSandboxExec();
  if (!sandboxExec) {
    if (settings.failIfUnavailable) {
      throw new Error(
        `sandbox-exec (Seatbelt) not found at ${SANDBOX_EXEC_PATH}. It ships with macOS; restore it to enable bash sandboxing, or set failIfUnavailable to false.`,
      );
    }
    console.warn(
      `⚠  sandbox-exec (Seatbelt) not found at ${SANDBOX_EXEC_PATH}. Commands will run unsandboxed.`,
    );
    return null;
  }
  const unbindable = warnUnenforceablePolicy(settings, 'sandbox-exec (Seatbelt)');
  const bookHome = resolveBookHome();
  const tempRoots = seatbeltTempRoots(realSandboxHost);
  return {
    wrap(command, workspaceRoot, protectedPaths): CommandExecution {
      return buildSeatbeltExecution(
        sandboxExec,
        command,
        workspaceRoot,
        settings,
        realSandboxHost,
        protectedPaths,
        tempRoots,
        bookHome,
      );
    },
    unseenNotices: unseenNoticesFilter(),
    describe(): string {
      return [
        `Seatbelt (${sandboxExec})`,
        hasDomainPolicy(settings)
          ? 'network disabled'
          : 'host network shared (unix sockets outside the workspace refused)',
        `home directory unreadable; host temp directories writable (${tempRoots.join(', ')})`,
        ...describePolicy(settings, unbindable),
      ].join('; ');
    },
  };
}

/**
 * Create the sandbox wrapper for this platform: Seatbelt (`sandbox-exec`) on
 * macOS, bubblewrap elsewhere. On Windows, returns null with a warning (sandbox
 * not supported).
 *
 * @param settings - Resolved sandbox settings
 * @returns Sandbox instance or null
 */
export function createSandbox(settings: ResolvedSettings['sandbox']): Sandbox | null {
  if (!settings.enabled) return null;

  const os = platform();
  if (os === 'darwin') return createSeatbeltSandbox(settings);
  if (os === 'win32') {
    if (settings.failIfUnavailable) {
      throw new Error(
        'Bash sandbox is not available on Windows. Disable sandbox.enabled or set failIfUnavailable to false.',
      );
    }
    console.warn('⚠  Bash sandbox is not available on Windows. Commands will run unsandboxed.');
    return null;
  }

  const bwrap = detectBwrap();
  if (!bwrap) {
    if (settings.failIfUnavailable) {
      throw new Error(
        'bubblewrap (bwrap) not found. Install it to enable bash sandboxing, or set failIfUnavailable to false.',
      );
    }
    console.warn(
      '⚠  bubblewrap (bwrap) not found — install it for bash sandboxing. Commands will run unsandboxed.',
    );
    return null;
  }

  // Diagnostics belong to whoever builds the sandbox, and callers are expected
  // to build it once per session — `createSandbox` runs per Bash call would
  // repeat these on every command.
  const unbindable = warnUnenforceablePolicy(settings, 'bubblewrap');

  return {
    wrap(
      command: string,
      workspaceRoot: string,
      protectedPaths?: ProtectedWorkspacePaths,
    ): CommandExecution {
      return buildSandboxExecution(
        bwrap,
        command,
        workspaceRoot,
        settings,
        realSandboxHost,
        protectedPaths,
      );
    },
    unseenNotices: unseenNoticesFilter(),
    describe(): string {
      return [
        `bubblewrap (${bwrap})`,
        hasDomainPolicy(settings) ? 'network disabled' : 'host network shared',
        ...describePolicy(settings, unbindable),
      ].join('; ');
    },
  };
}
