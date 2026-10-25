/**
 * The macOS sandbox backend: a Seatbelt (SBPL) profile run by `sandbox-exec`.
 *
 * This module only renders. `sandbox.ts` resolves the policy — the workspace,
 * the protected control paths, the declared `sandbox.filesystem` entries — from
 * the same functions the bubblewrap builder uses, and hands the result here as
 * ordered rules over canonical paths. Nothing here touches the filesystem, so
 * the rendered profile is fully determined by its input on every OS.
 *
 * Two properties carry the security of the profile:
 *
 * - **No path is ever spliced into the profile text.** Each one is passed as a
 *   `-D P<n>=<path>` argument and named in the profile as `(param "P<n>")`, so
 *   a workspace called `ws") (allow file-write* (subpath "/` is a string value,
 *   not SBPL. The only literals in the text are the constants below.
 * - **Rules are ordered, and the last match wins** — with one exception the
 *   renderer relies on: a deny of a *specific* operation (`file-write-unlink`,
 *   `file-write-create`) is not reopened by a later wildcard allow. The pins
 *   use that; every rule a later entry may reopen is written at
 *   `file-read*` / `file-write*` granularity.
 */
import type { CommandExecution } from './types/runtime.js';

/** The system binary; SIP-protected, so a fixed path rather than a PATH search. */
export const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

export type SeatbeltOperation =
  'file-read*' | 'file-write*' | 'file-read-metadata' | 'file-write-unlink' | 'file-write-create';

export interface SeatbeltPathFilter {
  /** `subpath` is the path and everything below it; `literal` is the path alone. */
  match: 'subpath' | 'literal';
  /** An absolute, canonical (symlink-resolved) POSIX path. */
  path: string;
}

export interface SeatbeltRule {
  action: 'allow' | 'deny';
  operations: readonly SeatbeltOperation[];
  filters: readonly SeatbeltPathFilter[];
  /**
   * Narrow every filter to Book's own temporary entries directly below it
   * (`book-rewind-*`, `book-index-*`, `book-config-preflight-*`). Used for the
   * temp roots, which are writable here but private under bubblewrap.
   */
  bookTempEntries?: boolean;
}

export interface SeatbeltPolicy {
  /** File rules, in the order they apply; a later rule overrides an earlier one. */
  rules: readonly SeatbeltRule[];
  /**
   * `host` shares the host network, `none` denies every socket. `none` is what a
   * declared domain policy fails closed to: Seatbelt, like bubblewrap, has no
   * per-domain filtering.
   */
  network: 'host' | 'none';
  /**
   * Under `host`, the directories whose unix-domain sockets a command may connect
   * to. Every other socket path is refused: under bubblewrap a socket outside the
   * bound paths is simply not there, and on macOS the reachable ones include the
   * launchd ssh-agent socket and whatever else the user runs.
   */
  unixSocketRoots: readonly string[];
  /** Socket paths refused again after `unixSocketRoots`, for `denyRead` entries inside them. */
  unixSocketDenied: readonly string[];
}

export interface RenderedSeatbeltProfile {
  profile: string;
  /** `-D` arguments for `sandbox-exec`, in order: `['-D', 'P0=/x', '-D', 'P1=/y', …]`. */
  parameters: string[];
}

/**
 * The prefixes of the temporary entries Book itself creates under `os.tmpdir()`
 * and later trusts: an ephemeral rewind store, a managed agent's scratch index,
 * the settings preflight copy. A sandboxed command that could rewrite one would
 * be writing into what the host does next. A new `mkdtemp` prefix in production
 * code belongs here; `sandbox-seatbelt.test.ts` checks the list against the
 * source.
 */
export const BOOK_TEMP_PREFIXES = ['book-rewind-', 'book-index-', 'book-config-preflight-'];

// The prefixes are constants of this file, letters and `-` only, so they need no
// regex escaping; a test pins that.
const BOOK_TEMP_ENTRY_REGEX = `#"/(${BOOK_TEMP_PREFIXES.join('|')})[^/]*(/|$)"`;

/**
 * Read-only system roots: the macOS spelling of what bubblewrap binds read-only
 * (`/usr /lib /lib64 /bin /sbin /etc /opt`). `/System` and `/Library` hold the
 * frameworks and the dyld cache a process needs to start at all, `/Applications`
 * the Xcode developer directory `/usr/bin/git` resolves through, and
 * `/private/var/select` the shell `/bin/sh` runs. The home directory is
 * deliberately absent: bubblewrap does not mount it, and it holds
 * `~/.book/settings.json`.
 */
export const SEATBELT_SYSTEM_READ_ROOTS = [
  '/usr',
  '/bin',
  '/sbin',
  '/opt',
  '/System',
  '/Library',
  '/Applications',
  '/private/etc',
  '/private/var/db',
  '/private/var/select',
  '/dev',
];

/**
 * The fixed part of the profile: what any process needs to start and run, and
 * nothing that reaches outside it. Process, IPC, IOKit and sysctl rules follow
 * Anthropic's sandbox-runtime (the macOS sandbox Claude Code uses), which has
 * run them on real workloads. Signals and process inspection are limited to the
 * sandbox itself, as a PID namespace limits them under bubblewrap. Mach lookups
 * are a short allowlist: launchd, LaunchServices `open` and Apple Events are
 * all ways to have an unsandboxed process run a command.
 */
const PREAMBLE = [
  '(version 1)',
  '(deny default)',
  '(allow process-exec)',
  '(allow process-fork)',
  '(allow process-info* (target same-sandbox))',
  '(allow signal (target same-sandbox))',
  '(allow mach-priv-task-port (target same-sandbox))',
  '(allow mach-lookup',
  '  (global-name "com.apple.audio.systemsoundserver")',
  '  (global-name "com.apple.distributed_notifications@Uv3")',
  '  (global-name "com.apple.FontObjectsServer")',
  '  (global-name "com.apple.fonts")',
  '  (global-name "com.apple.logd")',
  '  (global-name "com.apple.lsd.mapdb")',
  '  (global-name "com.apple.PowerManagement.control")',
  '  (global-name "com.apple.system.logger")',
  '  (global-name "com.apple.system.notification_center")',
  '  (global-name "com.apple.system.opendirectoryd.libinfo")',
  '  (global-name "com.apple.system.opendirectoryd.membership")',
  '  (global-name "com.apple.bsd.dirhelper")',
  '  (global-name "com.apple.securityd.xpc")',
  '  (global-name "com.apple.SecurityServer")',
  '  (global-name "com.apple.coreservices.launchservicesd"))',
  '(allow ipc-posix-shm)',
  '(allow ipc-posix-sem)',
  '(allow iokit-open',
  '  (iokit-registry-entry-class "IOSurfaceRootUserClient")',
  '  (iokit-registry-entry-class "RootDomainUserClient")',
  '  (iokit-user-client-class "IOSurfaceSendRight"))',
  '(allow iokit-get-properties)',
  '(allow system-socket (require-all (socket-domain AF_SYSTEM) (socket-protocol 2)))',
  '(allow sysctl-read)',
  '(allow sysctl-write (sysctl-name "kern.tcsm_enable"))',
  '(allow distributed-notification-post)',
  '(allow file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random")',
  '  (literal "/dev/urandom") (literal "/dev/dtracehelper") (literal "/dev/tty"))',
  '(allow file-read* (literal "/")',
  ...SEATBELT_SYSTEM_READ_ROOTS.map((root) => `  (subpath "${root}")`),
  // The symlinks a path through them has to be read to resolve.
  '  (literal "/etc") (literal "/tmp") (literal "/var"))',
  // The standard streams and the devices every shell writes to.
  '(allow file-read* file-write* (literal "/dev/null") (literal "/dev/zero")',
  '  (literal "/dev/tty") (literal "/dev/dtracehelper") (literal "/dev/stdin")',
  '  (literal "/dev/stdout") (literal "/dev/stderr") (subpath "/dev/fd"))',
];

/**
 * A path the profile may name. Only an absolute path reaches the profile: a
 * relative one would be matched against nothing, which reads as "protected"
 * while protecting nothing. A NUL cannot be passed as an argument at all.
 * Anything else is legal — it is a parameter value, not SBPL.
 */
function assertProfilePath(path: string): void {
  if (!path.startsWith('/')) {
    throw new Error(`Seatbelt profile path is not absolute: ${JSON.stringify(path)}`);
  }
  if (path.includes('\0')) {
    throw new Error(`Seatbelt profile path contains a NUL byte: ${JSON.stringify(path)}`);
  }
}

/**
 * Render a policy as an SBPL profile plus the `-D` arguments it reads.
 *
 * Identical paths share one parameter, so the argument list stays proportional
 * to the distinct paths rather than to the rules naming them.
 */
export function renderSeatbeltProfile(policy: SeatbeltPolicy): RenderedSeatbeltProfile {
  const names = new Map<string, string>();
  const parameters: string[] = [];
  const param = (path: string): string => {
    assertProfilePath(path);
    let name = names.get(path);
    if (name === undefined) {
      name = `P${names.size}`;
      names.set(path, name);
      parameters.push('-D', `${name}=${path}`);
    }
    return `(param "${name}")`;
  };
  const filter = (entry: SeatbeltPathFilter, bookTempEntries = false): string => {
    const base = `(${entry.match} ${param(entry.path)})`;
    return bookTempEntries ? `(require-all ${base} (regex ${BOOK_TEMP_ENTRY_REGEX}))` : base;
  };

  const lines = [...PREAMBLE];
  for (const rule of policy.rules) {
    if (rule.filters.length === 0) continue;
    const filters = rule.filters.map((entry) => filter(entry, rule.bookTempEntries));
    lines.push(`(${rule.action} ${rule.operations.join(' ')} ${filters.join(' ')})`);
  }

  if (policy.network === 'host') {
    lines.push('(allow network*)');
    lines.push('(deny network-outbound (remote unix-socket (path-regex #"^/")))');
    // DNS: the resolver is a daemon behind this socket, not a UDP packet.
    lines.push(
      '(allow network-outbound (remote unix-socket (literal "/private/var/run/mDNSResponder")))',
    );
    for (const root of policy.unixSocketRoots) {
      lines.push(`(allow network-outbound (remote unix-socket (subpath ${param(root)})))`);
    }
    for (const denied of policy.unixSocketDenied) {
      lines.push(`(deny network-outbound (remote unix-socket (subpath ${param(denied)})))`);
    }
  }

  return { profile: `${lines.join('\n')}\n`, parameters };
}

/**
 * The argv that runs `command` under the profile.
 *
 * The command is one argument to the shell inside the sandbox, exactly as in
 * the bubblewrap argv: nothing outside the sandbox ever parses it.
 *
 * `GIT_CONFIG_GLOBAL=/dev/null` stands in for a home directory that is not
 * there. Under bubblewrap `~/.gitconfig` does not exist and git skips it; here
 * it exists but cannot be read, and git dies on the `EPERM` rather than skipping
 * it — every sandboxed git command would fail. It is set through `env` inside the
 * argv rather than in `CommandExecution.env`, because not every spawn site
 * applies that field.
 */
export function seatbeltExecution(
  sandboxExecPath: string,
  policy: SeatbeltPolicy,
  command: string,
): CommandExecution {
  const { profile, parameters } = renderSeatbeltProfile(policy);
  return {
    file: sandboxExecPath,
    args: [
      ...parameters,
      '-p',
      profile,
      '--',
      '/usr/bin/env',
      'GIT_CONFIG_GLOBAL=/dev/null',
      '/bin/bash',
      '-c',
      command,
    ],
  };
}
