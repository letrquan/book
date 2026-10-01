/** The first complete `{...}` in a text, string-aware, or undefined when it never balances. */
function firstObjectIn(text: string): string | undefined {
  return objectIn(text, 0)?.slice;
}

/**
 * The first complete `{...}` at or after `from`, with where it starts and ends, so a caller can
 * ask what else in the text lies inside it.
 */
function objectIn(
  text: string,
  from: number,
): { start: number; end: number; slice: string } | undefined {
  const start = text.indexOf('{', from);
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      return { start, end: index + 1, slice: text.slice(start, index + 1) };
    }
  }
  return undefined;
}

/** Every ``` run in the text, as the index it starts at. */
function fenceRuns(text: string): number[] {
  const runs: number[] = [];
  for (let index = text.indexOf('```'); index !== -1; index = text.indexOf('```', index + 3)) {
    runs.push(index);
  }
  return runs;
}

/**
 * The text between an opening and a closing fence run, past an optional `json` tag
 * and any whitespace, exactly as the fence regex this replaces read it.
 */
function fenceContent(text: string, open: number, close: number): string {
  return text.slice(open + 3, close).replace(/^json\s*/i, '');
}

/** Whether a candidate is an object JSON can read, which a balanced brace run is not on its own. */
function isJsonObject(candidate: string): boolean {
  try {
    const parsed: unknown = JSON.parse(candidate);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

/** Extract the first complete JSON object from common model output wrappers. */
export function extractJsonObject(text: string): string | undefined {
  const runs = fenceRuns(text);

  // A fence run inside a JSON string is content and not a wrapper (#245). A memory body that
  // quotes a fenced object gives two runs whose pairing holds a balanced object — the quoted
  // one — and reading that is how a parseable answer was reported unparseable. The whole-text
  // object is preferred when it encloses every run, which is exactly the shape in which the runs
  // cannot be a wrapper around anything.
  const whole = objectIn(text, 0);
  if (
    whole !== undefined &&
    isJsonObject(whole.slice) &&
    runs.every((run) => run >= whole.start && run < whole.end)
  ) {
    return whole.slice;
  }

  // Every fence pair is a candidate, not just the first: a ``` run inside a JSON
  // string literal — a memory body quoting a code block, say — ended the lazy match
  // at the wrong place and cut the candidate off before it balanced (#299). Each
  // opening run is therefore paired with every later run until one holds an object.
  let firstBalanced: string | undefined;
  for (let open = 0; open < runs.length; open++) {
    for (let close = open + 1; close < runs.length; close++) {
      const found = firstObjectIn(fenceContent(text, runs[open]!, runs[close]!));
      if (found === undefined) continue;
      // A pair that holds something JSON can read wins over one that merely balances; the first
      // balanced pair is still returned below, so a caller that parses for itself is unaffected.
      if (isJsonObject(found)) return found;
      firstBalanced ??= found;
    }
  }
  // No fence held one, so the whole text is the candidate, as before.
  return firstBalanced ?? firstObjectIn(text);
}

export function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const candidate = extractJsonObject(text);
  if (!candidate) return undefined;
  try {
    const parsed: unknown = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
