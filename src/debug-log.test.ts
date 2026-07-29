import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'fs';
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

  it('rotates bounded debug logs before appending more output', async () => {
    const logPath = join(tempDir(), 'bounded-debug.log');
    vi.stubEnv('BOOK_DEBUG', '1');
    vi.stubEnv('BOOK_DEBUG_FILE', logPath);
    vi.stubEnv('BOOK_DEBUG_MAX_BYTES', '120');
    vi.stubEnv('BOOK_DEBUG_BACKUPS', '2');
    setStderrIsTTY(true);

    const { createDebugLogger } = await import('./debug-log.js');
    const logger = createDebugLogger('rotation');
    logger.debug('a'.repeat(80));
    logger.debug('b'.repeat(80));

    expect(existsSync(`${logPath}.1`)).toBe(true);
    expect(readFileSync(`${logPath}.1`, 'utf8')).toContain('a'.repeat(80));
    expect(readFileSync(logPath, 'utf8')).toContain('b'.repeat(80));
  });

  it('batches noisy render diagnostics off the current render turn', async () => {
    const logPath = join(tempDir(), 'render-debug.log');
    vi.stubEnv('BOOK_DEBUG_RENDER', '1');
    vi.stubEnv('BOOK_DEBUG_FILE', logPath);
    setStderrIsTTY(true);

    const { createRenderDebugLogger } = await import('./debug-log.js');
    const logger = createRenderDebugLogger('render-test');
    logger.event('render', { count: 1 });
    logger.event('render', { count: 2 });

    expect(existsSync(logPath)).toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const output = readFileSync(logPath, 'utf8');
    expect(output).toContain('count=1');
    expect(output).toContain('count=2');
  });

  it('keeps render-log rotation bounded when one flush contains many lines', async () => {
    const logPath = join(tempDir(), 'render-bounded.log');
    vi.stubEnv('BOOK_DEBUG_RENDER', '1');
    vi.stubEnv('BOOK_DEBUG_FILE', logPath);
    vi.stubEnv('BOOK_DEBUG_MAX_BYTES', '120');
    vi.stubEnv('BOOK_DEBUG_BACKUPS', '2');
    setStderrIsTTY(true);

    const { createRenderDebugLogger } = await import('./debug-log.js');
    const logger = createRenderDebugLogger('render-rotation');
    for (let index = 0; index < 8; index++) logger.event('render', { index });

    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(statSync(logPath).size).toBeLessThanOrEqual(120);
    expect(existsSync(`${logPath}.1`)).toBe(true);
  });

  it('splits one oversized render event before writing it', async () => {
    const logPath = join(tempDir(), 'render-oversized.log');
    vi.stubEnv('BOOK_DEBUG_RENDER', '1');
    vi.stubEnv('BOOK_DEBUG_FILE', logPath);
    vi.stubEnv('BOOK_DEBUG_MAX_BYTES', '32');
    setStderrIsTTY(true);

    const { createRenderDebugLogger } = await import('./debug-log.js');
    createRenderDebugLogger('render-oversized').event('render', { payload: 'x'.repeat(200) });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(statSync(logPath).size).toBeLessThanOrEqual(32);
  });

  it('keeps astral Unicode characters intact across oversized chunks', async () => {
    const logPath = join(tempDir(), 'render-unicode.log');
    vi.stubEnv('BOOK_DEBUG_RENDER', '1');
    vi.stubEnv('BOOK_DEBUG_FILE', logPath);
    vi.stubEnv('BOOK_DEBUG_MAX_BYTES', '32');
    vi.stubEnv('BOOK_DEBUG_BACKUPS', '20');
    setStderrIsTTY(true);

    const { createRenderDebugLogger } = await import('./debug-log.js');
    createRenderDebugLogger('render-unicode').event('render', { payload: '🙂'.repeat(80) });
    await new Promise<void>((resolve) => setImmediate(resolve));

    const files = [logPath, ...Array.from({ length: 20 }, (_, index) => `${logPath}.${index + 1}`)];
    const output = files
      .filter((path) => existsSync(path))
      .map((path) => readFileSync(path, 'utf8'))
      .join('');
    expect(output).not.toContain('\uFFFD');
    expect(output).toContain('🙂');
  });

  it('clears expired rotated logs while preserving the active log', async () => {
    const logPath = join(tempDir(), 'debug.log');
    writeFileSync(logPath, 'active');
    writeFileSync(`${logPath}.1`, 'expired');
    writeFileSync(`${logPath}.2`, 'fresh');
    const now = Date.now();
    utimesSync(`${logPath}.1`, new Date(now - 40 * 86_400_000), new Date(now - 40 * 86_400_000));

    const { cleanupDebugLogs } = await import('./debug-log.js');

    expect(cleanupDebugLogs(30, logPath, now)).toBe(1);
    expect(existsSync(logPath)).toBe(true);
    expect(existsSync(`${logPath}.1`)).toBe(false);
    expect(existsSync(`${logPath}.2`)).toBe(true);
  });

  it('cleans the resolved BOOK_DEBUG_FILE target without scanning the default workspace path', async () => {
    const workspace = tempDir();
    const customDirectory = tempDir();
    const customLog = join(customDirectory, 'custom-debug.log');
    const unrelatedLog = join(workspace, '.book', 'debug.log');
    mkdirSync(join(workspace, '.book'), { recursive: true });
    writeFileSync(`${customLog}.1`, 'expired custom log');
    writeFileSync(`${unrelatedLog}.1`, 'unrelated default log', { flag: 'w' });
    const now = Date.now();
    const expiredAt = new Date(now - 40 * 86_400_000);
    utimesSync(`${customLog}.1`, expiredAt, expiredAt);
    utimesSync(`${unrelatedLog}.1`, expiredAt, expiredAt);
    vi.stubEnv('BOOK_DEBUG_FILE', customLog);
    vi.stubEnv('BOOK_WORKSPACE', workspace);

    const { cleanupDebugLogs } = await import('./debug-log.js');

    expect(cleanupDebugLogs(30, undefined, now)).toBe(1);
    expect(existsSync(`${customLog}.1`)).toBe(false);
    expect(existsSync(`${unrelatedLog}.1`)).toBe(true);
  });
});
