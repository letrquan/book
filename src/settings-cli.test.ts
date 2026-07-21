import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

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
});
