/**
 * The index of the line that closes the front matter a `---` first line
 * opens: the next `---`, or YAML's `...` document end, trailing spaces
 * allowed. -1 when the first line opens none or nothing closes it.
 * The Markdown outline's rule; parseFrontmatter keeps the exact `---` that
 * command, skill and memory files are written with.
 */
export function frontMatterClose(lines: readonly string[]): number {
  if (lines[0]?.trim() !== '---') return -1;
  return lines.findIndex((line, index) => index > 0 && /^(?:---|\.\.\.)\s*$/.test(line));
}

// A front-matter key is anything up to a colon: `title:`, `"quoted key":`,
// `my key:`, `$schema:`, `título:`.
const FRONT_MATTER_KEY = /^[^\s#:-][^:]*:(?:\s|$)/;

// A key a `#` comment may sit beside outside the block's first run: a YAML
// identifier (`title:`, `allowed-tools:`). Beside a looser label
// (`Summary: what this covers`) a `#` line is more likely a heading.
const FRONT_MATTER_STRICT_KEY = /^[a-z_][\w-]*:(?:\s|$)/;

/**
 * Where a Markdown document's content starts: after its front matter, or at
 * line 0. A leading `---` may be a horizontal rule instead, so the lines up to
 * the closing delimiter count as front matter only when they read as YAML:
 * the first line that is not a `#` comment is a `key:` line, and every run of
 * lines between blank lines holds `key:`, indented and `- ` lines. `#` lines
 * are comments among the keys of the first run, as they always were. A `#`
 * line that opens the block, or sits in a later run, is a comment only beside
 * YAML identifier keys (`title:`). Alone in its run, or beside
 * `Summary: what this covers`, it is a heading, and the block is a rule
 * followed by text: dropping a real heading costs more than listing a comment.
 */
export function markdownContentStart(lines: readonly string[]): number {
  const close = frontMatterClose(lines);
  if (close < 0) return 0;
  const block = lines.slice(1, close);
  const first = block.find((line) => line.trim().length > 0 && !line.startsWith('#'));
  if (first === undefined || !FRONT_MATTER_KEY.test(first)) return 0;
  const runs: string[][] = [[]];
  for (const line of block) {
    if (line.trim().length === 0) runs.push([]);
    else runs[runs.length - 1].push(line);
  }
  for (const [position, run] of runs.filter((lines) => lines.length > 0).entries()) {
    const comments = run.some((line) => line.startsWith('#'));
    const strict = comments && (position > 0 || run[0].startsWith('#'));
    const key = strict ? FRONT_MATTER_STRICT_KEY : FRONT_MATTER_KEY;
    let keys = 0;
    for (const line of run) {
      if (line.startsWith('#')) continue;
      if (key.test(line)) keys++;
      else if (!/^\s+\S/.test(line) && !/^-(?:\s|$)/.test(line)) return 0;
    }
    if (comments && keys === 0) return 0;
  }
  return close + 1;
}

/** A scalar as YAML reads it: one pair of surrounding quotes is dropped. */
function unquote(value: string): string {
  return value.replace(/^["'](.*)["']$/, '$1');
}

/**
 * One whole quoted item: a matching pair around text that holds no quote of the same kind. `"Read"` and
 * `'Read'` give `Read`; `"Read", "Task"`, `"Read'` and `"a" and "b"` are left as written, as is a
 * pair with nothing inside, so a list of only `""` still names a rule that matches no tool instead
 * of becoming an empty list.
 */
function unquoteItem(value: string): string {
  const match = /^(["'])((?:(?!\1).)+)\1$/.exec(value);
  return match ? match[2] : value;
}

/** Splits outside parentheses, so `Bash(git *, x)` stays one piece. An unclosed one swallows the rest. */
function splitOutsideParens(value: string, isSeparator: (char: string) => boolean): string[] {
  const pieces: string[] = [];
  let current = '';
  let depth = 0;
  for (const char of value) {
    if (char === '(') depth++;
    else if (char === ')' && depth > 0) depth--;
    if (depth === 0 && isSeparator(char)) {
      pieces.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  pieces.push(current);
  return pieces.map((piece) => piece.trim()).filter(Boolean);
}

/**
 * The `allowed-tools` field of a command or skill, as one list. Items of an array (block or
 * inline) are literal rules: `- Read, Task` is one item. A string is split on commas and whitespace
 * outside parentheses, so `Read, Task`, `Read Task` and `Bash(git *), Read` give `["Read", "Task"]`
 * and `["Bash(git *)", "Read"]`, and each item that is wholly quoted loses its quotes. A
 * parenthesis that never closes keeps the rest of the string in one item. That item is not a
 * valid rule, so whatever reads the list refuses it (`parseCapabilityRule` throws), as it does for
 * an array item written the same way. An empty string, or anything that is neither an array nor a
 * string, gives `undefined`, as an absent key does; an empty array stays empty, and what that
 * means is each caller's rule.
 */
export function parseAllowedTools(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value
      .map(String)
      .map((tool) => tool.trim())
      .filter(Boolean);
  }
  if (typeof value !== 'string') return undefined;
  const tools = splitOutsideParens(value, (char) => char === ',' || /\s/.test(char)).map(
    unquoteItem,
  );
  return tools.length ? tools : undefined;
}

/**
 * Minimal YAML frontmatter parser shared by commands, skills, and subagents.
 *
 * Handles string values, array values (lines starting with "-"), and quoted
 * values. Returns a {body, frontmatter} pair. If no frontmatter is found
 * (missing opening or closing ---), the entire input is treated as the body.
 */
export function parseFrontmatter(raw: string): {
  body: string;
  frontmatter: Record<string, unknown>;
} {
  // Normalize line endings before looking for the closing delimiter. Skill
  // packages are commonly authored on Windows and use CRLF; comparing a raw
  // `---\r` line with the delimiter used to make otherwise valid metadata look
  // like an unparsed body.
  const normalized = raw.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  // Must start with ---
  if (lines[0]?.trim() !== '---') {
    return { body: raw, frontmatter: {} };
  }
  const endIdx = lines.indexOf('---', 1);
  if (endIdx === -1) {
    // No closing ---; treat entire file as body.
    return { body: raw, frontmatter: {} };
  }
  const fmLines = lines.slice(1, endIdx);
  const body = lines
    .slice(endIdx + 1)
    .join('\n')
    .trim();
  const frontmatter: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentArray: string[] = [];

  for (const line of fmLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Array item: "- value"
    const arrayMatch = trimmed.match(/^-\s+(.+)$/);
    if (arrayMatch && currentKey) {
      currentArray.push(unquoteItem(arrayMatch[1]));
      continue;
    }

    // Flush any pending array.
    if (currentKey) {
      if (currentArray.length > 0) {
        frontmatter[currentKey] = currentArray;
      }
      currentKey = null;
      currentArray = [];
    }

    // key: value
    const kvMatch = trimmed.match(/^([a-z][a-zA-Z0-9_-]*)\s*:\s*(.*)$/);
    if (kvMatch) {
      const key = kvMatch[1];
      const value = kvMatch[2].trim();
      // Could be the start of an array (value empty or starts the array on next line).
      if (value === '') {
        currentKey = key;
        currentArray = [];
      } else {
        // Unquote if quoted. A tool list is quoted as a whole or item by item, never both.
        const isToolList = key === 'tools' || key === 'allowed-tools';
        const unquoted = isToolList
          ? value.replace(/^(["'])((?:(?!\1).)*)\1$/, '$2')
          : unquote(value);
        if (isToolList && unquoted.startsWith('[') && unquoted.endsWith(']')) {
          frontmatter[key] = splitOutsideParens(unquoted.slice(1, -1), (char) => char === ',').map(
            unquoteItem,
          );
        } else {
          frontmatter[key] = unquoted;
        }
      }
    }
  }
  // Flush any trailing array.
  if (currentKey && currentArray.length > 0) {
    frontmatter[currentKey] = currentArray;
  }

  return { body, frontmatter };
}
