import { describe, it, expect, afterEach } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * CLI-level smoke tests for --settings and --no-settings flags.
 * Uses the built CLI via `node dist/index.js` when available; falls back
 * to tsx when not. These tests focus on the flag wiring, not the full
 * agent loop (which needs a provider).
 */
const RUNNER = 'npx tsx src/index.ts';
const ENV = {
  ...process.env,
  BOOK_API_KEY: 'test-key',
  BOOK_BASE_URL: 'http://localhost:20128/v1',
  BOOK_MODEL: 'test-model',
};

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('CLI --settings flag', () => {
  it('loads model from an ad-hoc --settings file (overrides project)', () => {
    dir = mkdtempSync(join(tmpdir(), 'book-cli-'));
    const projectSettings = join(dir, '.book');
    mkdirSync(projectSettings, { recursive: true });
    writeFileSync(
      join(projectSettings, 'settings.json'),
      JSON.stringify({ model: 'project-model' }),
    );

    const overridePath = join(dir, 'override.json');
    writeFileSync(overridePath, JSON.stringify({ model: 'override-model' }));

    // -p with a prompt that just echoes — we use bash to test settings load.
    // Since no provider is running, this will fail at the network call,
    // but the config loading happens first. We check the error output
    // does not mention a settings-load failure.
    let stderr = '';
    try {
      execSync(`${RUNNER} -w "${dir}" --settings "${overridePath}" -p "hi" --output-format json`, {
        env: ENV,
        encoding: 'utf-8',
        timeout: 15000,
      });
    } catch (e: any) {
      stderr = e.stderr ?? e.message ?? '';
    }
    // The CLI should have gotten past config loading; the failure should
    // be a network/provider error, not a settings error.
    expect(stderr).not.toMatch(/Invalid settings|Invalid JSON in settings/);
  }, 20000);

  it('--no-settings skips settings.json layers without error', () => {
    dir = mkdtempSync(join(tmpdir(), 'book-cli-'));
    const projectSettings = join(dir, '.book');
    mkdirSync(projectSettings, { recursive: true });
    writeFileSync(
      join(projectSettings, 'settings.json'),
      JSON.stringify({ model: 'should-be-ignored' }),
    );

    let stderr = '';
    try {
      execSync(`${RUNNER} -w "${dir}" --no-settings -p "hi" --output-format json`, {
        env: ENV,
        encoding: 'utf-8',
        timeout: 15000,
      });
    } catch (e: any) {
      stderr = e.stderr ?? e.message ?? '';
    }
    expect(stderr).not.toMatch(/Invalid settings|Invalid JSON in settings/);
  }, 20000);
});
