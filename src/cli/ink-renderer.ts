import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The Ink release whose renderer Book's TUI was last verified against. A dependency bump changes
 * `package.json` but not this constant, so the contract test and `npm run verify:ink` fail until
 * someone re-verifies the TUI (docs/guide/development.md, "Upgrading Ink") and updates it.
 */
export const VERIFIED_INK_VERSION = '7.1.1';

/**
 * The incremental renderer's cursor rewind with Ink's trailing-newline fix (upstream issue 909,
 * shipped in Ink 7.0.0). Without it, a frame that ends in a newline rewinds one row short and
 * later updates land below their rows.
 */
const INK_TRAILING_NEWLINE_FIX = 'ansiEscapes.cursorUp(previousLines.length - 1)';

/** The subset of a writable terminal stream Ink's renderer writes through. */
export interface InkStream {
  isTTY?: boolean;
  rows?: number;
  write: (data: string) => unknown;
}

/** Ink's private log-update renderer. Ink 7 added `reset()`; every wrapper must forward it. */
export interface LogUpdateRenderer {
  (output: string): boolean | void;
  clear: () => void;
  done: () => void;
  reset?: () => void;
  sync: (output: string) => void;
  setCursorPosition: (position: unknown) => void;
  isCursorDirty: () => boolean;
  willRender: (output: string) => boolean;
}

export type CreateLogUpdate = (
  stream: InkStream,
  options?: { incremental?: boolean },
) => LogUpdateRenderer;

/** Ink's build directory, where its private modules live. Throws when Ink cannot be resolved. */
export function inkBuildDir(from: string | URL = import.meta.url): string {
  const require = createRequire(from);
  return dirname(require.resolve('ink'));
}

/**
 * Ink's private log-update module: the renderer the TUI wraps for frame capture and scroll hints,
 * and the file whose trailing-newline fix decides the renderer mode. Throws when Ink cannot be
 * resolved. `from` is the module Ink is resolved from.
 */
export function inkLogUpdatePath(from?: string | URL): string {
  return join(inkBuildDir(from), 'log-update.js');
}

/** The installed Ink version, or undefined when Ink cannot be resolved. `from` is the module Ink is resolved from. */
export function installedInkVersion(from?: string | URL): string | undefined {
  try {
    const manifest = JSON.parse(
      readFileSync(join(inkBuildDir(from), '..', 'package.json'), 'utf8'),
    ) as {
      version?: unknown;
    };
    return typeof manifest.version === 'string' ? manifest.version : undefined;
  } catch {
    return undefined;
  }
}

/** Incremental rendering is safe only when Ink's renderer carries the trailing-newline fix. `from` is the module Ink is resolved from. */
export function hasInkTrailingNewlineFix(from?: string | URL): boolean {
  try {
    return readFileSync(inkLogUpdatePath(from), 'utf8').includes(INK_TRAILING_NEWLINE_FIX);
  } catch {
    return false;
  }
}

/** Runs `update` and commits the React work it scheduled before returning. */
export type InkFlushSync = (update: () => void) => void;

/**
 * The `flushSync` of Ink's own reconciler (#538), or undefined when Ink's private `reconciler.js`
 * cannot be read. Ink renders with `LegacyRoot`, but React 19's reconciler no longer commits a
 * legacy root's update synchronously outside a batch: a `setState` from a stdout `resize` listener
 * waits for a microtask, after Ink's own `resized()` has drawn the tree from before the resize. A
 * listener that sets the new size inside this flush has it committed before `resized()` draws.
 * Ink exports no flushSync, so this reads the reconciler instance Ink renders with.
 */
export async function loadInkFlushSync(from?: string | URL): Promise<InkFlushSync | undefined> {
  try {
    const module = (await import(pathToFileURL(join(inkBuildDir(from), 'reconciler.js')).href)) as {
      default?: { flushSyncFromReconciler?: unknown };
    };
    const reconciler = module.default;
    const flush = reconciler?.flushSyncFromReconciler;
    if (typeof flush !== 'function') return undefined;
    return (update) => {
      flush.call(reconciler, update);
    };
  } catch {
    return undefined;
  }
}

/**
 * Replaces Ink's private `logUpdate.create` with `wrap(original)`, so every renderer Ink creates
 * afterwards goes through the wrapper. Returns false, leaving Ink's renderer in place, when Ink's
 * module layout has changed.
 */
export async function wrapInkLogUpdate(
  wrap: (createBase: CreateLogUpdate) => CreateLogUpdate,
): Promise<boolean> {
  try {
    const module = (await import(pathToFileURL(inkLogUpdatePath()).href)) as {
      default: { create: CreateLogUpdate };
    };
    const logUpdate = module.default;
    logUpdate.create = wrap(logUpdate.create);
    return true;
  } catch {
    return false;
  }
}
