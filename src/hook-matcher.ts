import { parseRule } from './permissions.js';

/**
 * How a `PreToolUse` or `PostToolUse` hook's `matcher` reads (#656), in one place for everything
 * that reads one: the hook runner deciding which calls a hook sees, the tool surface deciding
 * whether a hook targets ToolSearch and so gates direct calls (#619), and `book doctor` checking the
 * names against the registry. Two readings of the same text are how a hook comes to run where the
 * gate assumes it does not.
 *
 * The grammar is Claude Code's, with names where Claude Code has regular expressions:
 * - absent, empty or blank: every tool call;
 * - `*`: every tool;
 * - `Tool` or `Tool(pattern)`: one tool by its exact name, every call of it or those whose primary
 *   argument the pattern matches (the permission-rule format, read by `parseRule`; `*(pattern)` is
 *   the pattern on any tool);
 * - `A|B`: any of the alternatives, each read as above. The text splits on a `|` outside
 *   parentheses only, so `Bash(a|b)` is one alternative whose pattern holds a `|`.
 */

/** One alternative of a tool-event matcher: a tool, and the calls of it that it selects. */
export interface HookMatcherAlternative {
  /** The tool's name as written, trimmed, or `*` for every tool. */
  readonly tool: string;
  /** The primary-argument pattern between the parentheses, trimmed, or `null` for every call. */
  readonly pattern: string | null;
}

/** The text split on each `|` outside parentheses. An unclosed `(` keeps the rest in its part. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === '(') depth++;
    else if (character === ')') depth = Math.max(0, depth - 1);
    else if (character === '|' && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * The alternatives a tool-event matcher lists, in order, or `undefined` when it lists none (absent,
 * empty, blank, or nothing but separators), which matches every tool call as no matcher does. Each
 * is read as `parseRule` reads a permission rule: the tool is the text before the first `(`, and
 * the pattern runs to the last `)`. A `*` alternative is listed as written: it matches every tool,
 * and the caller reads the rest.
 */
export function hookMatcherAlternatives(
  matcher: string | undefined,
): HookMatcherAlternative[] | undefined {
  if (matcher === undefined) return undefined;
  const alternatives = splitTopLevel(matcher)
    .filter((part) => part.trim() !== '')
    .map((part): HookMatcherAlternative => {
      const { toolName, pattern } = parseRule(part);
      return { tool: toolName, pattern };
    });
  return alternatives.length > 0 ? alternatives : undefined;
}

/**
 * Whether a tool-event matcher can select some calls of this tool without selecting every call:
 * an alternative that names the tool, alone or in an alternation, with or without a pattern, or a
 * `*` narrowed by a pattern (`*(select:*)` reads every tool's primary argument, ToolSearch's query
 * included). A catch-all does not target it: a bare `*`, and a matcher that lists nothing, match
 * every call of every tool. A named tool targets it even beside a bare `*` (`ToolSearch|*`).
 */
export function hookMatcherTargetsTool(matcher: string | undefined, toolName: string): boolean {
  return (
    hookMatcherAlternatives(matcher)?.some(
      ({ tool, pattern }) => tool === toolName || (tool === '*' && pattern !== null),
    ) ?? false
  );
}
