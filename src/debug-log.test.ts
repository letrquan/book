import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('debug logger output target', () => {
  const ORIGINAL_ENV = { ...process.env };
  const ORIGINAL_STDERR_ISTTY = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
  const tempDirs: string[] = [];

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'book-debug-log-'));
    tempDirs.push(dir);
    return dir;
  }

  function setStderrIsTTY(value: boolean): void {
    Object.defineProperty(process.stderr, 'isTTY', {
      configurable: true,
      value,
    });
  }

  function restoreStderrIsTTY(): void {
    if (ORIGINAL_STDERR_ISTTY) {
      Object.defineProperty(process.stderr, 'isTTY', ORIGINAL_STDERR_ISTTY);
    } else {
      Reflect.deleteProperty(process.stderr, 'isTTY');
    }
  }

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
    restoreStderrIsTTY();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes to a file when stderr is an interactive TTY', async () => {
    const workspace = tempDir();
    vi.stubEnv('BOOK_DEBUG', '1');
    vi.stubEnv('BOOK_WORKSPACE', workspace);
    vi.stubEnv('BOOK_DEBUG_STDERR', '');
    vi.stubEnv('BOOK_DEBUG_FILE', '');
    setStderrIsTTY(true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { createDebugLogger, getDebugLogPath } = await import('./debug-log.js');
    const logPath = join(workspace, '.book', 'debug.log');

    expect(getDebugLogPath()).toBe(logPath);
    createDebugLogger('test').debug('hello');

    expect(readFileSync(logPath, 'utf8')).toContain('[test] [DEBUG] hello');
    expect(stderr).not.toHaveBeenCalled();
  });

  it('keeps stderr behavior for non-TTY output', async () => {
    vi.stubEnv('BOOK_DEBUG', '1');
    setStderrIsTTY(false);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { createDebugLogger, getDebugLogPath } = await import('./debug-log.js');

    expect(getDebugLogPath()).toBeUndefined();
    createDebugLogger('test').info('hello');

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[test] [INFO] hello'));
  });

  it('honors BOOK_DEBUG_FILE over the default log path', async () => {
    const logPath = join(tempDir(), 'custom-debug.log');
    vi.stubEnv('BOOK_DEBUG', '1');
    vi.stubEnv('BOOK_DEBUG_FILE', logPath);
    setStderrIsTTY(true);

    const { createDebugLogger, getDebugLogPath } = await import('./debug-log.js');

    expect(getDebugLogPath()).toBe(logPath);
    createDebugLogger('test').warn('hello');

    expect(readFileSync(logPath, 'utf8')).toContain('[test] [WARN] hello');
  });
});
