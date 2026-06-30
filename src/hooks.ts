import { exec } from 'child_process';
import type { HookEntry, HookEvent } from './settings.js';
import { getPrimaryArg } from './tools/primary-arg.js';

/** Context passed to every hook invocation. */
export interface HookContext {
  workspace: string;
  event: HookEvent;
  /** For tool-related events: the canonical tool name. */
  toolName?: string;
  /** For tool-related events: the tool arguments. */
  toolArgs?: Record<string, unknown>;
  /** For UserPromptSubmit: the user's raw prompt. */
  userPrompt?: string;
  /** For PostToolUse: the tool result output (truncated). */
  toolOutput?: string;
}

/** Result of running a single hook. */
export interface HookResult {
  entry: HookEntry;
  action: 'continue' | 'block' | 'modify';
  /** When action === 'block': human-readable reason. */
  message?: string;
  /** When action === 'modify': the modified prompt / output. */
  modifiedPrompt?: string;
  modifiedOutput?: string;
}

const HOOK_TIMEOUT_MS = 10_000;

/**
 * Run a set of hooks for a given lifecycle event.
 * Hooks run sequentially in declaration order. If any PreToolUse/UserPromptSubmit
 * hook blocks, subsequent hooks are skipped and the block result is returned.
 *
 * @returns Array of hook results (non-blocking hooks always return all results).
 */
export async function runHooks(
  hooks: HookEntry[],
  event: HookEvent,
  ctx: HookContext,
): Promise<HookResult[]> {
  if (hooks.length === 0) return [];

  const results: HookResult[] = [];
  const blockingEvents: HookEvent[] = ['PreToolUse', 'UserPromptSubmit'];

  for (const entry of hooks) {
    // Filter by matcher if present (for tool events).
    if (entry.matcher && ctx.toolName) {
      if (!matchesHookMatcher(entry.matcher, ctx.toolName, ctx.toolArgs ?? {})) {
        continue;
      }
    }

    const result = await runSingleHook(entry, event, ctx);
    results.push(result);

    // On blocking events, stop after a block.
    if (blockingEvents.includes(event) && result.action === 'block') {
      break;
    }
  }

  return results;
}

/**
 * Check whether a hook entry's matcher pattern matches a tool call.
 * Uses the same Tool(specifier) format as permission rules.
 */
function matchesHookMatcher(
  matcher: string,
  toolName: string,
  args: Record<string, unknown>,
): boolean {
  // Reuse the permission rule parsing logic (dynamic import to avoid circular deps).
  try {
    // Inline simplified matcher — parse rule and test against primary arg.
    const parenIdx = matcher.indexOf('(');
    let ruleTool: string;
    let pattern: string | null = null;
    if (parenIdx === -1) {
      ruleTool = matcher.trim();
    } else {
      ruleTool = matcher.slice(0, parenIdx).trim();
      const closeIdx = matcher.indexOf(')', parenIdx);
      if (closeIdx > parenIdx) {
        pattern = matcher.slice(parenIdx + 1, closeIdx).trim() || null;
      }
    }

    if (ruleTool !== toolName) return false;
    if (pattern === null) return true; // match-all

    // Extract primary arg from tool arguments using shared utility.
    let primaryArg = getPrimaryArg(args);

    // Normalize leading ./ in paths.
    if (primaryArg.startsWith('./')) primaryArg = primaryArg.slice(2);
    let normPattern = pattern.startsWith('./') ? pattern.slice(2) : pattern;

    // Glob to regex: * → .* (zero or more). A trailing " *" (space-star)
    // idiom means "optionally followed by space and more args" (CC convention).
    let reStr = normPattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/ \*$/g, '( .*)?') // trailing " *" = optional args
      .replace(/\*/g, '.*');
    const re = new RegExp('^' + reStr + '$');
    return re.test(primaryArg);
  } catch {
    return false; // malformed matcher — skip
  }
}

async function runSingleHook(
  entry: HookEntry,
  event: HookEvent,
  ctx: HookContext,
): Promise<HookResult> {
  const inputPayload = JSON.stringify({
    hook: event,
    tool_name: ctx.toolName,
    tool_args: ctx.toolArgs,
    workspace: ctx.workspace,
    user_prompt: ctx.userPrompt,
    tool_output: ctx.toolOutput,
  });

  return new Promise<HookResult>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`⚠  Hook timed out after ${HOOK_TIMEOUT_MS / 1000}s: ${entry.command}`);
      resolve({ entry, action: 'continue' });
    }, HOOK_TIMEOUT_MS);

    const child = exec(
      entry.command,
      {
        env: { ...process.env, ...entry.env, BOOK_WORKSPACE: ctx.workspace },
        timeout: HOOK_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        clearTimeout(timer);

        if (error) {
          // Exit code 2 = block per CC's hook contract.
          if (error.code === 2) {
            // Try to parse a message from stdout.
            let message = '';
            try {
              const parsed = JSON.parse(stdout.trim());
              message = parsed.message ?? stdout.trim();
            } catch {
              message = stdout.trim() || 'Blocked by hook';
            }
            resolve({
              entry,
              action: 'block',
              message,
            });
            return;
          }

          // Non-zero exit but not a block — treat as continue with warning.
          console.warn(
            `⚠  Hook exited with code ${error.code}: ${entry.command}\n${stderr || error.message}`,
          );
          resolve({ entry, action: 'continue' });
          return;
        }

        // Success (exit code 0) — parse JSON response if available.
        try {
          const parsed = JSON.parse(stdout.trim());
          if (parsed.action === 'block') {
            resolve({
              entry,
              action: 'block',
              message: parsed.message,
            });
          } else if (parsed.action === 'modify') {
            resolve({
              entry,
              action: 'modify',
              modifiedPrompt: parsed.message ?? parsed.prompt,
              modifiedOutput: parsed.output,
            });
          } else {
            resolve({ entry, action: 'continue' });
          }
        } catch {
          // stdout isn't JSON — just continue.
          resolve({ entry, action: 'continue' });
        }
      },
    );

    // Write the event payload to stdin.
    child.stdin?.write(inputPayload);
    child.stdin?.end();
  });
}
