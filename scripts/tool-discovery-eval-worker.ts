import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { freezeAgentConfig, loadConfig } from '../src/config.js';
import { runHeadless } from '../src/headless.js';
import { addUsage, promptSizeTokens } from '../src/pricing.js';
import { canonicalToolName } from '../src/tools/aliases.js';
import { createDefaultRegistry } from '../src/tools/registry.js';
import { toolSuccess } from '../src/tools/result.js';
import type { Message, Usage } from '../src/types/messages.js';
import type { AgentRunResult } from '../src/types/runs.js';
import type { SessionStoreInterface } from '../src/types/sessions.js';
import type { AgentTerminalOutcome } from '../src/types/terminal.js';
import type { ToolResult } from '../src/types/tools.js';
import { taskTotalTokens } from './edit-eval-worker.js';
import { evaluateRunEligibility, type EvaluationEligibility } from './eval-eligibility.js';
import {
  FIXTURE_SEARCH_RESULTS,
  FIXTURE_SESSION_EVENTS,
  TOOL_EVAL_TASKS,
  type ToolEvalFixture,
  type ToolEvalTask,
} from './tool-discovery-eval-tasks.js';

/** The fixture server's origin, set by `tool-discovery-eval.ts` for the worker. */
export const FIXTURE_URL_ENV = 'BOOK_TOOL_EVAL_FIXTURE_URL';

const MAX_TURNS = 12;

/** Token counts of one task, summed over its run records. */
export interface ToolEvalUsage {
  /** Every input token, cached or not. */
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface ToolEvalMetrics {
  /** The task's tool ran successfully and the outcome is right. */
  success: boolean;
  /** The outcome is right, by whatever path. */
  verified: boolean;
  /** The model turn, from 1, of the first call to the task's tool that succeeded. */
  firstCorrectCallTurn?: number;
  modelTurns: number;
  /** Calls that did the task another way: `curl` in Bash, a notebook rewritten by hand. */
  fallbacks: number;
  /** ToolSearch calls that left the task's tool unavailable. */
  toolSearchMisses: number;
  /** Calls Book refused before running them: not active, outside the rules, blocked. */
  refusals: number;
  unknownTools: number;
}

export interface ToolEvalWorkerOutcome extends ToolEvalMetrics {
  task: string;
  target: string;
  runError?: string;
  totalTokens?: number;
  usage?: ToolEvalUsage;
  attribution?: EvaluationEligibility;
  durationMs: number;
}

const REFUSAL_CODES = new Set([
  'tool_not_active',
  'arguments_not_allowed',
  'tool_discovery_budget_exceeded',
]);

/** Whether a ToolSearch result left `target` loaded or active. */
function madeAvailable(result: ToolResult | undefined, target: string): boolean {
  if (result?.status !== 'success') return false;
  const data = result.data as
    | {
        matches?: Array<{ name: string; loaded?: boolean }>;
        active?: string[];
        selections?: Array<{ name?: string; status: string }>;
      }
    | undefined;
  return Boolean(
    data?.matches?.some((match) => match.name === target && match.loaded) ||
    data?.active?.includes(target) ||
    data?.selections?.some(
      (selection) =>
        selection.name === target &&
        (selection.status === 'loaded' || selection.status === 'active'),
    ),
  );
}

/**
 * The metrics of one recorded run, from its messages: every model turn is an assistant message
 * Book did not write itself, and each call's result is found by its id wherever it was recorded.
 */
export function scoreToolEvalRun(
  task: ToolEvalTask,
  messages: readonly Message[],
  answer: string,
  readWorkspaceFile: (path: string) => string | null,
): ToolEvalMetrics {
  const results = new Map<string, ToolResult>();
  for (const message of messages) {
    for (const result of message.toolResults ?? []) results.set(result.toolCallId, result);
  }
  const turns = messages.filter((message) => message.role === 'assistant' && !message.hostNotice);
  const metrics: ToolEvalMetrics = {
    success: false,
    verified: false,
    modelTurns: turns.length,
    fallbacks: 0,
    toolSearchMisses: 0,
    refusals: 0,
    unknownTools: 0,
  };
  turns.forEach((turn, index) => {
    for (const call of turn.toolCalls ?? []) {
      const result = results.get(call.id);
      const name = canonicalToolName(call.name);
      const code = result?.structuredError?.code ?? '';
      if (code === 'unknown_tool') metrics.unknownTools++;
      else if (REFUSAL_CODES.has(code) || result?.status === 'blocked') metrics.refusals++;
      else if (name === 'ToolSearch' && !madeAvailable(result, task.target)) {
        metrics.toolSearchMisses++;
      }
      if (task.isFallback(call)) metrics.fallbacks++;
      if (
        metrics.firstCorrectCallTurn === undefined &&
        name === task.target &&
        result?.status === 'success'
      ) {
        metrics.firstCorrectCallTurn = index + 1;
      }
    }
  });
  try {
    metrics.verified = task.verify(answer, readWorkspaceFile);
  } catch {
    metrics.verified = false;
  }
  metrics.success = metrics.verified && metrics.firstCorrectCallTurn !== undefined;
  return metrics;
}

/**
 * A task's token counts, summed over its run records' `directUsage` as `taskTotalTokens` sums
 * them (#631). Unknown, not low, when a record has no accounting.
 */
export function taskUsage(runs: readonly AgentRunResult[] | undefined): ToolEvalUsage | undefined {
  if (!runs?.length) return undefined;
  let total: Usage | null = null;
  for (const run of runs) {
    const usage = run.accounting?.directUsage;
    if (!usage) return undefined;
    total = addUsage(total, usage);
  }
  if (!total) return undefined;
  return {
    inputTokens: promptSizeTokens(total),
    cacheReadTokens: total.cacheReadInputTokens ?? 0,
    cacheWriteTokens: total.cacheCreationInputTokens ?? 0,
    outputTokens: total.completionTokens,
  };
}

/** Why a run cannot count, every reason at once: its evidence is ineligible, it did not complete. */
export function runErrorOf(
  attribution: Pick<EvaluationEligibility, 'eligible' | 'reasons'>,
  outcome: Pick<AgentTerminalOutcome, 'status' | 'reason'>,
): string | undefined {
  const errors = [
    ...(attribution.eligible
      ? []
      : [`ineligible evaluation evidence: ${attribution.reasons.join('; ')}`]),
    ...(outcome.status === 'completed' ? [] : [`${outcome.status}: ${outcome.reason}`]),
  ];
  return errors.length > 0 ? errors.join('; ') : undefined;
}

/** SessionHistorySearch and SessionHistoryRead over the fixture's events. */
const fixtureSessionStore = {
  searchCurrent: () => FIXTURE_SESSION_EVENTS.map((event) => ({ ...event, timestamp: 0 })),
  readCurrent: (_id: string, refs: string[]) =>
    FIXTURE_SESSION_EVENTS.filter((event) => refs.includes(event.ref)).map((event) => ({
      ref: event.ref,
      content: event.preview,
    })),
} as unknown as SessionStoreInterface;

/**
 * Run one task in the current directory, the workspace `runEvaluationProcess` prepared, through
 * the print-mode runner with the default registry. Two tools answer from fixtures, in every mode:
 * WebSearch (its providers are fixed public endpoints) and the session history (print mode offers
 * none). Both keep their real definitions, so the catalog, the budgets and the schemas are Book's.
 */
export async function runToolEvalWorker(
  task: ToolEvalTask,
  fixture: ToolEvalFixture,
): Promise<ToolEvalWorkerOutcome> {
  const startedAt = Date.now();
  let messages: Message[] = [];
  let answer = '';
  const outcome: Omit<ToolEvalWorkerOutcome, keyof ToolEvalMetrics> = {
    task: task.name,
    target: task.target,
    durationMs: 0,
  };
  try {
    const config = freezeAgentConfig(loadConfig(process.cwd()));
    const registry = createDefaultRegistry({
      agents: false,
      sessionHistory: { store: fixtureSessionStore, sessionId: () => 'tool-eval' },
    });
    const webSearch = registry.getTool('WebSearch');
    if (webSearch) {
      registry.register({ ...webSearch, execute: async () => toolSuccess(FIXTURE_SEARCH_RESULTS) });
    }
    const result = await runHeadless(config, registry, {
      prompt: task.prompt(fixture),
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'bypassPermissions',
      maxTurns: MAX_TURNS,
      quiet: true,
      persistSession: false,
      stdout: { write: () => true },
    });
    messages = result.messages;
    answer = result.answer ?? '';
    outcome.totalTokens = taskTotalTokens(result.runs);
    outcome.usage = taskUsage(result.runs);
    // Scripted and unlisted models have no rate; the tokens are what this eval reads.
    outcome.attribution = evaluateRunEligibility(result.runs, { requireKnownCost: false });
    outcome.runError = runErrorOf(outcome.attribution, result.outcome);
  } catch (error) {
    outcome.runError = error instanceof Error ? error.message : String(error);
  }
  const files = new Map<string, string | null>();
  for (const path of Object.keys(task.files ?? {})) {
    files.set(path, await readFile(resolve(process.cwd(), path), 'utf8').catch(() => null));
  }
  const metrics = scoreToolEvalRun(task, messages, answer, (path) => files.get(path) ?? null);
  if (outcome.runError) metrics.success = false;
  return { ...outcome, ...metrics, durationMs: Date.now() - startedAt };
}

async function main(): Promise<void> {
  const index = process.argv.indexOf('--task');
  const name = index === -1 ? undefined : process.argv[index + 1];
  const task = TOOL_EVAL_TASKS.find((candidate) => candidate.name === name);
  if (!task) throw new Error(`Unknown tool-discovery evaluation task: ${name ?? '<missing>'}`);
  const baseUrl = process.env[FIXTURE_URL_ENV];
  if (!baseUrl) throw new Error(`${FIXTURE_URL_ENV} is not set.`);
  const outcome = await runToolEvalWorker(task, { baseUrl });
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
