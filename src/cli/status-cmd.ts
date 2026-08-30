import { join } from 'node:path';
import { SessionStore } from '../session/store.js';
import { resolveBookHome } from '../book-home.js';
import { estimateUsageCost } from '../pricing.js';
import { readRunStatus, type RunStatusRecord } from '../run-status.js';
import type { LoadedSession, SessionMeta } from '../types/sessions.js';
import type { Message } from '../types/messages.js';

/**
 * `book status` — what a long-running session is working on and what it has cost,
 * answerable without a provider credential.
 *
 * The question this exists for is asked at hour 180, often by a supervisor script
 * or by someone who has just walked back to the machine: *what was this asked to
 * do, how far has it got, and what has it spent?* Every input is already on disk.
 *
 * Credential-free by construction, and asserted so in
 * `src/cli/subcommands.contract.test.ts`: a run whose provider is misconfigured is
 * exactly when someone needs to read its state.
 *
 * The objective is read from the transcript rather than a summary because the
 * transcript is never rewritten by compaction — `SessionStore.load` truncates it
 * only for a rewind record — so the user's first words survive verbatim however
 * many generations have passed.
 *
 * The session JSONL answers "what was this asked to do and what has it spent".
 * What it cannot answer is *liveness*, which is the half a supervisor actually
 * needs mid-run: whether the process is alive, which turn it is on, what tool it
 * last called, and whether it finished cleanly or died. `src/run-status.ts` has
 * been writing exactly that to `<BOOK_HOME>/runs/<session-id>.json` at every turn
 * boundary, and nothing read it — a 20-minute print run that had done the work
 * correctly and one that died at turn 16 looked identical from outside, and the
 * only way to tell them apart was `jq` on a file with no documented reader. That
 * record is folded in here rather than into a new command: this is the surface
 * someone looks at, and it already runs without a credential.
 */

/**
 * What the liveness record says about the process, once the pid is tested.
 *
 * `died` is the case the record exists for: no terminal outcome and no crash
 * note, and the process is gone. Silence and a clean finish are indistinguishable
 * without it, which is the whole complaint.
 */
export type RunLiveness = 'running' | 'completed' | 'crashed' | 'died';

export interface RunStatus {
  liveness: RunLiveness;
  pid: number;
  /** True when the pid answers a signal-0 probe right now. */
  processAlive: boolean;
  runId: string;
  turn: number;
  elapsedMs: number;
  /** When the record was last rewritten — a running record that is old is wedged. */
  updatedAt: number;
  lastTool?: string;
  currentTodo?: string;
  openTodos: number;
  costUsd: number | null;
  budgetUsd?: number;
  freeDiskBytes?: number;
  terminal?: { status: string; reason: string; message?: string };
  crash?: { message: string; at: number };
}

/**
 * Does this pid still answer? Signal 0 performs the permission and existence
 * checks without delivering anything. `EPERM` means it exists under another
 * user, which is still alive; only `ESRCH` means gone.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function buildRunStatus(record: RunStatusRecord): RunStatus {
  const processAlive = isProcessAlive(record.pid);
  const liveness: RunLiveness = record.terminal
    ? 'completed'
    : record.crash
      ? 'crashed'
      : processAlive
        ? 'running'
        : 'died';

  return {
    liveness,
    pid: record.pid,
    processAlive,
    runId: record.runId,
    turn: record.turn,
    elapsedMs: record.elapsedMs,
    updatedAt: record.updatedAt,
    lastTool: record.lastTool,
    currentTodo: record.currentTodo,
    openTodos: record.openTodos,
    costUsd: record.costUsd,
    budgetUsd: record.budgetUsd,
    freeDiskBytes: record.freeDiskBytes,
    terminal: record.terminal ? { ...record.terminal } : undefined,
    crash: record.crash ? { ...record.crash } : undefined,
  };
}

export interface SessionStatus {
  sessionId: string;
  sessionName?: string;
  workspace: string;
  createdAt: number;
  updatedAt: number;
  /** Byte-exact text of the first user turn. */
  objective?: string;
  transcriptMessages: number;
  contextMessages: number;
  compactions: number;
  /** Newest checkpoint generation, or 0 when the session has never compacted. */
  generation: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
  };
  costUsd: number | null;
  costModels: string[];
  plan?: {
    todos: Array<{ content: string; status: string }>;
    tasks: Array<{ id: string; subject: string; status: string; blockedBy: string[] }>;
  };
  /** Absent when no run of this session ever wrote a liveness record. */
  run?: RunStatus;
}

function firstUserTurn(transcript: readonly Message[]): string | undefined {
  for (const message of transcript) {
    if (message.role !== 'user') continue;
    // Skip host-authored turns: checkpoints, agent notifications, and the loop's
    // own continuation and work-state messages are not what anyone asked for.
    if (message.kind && message.kind !== 'conversation') continue;
    if (message.content.startsWith('[continuation]')) continue;
    if (message.content.startsWith('[work-state]')) continue;
    if (message.agentNotifications?.length) continue;
    return message.content;
  }
  return undefined;
}

export function buildSessionStatus(
  meta: SessionMeta,
  loaded: LoadedSession,
  runRecord?: RunStatusRecord,
): SessionStatus {
  const usage = loaded.carriedUsage;
  const models = loaded.carriedModels ?? [];
  // Price at the most expensive model involved: the records do not attribute
  // tokens per model, so an upper bound is the honest reading.
  let costUsd: number | null = models.length > 0 && usage ? 0 : null;
  if (usage) {
    for (const model of models) {
      const quote = estimateUsageCost(model, {
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        cacheReadInputTokens: usage.cacheReadInputTokens,
        cacheCreationInputTokens: usage.cacheCreationInputTokens,
      });
      if (quote.status !== 'known') {
        costUsd = null;
        break;
      }
      costUsd = Math.max(costUsd ?? 0, quote.costUsd);
    }
  }

  return {
    sessionId: meta.id,
    sessionName: meta.name,
    workspace: meta.cwd,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    objective: firstUserTurn(loaded.transcript),
    transcriptMessages: loaded.transcript.length,
    contextMessages: loaded.contextHistory.length,
    compactions: loaded.compactBoundaries.length,
    generation: loaded.compactBoundaries.at(-1)?.generation ?? 0,
    usage: usage
      ? {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
          cacheCreationInputTokens: usage.cacheCreationInputTokens ?? 0,
        }
      : undefined,
    costUsd,
    costModels: models,
    plan: loaded.plan
      ? {
          todos: (loaded.plan.todos ?? []).map((todo) => ({
            content: todo.content,
            status: todo.status,
          })),
          tasks: (loaded.plan.tasks ?? []).map((task) => ({
            id: task.id,
            subject: task.subject,
            status: task.status,
            blockedBy: task.blockedBy,
          })),
        }
      : undefined,
    run: runRecord ? buildRunStatus(runRecord) : undefined,
  };
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim();
  return single.length <= max ? single : `${single.slice(0, max - 1)}…`;
}

function since(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function gibibytes(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}

/**
 * The liveness half of the report.
 *
 * Led by the one fact the session JSONL cannot supply — whether the process is
 * still there — because that is the question being asked when someone runs this
 * mid-run. A `running` record whose last write is old is the wedged case, and is
 * called out rather than left for the reader to compute from two timestamps.
 */
function renderRunStatus(run: RunStatus, now: number): string[] {
  const lines: string[] = [];
  const headline: Record<RunLiveness, string> = {
    running: `running (pid ${run.pid})`,
    completed: `finished — ${run.terminal?.status ?? 'unknown'} (${run.terminal?.reason ?? 'no reason recorded'})`,
    crashed: 'crashed without a terminal outcome',
    died: `no longer running, and recorded no outcome (pid ${run.pid} is gone)`,
  };
  lines.push(`Run: ${headline[run.liveness]}`);

  if (run.terminal?.message) lines.push(`  ${run.terminal.message}`);
  if (run.crash) lines.push(`  ${run.crash.message}`);

  lines.push(`  turn ${run.turn}  •  elapsed ${duration(run.elapsedMs)}`);
  lines.push(`  last update: ${since(run.updatedAt, now)}`);
  if (run.liveness === 'running' && now - run.updatedAt > STALE_RUN_MS) {
    lines.push(
      `  ⚠ the process is alive but has not written a turn boundary in ${duration(now - run.updatedAt)} —` +
        ' it may be wedged on a long tool call or a permission prompt.',
    );
  }
  if (run.lastTool) lines.push(`  last tool: ${run.lastTool}`);
  if (run.currentTodo) lines.push(`  in progress: ${truncate(run.currentTodo, 120)}`);
  if (run.openTodos > 0) lines.push(`  open todos: ${run.openTodos}`);

  if (run.costUsd !== null) {
    lines.push(
      `  spend: ~$${run.costUsd.toFixed(4)}` +
        (run.budgetUsd !== undefined ? ` of $${run.budgetUsd.toFixed(2)} budget` : ''),
    );
  }
  if (run.freeDiskBytes !== undefined) lines.push(`  free disk: ${gibibytes(run.freeDiskBytes)}`);

  return lines;
}

/** How long a live process may go without a turn boundary before it is worth naming. */
const STALE_RUN_MS = 15 * 60_000;

export function renderSessionStatus(status: SessionStatus, now = Date.now()): string {
  const lines: string[] = [];
  lines.push(`Session: ${status.sessionName ?? status.sessionId}`);
  if (status.sessionName) lines.push(`  id: ${status.sessionId}`);
  lines.push(`  workspace: ${status.workspace}`);
  lines.push(`  last activity: ${since(status.updatedAt, now)}`);
  lines.push('');

  // Before the objective: someone running this mid-run wants liveness first, and
  // someone reading it afterwards wants to know how the run ended before they
  // read what it was for.
  if (status.run) {
    lines.push(...renderRunStatus(status.run, now));
    lines.push('');
  }
  lines.push(
    status.objective
      ? `Objective: ${truncate(status.objective, 300)}`
      : 'Objective: (no user turn recorded)',
  );
  lines.push('');
  lines.push(
    `History: ${status.transcriptMessages} messages, ${status.contextMessages} in context` +
      (status.compactions > 0
        ? `  •  ${status.compactions} compaction${status.compactions === 1 ? '' : 's'} (generation ${status.generation})`
        : '  •  never compacted'),
  );

  if (status.usage) {
    const { promptTokens, completionTokens, cacheReadInputTokens, cacheCreationInputTokens } =
      status.usage;
    lines.push(
      `Tokens: prompt ${promptTokens.toLocaleString()}  •  completion ${completionTokens.toLocaleString()}  •  cache read ${cacheReadInputTokens.toLocaleString()}  •  cache write ${cacheCreationInputTokens.toLocaleString()}`,
    );
    lines.push(
      status.costUsd !== null
        ? `Spend: ~$${status.costUsd.toFixed(4)} (upper bound across ${status.costModels.join(', ') || 'unknown model'})`
        : 'Spend: (pricing unknown for at least one model used)',
    );
  } else {
    lines.push('Tokens: (none recorded — this session predates usage records, or never ran)');
  }

  if (status.plan) {
    const open = status.plan.todos.filter((todo) => todo.status !== 'completed');
    const openTasks = status.plan.tasks.filter(
      (task) => task.status !== 'completed' && task.status !== 'deleted',
    );
    lines.push('');
    lines.push(`Plan: ${open.length} open todo(s), ${openTasks.length} open task(s)`);
    for (const todo of open.slice(0, 10)) lines.push(`  [${todo.status}] ${todo.content}`);
    for (const task of openTasks.slice(0, 10)) {
      const blockers = task.blockedBy.length ? ` (blocked by ${task.blockedBy.join(', ')})` : '';
      lines.push(`  [${task.status}] ${task.subject}${blockers}`);
    }
  } else {
    lines.push('');
    lines.push('Plan: (none persisted)');
  }

  return lines.join('\n');
}

export interface StatusCommandOptions {
  session?: string;
  workspace: string;
  json?: boolean;
  /** Injectable so the contract test can run without touching a real BOOK_HOME. */
  store?: SessionStore;
  /** Where `runs/<session-id>.json` lives; injectable for the same reason. */
  home?: string;
  stdout?: { write: (text: string) => unknown };
}

export function runStatusCommand(options: StatusCommandOptions): number {
  const stdout = options.stdout ?? process.stdout;
  const home = options.home ?? resolveBookHome();
  const store = options.store ?? new SessionStore(join(home, 'sessions'));

  const meta = options.session
    ? (store.findById(options.session) ?? store.findByName(options.session))
    : store.mostRecentInCwd(options.workspace);

  if (!meta) {
    stdout.write(
      options.session
        ? `No session found matching "${options.session}".\n`
        : `No session has run in ${options.workspace} yet.\n`,
    );
    return 1;
  }

  const status = buildSessionStatus(meta, store.load(meta.id), readRunStatus(meta.id, home));
  stdout.write(
    options.json ? `${JSON.stringify(status, null, 2)}\n` : `${renderSessionStatus(status)}\n`,
  );
  return 0;
}
