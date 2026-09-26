/**
 * Conservative syntax repair for tool-call arguments (#242).
 *
 * Only three malformed shapes are repairable, and this function is pure syntax: it
 * never changes string content beyond escaping raw control characters, never guesses a
 * truncated value, and never invents a key. Everything else is left to the
 * `invalid_json_arguments` rejection, which tells the model what was wrong with its own
 * text. The registry pairs a repair with the tool's schema before running it, so a
 * repair that is valid JSON but wrong for this tool is refused there.
 *
 * The three shapes, composed in this order:
 *
 * 1. A control character (U+0000–U+001F) inside a JSON string, written literally
 *    rather than escaped — a literal newline in a `command` or a `patch` body, a tab
 *    between two commands, a NUL or an ESC the model emitted. Escaping it parses back
 *    to the same character, so the value the tool receives is the one that was sent.
 * 2. A comma directly before a `}` or `]`, outside any string.
 * 3. A closer the text never reached: when the scan ends with an unclosed bracket
 *    stack and not inside a string, the stack's closers are appended in order.
 *
 * The refusals are as deliberate as the repairs: a dropped opening fragment (#260)
 * would have to invent a prefix, a cut-off literal a value, a text that ends inside a
 * string a closing quote, and a closer that does not match the open stack means the
 * text is corrupt rather than truncated.
 */

/** A character JSON requires escaped inside a string literal, escaped. */
function escapeControlCharacter(char: string): string {
  return `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`;
}

/**
 * The one candidate this text can be repaired into, or `undefined` when it is not one
 * of the three shapes.
 */
function repairCandidate(raw: string): string | undefined {
  let out = '';
  /** The open brackets, innermost last: what the text would still have to close. */
  const stack: string[] = [];
  /**
   * Where each non-whitespace character outside a string landed, so a comma before a
   * closer can be dropped afterwards and the character in front of it remembered.
   * `index` counts UTF-16 code units into `out` (what `out.length` counts), so the
   * drop filter has to walk code units too — see the end of this function.
   */
  const significant: Array<{ index: number; isComma: boolean }> = [];
  const dropped = new Set<number>();
  let inString = false;
  let escaped = false;

  for (const char of raw) {
    if (inString) {
      out += char.charCodeAt(0) <= 0x1f ? escapeControlCharacter(char) : char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      significant.push({ index: out.length, isComma: false });
      out += char;
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push(char === '{' ? '}' : ']');
      significant.push({ index: out.length, isComma: false });
      out += char;
      continue;
    }
    if (char === '}' || char === ']') {
      // A closer the open stack does not expect is corrupt text, not truncation
      // (`{"a":[1,2}`), so nothing is appended to it.
      if (stack[stack.length - 1] !== char) return undefined;
      stack.pop();
      const last = significant[significant.length - 1];
      if (last?.isComma) {
        dropped.add(last.index);
        significant.pop();
      }
      out += char;
      continue;
    }
    if (char.trim() === '') {
      out += char;
      continue;
    }
    significant.push({ index: out.length, isComma: char === ',' });
    out += char;
  }

  // A string left open is not closed: the quote that would end it was never sent, and
  // adding one would change the argument the model wrote.
  if (inString) return undefined;
  // Step 2 is deliberately not re-run over what step 3 appended: a text that ends on
  // a comma is "the rest never arrived" (`{"filePath": "a.ts",`), not a trailing comma,
  // so it stays refused.
  out += stack.reverse().join('');
  if (dropped.size === 0) return out;
  // `split('')`, not `[...out]`: the recorded indices are code units, and iterating code
  // points instead would shift them by one for every astral character in the text,
  // leaving the comma in place and the repair missed.
  return out
    .split('')
    .filter((_, index) => !dropped.has(index))
    .join('');
}

/**
 * The repaired arguments for a malformed argument text, or `undefined` when the text
 * parses as is, is not one of the three repairable shapes, or does not parse after
 * repair. Only a plain object is returned: an array or a scalar is not arguments.
 */
export function repairToolArguments(raw: string): Record<string, unknown> | undefined {
  if (!raw.trim()) return undefined;
  try {
    JSON.parse(raw);
    return undefined;
  } catch {
    // Only text that never parsed is a repair candidate.
  }
  const candidate = repairCandidate(raw);
  if (candidate === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return undefined;
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}
