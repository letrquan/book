/**
 * Lightweight debug logger controlled by BOOK_DEBUG=1.
 *
 * Writes timestamped messages to stderr so they don't interfere with
 * Ink's TUI rendering on stdout. All functions are no-ops when
 * BOOK_DEBUG is not set to '1'.
 *
 * Usage:
 *   import { createDebugLogger } from '../debug-log.js';
 *   const log = createDebugLogger('provider');
 *   log.debug('Sending request', { model: 'gpt-4' });
 */

const DEBUG_ENABLED = process.env.BOOK_DEBUG === '1';

function timestamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

function formatMessage(...args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export interface DebugLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export function createDebugLogger(namespace: string): DebugLogger {
  if (!DEBUG_ENABLED) {
    return {
      debug: () => {},
      info: () => {},
      warn: () => {},
    };
  }

  const prefix = (level: string) => `[${timestamp()}] [${namespace}] [${level}]`;

  return {
    debug: (...args: unknown[]) => {
      process.stderr.write(`${prefix('DEBUG')} ${formatMessage(...args)}\n`);
    },
    info: (...args: unknown[]) => {
      process.stderr.write(`${prefix('INFO')} ${formatMessage(...args)}\n`);
    },
    warn: (...args: unknown[]) => {
      process.stderr.write(`${prefix('WARN')} ${formatMessage(...args)}\n`);
    },
  };
}
