import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inkBuildDir } from './ink-renderer.js';

/** A render throttle Ink can settle: `flush` draws a pending frame now, `cancel` drops it. */
export interface FrameThrottle {
  (): void;
  flush: () => void;
  cancel: () => void;
}

/**
 * Draws at most once per `intervalMs`: at once when the last draw is that long ago, otherwise once,
 * at the last draw plus the interval, however many commits arrive meanwhile.
 *
 * Ink's own throttle (es-toolkit's `throttle`) is a debounce whose trailing timer restarts on every
 * call. Under a steady stream of commits — a wheel glide, a measured row, a streamed token — each
 * commit inside the window pushes the draw a whole window later, so a 14 ms cap drew every 25–31 ms
 * in a real session. Timing the trailing draw from the last draw keeps the cap honest.
 */
export function createFrameThrottle(
  draw: () => void,
  intervalMs: number,
  now: () => number = () => performance.now(),
): FrameThrottle {
  let lastDrawAt = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fire = () => {
    timer = null;
    lastDrawAt = now();
    draw();
  };
  const throttled = (() => {
    // A draw is already due, and it will show this commit too.
    if (timer !== null) return;
    const wait = lastDrawAt + intervalMs - now();
    if (wait <= 0) fire();
    else timer = setTimeout(fire, wait);
  }) as FrameThrottle;
  throttled.flush = () => {
    if (timer === null) return;
    clearTimeout(timer);
    fire();
  };
  throttled.cancel = () => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };
  return throttled;
}

/** The fields of Ink's private `Ink` instance the replacement touches. */
interface ThrottledInk {
  onRender: () => void;
  renderThrottleMs: number;
  hasPendingThrottledRender: boolean;
  throttledOnRender: { flush: () => void; cancel: () => void };
  rootNode: { onRender: () => void };
}

function isThrottledInk(ink: unknown): ink is ThrottledInk {
  if (typeof ink !== 'object' || ink === null) return false;
  const candidate = ink as Partial<ThrottledInk>;
  return (
    typeof candidate.onRender === 'function' &&
    typeof candidate.renderThrottleMs === 'number' &&
    candidate.renderThrottleMs > 0 &&
    typeof candidate.throttledOnRender?.flush === 'function' &&
    typeof candidate.throttledOnRender.cancel === 'function' &&
    typeof candidate.rootNode?.onRender === 'function'
  );
}

/**
 * Replace the render throttle of the Ink instance drawing to `stdout` with `createFrameThrottle`, at
 * the interval Ink derived from `maxFps`. Returns false, leaving Ink's own throttle in place, when
 * no throttled instance draws there (debug and screen-reader rendering are unthrottled) or Ink's
 * private layout has changed; `ink-renderer.contract.test.ts` fails in that case, so an Ink upgrade
 * cannot drop the replacement unnoticed.
 */
export async function installInkFrameThrottle(stdout: NodeJS.WriteStream): Promise<boolean> {
  try {
    const module = (await import(pathToFileURL(join(inkBuildDir(), 'instances.js')).href)) as {
      default: { get: (stream: NodeJS.WriteStream) => unknown };
    };
    const ink = module.default.get(stdout);
    if (!isThrottledInk(ink)) return false;
    // Draw anything Ink's throttle was holding before it is dropped.
    ink.throttledOnRender.flush();
    const throttle = createFrameThrottle(() => ink.onRender(), ink.renderThrottleMs);
    // Ink settles `throttledOnRender` on unmount and when waiting for a render to flush.
    ink.throttledOnRender = throttle;
    ink.rootNode.onRender = () => {
      ink.hasPendingThrottledRender = true;
      throttle();
    };
    return true;
  } catch {
    return false;
  }
}
