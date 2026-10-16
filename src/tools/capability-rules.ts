import { posix } from 'path';
import type { ToolCall, ToolDefinition } from '../types/tools.js';
import { canonicalToolName } from './aliases.js';
import { globToRegex } from './glob-regex.js';
import { comparablePath } from './path-utils.js';
import { getPrimaryArg } from './primary-arg.js';
import { SHELL_CHAINING } from './shell-chaining.js';
import { strictRmMatchesGlob } from './strict-rm.js';

/** Tools whose rule pattern names one file, so a call is matched by the path it really names. */
const FILE_PATH_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

/**
 * A rule `Bash(rm /abs/…)` or `Bash(rm C:/abs/…)`: read operand by operand, not as one glob over
 * the line. The rule is written with `/` (see `memoryConsolidateTools`), but a `\` drive path is
 * read as well.
 */
const ABSOLUTE_RM_RULE = /^rm +((?:\/|[A-Za-z]:[\\/]).*)$/;

export interface CapabilityRule {
  raw: string;
  tool: string;
  pattern?: string;
  wildcard: boolean;
}

export function parseCapabilityRule(rawRule: string): CapabilityRule {
  const raw = rawRule.trim();
  if (!raw) throw new Error('Capability rules must not be empty');
  if (raw === '*') return { raw, tool: '*', wildcard: true };

  const open = raw.indexOf('(');
  if (open === -1) return { raw, tool: canonicalToolName(raw), wildcard: false };
  if (!raw.endsWith(')') || open === 0) throw new Error(`Invalid capability rule: ${rawRule}`);

  const tool = canonicalToolName(raw.slice(0, open).trim());
  const pattern = raw.slice(open + 1, -1).trim();
  if (!tool || !pattern) throw new Error(`Invalid capability rule: ${rawRule}`);
  return { raw, tool, pattern, wildcard: false };
}

export function parseCapabilityRules(rules: string[]): CapabilityRule[] {
  return rules.map(parseCapabilityRule);
}

export function isToolDefinitionAllowed(
  rules: CapabilityRule[],
  definition: Pick<ToolDefinition, 'name'>,
  wildcardExclusions: ReadonlySet<string> = new Set(),
): boolean {
  const canonical = canonicalToolName(definition.name);
  return rules.some(
    (rule) =>
      (!rule.wildcard && rule.tool === canonical) ||
      (rule.wildcard && !wildcardExclusions.has(canonical)),
  );
}

export function isToolCallAllowed(
  rules: CapabilityRule[],
  call: ToolCall,
  wildcardExclusions: ReadonlySet<string> = new Set(),
  platform: NodeJS.Platform = process.platform,
): boolean {
  const canonical = canonicalToolName(call.name);
  const isFileTool = FILE_PATH_TOOLS.has(canonical);
  let primary = getPrimaryArg(call.arguments).replace(/^\.\//, '');
  // `*` crosses `/`, so `Write(/memory/*.md)` would match `/memory/../elsewhere/x.md` as written.
  // A file is matched by the path it names, with its `.` and `..` segments resolved. Rule and call
  // are compared in one spelling (`/` separators, case folded on Windows), and the segments are
  // resolved with the POSIX `normalize`: the platform's would turn `src/a.ts` into `src\a.ts` on
  // Windows, which no `/` pattern matches.
  if (isFileTool) primary = posix.normalize(comparablePath(primary, platform));

  return rules.some((rule) => {
    if (rule.wildcard) return !wildcardExclusions.has(canonical);
    if (rule.tool !== canonical) return false;
    if (rule.pattern === undefined) return true;
    // A command pattern is not a path and is matched as written; only an `rm` rule's operand is.
    const normalizedPattern = (
      isFileTool ? comparablePath(rule.pattern, platform) : rule.pattern
    ).replace(/^\.\//, '');
    // A glob over a command line cannot say "and nothing else" (`*` crosses `;`, `&&` and spaces),
    // so a rule that names an absolute path to remove admits a line that is a plain `rm` of such
    // paths and nothing more. The whole command is read: the primary argument is only its first line.
    const rm = canonical === 'Bash' ? ABSOLUTE_RM_RULE.exec(normalizedPattern) : null;
    if (rm) {
      const command = call.arguments.command;
      const operand = globToRegex(comparablePath(rm[1], platform));
      return (
        typeof command === 'string' &&
        strictRmMatchesGlob(
          command,
          (path) => operand.test(comparablePath(path, platform)),
          platform,
        )
      );
    }
    if (canonical === 'Bash') {
      // Under a command glob a compound command is refused outright, quoted or not, and the whole
      // command is matched: the primary argument is only its first line.
      const command = call.arguments.command;
      if (typeof command !== 'string' || isCompoundShellCommand(call)) return false;
      return globToRegex(normalizedPattern).test(command.trim().replace(/^\.\//, ''));
    }
    return globToRegex(normalizedPattern).test(primary);
  });
}

/**
 * Whether a call is a Bash command that chains, pipes, redirects or substitutes, which a
 * `Bash(<glob>)` capability rule refuses. This is the one predicate behind both the gate in
 * {@link isToolCallAllowed} and the refusal text the model reads.
 *
 * Surrounding whitespace is not part of the command (a model often ends one with a newline), so it
 * is trimmed first; a newline inside the command still counts. An inner carriage return counts too:
 * PowerShell reads a bare CR as a line break.
 */
export function isCompoundShellCommand(call: ToolCall): boolean {
  const command = call.arguments.command;
  if (canonicalToolName(call.name) !== 'Bash' || typeof command !== 'string') return false;
  const trimmed = command.trim();
  return SHELL_CHAINING.test(trimmed) || trimmed.includes('\r');
}

/** What a capability refusal of a compound Bash command says was wrong with the command. */
export const COMPOUND_COMMAND_REFUSAL =
  'The command was refused because it chains, pipes, redirects or substitutes (`;`, `&`, `|`, `<`, `>`, `$`, `(`, `)`, `{`, `}`, a backtick, or a newline), even inside quotes.';

/** What a capability refusal of a compound Bash command tells the model to do instead. */
export const COMPOUND_COMMAND_REMEDIATION =
  "Send each command as its own Bash call, and make each call match the run's allowed-tools rules (a skill's, command's or agent role's allowed-tools); or rewrite the command without these characters (for example, a commit message without parentheses); or use a different tool.";
