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
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { homedir, platform } from 'os';
import type { ResolvedSettings } from './settings.js';
import { isOutside, resolveWorkspacePath, type PathComparison } from './tools/path-utils.js';
import type { CommandExecution } from './types/runtime.js';
import { globToRegex } from './tools/glob-regex.js';

export interface Sandbox {
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
  wrap(command: string, workspaceRoot: string): CommandExecution | null;
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
  /** True only when this exact command will execute inside a bubblewrap namespace. */
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
 * Is the bubblewrap backend usable on this machine at all? Independent of
 * settings, so callers can distinguish "turned off" from "cannot be turned on".
 */
export function sandboxBackendAvailable(): boolean {
  return platform() !== 'win32' && detectBwrap() !== null;
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
 * sandboxed, and where such a setting takes effect — because "permission denied"
 * with none of that is unactionable, and the one place a user reaches for first
 * is a file the loader will not read it from.
 */
export function unsandboxedRefusalMessage(reason: SandboxSkipReason): string {
  return [
    'Refused to run this command outside the sandbox:',
    `${SKIP_REASON_DETAIL[reason]}.`,
    'sandbox.allowUnsandboxedCommands is false, so unsandboxed commands are not permitted.',
    `${SKIP_REASON_REMEDY[reason]} ${SANDBOX_SETTINGS_LOCATION}, or set sandbox.allowUnsandboxedCommands to true there to allow this command to run unsandboxed.`,
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
): { unsandboxedCommands: string; autoAllowBash: string } {
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
  };
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  /** File contents, or null when the file is missing or unreadable. */
  readFile(path: string): string | null;
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
 * carry one line — a `gitdir:` pointer, a `commondir`, a `[core]` stanza — and
 * a workspace that can make the host read anything at all can make it read
 * gigabytes, so the read is bounded rather than the file trusted to be small.
 */
const MAX_CONTROL_FILE_BYTES = 4096;

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
  path: { resolve, join, relative, isAbsolute, sep, dirname },
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
  readFile: (path) => {
    // `lstat` first, and only a regular file. An unguarded readFileSync blocks
    // for ever on a FIFO (a workspace that plants one at `.git` would hang
    // every later sandboxed command) and never ends on a character device such
    // as `/dev/zero`.
    if (entryKind(path) !== 'file') return null;
    let fd: number | undefined;
    try {
      fd = openSync(path, 'r');
      const buffer = Buffer.alloc(MAX_CONTROL_FILE_BYTES);
      const bytes = readSync(fd, buffer, 0, MAX_CONTROL_FILE_BYTES, 0);
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
function workspaceGitDirs(workspaceRoot: string, host: SandboxHost): GitDirRef[] {
  const root = host.path.resolve(workspaceRoot);
  const found: GitDirRef[] = [];
  const add = (candidate: string, workTree: string): void => {
    const dir = host.path.resolve(candidate);
    if (found.some((entry) => entry.dir === dir)) return;
    if (!host.isDirectory(dir) || !insideWorkspace(dir, root, host)) return;
    found.push({ dir, workTree: host.path.resolve(workTree) });
  };
  const dotGit = host.path.join(root, '.git');
  if (!host.exists(dotGit)) return found;
  if (host.isDirectory(dotGit)) {
    add(dotGit, root);
  } else {
    const target = /^gitdir:\s*(.+)$/m.exec(host.readFile(dotGit) ?? '')?.[1]?.trim();
    if (!target) return found;
    add(host.path.isAbsolute(target) ? target : host.path.join(root, target), root);
  }
  // A linked worktree's own dir holds only `config.worktree`, `HEAD` and the
  // `gitdir` naming its work tree; the hooks and the shared config live in the
  // common dir.
  for (let index = 0; index < found.length; index++) {
    const { dir, workTree } = found[index];
    const common = host.readFile(host.path.join(dir, 'commondir'))?.trim();
    if (common) add(host.path.isAbsolute(common) ? common : host.path.join(dir, common), workTree);
    for (const name of host.readDir(host.path.join(dir, 'worktrees'))) {
      const linked = host.path.join(dir, 'worktrees', name);
      // `gitdir` inside a linked worktree's dir names the work tree's own
      // `.git` file, so its directory is the work tree root — what a relative
      // `core.hooksPath` in that worktree's config is resolved against.
      const workTreeGitdir = host.readFile(host.path.join(linked, 'gitdir'))?.trim();
      add(linked, workTreeGitdir ? host.path.dirname(workTreeGitdir) : root);
    }
    for (const module of host.readDir(host.path.join(dir, 'modules'))) {
      const moduleDir = host.path.join(dir, 'modules', module);
      // git names a module directory after the submodule's path in the work
      // tree, so the work tree root it serves is the workspace plus that path.
      add(
        moduleDir,
        host.path.join(root, host.path.relative(host.path.join(dir, 'modules'), moduleDir)),
      );
    }
  }
  return found;
}

/**
 * `core.hooksPath` as a git config file states it, or undefined.
 *
 * A deliberately small `[core]` parser rather than a git-config dependency: the
 * key is the one setting that moves `hooks/` out of the git dir, and it is read
 * from a file a workspace can rewrite. Subsection names are excluded, because
 * `[core "x"]` is not `[core]`, and a quoted value is unquoted, because a
 * `hooksPath` git would never use is not worth protecting.
 */
export function readCoreHooksPath(configText: string): string | undefined {
  let inCore = false;
  for (const line of configText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const section = trimmed.slice(1, -1).trim().toLowerCase();
      inCore = section === 'core' || section.startsWith('core ');
      continue;
    }
    if (!inCore) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    if (trimmed.slice(0, separator).trim().toLowerCase() !== 'hookspath') continue;
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^"(.*)"$/, '$1');
    return value || undefined;
  }
  return undefined;
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
  /** Already resolved through a symlink: the path the host reads the control file at. */
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
   */
  pinnedDirectories: string[];
  mounts: ProtectedMount[];
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
 * What this cannot cover is stated in the docs rather than implied here: a
 * sandboxed command can still *create* a pointer file a plain repository has
 * none of (`.git/commondir`), because closing that needs the whole git
 * directory read-only, which would make sandboxed `git commit`, `checkout` and
 * `fetch` fail.
 */
export function protectedWorkspacePaths(
  workspaceRoot: string,
  host: SandboxHost = realSandboxHost,
): ProtectedWorkspacePaths {
  const root = host.path.resolve(workspaceRoot);
  const result: ProtectedWorkspacePaths = { pinnedDirectories: [], mounts: [] };
  const seen = new Set<string>();

  /**
   * The path a control file is really read through, following a symlink once.
   *
   * `.book` and `.bookrc.json` are files a repository can ship as symlinks, and
   * bubblewrap aborts the whole invocation on either shape: `--tmpfs` cannot
   * mkdir through a dangling link, and a link to a directory is "Can't bind
   * mount". A clone could therefore break *every* sandboxed command in the
   * workspace. So a symlinked control path is resolved — relative to its own
   * directory, then canonicalised — and it is the target that gets protected,
   * because that is the path the host reads through the link. A target outside
   * the workspace is not bound writable and so is nothing to protect; one
   * inside it that does not exist yet is masked as a directory, which is the
   * shape the host would be reading. Anything that is neither a regular file
   * nor a directory — a FIFO, a socket, a device — is skipped.
   */
  const target = (path: string, kind: ProtectedMountKind): ProtectedMount | null => {
    const resolved = host.path.resolve(path);
    if (seen.has(resolved)) return null;
    const describe = (at: string, present: boolean): ProtectedMount => {
      seen.add(at);
      return { path: at, kind, present };
    };
    const first = host.entryKind(resolved);
    if (first === null) {
      // Absent: only a directory has a mask, and only a directory needs one —
      // an absent file has nothing to protect and nothing to create that git or
      // the settings resolver would read as one.
      return kind === 'directory' ? describe(resolved, false) : null;
    }
    if (first === 'directory' || first === 'file') return describe(resolved, true);
    if (first !== 'symlink') return null;
    const link = host.linkTarget(resolved);
    if (link === null) return null;
    const linked = canonicalPath(
      host.path.isAbsolute(link) ? link : host.path.join(host.path.dirname(resolved), link),
      host,
    );
    if (!insideWorkspace(linked, root, host)) return null;
    const second = host.entryKind(linked);
    if (second === null) return kind === 'directory' ? describe(linked, false) : null;
    if (second !== 'directory' && second !== 'file') return null;
    return describe(linked, true);
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
  if (host.isDirectory(dotGit)) {
    // The git dir is bound onto itself, writable, so it is a mount point: the
    // read-only children below can then be swapped for a fresh writable
    // directory only by renaming this one away, which EBUSY refuses.
    result.pinnedDirectories.push(dotGit);
  } else {
    // A worktree's `.git` is a file naming its git dir. Read-only, so the
    // pointer itself cannot be rewritten at another git directory.
    addFile(dotGit);
  }

  for (const gitDir of workspaceGitDirs(root, host)) {
    if (!result.pinnedDirectories.includes(gitDir.dir)) result.pinnedDirectories.push(gitDir.dir);
    addDirectory(host.path.join(gitDir.dir, 'hooks'));
    for (const name of ['config', 'config.worktree', 'commondir', 'gitdir']) {
      addFile(host.path.join(gitDir.dir, name));
    }
    // `core.hooksPath` moves the hook directory out of the git dir entirely —
    // husky v9 points it at `.husky/_` — so a config this namespace leaves
    // writable is a hooks directory it never looked at.
    for (const name of ['config', 'config.worktree']) {
      const text = host.readFile(host.path.join(gitDir.dir, name));
      const hooksPath = text === null ? undefined : readCoreHooksPath(text);
      if (!hooksPath) continue;
      const directory = host.path.isAbsolute(hooksPath)
        ? hooksPath
        : host.path.join(gitDir.workTree, hooksPath);
      if (insideWorkspace(directory, root, host)) addDirectory(directory);
    }
  }

  return result;
}

function mountProtected(args: string[], mount: ProtectedMount, host: SandboxHost): void {
  const target = host.path.resolve(mount.path);
  if (mount.kind === 'hidden-file') {
    if (mount.present) args.push('--ro-bind', '/dev/null', target);
    return;
  }
  if (mount.kind === 'file') {
    if (mount.present) args.push('--ro-bind', target, target);
    return;
  }
  if (mount.present) {
    args.push('--ro-bind', target, target);
    return;
  }
  // `--tmpfs` creates the mount point, and bwrap does that *through* the
  // workspace bind: a sandboxed command in a workspace with no `.book/` leaves
  // an empty `.book/` directory on the host as a side effect. It is recorded in
  // docs/guide/configuration.md; the alternative would be a writable hole.
  args.push('--tmpfs', target, '--remount-ro', target);
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
 * so it cannot reopen what the protections just closed.
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
  for (const dir of ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc', '/opt']) {
    bindIfPresent(args, '--ro-bind', dir, host);
  }

  args.push('--tmpfs', '/tmp');

  // The workspace is writable. Bound after /tmp so a workspace inside /tmp
  // (every mkdtemp-based test run, among others) survives the tmpfs.
  bindIfPresent(args, '--bind', workspaceRoot, host);

  // Declared filesystem policy overrides the defaults above.
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
  const protectedPaths = protectedWorkspacePaths(workspaceRoot, host);
  const isProtectedArea = (path: string): boolean => {
    const canonical = canonicalPath(expandPath(path, host), host);
    return protectedPaths.mounts.some(
      (mount) => !isOutside(canonicalPath(mount.path, host), canonical, host.path),
    );
  };
  for (const path of settings.filesystem.allowWrite) {
    if (isProtectedArea(path)) continue;
    bindIfPresent(args, '--bind', path, host);
  }

  // Control files the host acts on after this command exits come after the
  // workspace bind, so the workspace does not shadow them.
  for (const dir of protectedPaths.pinnedDirectories) {
    args.push('--bind', host.path.resolve(dir), host.path.resolve(dir));
  }
  for (const mount of protectedPaths.mounts) mountProtected(args, mount, host);
  // ...and only now the opt-ins for the protected areas themselves.
  for (const path of settings.filesystem.allowWrite) {
    if (!isProtectedArea(path)) continue;
    bindIfPresent(args, '--bind', path, host);
  }

  for (const path of settings.filesystem.denyWrite) bindIfPresent(args, '--ro-bind', path, host);
  // bwrap cannot unmount a subpath, so a denied path is masked instead. The
  // mask has to match the kind: --tmpfs needs to mkdir its target, so pointing
  // it at a file aborts the entire invocation with "Not a directory" — and a
  // credentials *file* is the most natural thing to deny. Files are masked with
  // /dev/null instead, which makes reads fail outright.
  for (const path of settings.filesystem.denyRead) {
    const target = expandPath(path, host);
    if (!host.exists(target)) continue;
    if (host.isDirectory(target)) args.push('--tmpfs', target);
    else args.push('--ro-bind', '/dev/null', target);
  }

  // bwrap can only share or unshare the network wholesale. A declared
  // per-domain policy cannot be enforced as written, so fail closed rather
  // than hand out the unrestricted host network the caller did not ask for.
  args.push(hasDomainPolicy(settings) ? '--unshare-net' : '--share-net');

  args.push('--cap-drop', 'ALL');

  // The command string is a single argv element: bash inside the sandbox
  // parses it, and nothing outside the sandbox ever does.
  args.push('--', '/bin/bash', '-c', command);

  return { file: bwrapPath, args };
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
 * 3. otherwise wrap it, and report the wrapped argv.
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
  const exec = sandbox?.wrap(command, ctx.workspaceRoot);
  if (exec) return { sandboxed: true, exec };
  if (ctx.sandbox.failIfUnavailable) {
    return { sandboxed: false, error: 'Sandbox unavailable and failIfUnavailable is set' };
  }
  return unsandboxed('unavailable');
}

/**
 * The line a git command needs when it could not update the repository config.
 *
 * Inside the sandbox a git dir's `config` is bound read-only (#373), which is
 * what stops a sandboxed command from repointing `core.hooksPath` at a script it
 * plants. It is also why `git checkout -b`, `git push -u`, `git remote add`,
 * `git branch --set-upstream-to` and `git config` fail there with
 * "could not write config file" / "could not lock config file" — an error that
 * says nothing about the read-only bind, so the model retries the same command
 * or rewrites the command to avoid the config instead of running it outside.
 *
 * Returned as a line the caller appends to the output that carried the error,
 * and only for a sandboxed command: unsandboxed git has no read-only config, and
 * an unrelated file that happens to be called `config` is not this.
 */
export function withGitConfigReadOnlyNotice(
  text: string,
  output: string,
  sandboxed: boolean,
): string {
  if (!sandboxed || !/could not (?:write|lock) config file/.test(output)) return text;
  return (
    `${text}\n` +
    'Note: .git/config is read-only inside the sandbox, so git cannot update repository ' +
    'configuration there. Run this command outside the sandbox.'
  );
}

/**
 * Create a sandbox wrapper if bwrap is available on this platform.
 * On Windows, returns null with a warning (sandbox not supported).
 *
 * @param settings - Resolved sandbox settings
 * @returns Sandbox instance or null
 */
export function createSandbox(settings: ResolvedSettings['sandbox']): Sandbox | null {
  if (!settings.enabled) return null;

  const os = platform();
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
  if (hasDomainPolicy(settings)) {
    console.warn(
      '⚠  sandbox.network domain rules cannot be enforced by bubblewrap, which has no per-domain filtering. Network access is disabled entirely for sandboxed commands.',
    );
  }
  const unbindable = unbindablePaths(settings);
  if (unbindable.length > 0) {
    console.warn(
      `⚠  sandbox.filesystem rules skipped — nothing exists at: ${unbindable.join(', ')}. These paths are not protected.`,
    );
  }

  return {
    wrap(command: string, workspaceRoot: string): CommandExecution {
      return buildSandboxExecution(bwrap, command, workspaceRoot, settings);
    },
    describe(): string {
      return [
        `bubblewrap (${bwrap})`,
        hasDomainPolicy(settings) ? 'network disabled' : 'host network shared',
        `${settings.filesystem.allowWrite.length} extra writable path(s)`,
        `${settings.filesystem.denyWrite.length} read-only path(s)`,
        `${settings.filesystem.denyRead.length} masked path(s)`,
        unbindable.length > 0 ? `${unbindable.length} skipped (missing)` : 'all paths resolved',
      ].join('; ');
    },
  };
}
