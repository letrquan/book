import { join } from 'node:path';
import { SessionStore } from '../session/store.js';
import { resolveBookHome } from '../book-home.js';
import { estimateUsageCost } from '../pricing.js';
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
 */

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

export function buildSessionStatus(meta: SessionMeta, loaded: LoadedSession): SessionStatus {
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

export function renderSessionStatus(status: SessionStatus, now = Date.now()): string {
  const lines: string[] = [];
  lines.push(`Session: ${status.sessionName ?? status.sessionId}`);
  if (status.sessionName) lines.push(`  id: ${status.sessionId}`);
  lines.push(`  workspace: ${status.workspace}`);
  lines.push(`  last activity: ${since(status.updatedAt, now)}`);
  lines.push('');
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
  stdout?: { write: (text: string) => unknown };
}

export function runStatusCommand(options: StatusCommandOptions): number {
  const stdout = options.stdout ?? process.stdout;
  const store = options.store ?? new SessionStore(join(resolveBookHome(), 'sessions'));

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

  const status = buildSessionStatus(meta, store.load(meta.id));
  stdout.write(
    options.json ? `${JSON.stringify(status, null, 2)}\n` : `${renderSessionStatus(status)}\n`,
  );
  return 0;
}
