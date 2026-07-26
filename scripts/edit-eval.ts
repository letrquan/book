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

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { query } from '../src/sdk.js';
import { slugifyWorkspace } from '../src/memory-store.js';
import { formatFailureCounts } from '../src/pricing.js';
import { EVAL_TASKS, type EvalTask } from './edit-eval-fixtures.js';

interface TaskOutcome {
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
}

const MUTATION_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'ApplyPatch', 'NotebookEdit']);
const TASK_TIMEOUT_MS = (() => {
  const raw = process.env.BOOK_EVAL_TIMEOUT_MS;
  const parsed = raw === undefined ? NaN : Number(raw);
  // Empty or non-numeric values must not collapse to a 0/NaN (≈1ms) timeout.
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 240_000;
})();

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

async function seedWorkspace(task: EvalTask): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), 'book-edit-eval-'));
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
  return workspace;
}

async function runTask(task: EvalTask, model?: string): Promise<TaskOutcome> {
  const startedAt = Date.now();
  const outcome: TaskOutcome = {
    name: task.name,
    category: task.category,
    success: false,
    verified: false,
    durationMs: 0,
    mutationCalls: {},
    failuresByCode: {},
    toolCalls: 0,
  };
  const workspace = await seedWorkspace(task);
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error('eval task timeout')),
    TASK_TIMEOUT_MS,
  );

  try {
    const events = query(
      `${task.instruction}\n\nWork only inside this workspace. When the change is complete, stop.`,
      {
        workspace,
        model,
        permissionMode: 'bypassPermissions',
        persistSession: false,
        agents: 'off',
        maxTurns: 16,
        signal: controller.signal,
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
        if (error)
          outcome.failuresByCode[error.code] = (outcome.failuresByCode[error.code] ?? 0) + 1;
      } else if (event.type === 'result') {
        outcome.totalTokens = event.usage?.totalTokens;
      } else if (event.type === 'error') {
        outcome.runError = event.error;
      }
    }
  } catch (error) {
    outcome.runError = error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timeout);
  }

  const contents = new Map<string, string | null>();
  const readWorkspaceFile = (relativePath: string): string | null => {
    if (!contents.has(relativePath)) contents.set(relativePath, null);
    return contents.get(relativePath) ?? null;
  };
  for (const relativePath of collectVerifyPaths(task)) {
    try {
      contents.set(relativePath, await readFile(join(workspace, relativePath), 'utf8'));
    } catch {
      contents.set(relativePath, null);
    }
  }
  try {
    outcome.verified = task.verify(readWorkspaceFile);
  } catch {
    outcome.verified = false;
  }
  outcome.success = outcome.verified && !outcome.runError;
  outcome.durationMs = Date.now() - startedAt;
  await rm(workspace, { recursive: true, force: true });
  return outcome;
}

/** Seeded files plus paths the fixture declares it creates. */
function collectVerifyPaths(task: EvalTask): string[] {
  return [...new Set([...Object.keys(task.files), ...(task.createdFiles ?? [])])];
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
    const outcome = await runTask(task, model);
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
    '| Task | Category | Result | Duration | Mutation calls | Tool failures |',
    '| --- | --- | --- | --- | --- | --- |',
    ...outcomes.map(
      (outcome) =>
        `| ${outcome.name} | ${outcome.category} | ${outcome.success ? 'pass' : 'FAIL'} | ${(outcome.durationMs / 1000).toFixed(1)}s | ${
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

await main();
