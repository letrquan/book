/**
 * Edit-reliability eval: runs each fixture task against the configured model in
 * a throwaway workspace and verifies the resulting files with deterministic
 * predicates. Produces a per-model report under .book/reports/.
 *
 * Usage:
 *   npm run eval:edit                 # all tasks, configured/default model
 *   npm run eval:edit -- --model qc/qwen3.7-max --filter whitespace
 *
 * Requires a reachable provider (BOOK_API_KEY / settings). Never part of CI.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';
import {
  evaluationControlsFromResult,
  runEvaluationProcess,
} from '../src/harness/evaluation/runner.js';
import { slugifyWorkspace } from '../src/memory-store.js';
import { formatFailureCounts } from '../src/pricing.js';
import { isAnthropicProvider } from '../src/provider/index.js';
import type { AgentConfig } from '../src/types/runtime.js';
import { EVAL_TASKS, type EvalTask } from './edit-eval-fixtures.js';

import type { EditEvalTaskOutcome as TaskOutcome } from './edit-eval-worker.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isFiniteNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((item) => Number.isFinite(item));
}

function isEligibility(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.eligible === 'boolean' &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => typeof reason === 'string')
  );
}

const TASK_TIMEOUT_MS = (() => {
  const raw = process.env.BOOK_EVAL_TIMEOUT_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  // Empty or non-numeric values must not collapse to a 0/NaN (≈1ms) timeout.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 240_000;
})();
const EDIT_EVAL_WORKER = fileURLToPath(new URL('./edit-eval-worker.ts', import.meta.url));
const TSX_LOADER = import.meta.resolve('tsx');

function parseArgs(argv: string[]): { model?: string; filter?: string } {
  const args: { model?: string; filter?: string } = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--model') args.model = argv[++index];
    else if (argv[index] === '--filter') args.filter = argv[++index];
  }
  return args;
}

async function runCommand(command: string, commandArgs: string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(command, commandArgs, { cwd, stdio: 'ignore', shell: false });
    child.once('error', () => resolve());
    child.once('close', () => resolve());
  });
}

async function seedWorkspace(task: EvalTask, workspace: string): Promise<void> {
  for (const [relativePath, content] of Object.entries(task.files)) {
    const target = join(workspace, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  await runCommand('git', ['init', '--quiet'], workspace);
  await runCommand('git', ['add', '-A'], workspace);
  await runCommand(
    'git',
    ['-c', 'user.email=eval@book', '-c', 'user.name=book-eval', 'commit', '-qm', 'seed'],
    workspace,
  );
}

export function createEditEvaluationSettings(config: AgentConfig): Record<string, unknown> {
  const providerId = 'evaluation';
  const settings: Record<string, unknown> = {
    model: `${providerId}/${config.model}`,
    provider: {
      [providerId]: {
        type: isAnthropicProvider(config) ? 'anthropic' : 'openai',
        baseURL: config.baseUrl,
        apiKey: '{env:BOOK_API_KEY}',
        models: { [config.model]: config.modelInfo ?? {} },
      },
    },
    retry: { ...config.retry },
    agents: { mode: 'off' },
    memory: { enabled: false },
    skills: { enabled: false },
    observability: { toolTelemetry: false },
  };
  if (config.maxTokensExplicit) settings.maxTokens = config.maxTokens;
  if (config.effortExplicit && config.effort) settings.effort = config.effort;
  return settings;
}

export async function runEditEvalTask(task: EvalTask, model?: string): Promise<TaskOutcome> {
  const startedAt = Date.now();
  const failedOutcome = (runError: string): TaskOutcome => ({
    name: task.name,
    category: task.category,
    success: false,
    verified: false,
    runError,
    durationMs: Date.now() - startedAt,
    mutationCalls: {},
    failuresByCode: {},
    toolCalls: 0,
  });
  const configWorkspace = await mkdtemp(join(tmpdir(), 'book-edit-eval-config-'));
  let config: ReturnType<typeof loadConfig>;
  try {
    try {
      config = loadConfig(configWorkspace, { modelOverride: model });
    } catch (error) {
      return failedOutcome(error instanceof Error ? error.message : String(error));
    }
  } finally {
    await rm(configWorkspace, { recursive: true, force: true });
  }
  const isolatedSettings = createEditEvaluationSettings(config);

  let processResult: Awaited<ReturnType<typeof runEvaluationProcess>>;
  try {
    processResult = await runEvaluationProcess({
      command: process.execPath,
      args: ['--import', TSX_LOADER, EDIT_EVAL_WORKER, '--task', task.name],
      timeoutMs: TASK_TIMEOUT_MS,
      env: { BOOK_API_KEY: config.apiKey },
      prepare: async ({ workspace, bookHome }) => {
        await seedWorkspace(task, workspace);
        await writeFile(
          join(bookHome, 'settings.json'),
          JSON.stringify(isolatedSettings, null, 2),
          'utf8',
        );
      },
    });
  } catch (error) {
    return failedOutcome(error instanceof Error ? error.message : String(error));
  }
  let outcome: TaskOutcome;
  if (processResult.status === 'completed') {
    try {
      const line = processResult.stdout.trim().split(/\r?\n/).at(-1);
      if (!line) throw new Error('Edit evaluation worker returned no result.');
      const parsed: unknown = JSON.parse(line);
      if (
        !isRecord(parsed) ||
        parsed.name !== task.name ||
        parsed.category !== task.category ||
        typeof parsed.success !== 'boolean' ||
        typeof parsed.verified !== 'boolean' ||
        !Number.isFinite(parsed.durationMs) ||
        !Number.isFinite(parsed.toolCalls) ||
        !isFiniteNumberRecord(parsed.mutationCalls) ||
        !isFiniteNumberRecord(parsed.failuresByCode) ||
        (parsed.runError !== undefined && typeof parsed.runError !== 'string') ||
        (parsed.totalTokens !== undefined && !Number.isFinite(parsed.totalTokens)) ||
        (parsed.attribution !== undefined && !isEligibility(parsed.attribution))
      ) {
        throw new Error('Edit evaluation worker returned a malformed or mismatched task result.');
      }
      outcome = parsed as unknown as TaskOutcome;
      if (outcome.success && (!outcome.verified || outcome.attribution?.eligible !== true)) {
        throw new Error('Edit evaluation worker returned success without eligible run evidence.');
      }
    } catch (error) {
      outcome = failedOutcome(error instanceof Error ? error.message : String(error));
    }
  } else {
    outcome = failedOutcome(
      processResult.stderr.trim() || `Evaluation process ${processResult.status}.`,
    );
  }
  outcome.controls = evaluationControlsFromResult(processResult);
  outcome.durationMs = Date.now() - startedAt;
  return outcome;
}

async function main(): Promise<void> {
  const { model, filter } = parseArgs(process.argv.slice(2));
  const tasks = filter
    ? EVAL_TASKS.filter((task) => task.name.includes(filter) || task.category.includes(filter))
    : EVAL_TASKS;
  if (tasks.length === 0) {
    console.error(`No tasks match filter "${filter}".`);
    process.exitCode = 1;
    return;
  }

  console.log(`edit-eval: ${tasks.length} task(s)${model ? ` on ${model}` : ''}\n`);
  const outcomes: TaskOutcome[] = [];
  for (const task of tasks) {
    process.stdout.write(`  ${task.name} ... `);
    const outcome = await runEditEvalTask(task, model);
    outcomes.push(outcome);
    const failures = formatFailureCounts(outcome.failuresByCode);
    console.log(
      `${outcome.success ? 'PASS' : 'FAIL'} (${(outcome.durationMs / 1000).toFixed(1)}s` +
        `${failures ? `, tool failures: ${failures}` : ''}` +
        `${outcome.runError ? `, run error: ${outcome.runError.slice(0, 80)}` : ''})`,
    );
  }

  const passed = outcomes.filter((outcome) => outcome.success).length;
  const failureTotals: Record<string, number> = {};
  const mutationTotals: Record<string, number> = {};
  for (const outcome of outcomes) {
    for (const [code, count] of Object.entries(outcome.failuresByCode)) {
      failureTotals[code] = (failureTotals[code] ?? 0) + count;
    }
    for (const [tool, count] of Object.entries(outcome.mutationCalls)) {
      mutationTotals[tool] = (mutationTotals[tool] ?? 0) + count;
    }
  }

  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..*$/, '')
    .replace('T', '-');
  const modelSlug = slugifyWorkspace(model ?? 'default');
  const reportDir = join(process.cwd(), '.book', 'reports');
  await mkdir(reportDir, { recursive: true });
  const baseName = `edit-eval-${modelSlug}-${stamp}`;

  const markdown = [
    `# Edit reliability eval — ${model ?? 'configured default model'}`,
    '',
    `- Date: ${new Date().toISOString()}`,
    `- Result: **${passed}/${outcomes.length} passed**`,
    `- Mutation tool usage: ${
      Object.entries(mutationTotals)
        .map(([tool, count]) => `${tool} ×${count}`)
        .join(', ') || 'none'
    }`,
    `- Tool failures: ${formatFailureCounts(failureTotals) || 'none'}`,
    '',
    '## Evaluator Controls',
    '',
    '| Task | Date | Seed | Runtime | Fixture | Fixture capture |',
    '| --- | --- | --- | --- | --- | --- |',
    ...outcomes.map((outcome) => {
      const controls = outcome.controls;
      return controls
        ? `| ${outcome.name} | ${controls.evaluationDate} | ${controls.randomSeed} | ${controls.runtimeRevision} | ${controls.fixtureRevision} | ${controls.fixtureRevisionStatus} |`
        : `| ${outcome.name} | unavailable | unavailable | unavailable | unavailable | unavailable |`;
    }),
    '',
    '## Task Results',
    '',
    '| Task | Category | Result | Attribution | Duration | Mutation calls | Tool failures |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...outcomes.map(
      (outcome) =>
        `| ${outcome.name} | ${outcome.category} | ${outcome.success ? 'pass' : 'FAIL'} | ${outcome.attribution?.eligible ? 'eligible' : `ineligible:${outcome.attribution?.reasons.join(',') ?? 'missing'}`} | ${(outcome.durationMs / 1000).toFixed(1)}s | ${
          Object.entries(outcome.mutationCalls)
            .map(([tool, count]) => `${tool} ×${count}`)
            .join(', ') || '—'
        } | ${formatFailureCounts(outcome.failuresByCode) || '—'} |`,
    ),
    '',
  ].join('\n');

  await writeFile(join(reportDir, `${baseName}.json`), JSON.stringify(outcomes, null, 2), 'utf8');
  await writeFile(join(reportDir, `${baseName}.md`), markdown, 'utf8');
  console.log(`\n${passed}/${outcomes.length} passed. Report: .book/reports/${baseName}.md`);
  if (passed < outcomes.length) process.exitCode = 1;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) await main();
