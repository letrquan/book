import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from './config.js';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let workspace: string;
const origEnv = { ...process.env };

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-config-test-'));
  mkdirSync(join(workspace, '.book'), { recursive: true });
  // Clear all BOOK_* env vars for clean test state.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('BOOK_')) delete process.env[key];
  }
  // Set required API key.
  process.env.BOOK_API_KEY = 'test-key';
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  // Restore env.
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('BOOK_')) delete process.env[key];
  }
  for (const key of Object.keys(origEnv)) {
    if (key.startsWith('BOOK_')) process.env[key] = origEnv[key];
  }
});

describe('loadConfig retry defaults', () => {
  it('loads default retry config (10 attempts, 600s timeout)', () => {
    const config = loadConfig(workspace, { noSettings: true });
    expect(config.retry.maxAttempts).toBe(10);
    expect(config.retry.requestTimeoutMs).toBe(600000);
    expect(config.retry.streamStallTimeoutMs).toBe(20000);
    expect(config.retry.toolRetries).toBe(1);
    expect(config.retry.watchdog).toBe(false);
    expect(config.retry.baseDelayMs).toBe(1000);
    expect(config.retry.maxDelayMs).toBe(30000);
    expect(config.retry.totalBudgetMs).toBe(0);
  });
});

describe('loadConfig retry — env var overrides', () => {
  it('overrides retry.maxAttempts from BOOK_RETRY_MAX_ATTEMPTS', () => {
    process.env.BOOK_RETRY_MAX_ATTEMPTS = '5';
    const config = loadConfig(workspace, { noSettings: true });
    expect(config.retry.maxAttempts).toBe(5);
  });

  it('overrides retry.baseDelayMs from BOOK_RETRY_BASE_DELAY_MS', () => {
    process.env.BOOK_RETRY_BASE_DELAY_MS = '500';
    const config = loadConfig(workspace, { noSettings: true });
    expect(config.retry.baseDelayMs).toBe(500);
  });

  it('overrides retry.requestTimeoutMs from BOOK_REQUEST_TIMEOUT_MS', () => {
    process.env.BOOK_REQUEST_TIMEOUT_MS = '30000';
    const config = loadConfig(workspace, { noSettings: true });
    expect(config.retry.requestTimeoutMs).toBe(30000);
  });

  it('enables watchdog mode via BOOK_RETRY_WATCHDOG=1', () => {
    process.env.BOOK_RETRY_WATCHDOG = '1';
    const config = loadConfig(workspace, { noSettings: true });
    expect(config.retry.watchdog).toBe(true);
  });

  it('clamps maxAttempts to valid range (0-15)', () => {
    process.env.BOOK_RETRY_MAX_ATTEMPTS = '999';
    const config = loadConfig(workspace, { noSettings: true });
    expect(config.retry.maxAttempts).toBe(15); // clamped to max 15
  });

  it('clamps requestTimeoutMs to min 5000', () => {
    process.env.BOOK_REQUEST_TIMEOUT_MS = '100';
    const config = loadConfig(workspace, { noSettings: true });
    expect(config.retry.requestTimeoutMs).toBe(5000);
  });

  it('overrides toolRetries from BOOK_TOOL_RETRIES', () => {
    process.env.BOOK_TOOL_RETRIES = '3';
    const config = loadConfig(workspace, { noSettings: true });
    expect(config.retry.toolRetries).toBe(3);
  });
});

describe('loadConfig retry — settings.json', () => {
  it('loads retry settings from settings.json', () => {
    writeFileSync(
      join(workspace, '.book', 'settings.json'),
      JSON.stringify({
        retry: {
          maxAttempts: 5,
          baseDelayMs: 500,
          requestTimeoutMs: 120000,
          watchdog: true,
        },
      }),
    );

    const config = loadConfig(workspace);
    expect(config.retry.maxAttempts).toBe(5);
    expect(config.retry.baseDelayMs).toBe(500);
    expect(config.retry.requestTimeoutMs).toBe(120000);
    expect(config.retry.watchdog).toBe(true);
  });
});
