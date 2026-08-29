import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runDoctorCommand } from './doctor.js';
import { runConfigCommand } from './config-cmd.js';
import { runMcpListCommand } from './mcp.js';
import { runToolStatsCommand } from './tool-stats.js';
import { runStatusCommand } from './status-cmd.js';
import { runTrustCommand } from './trust-cmd.js';
import { runAuthLogoutCommand, runAuthStatusCommand } from './auth-cmd.js';
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
    // Reading what a long run is doing and what it has spent is exactly what
    // someone needs when the provider is misconfigured.
    ['book status', () => void runStatusCommand({ workspace })],
    // Approving a project hook is part of getting a broken workspace working,
    // so it must not be gated behind the provider it may be needed to fix.
    // Subscription auth is exactly the thing a user without a working key comes
    // here to set up, so reading and clearing it must not require one.
    ['book auth status', () => runAuthStatusCommand({ workspace, home: bookHome })],
    [
      'book auth logout --all',
      () => runAuthLogoutCommand(undefined, { workspace, home: bookHome, all: true }),
    ],
    [
      'book trust hook --all-pending',
      () =>
        runTrustCommand('hook', undefined, {
          workspace,
          allPending: true,
        }),
    ],
  ];

  for (const [name, run] of subcommands) {
    it(`${name} completes with no API key configured`, async () => {
      expect(process.env.BOOK_API_KEY).toBeUndefined();
      await expect(runQuietly(run)).resolves.toBeUndefined();
    });
  }
});

/**
 * Contract: doctor reports a configuration that will not load, rather than
 * dying on it.
 *
 * allowMissingApiKey covers only the missing-credential rejection. Every other
 * one - malformed JSON, a schema violation, an unknown harness workflow - used
 * to escape loadConfig as an unhandled stack trace, which is the least useful
 * possible response from the command whose job is diagnosing a broken setup.
 */
describe('book doctor with an unloadable configuration', () => {
  function writeProjectSettings(contents: string): void {
    mkdirSync(join(workspace, '.book'), { recursive: true });
    writeFileSync(join(workspace, '.book', 'settings.json'), contents);
  }

  const broken: Array<[string, string]> = [
    ['malformed JSON', '{ "model": '],
    ['a schema violation', JSON.stringify({ permissions: { allow: 'not-an-array' } })],
    ['an unknown harness workflow', JSON.stringify({ harness: { workflow: 'not-a-workflow' } })],
  ];

  for (const [label, contents] of broken) {
    it(`reports ${label} instead of throwing`, async () => {
      writeProjectSettings(contents);
      const lines: string[] = [];
      const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
      try {
        await expect(runDoctorCommand(workspace)).resolves.toBeUndefined();
      } finally {
        log.mockRestore();
      }
      const output = lines.join('\n');
      expect(output).toContain('Book Doctor');
      expect(output).toContain('Configuration: FAILED TO LOAD');
      // The offending file is named, so the report is actionable.
      expect(output).toContain(join(workspace, '.book', 'settings.json'));
    });
  }
});
