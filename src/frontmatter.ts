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
 * YAML identifier keys (`title:`); beside `Summary: what this covers`, or
 * alone, it is a heading, and the block is a rule followed by text.
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
      currentArray.push(arrayMatch[1]);
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
        // Unquote if quoted.
        const unquoted = value.replace(/^["'](.*)["']$/, '$1');
        if (
          (key === 'tools' || key === 'allowed-tools') &&
          unquoted.startsWith('[') &&
          unquoted.endsWith(']')
        ) {
          frontmatter[key] = unquoted
            .slice(1, -1)
            .split(',')
            .map((item) => item.trim().replace(/^["'](.*)["']$/, '$1'))
            .filter(Boolean);
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
