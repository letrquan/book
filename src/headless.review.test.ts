/**
 * `book -p /review` end to end through `runHeadless`.
 *
 * Nothing is stubbed below the provider: the print dispatcher builds a real
 * `AgentManager`, the manager runs a real reviewer agent, and the scripted
 * provider plays the reviewer's structured answer. That is the only way to
 * prove the host actually wired the pipeline rather than the seam around it.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHeadless } from './headless.js';
import { UnsupportedPrintCommandError } from './commands/print-dispatch.js';
import { createDefaultRegistry } from './tools/registry.js';
import { defaultConfig } from './test/fixtures.js';
import { createRepeatingScriptedProvider, sseResponse } from './test/scripted-provider.js';
import type { ScriptedProvider } from './test/scripted-provider.js';
import type { AgentConfig } from './types/runtime.js';

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
  workspace = mkdtempSync(join(tmpdir(), 'book-headless-review-'));
  home = mkdtempSync(join(tmpdir(), 'book-headless-review-home-'));
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
  vi.unstubAllGlobals();
  for (const dir of [workspace, home]) rmSync(dir, { recursive: true, force: true });
  if (previousBookHome === undefined) delete process.env.BOOK_HOME;
  else process.env.BOOK_HOME = previousBookHome;
});

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  const config = defaultConfig({ baseUrl: 'http://localhost/v1', workspace, ...overrides });
  // Keep the throwaway agent state out of the developer's BOOK_HOME history.
  config.settings.agents.persist = false;
  config.settings.agents.telemetry = false;
  return config;
}

const REVIEWER_REPORT = JSON.stringify({
  verdict: 'recommend',
  findings: [
    {
      severity: 'major',
      category: 'correctness',
      file: 'a.ts',
      line: 1,
      summary: 'the exported constant changed meaning',
      evidence: 'export const value = 2;',
      failure: 'callers that branch on value === 1 stop matching',
      suggestedFix: 'introduce a new constant instead of changing this one',
      confidence: 92,
    },
  ],
});

function stubProvider(text: string): ScriptedProvider {
  const provider = createRepeatingScriptedProvider(() =>
    sseResponse([
      JSON.stringify({ choices: [{ delta: { content: text } }] }),
      // Reviewer agents are the only thing that spends here, so the run's
      // reported usage has to come from them or it comes from nowhere.
      JSON.stringify({
        choices: [],
        usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
      }),
    ]),
  );
  vi.stubGlobal('fetch', provider.fetch);
  return provider;
}

function collectWrites(): { stdout: { write: (value: string) => boolean }; text: () => string } {
  const writes: string[] = [];
  return {
    stdout: {
      write: (value: string) => {
        writes.push(value);
        return true;
      },
    },
    text: () => writes.join(''),
  };
}

function run(config: AgentConfig, prompt: string, overrides: Record<string, unknown> = {}) {
  const out = collectWrites();
  return {
    out,
    result: runHeadless(config, createDefaultRegistry({ agents: true }), {
      prompt,
      inputFormat: 'text',
      outputFormat: 'text',
      history: [],
      mode: 'default',
      maxTurns: 2,
      persistSession: false,
      stdout: out.stdout,
      ...overrides,
    }),
  };
}

describe('runHeadless — /review', () => {
  it('runs the review in the host and prints the report as text', async () => {
    stubProvider(REVIEWER_REPORT);
    const config = makeConfig();

    const { out, result } = run(config, '/review');
    const finished = await result;

    expect(out.text()).toContain('Verdict: recommend');
    expect(out.text()).toContain('the exported constant changed meaning');
    // No parent model turn ran: the report is the whole deliverable.
    expect(finished.messages).toEqual([]);
    expect(finished.outcome.status).toBe('completed');
  }, 30000);

  // `--output-format json` is a single-document format (src/headless.test.ts
  // pins `JSON.parse(stdout)`), so the report travels inside the one result
  // object rather than as a second top-level document beside it.
  it('emits the machine contract inside the single --output-format json document', async () => {
    stubProvider(REVIEWER_REPORT);
    const config = makeConfig();

    const { out, result } = run(config, '/review', { outputFormat: 'json' });
    await result;

    const document = JSON.parse(out.text().trim()) as {
      result: { commandResults: Array<{ command: string; output?: string; data?: unknown }> };
    };
    const [command] = document.result.commandResults;
    expect(document.result.commandResults).toHaveLength(1);
    expect(command.command).toBe('review');
    expect(command.output).toContain('Verdict: recommend');
    const data = command.data as {
      verdict: string;
      target: { kind: string; baseSha: string; changedFiles: string[] };
      findings: Array<Record<string, unknown>>;
    };
    expect(data.verdict).toBe('recommend');
    expect(data.target).toMatchObject({
      kind: 'working-tree',
      baseSha: git(workspace, 'rev-parse', 'HEAD'),
      changedFiles: ['a.ts'],
    });
    expect(data.findings[0]).toMatchObject({
      id: 'finding-1',
      severity: 'major',
      file: 'a.ts',
      confidence: 92,
    });
  }, 30000);

  it('writes exactly one JSON document to stdout for --output-format json', async () => {
    stubProvider(REVIEWER_REPORT);

    const { out, result } = run(makeConfig(), '/review', { outputFormat: 'json' });
    await result;

    // Two documents would parse line by line but explode on the whole buffer,
    // which is what every `book -p --output-format json … | jq` consumer does.
    expect(() => JSON.parse(out.text().trim())).not.toThrow();
    expect(out.text().trim().split('\n').filter(Boolean)).toHaveLength(1);
  }, 30000);

  // The SDK passes a discarding stdout sink, so the returned result is the only
  // channel it has. A report reachable only through stdout is a report an SDK
  // caller paid for and cannot read.
  it('returns the command result on HeadlessResult for callers with no stdout', async () => {
    stubProvider(REVIEWER_REPORT);

    const finished = await run(makeConfig(), '/review', {
      stdout: { write: () => true },
    }).result;

    expect(finished.commandResults).toHaveLength(1);
    const [command] = finished.commandResults ?? [];
    expect(command.command).toBe('review');
    expect(command.output).toContain('Verdict: recommend');
    expect((command.data as { verdict: string }).verdict).toBe('recommend');
  }, 30000);

  it('reports the review spend in usage and runs rather than reporting nothing', async () => {
    stubProvider(REVIEWER_REPORT);

    const finished = await run(makeConfig(), '/review').result;

    // The host's own run for the command, plus the reviewer agent it ran, under
    // one root — the shape that makes the spend attributable and budgetable.
    const runs = finished.runs ?? [];
    const hostRun = runs.find((entry) => entry.context.source === 'headless');
    const reviewerRun = runs.find((entry) => entry.context.source === 'internal');
    expect(hostRun).toBeDefined();
    expect(reviewerRun?.context.rootRunId).toBe(hostRun?.context.rootRunId);
    expect(finished.usage?.totalTokens).toBe(42);
  }, 30000);

  // The parent-turn path refuses before any provider call when the budget
  // cannot be enforced. A host-performed command spawns agents of its own, and
  // those must land under the same budget root instead of escaping the cap.
  it('enforces --max-budget-usd on the reviewer agents', async () => {
    const provider = stubProvider(REVIEWER_REPORT);

    const finished = await run(makeConfig(), '/review', { maxBudgetUsd: 1e-7 }).result;

    // Refused before the first provider call, exactly as a parent turn is.
    expect(provider.requests.length).toBe(0);
    const [command] = finished.commandResults ?? [];
    expect((command.data as { verdict: string }).verdict).toBe('inconclusive');
    expect(command.output).toContain('Cannot enforce the USD budget');
    expect(
      (finished.runs ?? []).find((entry) => entry.context.source === 'internal')?.outcome,
    ).toMatchObject({ status: 'failed', reason: 'budget_unverifiable' });
  }, 30000);

  it('emits the same contract on the stream-json wire', async () => {
    stubProvider(REVIEWER_REPORT);
    const config = makeConfig();

    const { out, result } = run(config, '/review', { outputFormat: 'stream-json' });
    await result;

    const records = out
      .text()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const command = records.find((record) => record.type === 'command_result');
    expect(command).toBeDefined();
    expect((command?.data as { verdict: string }).verdict).toBe('recommend');
    expect(String(command?.output)).toContain('Verdict: recommend');
  }, 30000);

  it('refuses --fix without spawning anything', async () => {
    const provider = stubProvider(REVIEWER_REPORT);
    const config = makeConfig();

    const error = await run(config, '/review --fix').result.catch((thrown) => thrown);

    expect(error).toBeInstanceOf(UnsupportedPrintCommandError);
    expect((error as Error).message).toContain('--fix');
    expect(provider.requests.length).toBe(0);
  }, 30000);

  it('fails the run when the review target cannot be resolved', async () => {
    const provider = stubProvider(REVIEWER_REPORT);
    const config = makeConfig();

    const error = await run(config, '/review --base nope/missing').result.catch((thrown) => thrown);

    expect((error as Error).message).toContain('✕ review failed:');
    expect(provider.requests.length).toBe(0);
  }, 30000);

  it('fails the run on an unknown review option', async () => {
    const provider = stubProvider(REVIEWER_REPORT);

    const error = await run(makeConfig(), '/review --dep').result.catch((thrown) => thrown);

    expect((error as Error).message).toContain('Unknown review option: --dep');
    expect(provider.requests.length).toBe(0);
  }, 30000);

  it('fails the run when managed agents are disabled', async () => {
    const provider = stubProvider(REVIEWER_REPORT);
    const config = makeConfig();
    config.settings.agents.mode = 'off';

    const error = await run(config, '/review').result.catch((thrown) => thrown);

    // No silent downgrade to "clean": the review could not run, so the run fails.
    expect((error as Error).message).toContain('✕ review failed:');
    expect((error as Error).message).toContain('Managed agents are disabled');
    expect(provider.requests.length).toBe(0);
  }, 30000);
});
