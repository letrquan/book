/**
 * Wrap arbitrary text so a markdown renderer shows it verbatim.
 *
 * Local transcript messages (`addLocalMessage`) are prose: they go through
 * `MarkdownBlock`, so any text interpolated into one is markdown. A background
 * shell command is not — a command carrying a `KILLPROBE` block comment lost
 * both of its asterisks to the `em` token, and the completion row disagreed
 * with the tool row directly above it about which command had just finished.
 * Asterisks are only the visible half of the class: `#`, `[x](y)`, `~~` and `_`
 * are all live in prose too.
 *
 * A code span is the escape hatch, but only if the fence survives the content:
 *
 * - **Line breaks first.** Block parsing runs before inline parsing, so a `#`
 *   or a fence line at the start of an embedded line splits the paragraph and
 *   strands the opening backtick as a literal. Flatten to one line and the
 *   fence has a single paragraph to live in.
 * - **Fence longer than any run inside.** ``echo `date` `` needs a two-backtick
 *   fence, or the span closes on the command's own backtick.
 * - **Pad when the edges collide.** A leading or trailing backtick would fuse
 *   with the fence; CommonMark strips one space from each end when both are
 *   present, so the padding does not survive into the rendered text.
 */
export function inlineCode(text: string): string {
  const oneLine = text.replace(/\r\n|\r|\n/g, ' ');
  // Nothing to quote. An empty span is not a code span at all, so a fence here
  // would leave two stray backticks sitting in the row.
  if (!oneLine.trim()) return '';

  const longestRun = [...oneLine.matchAll(/`+/g)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0,
  );
  const fence = '`'.repeat(longestRun + 1);
  const pad = /^[`\s]|[`\s]$/.test(oneLine) ? ' ' : '';
  return `${fence}${pad}${oneLine}${pad}${fence}`;
}
