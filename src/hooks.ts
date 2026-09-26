import { spawn } from 'child_process';
import type { HookEntry, HookEvent } from './settings.js';
import { getPrimaryArg } from './tools/primary-arg.js';
import { parsePatch } from './tools/patch.js';
import { terminateForegroundProcess } from './jobs/process-tree.js';

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
  /** Active persisted conversation id for session lifecycle events. */
  sessionId?: string;
  /** How a session began (startup, resume, or clear). */
  source?: string;
  /** Why a session ended (clear, resume, exit, completion, aborted, or error). */
  reason?: string;
  /** For PreCompact/PostCompact: what triggered compaction. */
  trigger?: 'manual' | 'auto';
  /** For PreCompact/PostCompact: optional focus instructions from /compact. */
  focus?: string;
  /**
   * For PreCompact: sentences in the span about to be summarized that address
   * a summarizer and ask it to leave something out -- tool output or a file
   * expansion talking to the model. A hook that returns `block` refuses the
   * compaction; otherwise the reducer runs and the checkpoint records the refs.
   */
  suspectInputs?: Array<{ eventRef: string; excerpt: string }>;
  agentId?: string;
  agentRole?: string;
  parentSessionId?: string;
  worktree?: string;
  status?: string;
  stopReason?: string;
  /** Notification: how loudly this wants to be heard. Only `alarm` wakes anyone. */
  severity?: 'alarm' | 'warn' | 'info';
  /** Notification: a stable machine-readable kind, e.g. `agent_disk_space`. */
  kind?: string;
  /** Notification: human-readable detail. */
  message?: string;
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

export interface HookRunOptions {
  onHookEvent?: (event: string, payload: Record<string, unknown>) => void;
  signal?: AbortSignal;
  /** How long one hook may run before it is killed with every process it started. Default 10 s. */
  timeoutMs?: number;
}

const HOOK_TIMEOUT_MS = 10_000;
/** A hook writing more than this is ended, the way a runaway log would be: its output is not read. */
const HOOK_MAX_OUTPUT_BYTES = 1024 * 1024;

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
  opts?: HookRunOptions,
): Promise<HookResult[]> {
  opts?.signal?.throwIfAborted();
  if (hooks.length === 0) return [];

  opts?.onHookEvent?.(event, {
    event,
    toolName: ctx.toolName ?? null,
    toolArgs: ctx.toolArgs ?? null,
    userPrompt: ctx.userPrompt ?? null,
    sessionId: ctx.sessionId ?? null,
    source: ctx.source ?? null,
    reason: ctx.reason ?? null,
    trigger: ctx.trigger ?? null,
    focus: ctx.focus ?? null,
    suspectInputs: ctx.suspectInputs ?? null,
    agentId: ctx.agentId ?? null,
    agentRole: ctx.agentRole ?? null,
    parentSessionId: ctx.parentSessionId ?? null,
    worktree: ctx.worktree ?? null,
    status: ctx.status ?? null,
    stopReason: ctx.stopReason ?? null,
    severity: ctx.severity ?? null,
    kind: ctx.kind ?? null,
    message: ctx.message ?? null,
  });

  const results: HookResult[] = [];
  // `Stop` is blocking so a project can refuse a premature "I'm finished": the
  // hook's `block` becomes a continuation turn carrying its message. That is the
  // only way "do not consider this done until `npm run check` passes" is
  // expressible from outside the process at all.
  const blockingEvents: HookEvent[] = ['PreToolUse', 'UserPromptSubmit', 'PreCompact', 'Stop'];

  for (const entry of hooks) {
    opts?.signal?.throwIfAborted();
    // Filter by matcher when present.
    if (entry.matcher) {
      if (event === 'PreCompact' || event === 'PostCompact') {
        if (!matchesCompactTrigger(entry.matcher, ctx.trigger)) continue;
      } else if (ctx.toolName) {
        if (!matchesHookMatcher(entry.matcher, ctx.toolName, ctx.toolArgs ?? {})) {
          continue;
        }
      }
    }

    const result = await runSingleHook(
      entry,
      event,
      ctx,
      opts?.signal,
      opts?.timeoutMs ?? HOOK_TIMEOUT_MS,
    );
    results.push(result);

    // On blocking events, stop after a block.
    if (blockingEvents.includes(event) && result.action === 'block') {
      break;
    }
  }

  return results;
}

/** Match PreCompact/PostCompact hooks against trigger (`manual` | `auto` | `*`). */
function matchesCompactTrigger(matcher: string, trigger?: 'manual' | 'auto'): boolean {
  const m = matcher.trim();
  if (!m || m === '*') return true;
  if (!trigger) return false;
  // Support simple alternation: manual|auto
  return m.split('|').some((part) => part.trim() === trigger);
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

    const patchTargets =
      toolName === 'ApplyPatch' && args
        ? (() => {
            const parsed = parsePatch(args.patch);
            return 'operations' in parsed
              ? parsed.operations.map((operation) => operation.path)
              : [];
          })()
        : [];
    const compatibleTool =
      ruleTool === toolName ||
      (toolName === 'ApplyPatch' && (ruleTool === 'Edit' || ruleTool === 'Write'));
    if (!compatibleTool) return false;
    if (pattern === null) return true; // match-all

    if (patchTargets.length > 0 && (ruleTool === 'Edit' || ruleTool === 'Write')) {
      return patchTargets.some((path) => {
        const normalizedPath = path.startsWith('./') ? path.slice(2) : path;
        const normalizedPattern = pattern.startsWith('./') ? pattern.slice(2) : pattern;
        const reStr = normalizedPattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '.*')
          .replace(/ \*$/g, '( .*)?')
          .replace(/\*/g, '.*');
        return new RegExp(`^${reStr}$`).test(normalizedPath);
      });
    }

    // Extract primary arg from tool arguments using shared utility.
    let primaryArg = getPrimaryArg(args);

    // Normalize leading ./ in paths.
    if (primaryArg.startsWith('./')) primaryArg = primaryArg.slice(2);
    const normPattern = pattern.startsWith('./') ? pattern.slice(2) : pattern;

    // Glob to regex: * → .* (zero or more). A trailing " *" (space-star)
    // idiom means "optionally followed by space and more args" (CC convention).
    const reStr = normPattern
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
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<HookResult> {
  const inputPayload = JSON.stringify({
    hook: event,
    tool_name: ctx.toolName,
    tool_args: ctx.toolArgs,
    workspace: ctx.workspace,
    user_prompt: ctx.userPrompt,
    tool_output: ctx.toolOutput,
    session_id: ctx.sessionId,
    source: ctx.source,
    reason: ctx.reason,
    trigger: ctx.trigger,
    focus: ctx.focus,
    suspect_inputs: ctx.suspectInputs,
    agent_id: ctx.agentId,
    agent_role: ctx.agentRole,
    parent_session_id: ctx.parentSessionId,
    worktree: ctx.worktree,
    status: ctx.status,
    stop_reason: ctx.stopReason,
    severity: ctx.severity,
    kind: ctx.kind,
    message: ctx.message,
  });

  return new Promise<HookResult>((resolve, reject) => {
    let settled = false;
    // Set once a timeout, a cancellation or an output overflow has begun ending the tree, so the
    // 'close' that the kill itself causes is not mistaken for the hook's own result.
    let ending = false;
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    // Off Windows a hook runs in its own process group, so ending it reaches every process it
    // started; on Windows taskkill walks the tree instead.
    const child = spawn(entry.command, {
      shell: true,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        ...entry.env,
        BOOK_WORKSPACE: ctx.workspace,
        ...(ctx.sessionId ? { BOOK_SESSION_ID: ctx.sessionId } : {}),
        ...(ctx.agentId ? { BOOK_AGENT_ID: ctx.agentId } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    /**
     * End the hook's whole process tree and let go of its pipes. A process the kill cannot reach
     * (on Windows, one whose parent has already exited) would otherwise hold the pipes, and with
     * them the host's event loop, open. Resolves once the kill has finished, because on Windows
     * taskkill is a child of this process and would die with it if the host exited first.
     */
    const endTree = async (): Promise<void> => {
      ending = true;
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      await terminateForegroundProcess(child);
    };

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const settle = (result: HookResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const collect = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > HOOK_MAX_OUTPUT_BYTES) {
        if (settled || ending) return;
        console.warn(`⚠  Hook output exceeded 1 MB: ${entry.command}`);
        void endTree().finally(() => settle({ entry, action: 'continue' }));
        return;
      }
      if (stream === 'stdout') stdout += chunk.toString('utf8');
      else stderr += chunk.toString('utf8');
    };
    child.stdout?.on('data', collect('stdout'));
    child.stderr?.on('data', collect('stderr'));

    child.on('close', (code, exitSignal) => {
      if (settled || ending) return;
      if (signal?.aborted) {
        fail(signal.reason ?? new DOMException('Hook execution aborted', 'AbortError'));
        return;
      }
      if (code === 2) {
        // Exit code 2 = block per CC's hook contract.
        let message = stderr.trim();
        if (!message) {
          try {
            const parsed = JSON.parse(stdout.trim());
            message = parsed.message ?? stdout.trim();
          } catch {
            message = stdout.trim() || 'Blocked by hook';
          }
        }
        settle({
          entry,
          action: 'block',
          message,
        });
        return;
      }

      // Non-zero exit but not a block — treat as continue with warning.
      if (code !== 0) {
        const how = code === null ? `signal ${exitSignal}` : `code ${code}`;
        console.warn(`⚠  Hook exited with ${how}: ${entry.command}\n${stderr}`);
        settle({ entry, action: 'continue' });
        return;
      }

      // Success (exit code 0) — parse JSON response if available.
      try {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.action === 'block') {
          settle({
            entry,
            action: 'block',
            message: parsed.message,
          });
        } else if (parsed.action === 'modify') {
          settle({
            entry,
            action: 'modify',
            modifiedPrompt: parsed.message ?? parsed.prompt,
            modifiedOutput: parsed.output,
          });
        } else {
          settle({ entry, action: 'continue' });
        }
      } catch {
        // stdout isn't JSON — just continue.
        settle({ entry, action: 'continue' });
      }
    });
    child.on('error', (error) => {
      if (settled || ending) return;
      console.warn(`⚠  Hook failed to start: ${entry.command}\n${error.message}`);
      settle({ entry, action: 'continue' });
    });

    const onAbort = () => {
      if (settled || ending) return;
      const reason = signal?.reason ?? new DOMException('Hook execution aborted', 'AbortError');
      void endTree().finally(() => fail(reason));
    };
    const timer = setTimeout(() => {
      if (settled || ending) return;
      console.warn(`⚠  Hook timed out after ${timeoutMs / 1000}s: ${entry.command}`);
      void endTree().finally(() => settle({ entry, action: 'continue' }));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });

    if (signal?.aborted) onAbort();

    // Some hooks exit before reading stdin. Treat a closed pipe as normal hook
    // lifecycle instead of surfacing an unhandled EPIPE from the parent process.
    if (child.stdin) {
      child.stdin.once('error', () => {});
      child.stdin.end(inputPayload);
    }
  });
}
