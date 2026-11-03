import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { evaluateRunEligibility, type EvaluationEligibility } from './eval-eligibility.js';
import type { EvaluationControls } from './eval-process.js';
import { query } from '../src/sdk.js';
import type { AgentRunResult } from '../src/types/runs.js';
import { EVAL_TASKS, type EvalTask } from './edit-eval-fixtures.js';

export interface EditEvalTaskOutcome {
  name: string;
  category: string;
  success: boolean;
  verified: boolean;
  runError?: string;
  durationMs: number;
  mutationCalls: Record<string, number>;
  failuresByCode: Record<string, number>;
  toolCalls: number;
  totalTokens?: number;
  /**
   * What the task cost, summed over the run records; null when a record's model has no price
   * (#663). An unpriced model does not fail the task: the eval scores it by verification and
   * says here that the dollars are unknown.
   */
  costUsd?: number | null;
  costStatus?: TaskCostStatus;
  attribution?: EvaluationEligibility;
  controls?: EvaluationControls;
}

type TaskCostStatus = 'known' | 'estimated' | 'unknown';

const COST_STATUS_RANK: Record<TaskCostStatus, number> = { known: 0, estimated: 1, unknown: 2 };

const MUTATION_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'ApplyPatch', 'NotebookEdit']);

function parseArgs(argv: string[]): { task?: string; model?: string } {
  const args: { task?: string; model?: string } = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--task') args.task = argv[++index];
    else if (argv[index] === '--model') args.model = argv[++index];
  }
  return args;
}

/**
 * Every token the task spent, summed over the result's run records. The `result`
 * event's own `usage` is only the latest request (the compaction gauge), which
 * counted a four-request task as about a quarter of its traffic. Each record's
 * accounting describes that one execution (snapshotRun), so a root's figure leaves
 * out its children and any second root; summing the records keeps both. A record
 * without accounting makes the total unknown rather than low, with no fallback to
 * `usage`; eligibility already fails closed on such a run.
 */
export function taskTotalTokens(runs: readonly AgentRunResult[] | undefined): number | undefined {
  if (!runs?.length) return undefined;
  let total = 0;
  for (const run of runs) {
    const usage = run.accounting?.directUsage;
    if (!usage) return undefined;
    total += usage.totalTokens;
  }
  return total;
}

/**
 * What the task spent in dollars, summed over the result's run records as {@link taskTotalTokens}
 * is, with the least certain record's status. A model Book has no price for (a router or BYOK
 * model that `provider.<id>.models.<model>.pricing` does not declare) makes the cost unknown rather
 * than low, and a record without accounting does too.
 */
export function taskCost(
  runs: readonly AgentRunResult[] | undefined,
): { costUsd: number | null; costStatus: TaskCostStatus } | undefined {
  if (!runs?.length) return undefined;
  let costUsd: number | null = 0;
  let costStatus: TaskCostStatus = 'known';
  for (const run of runs) {
    const accounting = run.accounting;
    if (!accounting) return { costUsd: null, costStatus: 'unknown' };
    if (COST_STATUS_RANK[accounting.costStatus] > COST_STATUS_RANK[costStatus]) {
      costStatus = accounting.costStatus;
    }
    costUsd = costUsd === null || accounting.costUsd === null ? null : costUsd + accounting.costUsd;
  }
  return costStatus === 'unknown' ? { costUsd: null, costStatus } : { costUsd, costStatus };
}

function collectVerifyPaths(task: EvalTask): string[] {
  return [...new Set([...Object.keys(task.files), ...(task.createdFiles ?? [])])];
}

export async function runEditEvalWorker(
  task: EvalTask,
  model?: string,
): Promise<EditEvalTaskOutcome> {
  const startedAt = Date.now();
  const outcome: EditEvalTaskOutcome = {
    name: task.name,
    category: task.category,
    success: false,
    verified: false,
    durationMs: 0,
    mutationCalls: {},
    failuresByCode: {},
    toolCalls: 0,
  };

  try {
    const events = query(
      `${task.instruction}\n\nWork only inside this workspace. When the change is complete, stop.`,
      {
        workspace: process.cwd(),
        model,
        permissionMode: 'bypassPermissions',
        persistSession: false,
        agents: 'off',
        maxTurns: 16,
      },
    );
    for await (const event of events) {
      if (event.type === 'tool_use') {
        outcome.toolCalls++;
        const name = event.toolCall.name;
        if (MUTATION_TOOLS.has(name)) {
          outcome.mutationCalls[name] = (outcome.mutationCalls[name] ?? 0) + 1;
        }
      } else if (event.type === 'tool_result') {
        const error = event.toolResult.structuredError;
        if (error) {
          outcome.failuresByCode[error.code] = (outcome.failuresByCode[error.code] ?? 0) + 1;
        }
      } else if (event.type === 'result') {
        outcome.totalTokens = taskTotalTokens(event.runs);
        const cost = taskCost(event.runs);
        if (cost) {
          outcome.costUsd = cost.costUsd;
          outcome.costStatus = cost.costStatus;
        }
        // The edit is what this eval measures. A router or BYOK model usually has no price, and
        // failing every task for that (`cost_unknown`) made the eval unusable on exactly the
        // cheap models it should compare (#663); the report records the cost as unknown instead.
        outcome.attribution = evaluateRunEligibility(event.runs, { requireKnownCost: false });
        if (!outcome.attribution.eligible && !outcome.runError) {
          outcome.runError = `ineligible evaluation evidence: ${outcome.attribution.reasons.join('; ')}`;
        }
        if (event.outcome?.status !== undefined && event.outcome.status !== 'completed') {
          outcome.runError = `${event.outcome.status}: ${event.outcome.reason}`;
        }
      } else if (event.type === 'error') {
        outcome.runError = event.error;
      }
    }
  } catch (error) {
    outcome.runError = error instanceof Error ? error.message : String(error);
  }

  const contents = new Map<string, string | null>();
  const readWorkspaceFile = (relativePath: string): string | null => {
    if (!contents.has(relativePath)) contents.set(relativePath, null);
    return contents.get(relativePath) ?? null;
  };
  for (const relativePath of collectVerifyPaths(task)) {
    try {
      contents.set(relativePath, await readFile(resolve(process.cwd(), relativePath), 'utf8'));
    } catch {
      contents.set(relativePath, null);
    }
  }
  try {
    outcome.verified = task.verify(readWorkspaceFile);
  } catch {
    outcome.verified = false;
  }
  outcome.success = outcome.verified && !outcome.runError && outcome.attribution?.eligible === true;
  outcome.durationMs = Date.now() - startedAt;
  return outcome;
}

async function main(): Promise<void> {
  const { task: taskName, model } = parseArgs(process.argv.slice(2));
  const task = EVAL_TASKS.find((candidate) => candidate.name === taskName);
  if (!task) throw new Error(`Unknown edit evaluation task: ${taskName ?? '<missing>'}`);
  const outcome = await runEditEvalWorker(task, model);
  process.stdout.write(JSON.stringify(outcome) + '\n');
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
