/**
 * Shared TUI debug helpers.
 *
 * Thin hooks and functions that wrap {@link ../debug-log.js} so components
 * don't get cluttered with repetitive `isUiDebugEnabled()` guards and manual
 * event formatting. They all resolve to no-ops when the corresponding debug
 * flag is off.
 *
 * Usage in a component:
 *   import { useDebugMount, useDebugRender, debugInput } from '../debug.js';
 *   const log = createUiDebugLogger('tui:mycomponent');
 *   useDebugMount(log, { optional: 'info' });
 *   useDebugRender(log, { count });
 *   debugInput(log, 'Enter', 'submit-text');
 */

import { useRef, useEffect } from 'react';
import type { DebugLogger } from '../debug-log.js';
import {
  isUiDebugEnabled,
  isRenderDebugEnabled,
  isFlowDebugEnabled,
} from '../debug-log.js';

// ---------------------------------------------------------------------------
// Hooks — useDebug* helpers for components to use inside render/effect bodies.
// ---------------------------------------------------------------------------

/**
 * Log a component mount/unmount event once.
 *
 * Call unconditionally in the component body (not inside a condition/loop).
 * When `BOOK_DEBUG_UI=1` (or `BOOK_DEBUG=1`) this logs `mounted` on first render
 * and `unmounted` in the cleanup effect.
 */
export function useDebugMount(
  log: DebugLogger,
  info?: Record<string, unknown>,
): void {
  if (!isUiDebugEnabled()) return;

  const isMount = useRef(true);
  if (isMount.current) {
    log.event('mounted', info);
  }

  useEffect(() => {
    isMount.current = false;
    return () => {
      log.event('unmounted');
    };
  }, [log]);
}

/**
 * Log component render events.
 *
 * Call unconditionally at the top of the component body. Gated by
 * `BOOK_DEBUG_RENDER=1` to keep stderr readable. When enabled, logs
 * `render` with the supplied metadata every time the component renders.
 *
 * Uses a ref-based throttle so high-frequency renders (streaming) don't
 * flood stderr.
 */
export function useDebugRender(
  log: DebugLogger,
  info?: Record<string, unknown>,
  throttleMs = 250,
): void {
  if (!isRenderDebugEnabled()) return;

  const lastRender = useRef(0);
  const now = Date.now();
  if (now - lastRender.current < throttleMs) return;
  lastRender.current = now;

  log.event('render', info);
}

/**
 * Log when a specific value changes between renders, showing old→new.
 *
 * Useful for tracking state transitions without adding verbose `useEffect`
 * observers for each value.
 */
export function useDebugValueChange(
  log: DebugLogger,
  label: string,
  value: unknown,
  toRepr?: (val: unknown) => string,
): void {
  if (!isUiDebugEnabled()) return;

  const prevRef = useRef<{ stored: boolean; value: unknown }>({ stored: false, value: undefined });
  const { stored, value: prevVal } = prevRef.current;
  prevRef.current = { stored: true, value };

  if (!stored) return;

  const format = toRepr ?? String;
  if (value !== prevVal) {
    log.event(`${label}:change`, { from: format(prevVal), to: format(value) });
  }
}

// ---------------------------------------------------------------------------
// Plain functions — call outside React render cycles (e.g. callbacks).
// ---------------------------------------------------------------------------

/**
 * Log an input / keyboard event from a TUI component. Gated by UI debug.
 */
export function debugInput(
  log: DebugLogger,
  key: string,
  action: string,
  extra?: Record<string, unknown>,
): void {
  if (!isUiDebugEnabled()) return;
  log.event(`input:${key}`, { action, ...extra });
}

/**
 * Log a layout / sizing decision. Gated by render debug (noisy).
 */
export function debugLayout(
  log: DebugLogger,
  info: Record<string, unknown>,
): void {
  if (!isRenderDebugEnabled()) return;
  log.event('layout', info);
}

/**
 * Log a flow enter/exit pair with timing.
 *
 * Call `debugFlowEnter` at the start of an operation and `debugFlowExit`
 * at the end. Gated by `BOOK_DEBUG_FLOW=1`.
 */
let flowSeq = 0;
const flowStack: Array<{ id: number; label: string; start: number }> = [];

export function debugFlowEnter(log: DebugLogger, label: string): number {
  if (!isFlowDebugEnabled()) return -1;
  const id = ++flowSeq;
  flowStack.push({ id, label, start: Date.now() });
  log.event('enter', { flow: label, id });
  return id;
}

export function debugFlowExit(log: DebugLogger, label: string, id?: number): void {
  if (!isFlowDebugEnabled()) return;
  let entry: { id: number; label: string; start: number } | undefined;
  if (id !== undefined) {
    entry = flowStack.find((f) => f.id === id);
  } else {
    // Walk backwards to find the latest matching label (findLast replacement).
    for (let i = flowStack.length - 1; i >= 0; i--) {
      if (flowStack[i].label === label) {
        entry = flowStack[i];
        break;
      }
    }
  }
  if (!entry) {
    log.event('exit', { flow: label, durationMs: '?' });
    return;
  }
  const durationMs = Date.now() - entry.start;
  // remove from stack
  const idx = flowStack.indexOf(entry);
  if (idx >= 0) flowStack.splice(idx, 1);
  log.event('exit', { flow: label, id: entry.id, durationMs });
}
