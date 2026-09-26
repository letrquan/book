import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aggregateToolUse,
  appendToolUseRecords,
  formatToolStatsReport,
  pruneToolUseRecords,
  readToolUseRecords,
  telemetryProviderOf,
} from './tool-telemetry.js';
import type { ToolUseRecord } from './types/tool-telemetry.js';

function record(overrides: Partial<ToolUseRecord> = {}): ToolUseRecord {
  return {
    ts: 1_000,
    session: 's1',
    tool: 'Bash',
    status: 'success',
    isFailure: false,
    retries: 0,
    model: 'claude-opus-4-8',
    subagent: false,
    ...overrides,
  };
}

describe('appendToolUseRecords / readToolUseRecords', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'book-tooltel-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('round-trips a batch of records as JSONL', async () => {
    await appendToolUseRecords([record({ tool: 'Read' }), record({ tool: 'Grep' })], { root });
    await appendToolUseRecords([record({ tool: 'Bash' })], { root });
    const records = await readToolUseRecords(root);
    expect(records.map((r) => r.tool)).toEqual(['Read', 'Grep', 'Bash']);
  });

  it('is a no-op for an empty batch', async () => {
    await appendToolUseRecords([], { root });
    expect(await readToolUseRecords(root)).toEqual([]);
  });

  it('tolerates malformed and blank lines', async () => {
    writeFileSync(
      join(root, 'tool-use.jsonl'),
      '\n{"tool":"Read","status":"success"}\nnot json\n\n',
    );
    const records = await readToolUseRecords(root);
    expect(records).toHaveLength(1);
    expect(records[0].tool).toBe('Read');
  });

  it('rotates into a .1 backup and still reads both files in order', async () => {
    // Tiny cap forces rotation; the backup (older) must read before the active file.
    await appendToolUseRecords([record({ tool: 'First' })], { root, maxBytes: 10 });
    await appendToolUseRecords([record({ tool: 'Second' })], { root, maxBytes: 10 });
    const records = await readToolUseRecords(root);
    expect(records.map((r) => r.tool)).toEqual(['First', 'Second']);
    expect(readFileSync(join(root, 'tool-use.jsonl.1'), 'utf8')).toContain('First');
  });
});

describe('aggregateToolUse', () => {
  it('computes calls, failures, and fail rate per tool', () => {
    const agg = aggregateToolUse([
      record({ tool: 'Bash' }),
      record({ tool: 'Bash', status: 'error', isFailure: true, errorCode: 'tool_timeout' }),
      record({ tool: 'Read' }),
    ]);
    expect(agg.totalCalls).toBe(3);
    expect(agg.totalFailures).toBe(1);
    const bash = agg.tools.find((t) => t.tool === 'Bash');
    expect(bash).toMatchObject({ calls: 2, failures: 1 });
    expect(bash?.failRate).toBeCloseTo(0.5);
    // Failing tools sort first.
    expect(agg.tools[0].tool).toBe('Bash');
  });

  it('excludes blocked and cancelled outcomes from failures', () => {
    const agg = aggregateToolUse([
      record({ tool: 'Edit', status: 'blocked', isFailure: false }),
      record({ tool: 'Edit', status: 'cancelled', isFailure: false }),
      record({ tool: 'Edit', status: 'error', isFailure: true, errorCode: 'patch_failed' }),
    ]);
    const edit = agg.tools.find((t) => t.tool === 'Edit');
    expect(edit?.calls).toBe(3);
    expect(edit?.failures).toBe(1);
    expect(agg.errorCodes).toEqual([{ code: 'patch_failed', count: 1 }]);
  });

  it('computes duration percentiles and retry rate', () => {
    const durations = [10, 20, 30, 40, 100];
    const agg = aggregateToolUse(
      durations.map((d, i) => record({ tool: 'Bash', durationMs: d, retries: i === 0 ? 2 : 0 })),
    );
    const bash = agg.tools[0];
    expect(bash.p50Ms).toBe(30);
    expect(bash.p95Ms).toBe(88); // interpolated between 40 and 100
    expect(bash.retried).toBe(1);
    expect(bash.retryRate).toBeCloseTo(0.2);
  });

  it('counts distinct sessions and splits by model', () => {
    const agg = aggregateToolUse([
      record({ session: 'a', model: 'opus' }),
      record({ session: 'a', model: 'sonnet', status: 'error', isFailure: true }),
      record({ session: 'b', model: 'opus' }),
    ]);
    expect(agg.sessions).toBe(2);
    expect(agg.models.map((m) => m.model).sort()).toEqual(['opus', 'sonnet']);
    expect(agg.models.find((m) => m.model === 'opus')?.calls).toBe(2);
  });

  it('keys a model by its provider, so a bad route is not hidden behind a shared model id', () => {
    const agg = aggregateToolUse([
      record({ model: 'cmc/x', provider: '9router' }),
      record({ model: 'cmc/x' }),
    ]);
    expect(agg.models.map((m) => m.model).sort()).toEqual(['9router/cmc/x', 'cmc/x']);
  });

  it('counts malformed arguments by shape, globally, per tool and per model', () => {
    const agg = aggregateToolUse([
      record({
        tool: 'Edit',
        model: 'cmc/x',
        provider: '9router',
        status: 'error',
        isFailure: true,
        errorCode: 'invalid_json_arguments',
        errorShape: 'truncated_start',
      }),
    ]);
    expect(agg.errorCodes).toEqual([{ code: 'invalid_json_arguments:truncated_start', count: 1 }]);
    expect(agg.tools[0].errorCodes).toEqual({ 'invalid_json_arguments:truncated_start': 1 });
    expect(agg.models[0].errorCodes).toEqual({ 'invalid_json_arguments:truncated_start': 1 });
  });
});

describe('telemetryProviderOf', () => {
  it('reads the provider prefix off a model selection, and nothing off a bare id', () => {
    expect(telemetryProviderOf({ model: 'cmc/x', modelSelection: '9router/cmc/x' })).toBe(
      '9router',
    );
    expect(telemetryProviderOf({ model: 'gpt-4o', modelSelection: 'gpt-4o' })).toBeUndefined();
    expect(telemetryProviderOf({ model: 'cmc/x' })).toBeUndefined();
    // A selection that is not a prefix of the model names no provider; it is not a route.
    expect(
      telemetryProviderOf({ model: 'cmc/x', modelSelection: '9router/cmc/y' }),
    ).toBeUndefined();
  });
});

describe('formatToolStatsReport', () => {
  it('renders an empty-state message', () => {
    expect(formatToolStatsReport(aggregateToolUse([]))).toContain('no telemetry recorded');
  });

  it('renders totals, a per-tool table, and error codes', () => {
    const report = formatToolStatsReport(
      aggregateToolUse([
        record({ tool: 'Bash', durationMs: 100 }),
        record({
          tool: 'Bash',
          status: 'error',
          isFailure: true,
          errorCode: 'tool_timeout',
          durationMs: 200,
        }),
      ]),
    );
    expect(report).toContain('2 calls across 1 session');
    expect(report).toContain('1 failed');
    expect(report).toMatch(/Bash\s+2\s+1\s+50\.0%/);
    expect(report).toContain('Top error codes: tool_timeout(1)');
  });

  it('names the provider and the error codes on a per-model line', () => {
    const report = formatToolStatsReport(
      aggregateToolUse([
        record({ model: 'cmc/x', provider: '9router' }),
        record({
          model: 'cmc/x',
          provider: '9router',
          status: 'error',
          isFailure: true,
          errorCode: 'invalid_json_arguments',
          errorShape: 'truncated_start',
        }),
        record({ model: 'gpt-4o' }),
      ]),
    );
    // `cmc/x` alone would not say which route mangled the call.
    expect(report).toContain('9router/cmc/x: 2 calls, 1 failed (50.0%)');
    expect(report).toContain('codes: invalid_json_arguments:truncated_start(1)');
  });
});

describe('pruneToolUseRecords', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'book-tooltel-prune-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('drops records older than the cutoff and collapses the backup', async () => {
    // Two appends with a tiny cap force the first batch into a `.1` backup, so
    // prune must read across both files and then remove the collapsed backup.
    const { existsSync } = await import('node:fs');
    await appendToolUseRecords([record({ ts: 100, tool: 'Old' })], { root, maxBytes: 10 });
    await appendToolUseRecords([record({ ts: 5_000, tool: 'New' })], { root, maxBytes: 10 });
    expect(existsSync(join(root, 'tool-use.jsonl.1'))).toBe(true);

    const result = await pruneToolUseRecords(1_000, root);
    expect(result.dropped).toBe(1);
    expect(result.kept).toBe(1);
    const records = await readToolUseRecords(root);
    expect(records.map((r) => r.tool)).toEqual(['New']);
    expect(existsSync(join(root, 'tool-use.jsonl.1'))).toBe(false);
  });
});
