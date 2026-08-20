import { accessSync, constants, existsSync, statSync } from 'fs';
import { delimiter, join, resolve } from 'path';
import { homedir, platform } from 'os';
import type { ResolvedSettings } from './settings.js';
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
 * are directories, and the path semantics used to resolve configured entries.
 *
 * Injectable so the generated argv can be pinned by tests on any platform.
 * The unit suite runs on Windows CI, where probing the real filesystem finds
 * none of the POSIX system mounts (`resolve('/usr')` lands on `C:\usr`), so a
 * test against the real host would be asserting on binds that were never
 * emitted. Production always uses the real host below.
 */
export interface SandboxHost {
  /** Path semantics for configured entries; tests inject path.win32/path.posix. */
  path: { resolve(...segments: string[]): string; join(...segments: string[]): string };
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  homedir(): string;
}

const realSandboxHost: SandboxHost = {
  path: { resolve, join },
  exists: existsSync,
  isDirectory: (path) => statSync(path).isDirectory(),
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
 * Build the bubblewrap argument vector for one command.
 *
 * Mount order is significant: bwrap applies operations in sequence and a later
 * mount shadows an earlier one covering the same path. The workspace bind
 * therefore comes *after* the system read-only binds and the /tmp tmpfs (a
 * workspace under /usr/local or /tmp would otherwise be silently shadowed), and
 * explicit filesystem policy comes after the workspace so it can override it.
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
