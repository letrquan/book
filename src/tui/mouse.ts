export type MouseWheelDirection = 'up' | 'down';

export type SgrMouseEventType = 'press' | 'release' | 'move' | 'wheel';
export type SgrMouseButton = 'left' | 'middle' | 'right' | 'none' | 'wheel-up' | 'wheel-down';

export interface SgrMouseEvent {
  type: SgrMouseEventType;
  button: SgrMouseButton;
  x: number;
  y: number;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

const SGR_MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)(M|m)$/;
const SGR_MOUSE_SEQUENCE_PATTERN = /\x1b\[<\d+;\d+;\d+[Mm]/g;

/** Parse an SGR mouse report into a typed, 1-based terminal event. */
export function parseSgrMouseEvent(input: string): SgrMouseEvent | null {
  const match = SGR_MOUSE_PATTERN.exec(input);
  if (!match) return null;

  const code = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (![code, x, y].every(Number.isSafeInteger) || x < 1 || y < 1) return null;

  const shift = (code & 4) !== 0;
  const alt = (code & 8) !== 0;
  const ctrl = (code & 16) !== 0;
  const isWheel = (code & 64) !== 0;
  const isMove = (code & 32) !== 0;
  const buttonCode = code & 3;

  if (isWheel) {
    if (buttonCode > 1 || match[4] === 'm') return null;
    return {
      type: 'wheel',
      button: buttonCode === 0 ? 'wheel-up' : 'wheel-down',
      x,
      y,
      shift,
      alt,
      ctrl,
    };
  }

  const button: SgrMouseButton =
    buttonCode === 0 ? 'left' : buttonCode === 1 ? 'middle' : buttonCode === 2 ? 'right' : 'none';
  const type: SgrMouseEventType =
    match[4] === 'm' ? 'release' : isMove ? 'move' : buttonCode === 3 ? 'release' : 'press';
  return { type, button, x, y, shift, alt, ctrl };
}

/** Parse every complete SGR mouse report from a terminal input chunk. */
export function parseSgrMouseEvents(input: string): SgrMouseEvent[] {
  const events: SgrMouseEvent[] = [];
  for (const match of input.matchAll(SGR_MOUSE_SEQUENCE_PATTERN)) {
    const event = parseSgrMouseEvent(match[0]);
    if (event) events.push(event);
  }
  return events;
}

/**
 * Parse an SGR mouse wheel report (CSI < Cb ; Cx ; Cy M).
 *
 * Modifier bits may be combined with the wheel bit, so decode the button
 * bitmask instead of comparing only the common 64/65 button values.
 */
export function parseMouseWheelDirection(input: string): MouseWheelDirection | null {
  const event = parseSgrMouseEvent(input);
  if (event?.type !== 'wheel') return null;
  return event.button === 'wheel-up' ? 'up' : 'down';
}
