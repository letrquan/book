/**
 * Lightweight debug logger controlled by environment variables.
 *
 * Writes timestamped messages to a log file when stderr is an interactive TTY,
 * because Ink renders to the same terminal and raw stderr writes corrupt the UI.
 * In non-TTY contexts (redirected stderr, CI), logs continue to use stderr.
 * Most functions are no-ops when the relevant env var is not set to '1'.
 *
 * Gated by separate flags so output volume stays controllable:
 *   BOOK_DEBUG=1          — provider + agent + TUI lifecycle events
 *   BOOK_DEBUG_UI=1       — input handling, modal toggles, permission prompts,
 *                           component mount/unmount, layout state changes
 *   BOOK_DEBUG_RENDER=1   — per-render details (noisy; can flood during streaming)
 *   BOOK_DEBUG_FLOW=1     — enter/exit timing around expensive flows
 *   BOOK_DEBUG_FILE=path  — write logs to a specific file
 *   BOOK_DEBUG_STDERR=1   — force stderr even when attached to a TTY
 *
 * `BOOK_DEBUG=1` covers the union of "core + UI" (lifecycle). UI hooks read
 * `isUiDebugEnabled()`, which returns true if either BOOK_DEBUG=1 or
 * BOOK_DEBUG_UI=1 so the default mode surfaces UI events too.
 *
 * Usage:
 *   import { createDebugLogger } from '../debug-log.js';
 *   const log = createDebugLogger('provider');
 *   log.debug('Sending request', { model: 'gpt-4' });
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from 'fs';
import { dirname, join } from 'path';

// Core flag — provider, agent loop, and TUI lifecycle.
const DEBUG_ENABLED = process.env.BOOK_DEBUG === '1';
// UI flag — input, modals, permissions, mount/unmount, layout changes.
// Falls back to core flag so default debug mode surfaces UI events too.
const UI_DEBUG_ENABLED = process.env.BOOK_DEBUG_UI === '1' || DEBUG_ENABLED;
// Noisy per-render flag — opt-in only.
const RENDER_DEBUG_ENABLED = process.env.BOOK_DEBUG_RENDER === '1';
// Flow/tracing flag — enter/exit pairs with timing — opt-in only.
const FLOW_DEBUG_ENABLED = process.env.BOOK_DEBUG_FLOW === '1';

let debugLogPath: string | undefined;
const debugLogSizes = new Map<string, number>();
const DEFAULT_DEBUG_LOG_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_DEBUG_LOG_BACKUPS = 3;
export const DEFAULT_LOCAL_DATA_RETENTION_DAYS = 30;

export function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function rotateDebugLog(target: string, incomingBytes: number): void {
  if (!existsSync(target)) {
    debugLogSizes.set(target, 0);
    return;
  }
  const maxBytes = positiveInteger(process.env.BOOK_DEBUG_MAX_BYTES, DEFAULT_DEBUG_LOG_MAX_BYTES);
  const currentBytes = debugLogSizes.get(target) ?? statSync(target).size;
  debugLogSizes.set(target, currentBytes);
  if (currentBytes + incomingBytes <= maxBytes) return;

  const backups = positiveInteger(process.env.BOOK_DEBUG_BACKUPS, DEFAULT_DEBUG_LOG_BACKUPS);
  const oldest = `${target}.${backups}`;
  if (existsSync(oldest)) unlinkSync(oldest);
  for (let index = backups - 1; index >= 1; index--) {
    const source = `${target}.${index}`;
    if (existsSync(source)) renameSync(source, `${target}.${index + 1}`);
  }
  renameSync(target, `${target}.1`);
  debugLogSizes.set(target, 0);
}

function defaultDebugLogPath(): string {
  return join(process.env.BOOK_WORKSPACE || process.cwd(), '.book', 'debug.log');
}

export function getDebugLogPath(): string | undefined {
  if (process.env.BOOK_DEBUG_STDERR === '1') return undefined;
  if (process.env.BOOK_DEBUG_FILE) return process.env.BOOK_DEBUG_FILE;
  if (process.stderr.isTTY) return defaultDebugLogPath();
  return undefined;
}

/** Remove expired rotated logs while always preserving the active log file. */
export function cleanupDebugLogs(
  days = DEFAULT_LOCAL_DATA_RETENTION_DAYS,
  target = getDebugLogPath(),
  now = Date.now(),
): number {
  if (!target) return 0;
  const cutoff = now - Math.max(1, days) * 86_400_000;
  const directory = dirname(target);
  const prefix = `${target.split(/[\\/]/).pop()}.`;
  let removed = 0;
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.startsWith(prefix)) continue;
      const path = join(directory, entry.name);
      if (statSync(path).mtimeMs >= cutoff) continue;
      unlinkSync(path);
      debugLogSizes.delete(path);
      removed++;
    }
  } catch {
    // Retention cleanup is best effort and must never block startup.
  }
  return removed;
}

function writeDebugLine(line: string): void {
  const target = debugLogPath ?? (debugLogPath = getDebugLogPath());
  if (!target) {
    process.stderr.write(line);
    return;
  }

  try {
    mkdirSync(dirname(target), { recursive: true });
    const lineBytes = Buffer.byteLength(line);
    rotateDebugLog(target, lineBytes);
    appendFileSync(target, line, 'utf8');
    debugLogSizes.set(target, (debugLogSizes.get(target) ?? 0) + lineBytes);
  } catch {
    process.stderr.write(line);
  }
}

function writeSizeBoundedDebugLine(line: string, maxBytes: number): void {
  if (Buffer.byteLength(line) <= maxBytes) {
    writeDebugLine(line);
    return;
  }

  // Split oversized render events on UTF-8 character boundaries so one burst
  // cannot bypass the configured active-log cap.
  let chunk = '';
  let chunkBytes = 0;
  for (const character of line) {
    const characterBytes = Buffer.byteLength(character);
    if (chunk && chunkBytes + characterBytes > maxBytes) {
      writeDebugLine(chunk);
      chunk = '';
      chunkBytes = 0;
    }
    chunk += character;
    chunkBytes += characterBytes;
  }
  if (chunk) writeDebugLine(chunk);
}

let pendingRenderDebug: string[] = [];
let renderDebugFlush: ReturnType<typeof setImmediate> | null = null;

function writeRenderDebugLine(line: string): void {
  pendingRenderDebug.push(line);
  if (renderDebugFlush !== null) return;
  renderDebugFlush = setImmediate(() => {
    renderDebugFlush = null;
    const batch = pendingRenderDebug;
    pendingRenderDebug = [];
    const maxBytes = positiveInteger(process.env.BOOK_DEBUG_MAX_BYTES, DEFAULT_DEBUG_LOG_MAX_BYTES);
    let chunk = '';
    let chunkBytes = 0;

    for (const pendingLine of batch) {
      const lineBytes = Buffer.byteLength(pendingLine);
      if (chunk && chunkBytes + lineBytes > maxBytes) {
        writeDebugLine(chunk);
        chunk = '';
        chunkBytes = 0;
      }
      if (lineBytes > maxBytes) {
        writeSizeBoundedDebugLine(pendingLine, maxBytes);
        continue;
      }
      chunk += pendingLine;
      chunkBytes += lineBytes;
    }
    if (chunk) writeDebugLine(chunk);
  });
}

// Per-namespace monotonic event counter, used when a logger is created with
// `createDebugLoggerWithCounter`. Useful for tracing event ordering across
// concurrent sources (streaming flushes vs. user input).
const namespaceCounters = new Map<string, number>();

function nextEventId(namespace: string): number {
  const n = (namespaceCounters.get(namespace) ?? 0) + 1;
  namespaceCounters.set(namespace, n);
  return n;
}

/** True if core debug (provider/agent/TUI lifecycle) is on. */
export function isDebugEnabled(): boolean {
  return DEBUG_ENABLED;
}

/** True if UI debug is on (BOOK_DEBUG=1 already enables this). */
export function isUiDebugEnabled(): boolean {
  return UI_DEBUG_ENABLED;
}

/** True if per-render debug is on (opt-in via BOOK_DEBUG_RENDER=1). */
export function isRenderDebugEnabled(): boolean {
  return RENDER_DEBUG_ENABLED;
}

/** True if flow tracing is on (opt-in via BOOK_DEBUG_FLOW=1). */
export function isFlowDebugEnabled(): boolean {
  return FLOW_DEBUG_ENABLED;
}

function timestamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

/** Truncate a string for safe preview in logs. */
function truncate(value: string, max = 80): string {
  const single = value.replace(/\s+/g, ' ').trim();
  if (single.length <= max) return single;
  return `${single.slice(0, max)}…`;
}

function formatValue(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function formatMessage(...args: unknown[]): string {
  return args.map(formatValue).join(' ');
}

/** Format a metadata object, truncating any long string values. */
function formatMeta(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(meta)) {
    let repr: string;
    if (typeof value === 'string') {
      repr = truncate(value, 120);
    } else if (value === null) {
      repr = 'null';
    } else if (value === undefined) {
      repr = 'undefined';
    } else {
      try {
        repr = JSON.stringify(value);
      } catch {
        repr = String(value);
      }
    }
    parts.push(`${key}=${repr}`);
  }
  return parts.join(' ');
}

export interface DebugLogger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  /** Structured log with key=value metadata (long strings are truncated). */
  event: (event: string, meta?: Record<string, unknown>) => void;
}

function noop(): void {}

const NOOP_LOGGER: DebugLogger = {
  debug: noop,
  info: noop,
  warn: noop,
  event: noop,
};

function makePrefix(namespace: string, level: string): string {
  return `[${timestamp()}] [${namespace}] [${level}]`;
}

/** Build a writing logger for an enabled namespace. */
function buildLogger(
  namespace: string,
  write: (line: string) => void = writeDebugLine,
): DebugLogger {
  return {
    debug: (...args: unknown[]) => {
      write(`${makePrefix(namespace, 'DEBUG')} ${formatMessage(...args)}\n`);
    },
    info: (...args: unknown[]) => {
      write(`${makePrefix(namespace, 'INFO')} ${formatMessage(...args)}\n`);
    },
    warn: (...args: unknown[]) => {
      write(`${makePrefix(namespace, 'WARN')} ${formatMessage(...args)}\n`);
    },
    event: (event, meta) => {
      const suffix = meta && Object.keys(meta).length > 0 ? ` ${formatMeta(meta)}` : '';
      write(`${makePrefix(namespace, 'DEBUG')} ${event}${suffix}\n`);
    },
  };
}

/**
 * Create a debug logger gated by `BOOK_DEBUG=1`. Returns a no-op logger when
 * debug is off, so callers can call freely without env checks at call sites.
 */
export function createDebugLogger(namespace: string): DebugLogger {
  if (!DEBUG_ENABLED) return NOOP_LOGGER;
  return buildLogger(namespace);
}

/**
 * Like {@link createDebugLogger} but emits a monotonic event id per namespace
 * in every message, e.g. `[tui:input] [DEBUG#42] key=Escape`. Helpful when
 * tracing event ordering across concurrent sources.
 *
 * Activation matches {@link createDebugLogger}: gated by `BOOK_DEBUG=1`.
 */
export function createDebugLoggerWithCounter(namespace: string): DebugLogger {
  if (!DEBUG_ENABLED) return NOOP_LOGGER;
  const wrap =
    (level: 'debug' | 'info' | 'warn') =>
    (...args: unknown[]) => {
      const id = nextEventId(namespace);
      writeDebugLine(
        `[${timestamp()}] [${namespace}] [${level.toUpperCase()}#${id}] ${formatMessage(...args)}\n`,
      );
    };
  return {
    debug: wrap('debug'),
    info: wrap('info'),
    warn: wrap('warn'),
    event: (event, meta) => {
      const id = nextEventId(namespace);
      const suffix = meta && Object.keys(meta).length > 0 ? ` ${formatMeta(meta)}` : '';
      writeDebugLine(`[${timestamp()}] [${namespace}] [DEBUG#${id}] ${event}${suffix}\n`);
    },
  };
}

/**
 * Create a debug logger gated by `BOOK_DEBUG_UI=1` (also active when
 * `BOOK_DEBUG=1`). No-op otherwise. Used for input, modal, permission, and
 * mount/unmount events.
 */
export function createUiDebugLogger(namespace: string): DebugLogger {
  if (!UI_DEBUG_ENABLED) return NOOP_LOGGER;
  return buildLogger(namespace);
}

/**
 * Create a debug logger gated by `BOOK_DEBUG_RENDER=1` only. No-op otherwise.
 * Used for noisy per-render logs. Render logs must be opt-in to keep stderr
 * readable during streaming.
 */
export function createRenderDebugLogger(namespace: string): DebugLogger {
  if (!RENDER_DEBUG_ENABLED) return NOOP_LOGGER;
  return buildLogger(namespace, writeRenderDebugLine);
}

/**
 * Create a debug logger gated by `BOOK_DEBUG_FLOW=1` only. No-op otherwise.
 * Used for enter/exit trace pairs around expensive flows.
 */
export function createFlowDebugLogger(namespace: string): DebugLogger {
  if (!FLOW_DEBUG_ENABLED) return NOOP_LOGGER;
  return buildLogger(namespace);
}

/** Throttle a callback to at most one invocation per `intervalMs`. */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs: number,
): (...args: A) => void {
  let last = 0;
  return (...args: A) => {
    const now = Date.now();
    if (now - last < intervalMs) return;
    last = now;
    fn(...args);
  };
}
