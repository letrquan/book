import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runDoctorCommand } from './doctor.js';
import { runConfigCommand } from './config-cmd.js';
import { runMcpListCommand } from './mcp.js';
import { runToolStatsCommand } from './tool-stats.js';
import { setExitFn } from './exit.js';

/**
 * Contract: a non-interactive subcommand must run without credentials.
 *
 * These commands exist to help a user whose credentials are missing, wrong, or
 * unresolved. Requiring a working provider to run them makes them useless in the
 * exact situation they were built for. `book doctor` regressed on this once: it
 * called the throwing `loadConfig` and died with an unhandled stack trace on the
 * missing key it was about to report two dozen lines later.
 *
 * Interactive and agent-running surfaces are deliberately out of scope - they
 * cannot do their job without a provider, so they may demand one.
 */

let workspace: string;
let bookHome: string;
const previousEnv: Record<string, string | undefined> = {};

/** Run one subcommand, capturing output and refusing any attempt to exit. */
async function runQuietly(run: () => void | Promise<void>): Promise<void> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  setExitFn((code: number): never => {
    throw new Error(`subcommand exited with code ${code}`);
  });
  try {
    await run();
  } finally {
    setExitFn((code: number): never => process.exit(code));
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  }
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-subcommand-ws-'));
  bookHome = mkdtempSync(join(tmpdir(), 'book-subcommand-home-'));
  for (const key of ['BOOK_HOME', 'BOOK_API_KEY', 'BOOK_BASE_URL', 'BOOK_MODEL']) {
    previousEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.BOOK_HOME = bookHome;
});

afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(workspace, { recursive: true, force: true });
  rmSync(bookHome, { recursive: true, force: true });
});

describe('non-interactive subcommands without credentials', () => {
  // Each entry is a subcommand a user can reach before a provider works.
  // Adding a credential-free subcommand to the CLI means adding it here.
  const subcommands: Array<[string, () => void | Promise<void>]> = [
    ['book doctor', () => runDoctorCommand(workspace)],
    ['book config list', () => runConfigCommand(workspace, 'list', undefined, undefined)],
    ['book config get model', () => runConfigCommand(workspace, 'get', 'model', undefined)],
    ['book mcp list', () => runMcpListCommand({ workspace, home: bookHome })],
    ['book tool-stats', () => runToolStatsCommand({ workspace })],
  ];

  for (const [name, run] of subcommands) {
    it(`${name} completes with no API key configured`, async () => {
      expect(process.env.BOOK_API_KEY).toBeUndefined();
      await expect(runQuietly(run)).resolves.toBeUndefined();
    });
  }
});
