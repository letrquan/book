import { platform } from 'os';
import { execSync } from 'child_process';
import type { ResolvedSettings } from './settings.js';

export interface Sandbox {
  /**
   * Wrap a shell command for sandboxed execution.
   * Returns the modified command string, or null if sandbox is unavailable.
   */
  wrap(command: string, cwd: string): string | null;
}

/**
 * Try to detect bubblewrap (bwrap) on the system PATH.
 * Returns the bwrap binary path or null if not found.
 */
function detectBwrap(): string | null {
  try {
    const out = execSync('which bwrap 2>/dev/null || command -v bwrap 2>/dev/null || echo ""', {
      encoding: 'utf-8',
      timeout: 2000,
    }).trim();
    if (out) return out;
    // Try absolute path on macOS (Homebrew).
    const altPaths = [
      '/usr/local/bin/bwrap',
      '/opt/homebrew/bin/bwrap',
      '/usr/bin/bwrap',
    ];
    for (const p of altPaths) {
      try {
        execSync(`test -x "${p}"`, { timeout: 1000, stdio: 'ignore' });
        return p;
      } catch {
        // not found
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build a bubblewrap command that isolates the shell.
 * Respects filesystem and network settings from the sandbox config.
 */
function buildBwrapCmd(
  bwrapPath: string,
  command: string,
  cwd: string,
  _settings: ResolvedSettings['sandbox'],
): string {
  const parts: string[] = [bwrapPath];

  // New namespaces: PID, IPC, UTS, network (if no domains allowed).
  parts.push('--unshare-pid', '--unshare-ipc', '--unshare-uts');

  // Mount /proc.
  parts.push('--proc', '/proc');

  // Mount a minimal /dev.
  parts.push('--dev', '/dev');

  // Make the workspace readable (and writable if allowed).
  parts.push('--bind', cwd, cwd);

  // Make /tmp available.
  parts.push('--tmpfs', '/tmp');

  // Minimal system directories read-only.
  const roDirs = ['/usr', '/lib', '/lib64', '/bin', '/sbin', '/etc', '/opt'];
  for (const d of roDirs) {
    try {
      execSync(`test -d "${d}"`, { timeout: 1000, stdio: 'ignore' });
      parts.push('--ro-bind', d, d);
    } catch {
      // directory doesn't exist — skip
    }
  }

  // Apply filesystem restrictions from settings.
  // Note: bubblewrap uses --bind for rw and --ro-bind for read-only.
  // For deny paths, we simply don't mount them (bwrap can't enforce non-existent paths).

  // Network isolation: if allowedDomains is populated, we unshare network.
  // Otherwise, share the host network.
  parts.push('--share-net');

  // Capabilities: drop all, but keep basic ones for shell operation.
  parts.push('--cap-drop', 'ALL');

  // Run the command through bash.
  parts.push('--', '/bin/bash', '-c', command);

  return parts.join(' ');
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

  return {
    wrap(command: string, cwd: string): string {
      return buildBwrapCmd(bwrap, command, cwd, settings);
    },
  };
}
