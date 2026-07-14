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
  const lines = raw.split('\n');
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
        frontmatter[key] = unquoted;
      }
    }
  }
  // Flush any trailing array.
  if (currentKey && currentArray.length > 0) {
    frontmatter[currentKey] = currentArray;
  }

  return { body, frontmatter };
}
