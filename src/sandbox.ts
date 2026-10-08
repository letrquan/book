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
 * sandboxed, and what to do about it.
 *
 * The settings location is attached to the *alternative* rather than to every
 * reason, because it is only part of that alternative: `allowUnsandboxedCommands`
 * and `excludedCommands` are loader-ignored in a workspace file, so "set it
 * there" is the instruction for them. A missing `bwrap` is fixed by installing
 * bubblewrap, and telling a user to edit `~/.book/settings.json` about it sends
 * them to look for a package name that is not in the file.
 */
export function unsandboxedRefusalMessage(reason: SandboxSkipReason): string {
  const remedy =
    reason === 'unavailable'
      ? 'Install bubblewrap (bwrap) to enable sandboxing.'
      : `${SKIP_REASON_REMEDY[reason]} ${SANDBOX_SETTINGS_LOCATION}, or set ` +
        'sandbox.allowUnsandboxedCommands to true there to allow this command to run unsandboxed.';
  return [
    'Refused to run this command outside the sandbox:',
    `${SKIP_REASON_DETAIL[reason]}.`,
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
  if (isOutside(root, resolved, host.path) || !rel || rel.startsWith('..')) return [];
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
  const found: GitDirRef[] = [];
  const pointerPaths: string[] = [];
  const add = (candidate: string, workTree: string): void => {
    const dir = host.path.resolve(candidate);
    if (found.some((entry) => entry.dir === dir)) return;
    if (!host.isDirectory(dir) || !insideWorkspace(dir, root, host)) return;
    found.push({ dir, workTree: host.path.resolve(workTree) });
  };
  const dotGit = host.path.join(root, '.git');
  if (!host.exists(dotGit)) return { gitDirs: found, pointerPaths };
  if (host.isDirectory(dotGit)) {
    add(dotGit, root);
  } else {
    const target = /^gitdir:\s*(.+)$/m.exec(host.readFile(dotGit) ?? '')?.[1]?.trim();
    if (!target) return { gitDirs: found, pointerPaths };
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
      if (workTreeGitdir) {
        const resolvedGitdir = host.path.isAbsolute(workTreeGitdir)
          ? workTreeGitdir
          : host.path.join(linked, workTreeGitdir);
        pointerPaths.push(resolvedGitdir);
      }
      add(linked, workTreeGitdir ? host.path.dirname(workTreeGitdir) : root);
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
  return { gitDirs: found, pointerPaths };
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
export type ControlPathRefusalReason = 'symlinked-control-path' | 'oversized-git-config';

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
      if (!result.refusals.some((entry) => entry.path === resolved)) {
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

  const { gitDirs, pointerPaths } = workspaceGitDirs(root, host);
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

  // Config files already read, so an `include` chain that names one of them ends
  // at the file rather than descending for ever.
  const configsRead = new Set<string>();
  const readConfig = (file: string, workTree: string, depth: number): void => {
    const at = host.path.resolve(file);
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
      const target = included.startsWith('~/')
        ? host.path.join(host.homedir(), included.slice(2))
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
    const workTreePointer = host.path.join(gitDir.workTree, '.git');
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

  for (const mount of result.mounts) {
    if (mount.kind === 'hidden-file') {
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

  // For every git dir the walk returns, and every path a pointer file names,
  // look at each path component strictly below the workspace root. A component
  // that is a symlink is safe only if the symlink itself lives inside a present
  // read-only directory mount. Otherwise push a symlinked-control-path refusal.
  const pointerCandidates = [...gitDirs.map((g) => g.dir), ...pointerPaths];
  const checkedComponents = new Set<string>();
  for (const cand of pointerCandidates) {
    for (const comp of workspaceComponents(cand, root, host)) {
      if (checkedComponents.has(comp)) continue;
      checkedComponents.add(comp);
      if (host.entryKind(comp) === 'symlink') {
        const parentCanonical = canonicalPath(host.path.dirname(comp), host);
        const symlinkLivePath = host.path.join(parentCanonical, host.path.basename(comp));
        const isSafe = presentReadOnlyDirs.some(
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
  const protectedPaths = protectedWorkspacePaths(workspaceRoot, host, {
    allowGitWrites: settings.filesystem.allowGitWrites,
  });
  const isProtectedArea = (path: string): boolean => {
    const canonical = canonicalPath(expandPath(path, host), host);
    return protectedPaths.mounts.some(
      (mount) => !isOutside(canonicalPath(mount.path, host), canonical, host.path),
    );
  };

  // Control files the host acts on after this command exits come after the
  // workspace bind, so the workspace does not shadow them.
  //
  // The pins come before the opt-in binds as well: a pin is a writable self-bind
  // of the git dir, so an `allowWrite` entry *under* it emitted earlier is
  // shadowed by it and silently does nothing — the entry the user wrote, dropped
  // without a word. In the read-only git-dirs mode there is no pin: the git dir
  // is a protected mount, so an `allowWrite` entry naming it reopens what it names,
  // while control paths strictly below it (hooks, config, pointer files) stay
  // read-only unless an entry names them directly.
  for (const dir of protectedPaths.pinnedDirectories) {
    args.push('--bind', host.path.resolve(dir), host.path.resolve(dir));
  }
  for (const path of settings.filesystem.allowWrite) {
    if (isProtectedArea(path)) continue;
    bindIfPresent(args, '--bind', path, host);
  }
  for (const mount of protectedPaths.mounts) mountProtected(args, mount, host);
  // ...and only now the opt-ins for the protected areas themselves.
  const deferredOptInCanonicals: string[] = [];
  for (const path of settings.filesystem.allowWrite) {
    if (!isProtectedArea(path)) continue;
    const target = expandPath(path, host);
    if (host.exists(target)) {
      args.push('--bind', target, target);
      deferredOptInCanonicals.push(canonicalPath(target, host));
    }
  }

  // An allowWrite opt-in on a git dir reopens what it names, but not the control
  // paths strictly below it (hooks, config, pointer files). Emit each of those
  // control mounts whose canonical path is strictly below a deferred opt-in entry,
  // unless an entry exactly at that control path reopens it.
  for (const mount of protectedPaths.gitDirControlMounts) {
    const mountCanonical = canonicalPath(mount.path, host);
    const strictlyBelowDeferredOptIn = deferredOptInCanonicals.some(
      (optIn) => !isOutside(optIn, mountCanonical, host.path) && optIn !== mountCanonical,
    );
    const explicitlyOptedIn = deferredOptInCanonicals.includes(mountCanonical);
    if (strictlyBelowDeferredOptIn && !explicitlyOptedIn) {
      mountProtected(args, mount, host);
    }
  }

  // A mask hides a file's *contents*, and an opt-in bind for the directory that
  // holds it undoes that: `allowWrite: ["<workspace>/.book"]` puts the whole
  // directory back in reach, provider credential included. The masks are
  // therefore emitted again after every opt-in, so the last mount of a masked
  // path is `/dev/null` whichever entry named its parent.
  for (const mount of protectedPaths.mounts) {
    if (mount.kind === 'hidden-file') mountProtected(args, mount, host);
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
  if (sandbox) {
    const refusal = protectedWorkspacePaths(ctx.workspaceRoot, realSandboxHost, {
      allowGitWrites: ctx.sandbox.filesystem.allowGitWrites,
    }).refusals[0];
    if (refusal) return { sandboxed: false, error: describeControlPathRefusal(refusal) };
  }
  const exec = sandbox?.wrap(command, ctx.workspaceRoot);
  if (exec) {
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
): string {
  if (!sandboxed) return text;
  if (writesAGlobalConfig(command)) return text;

  if (gitDirReadOnly) {
    const gitDirFailure =
      /(?:^|\n)(?=[^\n]*\.git\/)(?=[^\n]*\bRead-only file system\b)/i.test(output) ||
      /unable to create temporary file: Read-only file system/i.test(output) ||
      /could not (?:write|lock) config file/.test(output);

    if (gitDirFailure) {
      return withReadOnlyGitDirNote(text);
    }
    return text;
  }

  if (!/could not (?:write|lock) config file/.test(output)) return text;
  return withLegacyGitConfigNote(text);
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
    'git write again; workspace settings cannot change either.'
  );
}

/** Whether a `git config` invocation targets the user's or the system's config. */
function writesAGlobalConfig(command: string): boolean {
  return /^\s*(?:\S+\s+)*git\s+config\b[^|;&]*\s--(?:global|system)\b/.test(command);
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
        settings.filesystem.allowGitWrites
          ? 'git directories writable (hooks, config and pointer files read-only)'
          : 'git directories read-only',
        `${settings.filesystem.allowWrite.length} extra writable path(s)`,
        `${settings.filesystem.denyWrite.length} read-only path(s)`,
        `${settings.filesystem.denyRead.length} masked path(s)`,
        unbindable.length > 0 ? `${unbindable.length} skipped (missing)` : 'all paths resolved',
      ].join('; ');
    },
  };
}
