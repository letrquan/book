/**
 * The transcript's marks.
 *
 * Every item a turn draws — a paragraph the agent says, a call it makes — opens
 * on one mark in the gutter, and a call's result hangs under it on a connector.
 * The mark's colour carries the state (finished, failed, running), so no row
 * needs a check or a cross of its own. Each glyph here is measured one column
 * wide by `displayWidth` and by Ink, and drawn one column wide by the terminal;
 * `word-wrap.test.ts` holds them to it.
 */

/** Opens an item of a turn: the agent's prose, a tool call, a folded run of reads. */
export const ITEM_MARK = '●';

/** Hangs a call's result under its heading: `⎿  Read 40 lines`. */
export const RESULT_MARK = '⎿';

/** Opens a user turn, and prompts the composer you write the next one in. */
export const PROMPT_MARK = '>';

/** Heads a decision sheet and the title page's contents: chrome, not the transcript. */
export const PILCROW = '¶';

/** Precedes an H1 or H2 heading in an answer. */
export const SECTION_SIGN = '§';
