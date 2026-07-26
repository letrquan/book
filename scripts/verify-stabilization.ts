import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

interface WorkflowRun {
  id: number;
  conclusion: string | null;
  created_at: string;
  event: string;
  head_sha: string;
  html_url: string;
}

interface Issue {
  number: number;
  title: string;
  html_url: string;
  pull_request?: unknown;
}

export interface StabilizationReport {
  ok: boolean;
  runWindow: WorkflowRun[];
  blockingRegressions: Array<Issue & { label: string }>;
  problems: string[];
}

export function evaluateStabilization(
  runs: readonly WorkflowRun[],
  issuesByLabel: ReadonlyMap<string, readonly Issue[]>,
  requiredGreenRuns: number,
): StabilizationReport {
  const eligibleRuns = runs.filter(
    (run) => run.event === 'push' || run.event === 'workflow_dispatch',
  );
  const runWindow = eligibleRuns.slice(0, requiredGreenRuns);
  const blockingRegressions = [...issuesByLabel.entries()].flatMap(([label, issues]) =>
    issues
      .filter((issue) => issue.pull_request === undefined)
      .map((issue) => ({ ...issue, label })),
  );
  const problems: string[] = [];

  if (runWindow.length < requiredGreenRuns) {
    problems.push(
      `Only ${runWindow.length} of ${requiredGreenRuns} required CI runs are available.`,
    );
  }

  const unsuccessful = runWindow.filter((run) => run.conclusion !== 'success');
  if (unsuccessful.length > 0) {
    problems.push(
      `The CI window contains ${unsuccessful.length} non-successful run(s): ${unsuccessful
        .map((run) => `${run.id} (${run.conclusion ?? 'unknown'})`)
        .join(', ')}.`,
    );
  }

  if (blockingRegressions.length > 0) {
    problems.push(
      `${blockingRegressions.length} unresolved lifecycle/accounting regression(s) remain open.`,
    );
  }

  return {
    ok: problems.length === 0,
    runWindow,
    blockingRegressions,
    problems,
  };
}

async function githubGet<T>(repository: string, path: string, token: string): Promise<T> {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'User-Agent': 'book-stabilization-gate',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} for ${path}: ${await response.text()}`);
  }
  return (await response.json()) as T;
}

async function verifyLabelExists(repository: string, label: string, token: string): Promise<void> {
  await githubGet(repository, `/labels/${encodeURIComponent(label)}`, token);
}

async function run(): Promise<void> {
  const repository = requiredEnv('GITHUB_REPOSITORY');
  const token = requiredEnv('GITHUB_TOKEN');
  const workflow = process.env.STABILIZATION_WORKFLOW ?? 'ci.yml';
  const branch = process.env.STABILIZATION_BRANCH ?? 'main';
  const requiredGreenRuns = positiveInteger(
    process.env.STABILIZATION_REQUIRED_GREEN_RUNS ?? '3',
    'STABILIZATION_REQUIRED_GREEN_RUNS',
  );
  const labels = (
    process.env.STABILIZATION_REGRESSION_LABELS ?? 'regression:lifecycle,regression:accounting'
  )
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);

  const runResponse = await githubGet<{ workflow_runs: WorkflowRun[] }>(
    repository,
    `/actions/workflows/${encodeURIComponent(workflow)}/runs?branch=${encodeURIComponent(branch)}&status=completed&per_page=100`,
    token,
  );
  const issuesByLabel = new Map<string, Issue[]>();
  for (const label of labels) {
    await verifyLabelExists(repository, label, token);
    const issues = await githubGet<Issue[]>(
      repository,
      `/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100`,
      token,
    );
    issuesByLabel.set(label, issues);
  }

  const report = evaluateStabilization(runResponse.workflow_runs, issuesByLabel, requiredGreenRuns);
  const summary = renderSummary(report, requiredGreenRuns);
  process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, summary, 'utf8');
  }
  if (!report.ok) process.exitCode = 1;
}

function renderSummary(report: StabilizationReport, requiredGreenRuns: number): string {
  const lines = [
    '# Stabilization gate',
    '',
    `Status: ${report.ok ? 'PASS' : 'HOLD'}`,
    '',
    `Required consecutive green CI runs: ${requiredGreenRuns}`,
    '',
    '| Run | Event | Commit | Conclusion | Created |',
    '| --- | --- | --- | --- | --- |',
    ...report.runWindow.map(
      (run) =>
        `| [${run.id}](${run.html_url}) | ${run.event} | \`${run.head_sha.slice(0, 7)}\` | ${run.conclusion ?? 'unknown'} | ${run.created_at} |`,
    ),
    '',
  ];

  if (report.blockingRegressions.length > 0) {
    lines.push('## Blocking regressions', '');
    for (const issue of report.blockingRegressions) {
      lines.push(`- [#${issue.number}](${issue.html_url}) ${issue.title} (\`${issue.label}\`)`);
    }
    lines.push('');
  }

  if (report.problems.length > 0) {
    lines.push('## Hold reasons', '', ...report.problems.map((problem) => `- ${problem}`), '');
  }

  return `${lines.join('\n')}\n`;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function positiveInteger(raw: string, name: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === currentFile) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
