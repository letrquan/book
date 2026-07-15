export type MouseWheelDirection = 'up' | 'down';

const SGR_MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)M$/;

/**
 * Parse an SGR mouse wheel report (CSI < Cb ; Cx ; Cy M).
 *
 * Modifier bits may be combined with the wheel bit, so decode the button
 * bitmask instead of comparing only the common 64/65 button values.
 */
export function parseMouseWheelDirection(input: string): MouseWheelDirection | null {
  const match = SGR_MOUSE_PATTERN.exec(input);
  if (!match) return null;

  const button = Number(match[1]);
  if (!Number.isSafeInteger(button) || (button & 64) === 0) return null;

  const wheelButton = button & 3;
  if (wheelButton > 1) return null;
  return wheelButton === 0 ? 'up' : 'down';
}
