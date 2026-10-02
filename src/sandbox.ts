import { accessSync, constants, existsSync, readFileSync, statSync } from 'fs';
import { delimiter, isAbsolute, join, relative, resolve } from 'path';
import { homedir, platform } from 'os';
import type { ResolvedSettings } from './settings.js';
import { resolveWorkspacePath } from './tools/path-utils.js';
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
 * The refusal shown when `sandbox.allowUnsandboxedCommands` is false and a
 * command would otherwise have run outside the sandbox. It names the setting
 * that caused the refusal and the specific reason the command could not be
 * sandboxed, because "permission denied" with neither is unactionable.
 */
export function unsandboxedRefusalMessage(reason: SandboxSkipReason): string {
  return [
    'Refused to run this command outside the sandbox:',
    `${SKIP_REASON_DETAIL[reason]}.`,
    'sandbox.allowUnsandboxedCommands is false, so unsandboxed commands are not permitted.',
    `${SKIP_REASON_REMEDY[reason]}, or set sandbox.allowUnsandboxedCommands to true to allow this command to run unsandboxed.`,
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
  path: {
    resolve(...segments: string[]): string;
    join(...segments: string[]): string;
    relative(from: string, to: string): string;
    isAbsolute(path: string): boolean;
  };
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  /** File contents, or null when the file is missing or unreadable. */
  readFile(path: string): string | null;
  homedir(): string;
}

const realSandboxHost: SandboxHost = {
  path: { resolve, join, relative, isAbsolute },
  exists: existsSync,
  isDirectory: (path) => statSync(path).isDirectory(),
  readFile: (path) => {
    try {
      return readFileSync(path, 'utf-8');
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
 * True when `gitDir` resolves to the workspace root or something below it.
 *
 * A git dir outside the root is not bound writable — it is not bound at all —
 * so there is nothing to protect there, and mounting it would hand the command
 * a view of a repository the user never opened.
 */
function insideWorkspace(gitDir: string, workspaceRoot: string, host: SandboxHost): boolean {
  const relativePath = host.path.relative(
    host.path.resolve(workspaceRoot),
    host.path.resolve(gitDir),
  );
  return (
    relativePath === '' || (!relativePath.startsWith('..') && !host.path.isAbsolute(relativePath))
  );
}

/**
 * The git directories a workspace's `.git` names, in the order they apply.
 *
 * `.git` is usually the directory itself, but a worktree or submodule carries a
 * one-line `.git` file (`gitdir: <path>`; relative to the workspace when it is
 * not absolute), and that directory can itself name a `commondir` — the shared
 * part of the repository, where `hooks/` and `config` actually live for a
 * linked worktree.
 *
 * Only directories inside the workspace are returned; see `insideWorkspace`.
 */
function workspaceGitDirs(workspaceRoot: string, host: SandboxHost): string[] {
  const dotGit = host.path.join(workspaceRoot, '.git');
  if (!host.exists(dotGit)) return [];
  const dirs: string[] = [];
  const add = (candidate: string): void => {
    const resolved = host.path.resolve(candidate);
    if (dirs.includes(resolved) || !host.exists(resolved)) return;
    if (!insideWorkspace(resolved, workspaceRoot, host)) return;
    dirs.push(resolved);
  };
  if (host.isDirectory(dotGit)) {
    add(dotGit);
  } else {
    const target = /^gitdir:\s*(.+)$/m.exec(host.readFile(dotGit) ?? '')?.[1]?.trim();
    if (!target) return [];
    add(host.path.isAbsolute(target) ? target : host.path.join(workspaceRoot, target));
  }
  // A linked worktree's own dir holds only `config.worktree` and `HEAD`; the
  // hooks and the shared config live in the common dir it names.
  for (const dir of [...dirs]) {
    const common = host.readFile(host.path.join(dir, 'commondir'))?.trim();
    if (common) add(host.path.isAbsolute(common) ? common : host.path.join(dir, common));
  }
  return dirs;
}

/**
 * One workspace path the namespace must expose read-only.
 *
 * A `present` path is bound read-only. An absent one is masked with an empty
 * read-only tmpfs, which both hides any contents the host grows there later and
 * makes creating it fail — the only way to protect something that does not
 * exist yet.
 */
interface ReadOnlyMount {
  path: string;
  present: boolean;
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
 */
export function readOnlyWorkspacePaths(
  workspaceRoot: string,
  host: SandboxHost = realSandboxHost,
): ReadOnlyMount[] {
  const mounts: ReadOnlyMount[] = [];
  const add = (path: string): void => {
    if (mounts.some((mount) => mount.path === path)) return;
    mounts.push({ path, present: host.exists(path) });
  };
  // The settings directory, which holds both workspace layers plus the trust
  // store writes and `migrations.json`.
  add(host.path.join(workspaceRoot, '.book'));
  for (const gitDir of workspaceGitDirs(workspaceRoot, host)) {
    add(host.path.join(gitDir, 'hooks'));
    // Existing files only, unlike `hooks/` above: `--tmpfs` over a file path
    // aborts the whole invocation with "Not a directory", so an absent config
    // cannot be masked at all. `git init` writes `.git/config`, so the corner
    // this leaves open is a repository with no repository-local config.
    for (const name of ['config', 'config.worktree']) {
      const path = host.path.join(gitDir, name);
      if (host.exists(path)) add(path);
    }
  }
  return mounts;
}

function mountReadOnly(args: string[], mount: ReadOnlyMount, host: SandboxHost): void {
  const target = host.path.resolve(mount.path);
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
 * workspace": their read-only mounts come after the workspace bind *and* after
 * the `allowWrite` binds, so an extra writable root cannot reopen them, and
 * before `denyWrite`/`denyRead`, which stay free to be stricter still.
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
  for (const path of settings.filesystem.allowWrite) bindIfPresent(args, '--bind', path, host);
  // Control files the host acts on after this command exits come last among the
  // writable-covering mounts: after the workspace bind, so the workspace does
  // not shadow them, and after `allowWrite`, so an extra writable root cannot
  // reopen them.
  for (const mount of readOnlyWorkspacePaths(workspaceRoot, host)) mountReadOnly(args, mount, host);
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
  const sandbox = ctx.runtime ? ctx.runtime.sandbox(ctx.sandbox) : createSandbox(ctx.sandbox);
  const exec = sandbox?.wrap(command, ctx.workspaceRoot);
  if (exec) return { sandboxed: true, exec };
  if (ctx.sandbox.failIfUnavailable) {
    return { sandboxed: false, error: 'Sandbox unavailable and failIfUnavailable is set' };
  }
  return unsandboxed('unavailable');
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
