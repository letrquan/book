import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { SETTINGS_TOP_LEVEL_KEYS } from './settings-repository.js';

/**
 * CLI-level smoke tests for --settings and --no-settings flags.
 * Runs the source CLI through tsx and reads settings through `book config`,
 * keeping the contract offline and independent of the agent runtime.
 */

// Absolute, because the child runs from a scratch directory rather than from
// this checkout. A CLI bug that drops --workspace falls back to the child's own
// cwd, so running there is what keeps a stray `book config set` out of the
// repository - an assertion made after the write cannot prevent it.
const CLI_ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));
const TSX_LOADER = import.meta.resolve('tsx');

function isolatedEnv() {
  const env = { ...process.env };
  delete env.BOOK_API_KEY;
  delete env.BOOK_BASE_URL;
  delete env.BOOK_MODEL;
  delete env.BOOK_PROVIDER;
  delete env.BOOK_HOME;
  return { ...env, HOME: dir, USERPROFILE: dir };
}

function cliArgs(args: string[]): string[] {
  return ['--import', TSX_LOADER, CLI_ENTRY, ...args];
}

function childOptions() {
  return { env: isolatedEnv(), cwd: scratch, encoding: 'utf8' as const, timeout: 15_000 };
}

function runCli(args: string[]): string {
  return execFileSync(process.execPath, cliArgs(args), childOptions());
}

/** Fake HOME and the parent of any workspace a test names. */
let dir: string;
/** The child's cwd: a directory no test asks the CLI to act on. */
let scratch: string;

function newTempDirs(): void {
  dir = mkdtempSync(join(tmpdir(), 'book-cli-'));
  scratch = mkdtempSync(join(tmpdir(), 'book-cli-cwd-'));
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('CLI --settings flag', () => {
  it('lists the same schema-backed settings keys as the TUI config help', () => {
    newTempDirs();
    const stdout = runCli(['config', '--help']);

    expect(stdout).toContain('Supported top-level settings:');
    for (const key of SETTINGS_TOP_LEVEL_KEYS) expect(stdout).toContain(`  ${key}`);
  }, 20000);

  it('reports the ad-hoc model over the project model', () => {
    newTempDirs();
    const projectSettings = join(dir, '.book');
    mkdirSync(projectSettings, { recursive: true });
    writeFileSync(
      join(projectSettings, 'settings.json'),
      JSON.stringify({ model: 'project-model' }),
    );

    const overridePath = join(dir, 'override.json');
    writeFileSync(overridePath, JSON.stringify({ model: 'override-model' }));

    const stdout = runCli([
      '--settings',
      overridePath,
      'config',
      '--workspace',
      dir,
      'get',
      'model',
    ]);

    expect(stdout.trim()).toBe('"override-model"');
  }, 20000);

  it('--no-settings reports defaults instead of the project model', () => {
    newTempDirs();
    const projectSettings = join(dir, '.book');
    mkdirSync(projectSettings, { recursive: true });
    writeFileSync(
      join(projectSettings, 'settings.json'),
      JSON.stringify({ model: 'should-be-ignored' }),
    );

    const stdout = runCli(['--no-settings', 'config', '--workspace', dir, 'get', 'model']);

    expect(stdout.trim()).toBe('Key model is not set (no value).');
  }, 20000);

  it('rejects an unavailable harness mode without creating project storage', () => {
    newTempDirs();
    const result = spawnSync(
      process.execPath,
      cliArgs(['config', '--workspace', dir, 'set', 'harness.mode', 'shadow']),
      childOptions(),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Harness mode "shadow"');
    expect(existsSync(join(dir, '.book'))).toBe(false);
  }, 20000);

  it('persists a workflow selection when the mode is enabled in another scope', () => {
    // `book config set` validates one document, where `harness.mode` falls back
    // to its schema default. It must not reject a workflow because the mode
    // lives in a different settings layer.
    newTempDirs();
    const env = isolatedEnv();
    // User-global scope: isolatedEnv points HOME/USERPROFILE at `dir`.
    mkdirSync(join(dir, '.book'), { recursive: true });
    writeFileSync(
      join(dir, '.book', 'settings.json'),
      JSON.stringify({ harness: { mode: 'observe' } }),
    );
    const result = spawnSync(
      process.execPath,
      cliArgs(['config', '--workspace', dir, 'set', 'harness.workflow', 'safe-edit']),
      { ...childOptions(), env },
    );

    expect(result.stderr).not.toContain('requires an enabled harness mode');
    expect(result.status).toBe(0);
  }, 20000);

  it('refuses to persist an unknown workflow id', () => {
    newTempDirs();
    const result = spawnSync(
      process.execPath,
      cliArgs([
        'config',
        '--workspace',
        dir,
        'set',
        'harness',
        JSON.stringify({ mode: 'observe', workflow: 'not-a-workflow' }),
      ]),
      childOptions(),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown harness workflow "not-a-workflow"');
  }, 20000);
});

describe('subcommand --workspace targeting', () => {
  // The root command and every subcommand declare -w/--workspace, and positional
  // option parsing hands each placement to a different command object: `book -w X
  // sub` is parsed by the root, `book sub -w X` by the subcommand. Both must name
  // the same directory. These assert the flag has an *effect*, not merely that the
  // CLI exits 0 - the earlier tests passed throughout the regression because they
  // only checked the exit status.
  //
  // Every marker below lives in a workspace directory distinct from the fake HOME.
  // Writing it to `dir` itself would make the test pass even if the flag were
  // ignored entirely, because isolatedEnv points HOME at `dir`, so the user-global
  // layer resolves to the very file --workspace names.
  function workspaceWith(settings: unknown): string {
    const ws = join(dir, 'workspace');
    mkdirSync(join(ws, '.book'), { recursive: true });
    writeFileSync(join(ws, '.book', 'settings.json'), JSON.stringify(settings));
    return ws;
  }

  it('reads settings from the workspace the flag names, in every placement', () => {
    newTempDirs();
    const ws = workspaceWith({ model: 'flagged-workspace-model' });

    // Between the subcommand name and its positional arguments.
    expect(runCli(['config', '--workspace', ws, 'get', 'model'])).toContain(
      'flagged-workspace-model',
    );
    // After the positional arguments.
    expect(runCli(['config', 'get', 'model', '--workspace', ws])).toContain(
      'flagged-workspace-model',
    );
    // Before the subcommand name, where the root command parses it.
    expect(runCli(['--workspace', ws, 'config', 'get', 'model'])).toContain(
      'flagged-workspace-model',
    );
  }, 40000);

  it('does not reach the workspace model without the flag', () => {
    // The discriminator for the three assertions above: without it they would
    // still pass if some other layer happened to supply the same value.
    newTempDirs();
    workspaceWith({ model: 'flagged-workspace-model' });

    expect(runCli(['config', 'get', 'model'])).not.toContain('flagged-workspace-model');
  }, 20000);

  it('writes into the named workspace, in every placement', () => {
    newTempDirs();
    const subcommandSide = workspaceWith({ harness: { mode: 'observe' } });
    runCli(['config', '--workspace', subcommandSide, 'set', 'harness.workflow', 'safe-edit']);
    expect(existsSync(join(subcommandSide, '.book', 'settings.local.json'))).toBe(true);

    const rootSide = join(dir, 'root-side');
    mkdirSync(join(rootSide, '.book'), { recursive: true });
    writeFileSync(
      join(rootSide, '.book', 'settings.json'),
      JSON.stringify({ harness: { mode: 'observe' } }),
    );
    runCli(['--workspace', rootSide, 'config', 'set', 'harness.workflow', 'safe-edit']);
    expect(existsSync(join(rootSide, '.book', 'settings.local.json'))).toBe(true);

    // The child ran from `scratch`, so a placement the CLI silently dropped
    // writes there. Asserting on the scratch directory fails on every machine;
    // the previous check compared against the repository's own .book/ and
    // skipped itself whenever a developer had the local settings file that
    // scope exists for - inert on exactly the machines that needed it.
    expect(existsSync(join(scratch, '.book'))).toBe(false);
  }, 40000);
});

describe('root options after a subcommand name', () => {
  // enablePositionalOptions() makes a root option written after the subcommand
  // name an error, so any root option a subcommand's action reads has to be
  // re-declared on that subcommand. `config` reads --settings/--no-settings.
  it('accepts --settings on either side of the config subcommand', () => {
    newTempDirs();
    const ws = join(dir, 'workspace');
    mkdirSync(join(ws, '.book'), { recursive: true });
    writeFileSync(join(ws, '.book', 'settings.json'), JSON.stringify({ model: 'project-model' }));

    const overridePath = join(dir, 'override.json');
    writeFileSync(overridePath, JSON.stringify({ model: 'override-model' }));

    expect(
      runCli(['--settings', overridePath, 'config', '--workspace', ws, 'get', 'model']).trim(),
    ).toBe('"override-model"');
    expect(
      runCli(['config', '--workspace', ws, 'get', 'model', '--settings', overridePath]).trim(),
    ).toBe('"override-model"');
  }, 40000);

  it('accepts --no-settings on either side of the config subcommand', () => {
    newTempDirs();
    const ws = join(dir, 'workspace');
    mkdirSync(join(ws, '.book'), { recursive: true });
    writeFileSync(
      join(ws, '.book', 'settings.json'),
      JSON.stringify({ model: 'should-be-ignored' }),
    );

    const expected = 'Key model is not set (no value).';
    expect(runCli(['--no-settings', 'config', '--workspace', ws, 'get', 'model']).trim()).toBe(
      expected,
    );
    expect(runCli(['config', '--workspace', ws, 'get', 'model', '--no-settings']).trim()).toBe(
      expected,
    );
  }, 40000);
});
