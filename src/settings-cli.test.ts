import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SETTINGS_TOP_LEVEL_KEYS } from './settings-repository.js';

/**
 * CLI-level smoke tests for --settings and --no-settings flags.
 * Runs the source CLI through tsx and reads settings through `book config`,
 * keeping the contract offline and independent of the agent runtime.
 */
function isolatedEnv() {
  const env = { ...process.env };
  delete env.BOOK_API_KEY;
  delete env.BOOK_BASE_URL;
  delete env.BOOK_MODEL;
  delete env.BOOK_PROVIDER;
  delete env.BOOK_HOME;
  return { ...env, HOME: dir, USERPROFILE: dir };
}

function runCli(args: string[]): string {
  return execFileSync(process.execPath, ['--import', 'tsx', 'src/index.ts', ...args], {
    env: isolatedEnv(),
    encoding: 'utf8',
    timeout: 15_000,
  });
}

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('CLI --settings flag', () => {
  it('lists the same schema-backed settings keys as the TUI config help', () => {
    dir = mkdtempSync(join(tmpdir(), 'book-cli-'));
    const stdout = runCli(['config', '--help']);

    expect(stdout).toContain('Supported top-level settings:');
    for (const key of SETTINGS_TOP_LEVEL_KEYS) expect(stdout).toContain(`  ${key}`);
  }, 20000);

  it('reports the ad-hoc model over the project model', () => {
    dir = mkdtempSync(join(tmpdir(), 'book-cli-'));
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
    dir = mkdtempSync(join(tmpdir(), 'book-cli-'));
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
    dir = mkdtempSync(join(tmpdir(), 'book-cli-'));
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/index.ts',
        'config',
        '--workspace',
        dir,
        'set',
        'harness.mode',
        'shadow',
      ],
      {
        env: isolatedEnv(),
        encoding: 'utf8',
        timeout: 15_000,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Harness mode "shadow"');
    expect(existsSync(join(dir, '.book'))).toBe(false);
  }, 20000);

  it('persists a workflow selection when the mode is enabled in another scope', () => {
    // `book config set` validates one document, where `harness.mode` falls back
    // to its schema default. It must not reject a workflow because the mode
    // lives in a different settings layer.
    dir = mkdtempSync(join(tmpdir(), 'book-cli-'));
    const env = isolatedEnv();
    // User-global scope: isolatedEnv points HOME/USERPROFILE at `dir`.
    mkdirSync(join(dir, '.book'), { recursive: true });
    writeFileSync(
      join(dir, '.book', 'settings.json'),
      JSON.stringify({ harness: { mode: 'observe' } }),
    );
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/index.ts',
        'config',
        '--workspace',
        dir,
        'set',
        'harness.workflow',
        'safe-edit',
      ],
      { env, encoding: 'utf8', timeout: 15_000 },
    );

    expect(result.stderr).not.toContain('requires an enabled harness mode');
    expect(result.status).toBe(0);
  }, 20000);

  it('refuses to persist an unknown workflow id', () => {
    dir = mkdtempSync(join(tmpdir(), 'book-cli-'));
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/index.ts',
        'config',
        '--workspace',
        dir,
        'set',
        'harness',
        JSON.stringify({ mode: 'observe', workflow: 'not-a-workflow' }),
      ],
      { env: isolatedEnv(), encoding: 'utf8', timeout: 15_000 },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown harness workflow "not-a-workflow"');
  }, 20000);
});

describe('subcommand --workspace targeting', () => {
  // The root command and every subcommand both declare -w/--workspace. Without
  // positional option parsing, commander routes a -w that follows a subcommand
  // to the root, silently leaving the subcommand on its process.cwd() default.
  // These assert the flag has an *effect*, not merely that the CLI exits 0 —
  // the earlier tests passed throughout the regression because they only
  // checked the exit status.
  it('reads settings from the workspace the flag names', () => {
    dir = mkdtempSync(join(tmpdir(), 'book-cli-'));
    mkdirSync(join(dir, '.book'), { recursive: true });
    writeFileSync(
      join(dir, '.book', 'settings.json'),
      JSON.stringify({ model: 'flagged-workspace-model' }),
    );

    expect(runCli(['config', '--workspace', dir, 'get', 'model'])).toContain(
      'flagged-workspace-model',
    );
    // The flag must work on either side of the positional arguments.
    expect(runCli(['config', 'get', 'model', '--workspace', dir])).toContain(
      'flagged-workspace-model',
    );
  }, 20000);

  it('writes into the named workspace and not the current directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'book-cli-'));
    mkdirSync(join(dir, '.book'), { recursive: true });
    writeFileSync(
      join(dir, '.book', 'settings.json'),
      JSON.stringify({ harness: { mode: 'observe' } }),
    );

    const cwdLocalSettings = join(process.cwd(), '.book', 'settings.local.json');
    const existedBefore = existsSync(cwdLocalSettings);

    runCli(['config', '--workspace', dir, 'set', 'harness.workflow', 'safe-edit']);

    expect(existsSync(join(dir, '.book', 'settings.local.json'))).toBe(true);
    // Running the suite must never write real settings into the repository.
    if (!existedBefore) expect(existsSync(cwdLocalSettings)).toBe(false);
  }, 20000);
});
