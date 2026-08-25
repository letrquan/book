/**
 * Book never turns terminal mouse reporting on — the terminal keeps the mouse so
 * drag-select and copy work without a modifier key. Reports can still arrive from
 * a mode another program (or a multiplexer) left enabled, and Ink hands them to
 * every `useInput` consumer as ordinary text, where they would be typed into
 * whatever field has focus. Strip them on the way into any editable value.
 */
const SGR_MOUSE_SEQUENCE_PATTERN = /(?:\x1b)?\[<\d+;\d+;\d+[Mm]/g;

/** Remove complete SGR mouse reports, with or without the escape byte Ink may consume. */
export function stripSgrMouseSequences(input: string): string {
  return input.replace(SGR_MOUSE_SEQUENCE_PATTERN, '');
}
