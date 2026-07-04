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

import { appendFileSync, mkdirSync } from 'fs';
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

function defaultDebugLogPath(): string {
  return join(process.env.BOOK_WORKSPACE || process.cwd(), '.book', 'debug.log');
}

export function getDebugLogPath(): string | undefined {
  if (process.env.BOOK_DEBUG_STDERR === '1') return undefined;
  if (process.env.BOOK_DEBUG_FILE) return process.env.BOOK_DEBUG_FILE;
  if (process.stderr.isTTY) return defaultDebugLogPath();
  return undefined;
}

function writeDebugLine(line: string): void {
  const target = debugLogPath ?? (debugLogPath = getDebugLogPath());
  if (!target) {
    process.stderr.write(line);
    return;
  }

  try {
    mkdirSync(dirname(target), { recursive: true });
    appendFileSync(target, line, 'utf8');
  } catch {
    process.stderr.write(line);
  }
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
function buildLogger(namespace: string): DebugLogger {
  return {
    debug: (...args: unknown[]) => {
      writeDebugLine(`${makePrefix(namespace, 'DEBUG')} ${formatMessage(...args)}\n`);
    },
    info: (...args: unknown[]) => {
      writeDebugLine(`${makePrefix(namespace, 'INFO')} ${formatMessage(...args)}\n`);
    },
    warn: (...args: unknown[]) => {
      writeDebugLine(`${makePrefix(namespace, 'WARN')} ${formatMessage(...args)}\n`);
    },
    event: (event, meta) => {
      const suffix = meta && Object.keys(meta).length > 0 ? ` ${formatMeta(meta)}` : '';
      writeDebugLine(`${makePrefix(namespace, 'DEBUG')} ${event}${suffix}\n`);
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
  const base = buildLogger(namespace);
  const wrap = (level: 'debug' | 'info' | 'warn') =>
    (...args: unknown[]) => {
      const id = nextEventId(namespace);
      writeDebugLine(`[${timestamp()}] [${namespace}] [${level.toUpperCase()}#${id}] ${formatMessage(...args)}\n`);
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
  return buildLogger(namespace);
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
