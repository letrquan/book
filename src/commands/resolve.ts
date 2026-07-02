import { execSync } from 'child_process';
import type { SlashCommand } from '../types.js';

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
  resolved = resolved.replace(
    /\$\{BOOK_DATE\}/g,
    new Date().toISOString().split('T')[0],
  );

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
 * Each shell command runs via execSync with a 5-second timeout.
 * Output replaces the placeholder inline. Errors are collected.
 */
export function resolveShellInjection(
  body: string,
  workspace: string,
): { resolved: string; errors: string[] } {
  const errors: string[] = [];
  let resolved = body;

  // Fenced code blocks: ```! ... ```
  resolved = resolved.replace(
    /```!\s*\n([\s\S]*?)```/g,
    (_match: string, cmd: string) => {
      try {
        return execSync(cmd.trim(), {
          cwd: workspace,
          encoding: 'utf-8',
          timeout: 5000,
          maxBuffer: 1024 * 1024, // 1MB
          shell: process.env.ComSpec || 'cmd.exe',
        }).trim();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Shell block failed: ${msg}`);
        return `[shell error: ${msg}]`;
      }
    },
  );

  // Inline backtick commands: !`cmd` or `!cmd`
  resolved = resolved.replace(
    /!?`([^`]+)`/g,
    (_match: string, cmd: string) => {
      // Only expand patterns with ! prefix (either !`cmd` or `!cmd`).
      // Skip regular markdown inline code like `code`.
      const isShell = _match.startsWith('!`') || cmd.startsWith('!');
      if (!isShell) return _match;
      const shellCmd = cmd.startsWith('!') ? cmd.slice(1).trim() : cmd.trim();
      try {
        return execSync(shellCmd, {
          cwd: workspace,
          encoding: 'utf-8',
          timeout: 5000,
          maxBuffer: 1024 * 1024,
          shell: process.env.ComSpec || 'cmd.exe',
        }).trim();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`Shell command '${shellCmd}' failed: ${msg}`);
        return `[shell error: ${msg}]`;
      }
    },
  );

  return { resolved, errors };
}

/**
 * Resolve a command body by substituting arguments, named args, env vars,
 * and shell injections.
 *
 * Returns the fully resolved body and any shell errors encountered.
 */
export function resolveCommandBody(
  command: SlashCommand,
  args: string,
  context?: { sessionId?: string; workspace?: string; model?: string },
): { resolved: string; shellErrors: string[] } {
  const argv = parseArgs(args);
  const namedArgs = command.arguments ?? [];

  // Step 1: Resolve shell injections first (raw body, before var substitution).
  // This allows shell commands to produce text that may contain $variables.
  const { resolved: afterShell, errors } = resolveShellInjection(
    command.body,
    context?.workspace ?? process.cwd(),
  );

  // Step 2: Resolve variables ($ARGUMENTS, $1..$9, $name, ${ENV}).
  const resolved = resolveVariables(afterShell, argv, namedArgs, context);

  return { resolved, shellErrors: errors };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
