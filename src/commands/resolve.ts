import { exec } from 'child_process';
import type { SlashCommand } from '../types/commands.js';

export interface ParsedSlashInput {
  name: string;
  rawArguments: string;
}

/** Parse slash input once; command identity is always an exact token match. */
export function parseSlashInput(value: string): ParsedSlashInput | null {
  if (!value.startsWith('/')) return null;
  const body = value.slice(1);
  const separator = body.search(/\s/);
  return separator === -1
    ? { name: body, rawArguments: '' }
    : { name: body.slice(0, separator), rawArguments: body.slice(separator + 1).trim() };
}

/**
 * Parse raw argument string with shell-style quoting.
 *
 * Examples:
 *   "hello world"       → ["hello", "world"]
 *   '"hello world" arg' → ["hello world", "arg"]
 *   ''                  → []
 */
export function parseArgs(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const argv: string[] = [];
  let current = '';
  let inDouble = false;
  let inSingle = false;

  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];

    if (inDouble) {
      if (ch === '"') {
        inDouble = false;
      } else {
        current += ch;
      }
    } else if (inSingle) {
      if (ch === "'") {
        inSingle = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inDouble = true;
      } else if (ch === "'") {
        inSingle = true;
      } else if (ch === ' ' || ch === '\t') {
        if (current.length > 0) {
          argv.push(current);
          current = '';
        }
      } else {
        current += ch;
      }
    }
  }

  if (current.length > 0) {
    argv.push(current);
  }

  return argv;
}

/**
 * Resolve all variables in a command body.
 *
 * Supported variables:
 *   $ARGUMENTS / $*   — all arguments joined by spaces
 *   $1 through $9     — positional arguments (1-indexed)
 *   $name             — named argument from `arguments` frontmatter
 *   ${BOOK_SESSION_ID} — current session ID
 *   ${BOOK_WORKSPACE}  — workspace root path
 *   ${BOOK_MODEL}      — current model name
 *   ${BOOK_DATE}       — current date (YYYY-MM-DD)
 */
export function resolveVariables(
  body: string,
  argv: string[],
  namedArgs: string[],
  context?: { sessionId?: string; workspace?: string; model?: string },
): string {
  let resolved = body;

  // $ARGUMENTS / $* — all arguments joined
  const allArgs = argv.join(' ');
  resolved = resolved.replace(/\$ARGUMENTS|\$\*/g, allArgs);

  // $1..$9 — positional arguments (1-indexed)
  for (let i = 1; i <= 9; i++) {
    const val = i <= argv.length ? argv[i - 1] : '';
    resolved = resolved.replace(new RegExp(`\\$${i}`, 'g'), val);
  }

  // $name — named arguments from `arguments` frontmatter
  for (let i = 0; i < namedArgs.length; i++) {
    const name = namedArgs[i];
    const val = i < argv.length ? argv[i] : '';
    resolved = resolved.replace(new RegExp(`\\$${escapeRegex(name)}`, 'g'), val);
  }

  // ${ENV_VAR} style
  if (context?.sessionId) {
    resolved = resolved.replace(/\$\{BOOK_SESSION_ID\}/g, context.sessionId);
  }
  if (context?.workspace) {
    resolved = resolved.replace(/\$\{BOOK_WORKSPACE\}/g, context.workspace);
  }
  if (context?.model) {
    resolved = resolved.replace(/\$\{BOOK_MODEL\}/g, context.model);
  }
  resolved = resolved.replace(/\$\{BOOK_DATE\}/g, new Date().toISOString().split('T')[0]);

  return resolved;
}

/**
 * Resolve inline shell commands and fenced shell blocks in a command body.
 *
 * Supports:
 *   `cmd`         — inline shell command (backtick-wrapped)
 *   ```!           — fenced code block for multi-line commands
 *   ```
 *
 * Each shell command runs asynchronously with a 5-second timeout.
 * Output replaces the placeholder inline. Errors are collected.
 */
export async function resolveShellInjection(
  body: string,
  workspace: string,
  signal?: AbortSignal,
): Promise<{ resolved: string; errors: string[] }> {
  const errors: string[] = [];
  let resolved = await replaceAsync(body, /```!\s*\n([\s\S]*?)```/g, async (_match, command) =>
    executeInjection(command.trim(), workspace, errors, 'block', signal),
  );

  resolved = await replaceAsync(resolved, /!?`([^`]+)`/g, async (match, command) => {
    const isShell = match.startsWith('!`') || command.startsWith('!');
    if (!isShell) return match;
    const shellCommand = command.startsWith('!') ? command.slice(1).trim() : command.trim();
    return executeInjection(shellCommand, workspace, errors, 'command', signal);
  });

  return { resolved, errors };
}

/**
 * Resolve a command body by substituting arguments, named args, env vars,
 * and shell injections.
 *
 * Returns the fully resolved body and any shell errors encountered.
 */
export async function resolveCommandBody(
  command: SlashCommand,
  args: string,
  context?: { sessionId?: string; workspace?: string; model?: string },
  signal?: AbortSignal,
): Promise<{ resolved: string; shellErrors: string[] }> {
  const argv = parseArgs(args);
  const namedArgs = command.arguments ?? [];

  // Step 1: Resolve shell injections first (raw body, before var substitution).
  // This allows shell commands to produce text that may contain $variables.
  const { resolved: afterShell, errors } = await resolveShellInjection(
    command.body,
    context?.workspace ?? process.cwd(),
    signal,
  );

  // Step 2: Resolve variables ($ARGUMENTS, $1..$9, $name, ${ENV}).
  const resolved = resolveVariables(afterShell, argv, namedArgs, context);

  return { resolved, shellErrors: errors };
}

async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (match: string, capture: string) => Promise<string>,
): Promise<string> {
  const matches = [...input.matchAll(pattern)];
  let output = '';
  let cursor = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    output += input.slice(cursor, index);
    output += await replacer(match[0], match[1]);
    cursor = index + match[0].length;
  }
  return output + input.slice(cursor);
}

function executeInjection(
  command: string,
  workspace: string,
  errors: string[],
  kind: 'block' | 'command',
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
        signal,
        windowsHide: true,
      },
      (error, stdout) => {
        if (!error) {
          resolve(stdout.trim());
          return;
        }
        const message = error.message;
        errors.push(
          kind === 'block'
            ? `Shell block failed: ${message}`
            : `Shell command '${command}' failed: ${message}`,
        );
        resolve(`[shell error: ${message}]`);
      },
    );
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
