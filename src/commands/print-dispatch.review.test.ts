/**
 * `/review` in a host with no interactive surface (`book -p /review`).
 *
 * The managed-agent runtime is stubbed — these tests are about the wiring the
 * print host owns: that the target is resolved host-side before any reviewer
 * starts, that every scope form survives the trip, and that the paths a
 * non-interactive host must not take (`--fix`, a failed review, a typo) end the
 * run instead of printing something reassuring.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PrintCommandUsageError,
  resolvePrintCommand,
  UnsupportedPrintCommandError,
  type PrintCommandEnvironment,
} from './print-dispatch.js';
import type { AgentManager } from '../agents/manager.js';
import type { ReviewJsonReport } from '../review/host.js';
import { createAgentRunContext, type AgentRunContext } from '../types/runs.js';
import { defaultConfig } from '../test/fixtures.js';

let workspace: string;
let home: string;
const previousBookHome = process.env.BOOK_HOME;

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-print-review-'));
  // Keep the developer's own ~/.book/commands out of discovery.
  home = mkdtempSync(join(tmpdir(), 'book-print-review-home-'));
  process.env.BOOK_HOME = home;
  git(workspace, 'init', '-q');
  git(workspace, 'config', 'user.email', 'book-tests@example.invalid');
  git(workspace, 'config', 'user.name', 'Book Tests');
  writeFileSync(join(workspace, 'a.ts'), 'export const value = 1;\n', 'utf8');
  git(workspace, 'add', '.');
  git(workspace, 'commit', '-qm', 'initial');
  writeFileSync(join(workspace, 'a.ts'), 'export const value = 2;\n', 'utf8');
});

afterEach(() => {
  for (const dir of [workspace, home]) rmSync(dir, { recursive: true, force: true });
  if (previousBookHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = previousBookHome;
});

interface SpawnRequest {
  agent: string;
  prompt: string;
  parentSessionId?: string;
  rootRunId?: string;
  parentRunId?: string;
}

interface StubManager {
  manager: AgentManager;
  prompts: string[];
  agents: string[];
  spawns: SpawnRequest[];
}

/**
 * Minimal stand-in for the managed-agent runtime: `reviewRunnerFor` calls only
 * `spawn`, `wait`, and `stop`, so the review pipeline is exercised for real
 * while no agent process is started.
 */
function stubManager(results: string[]): StubManager {
  const prompts: string[] = [];
  const agents: string[] = [];
  const spawns: SpawnRequest[] = [];
  const manager = {
    async spawn(request: SpawnRequest) {
      agents.push(request.agent);
      prompts.push(request.prompt);
      spawns.push(request);
      return { id: `agent-${agents.length - 1}`, status: 'queued' };
    },
    async wait(id: string) {
      const index = Number(id.slice('agent-'.length));
      return { id, status: 'completed', result: results[index] };
    },
    async stop() {},
  };
  return { manager: manager as unknown as AgentManager, prompts, agents, spawns };
}

function env(stub?: StubManager, runContext = reviewRunContext()): PrintCommandEnvironment {
  return {
    config: defaultConfig({ workspace, model: 'test-model' }),
    mode: 'default',
    sessionId: 'session-review-1',
    agents: stub ? { manager: () => stub.manager, runContext } : undefined,
  };
}

function reviewRunContext(): AgentRunContext {
  return createAgentRunContext({ sessionId: 'session-review-1', source: 'headless' });
}

function findingJson(file = 'a.ts'): string {
  return JSON.stringify({
    verdict: 'recommend',
    findings: [
      {
        severity: 'critical',
        category: 'correctness',
        file,
        line: 1,
        summary: 'the exported constant changed meaning',
        evidence: 'export const value = 2;',
        failure: 'downstream callers branch on value === 1',
        suggestedFix: 'keep the old constant and add a new one',
        confidence: 95,
      },
    ],
  });
}

const CLEAN = JSON.stringify({ verdict: 'clean', findings: [] });

function deepResults(): string[] {
  return [
    findingJson(),
    CLEAN,
    CLEAN,
    CLEAN,
    JSON.stringify({
      verdicts: [{ findingId: 'finding-1', state: 'confirmed', reason: 'verified in source' }],
    }),
  ];
}

function reviewData(dispatch: Awaited<ReturnType<typeof resolvePrintCommand>>): ReviewJsonReport {
  if (dispatch.kind !== 'handled')
    throw new Error(`expected a handled dispatch, got ${dispatch.kind}`);
  return dispatch.data as ReviewJsonReport;
}

describe('book -p /review', () => {
  it('performs the review in the host and runs no model turn', async () => {
    const stub = stubManager([findingJson()]);

    const dispatch = await resolvePrintCommand('/review', env(stub));

    expect(dispatch.kind).toBe('handled');
    if (dispatch.kind !== 'handled') throw new Error('unreachable');
    expect(dispatch.command).toBe('review');
    expect(dispatch.output).toContain('Verdict: recommend');
    expect(dispatch.output).toContain('the exported constant changed meaning');
    expect(stub.agents).toEqual(['reviewer']);
  });

  it('resolves the target host-side and hands the reviewer an immutable diff', async () => {
    const stub = stubManager([findingJson()]);

    const data = reviewData(await resolvePrintCommand('/review', env(stub)));

    expect(stub.prompts[0]).toContain('## Immutable review target');
    expect(stub.prompts[0]).toContain('export const value = 2;');
    expect(stub.prompts[0]).toContain('Do not run GitDiff to select a different target');
    expect(data.target).toEqual({
      kind: 'working-tree',
      baseSha: git(workspace, 'rev-parse', 'HEAD'),
      headSha: undefined,
      path: undefined,
      changedFiles: ['a.ts'],
    });
  });

  it('emits the documented JSON shape for machine consumers', async () => {
    const stub = stubManager([findingJson()]);

    const data = reviewData(await resolvePrintCommand('/review', env(stub)));

    expect(Object.keys(data).sort()).toEqual(['coverage', 'findings', 'target', 'verdict']);
    expect(data.verdict).toBe('recommend');
    expect(data.findings).toEqual([
      {
        id: 'finding-1',
        severity: 'critical',
        category: 'correctness',
        file: 'a.ts',
        line: 1,
        summary: 'the exported constant changed meaning',
        evidence: 'export const value = 2;',
        failure: 'downstream callers branch on value === 1',
        suggestedFix: 'keep the old constant and add a new one',
        confidence: 95,
      },
    ]);
    expect(data.coverage?.reviewers).toEqual([{ id: 'single', status: 'completed', findings: 1 }]);
    // The diff is the host's input, not part of the contract.
    expect(JSON.stringify(data)).not.toContain('diff --git');
  });

  it('runs every lens and the falsification pass for --deep', async () => {
    const stub = stubManager(deepResults());

    const data = reviewData(await resolvePrintCommand('/review --deep', env(stub)));

    expect(stub.agents).toEqual(['reviewer', 'reviewer', 'reviewer', 'reviewer', 'reviewer']);
    expect(stub.prompts[4]).toContain('try to DISPROVE each finding');
    expect(data.findings[0]?.verification).toBe('confirmed');
    expect(data.coverage?.verifier?.status).toBe('completed');
    expect(data.verdict).toBe('blocking');
  });

  it('stays inconclusive when a deep pass could not be read', async () => {
    const results = deepResults();
    results[1] = 'sorry, no JSON from me';
    const stub = stubManager(results);

    const dispatch = await resolvePrintCommand('/review --deep', env(stub));
    const data = reviewData(dispatch);

    expect(data.verdict).toBe('inconclusive');
    expect(data.coverage?.reviewers[1]).toMatchObject({ id: 'security', status: 'unstructured' });
    if (dispatch.kind !== 'handled') throw new Error('unreachable');
    expect(dispatch.output).toContain('Coverage warning');
  });
});

describe('book -p /review — scope forms', () => {
  it('honours --base', async () => {
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-qm', 'second');
    const base = git(workspace, 'rev-parse', 'HEAD~1');
    git(workspace, 'branch', 'baseline', base);
    writeFileSync(join(workspace, 'a.ts'), 'export const value = 3;\n', 'utf8');
    const stub = stubManager([findingJson()]);

    const data = reviewData(await resolvePrintCommand('/review --base baseline', env(stub)));

    expect(data.target?.baseSha).toBe(base);
    expect(stub.prompts[0]).toContain('export const value = 3;');
  });

  it('honours a <base>...<head> range', async () => {
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-qm', 'second');
    const head = git(workspace, 'rev-parse', 'HEAD');
    const base = git(workspace, 'rev-parse', 'HEAD~1');
    const stub = stubManager([findingJson()]);

    const data = reviewData(await resolvePrintCommand(`/review ${base}...${head}`, env(stub)));

    expect(data.target).toMatchObject({ kind: 'committed-range', baseSha: base, headSha: head });
  });

  it('honours a path scope', async () => {
    writeFileSync(join(workspace, 'b.ts'), 'export const other = 1;\n', 'utf8');
    const stub = stubManager([findingJson()]);

    const data = reviewData(await resolvePrintCommand('/review a.ts', env(stub)));

    expect(data.target?.path).toBe('a.ts');
    expect(data.target?.changedFiles).toEqual(['a.ts']);
    expect(stub.prompts[0]).not.toContain('b.ts');
  });

  it('applies REVIEW.md calibration from the workspace', async () => {
    writeFileSync(join(workspace, 'REVIEW.md'), 'Exported constants are load-bearing here.\n');
    const stub = stubManager([findingJson()]);

    await resolvePrintCommand('/review', env(stub));

    expect(stub.prompts[0]).toContain('## Review instructions (REVIEW.md)');
    expect(stub.prompts[0]).toContain('Exported constants are load-bearing here.');
  });
});

describe('book -p /review — paths that must end the run', () => {
  it('refuses --fix and never spawns a patcher', async () => {
    const stub = stubManager(deepResults());

    const error = (await resolvePrintCommand('/review --fix', env(stub)).catch(
      (thrown) => thrown,
    )) as UnsupportedPrintCommandError;

    expect(error).toBeInstanceOf(UnsupportedPrintCommandError);
    expect(error.command).toBe('review');
    expect(error.message).toContain('--fix');
    expect(error.message).toContain('needs an interactive session');
    expect(error.message).toContain('/review --deep');
    expect(stub.agents).toEqual([]);
  });

  it('refuses when the host provides no managed-agent runtime', async () => {
    const error = (await resolvePrintCommand('/review', env()).catch(
      (thrown) => thrown,
    )) as UnsupportedPrintCommandError;

    expect(error).toBeInstanceOf(UnsupportedPrintCommandError);
    expect(error.message).toContain('managed-agent runtime');
  });

  it('fails the run when the review itself could not run', async () => {
    const stub = stubManager([findingJson()]);

    const error = (await resolvePrintCommand('/review --base nope/missing', env(stub)).catch(
      (thrown) => thrown,
    )) as Error;

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('✕ review failed:');
    expect(stub.agents).toEqual([]);
  });

  it('fails the run on an unknown review option instead of exiting clean', async () => {
    const stub = stubManager([findingJson()]);

    const error = (await resolvePrintCommand('/review --dep', env(stub)).catch(
      (thrown) => thrown,
    )) as PrintCommandUsageError;

    expect(error).toBeInstanceOf(PrintCommandUsageError);
    expect(error.command).toBe('review');
    expect(error.message).toContain('Unknown review option: --dep');
    expect(error.message).toContain('Usage: /review');
    expect(stub.agents).toEqual([]);
  });

  // Budget enforcement is keyed by rootRunId (RunAccounting.checkBeforeModelCall).
  // A reviewer spawned without the host's root starts a fresh, budget-free root
  // and spends past --max-budget-usd without ever being checked.
  it('spawns every reviewer under the host run so the budget root applies', async () => {
    const stub = stubManager(deepResults());
    const runContext = reviewRunContext();

    await resolvePrintCommand('/review --deep', env(stub, runContext));

    expect(stub.spawns.length).toBeGreaterThan(1);
    for (const spawn of stub.spawns) {
      expect(spawn.rootRunId).toBe(runContext.rootRunId);
      expect(spawn.parentRunId).toBe(runContext.runId);
      // Not the parent session: that would route each finished reviewer's
      // completion notification back into the host as an extra model turn,
      // re-narrating a report the host already rendered.
      expect(spawn.parentSessionId).toBeUndefined();
    }
  });

  it('prints usage for --help without starting a review', async () => {
    const stub = stubManager([findingJson()]);

    const dispatch = await resolvePrintCommand('/review --help', env(stub));

    expect(dispatch.kind).toBe('handled');
    if (dispatch.kind !== 'handled') throw new Error('unreachable');
    expect(dispatch.command).toBe('review');
    expect(dispatch.output).toContain('Usage: /review');
    expect(dispatch.data).toBeUndefined();
    expect(stub.agents).toEqual([]);
  });
});
