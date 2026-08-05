import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  evaluateRunEligibility,
  type EvaluationEligibility,
} from '../src/harness/evaluation/eligibility.js';
import type { EvaluationControls } from '../src/harness/evaluation/runner.js';
import { query } from '../src/sdk.js';
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
  attribution?: EvaluationEligibility;
  controls?: EvaluationControls;
}

const MUTATION_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'ApplyPatch', 'NotebookEdit']);

function parseArgs(argv: string[]): { task?: string; model?: string } {
  const args: { task?: string; model?: string } = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--task') args.task = argv[++index];
    else if (argv[index] === '--model') args.model = argv[++index];
  }
  return args;
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
        outcome.totalTokens = event.usage?.totalTokens;
        outcome.attribution = evaluateRunEligibility(event.runs);
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
