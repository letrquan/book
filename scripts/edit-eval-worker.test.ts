import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runEvaluationProcess } from '../src/harness/evaluation/runner.js';
import { evaluateRunEligibility } from '../src/harness/evaluation/eligibility.js';
import { query } from '../src/sdk.js';
import type { EvalTask } from './edit-eval-fixtures.js';
import { runEditEvalWorker } from './edit-eval-worker.js';

vi.mock('../src/sdk.js', () => ({ query: vi.fn() }));
vi.mock('../src/harness/evaluation/eligibility.js', () => ({
  evaluateRunEligibility: vi.fn(),
}));

async function* events(values: unknown[]): ReturnType<typeof query> {
  for (const value of values) yield value as never;
}

describe('runEditEvalWorker', () => {
  let workspace: string;
  let previousWorkspace: string;

  beforeEach(async () => {
    previousWorkspace = process.cwd();
    workspace = await mkdtemp(join(tmpdir(), 'book-edit-worker-'));
    process.chdir(workspace);
    vi.mocked(query).mockReset();
    vi.mocked(evaluateRunEligibility).mockReturnValue({
      eligible: true,
      reasons: [],
      rootRunId: 'root-run',
      ambientFingerprint: 'ambient',
      pricingVersion: 'pricing',
    });
  });

  afterEach(async () => {
    process.chdir(previousWorkspace);
    await rm(workspace, { recursive: true, force: true });
  });

  it('collects tool evidence and grades the final workspace state', async () => {
    const task: EvalTask = {
      name: 'worker-pass',
      category: 'test',
      files: { 'value.txt': 'before' },
      instruction: 'Change value.txt.',
      verify: (read) => read('value.txt') === 'after',
    };
    await writeFile(join(workspace, 'value.txt'), 'before', 'utf8');
    vi.mocked(query).mockImplementation(() => {
      return (async function* () {
        await writeFile(join(workspace, 'value.txt'), 'after', 'utf8');
        yield { type: 'tool_use', toolCall: { name: 'Edit' } } as never;
        yield {
          type: 'tool_result',
          toolResult: { structuredError: { code: 'transient_failure' } },
        } as never;
        yield {
          type: 'result',
          usage: { totalTokens: 42 },
          outcome: { status: 'completed', reason: 'normal_completion' },
        } as never;
      })();
    });

    const outcome = await runEditEvalWorker(task, 'provider/model');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('Change value.txt.'),
      expect.objectContaining({
        workspace,
        model: 'provider/model',
        agents: 'off',
        persistSession: false,
      }),
    );
    expect(outcome).toMatchObject({
      success: true,
      verified: true,
      toolCalls: 1,
      mutationCalls: { Edit: 1 },
      failuresByCode: { transient_failure: 1 },
      totalTokens: 42,
      attribution: { eligible: true },
    });
  });

  it('fails closed when the final run evidence is not attributable', async () => {
    const task: EvalTask = {
      name: 'worker-ineligible',
      category: 'test',
      files: { 'value.txt': 'expected' },
      instruction: 'Inspect value.txt.',
      verify: (read) => read('value.txt') === 'expected',
    };
    await writeFile(join(workspace, 'value.txt'), 'expected', 'utf8');
    vi.mocked(evaluateRunEligibility).mockReturnValue({
      eligible: false,
      reasons: ['ambient_partial:random_seed'],
    });
    vi.mocked(query).mockReturnValue(
      events([
        {
          type: 'result',
          usage: { totalTokens: 42 },
          outcome: { status: 'completed', reason: 'normal_completion' },
          runs: [],
        },
      ]),
    );

    await expect(runEditEvalWorker(task)).resolves.toMatchObject({
      success: false,
      verified: true,
      runError: 'ineligible evaluation evidence: ambient_partial:random_seed',
      attribution: { eligible: false },
    });
  });

  it('keeps non-completed terminal outcomes distinct from verifier success', async () => {
    const task: EvalTask = {
      name: 'worker-failed-run',
      category: 'test',
      files: { 'value.txt': 'expected' },
      instruction: 'Inspect value.txt.',
      verify: (read) => read('value.txt') === 'expected',
    };
    await writeFile(join(workspace, 'value.txt'), 'expected', 'utf8');
    vi.mocked(query).mockReturnValue(
      events([
        {
          type: 'result',
          outcome: { status: 'interrupted', reason: 'transport_interrupted' },
        },
      ]),
    );

    await expect(runEditEvalWorker(task)).resolves.toMatchObject({
      success: false,
      verified: true,
      runError: 'interrupted: transport_interrupted',
    });
  });

  it('loads the TypeScript worker from an isolated process workspace', async () => {
    const worker = fileURLToPath(new URL('./edit-eval-worker.ts', import.meta.url));
    const result = await runEvaluationProcess({
      command: process.execPath,
      args: ['--import', import.meta.resolve('tsx'), worker, '--task', 'missing-task'],
      timeoutMs: 5_000,
    });

    expect(result.status).toBe('failed');
    expect(result.stderr).toContain('Unknown edit evaluation task: missing-task');
  });
});
