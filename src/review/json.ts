/** The first complete `{...}` in a text, string-aware, or undefined when it never balances. */
function firstObjectIn(text: string): string | undefined {
  const start = text.indexOf('{');
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
    else if (char === '}' && --depth === 0) return text.slice(start, index + 1);
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

/** Extract the first complete JSON object from common model output wrappers. */
export function extractJsonObject(text: string): string | undefined {
  // Every fence pair is a candidate, not just the first: a ``` run inside a JSON
  // string literal — a memory body quoting a code block, say — ended the lazy match
  // at the wrong place and cut the candidate off before it balanced (#299). Each
  // opening run is therefore paired with every later run until one holds an object.
  const runs = fenceRuns(text);
  for (let open = 0; open < runs.length; open++) {
    for (let close = open + 1; close < runs.length; close++) {
      const found = firstObjectIn(fenceContent(text, runs[open]!, runs[close]!));
      if (found !== undefined) return found;
    }
  }
  // No fence held one, so the whole text is the candidate, as before.
  return firstObjectIn(text);
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
