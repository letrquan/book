/**
 * Persistent, machine-readable tool-use telemetry.
 *
 * Every finalized tool call is appended as one JSON line to
 * `<root>/tool-use.jsonl` (default `~/.book/telemetry`). This is a separate,
 * durable pipeline from the ephemeral in-session `toolCallStats` counters that
 * feed `/usage`: the JSONL log survives across sessions so tool use can be
 * inspected and measured over time (`book tool-stats`).
 *
 * Writes are best-effort and non-fatal — telemetry never blocks or breaks a
 * session. The active log is size-capped and rotated into a single `.1` backup;
 * the reader consumes the active file plus that backup.
 */
import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  ModelStatRow,
  ToolStatRow,
  ToolUseAggregate,
  ToolUseRecord,
} from './types/tool-telemetry.js';
import { createDebugLogger, positiveInteger } from './debug-log.js';

const log = createDebugLogger('tool-telemetry');

const LOG_BASENAME = 'tool-use.jsonl';
/** Rotate the active log once it reaches this size (10 MiB). */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/** Resolve the telemetry directory, honoring an env override for tests/CI. */
export function defaultToolTelemetryDir(): string {
  return process.env.BOOK_TOOL_TELEMETRY_DIR || join(homedir(), '.book', 'telemetry');
}

function logPath(root: string): string {
  return join(root, LOG_BASENAME);
}

/**
 * Append a batch of records as JSONL. Fire-and-forget from the hot path; the
 * returned promise resolves once the write settles (awaited only by tests).
 */
export async function appendToolUseRecords(
  records: ToolUseRecord[],
  options: { root?: string; maxBytes?: number } = {},
): Promise<void> {
  if (records.length === 0) return;
  const root = options.root ?? defaultToolTelemetryDir();
  const target = logPath(root);
  const maxBytes =
    options.maxBytes ??
    positiveInteger(process.env.BOOK_TOOL_TELEMETRY_MAX_BYTES, DEFAULT_MAX_BYTES);
  const payload = records.map((record) => JSON.stringify(record)).join('\n') + '\n';
  try {
    await mkdir(root, { recursive: true });
    await rotateIfNeeded(target, Buffer.byteLength(payload), maxBytes);
    await appendFile(target, payload, 'utf8');
  } catch (error) {
    log.warn('tool telemetry append failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// Single-backup, size-based rotation. Best-effort: concurrent fire-and-forget
// appends can race the stat→rename→append sequence, at worst losing one backup
// window of records. That is an acceptable trade for keeping telemetry off the
// hot path with no shared lock (module-level mutable state is disallowed here).
async function rotateIfNeeded(
  target: string,
  incomingBytes: number,
  maxBytes: number,
): Promise<void> {
  let currentBytes: number;
  try {
    currentBytes = (await stat(target)).size;
  } catch {
    return; // No active log yet — nothing to rotate.
  }
  if (currentBytes + incomingBytes <= maxBytes) return;
  try {
    await rename(target, `${target}.1`); // Overwrites any prior backup.
  } catch {
    // Best effort: if rotation fails, keep appending to the active log.
  }
}

async function readLines(path: string): Promise<string[]> {
  try {
    const text = await readFile(path, 'utf8');
    return text.split('\n');
  } catch {
    return [];
  }
}

/** Parse the active log plus its rotated backup into records (bad lines skipped). */
export async function readToolUseRecords(
  root = defaultToolTelemetryDir(),
): Promise<ToolUseRecord[]> {
  const target = logPath(root);
  // Backup is older, so read it first to preserve chronological order.
  const lines = [...(await readLines(`${target}.1`)), ...(await readLines(target))];
  const records: ToolUseRecord[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as ToolUseRecord;
      if (parsed && typeof parsed.tool === 'string' && typeof parsed.status === 'string') {
        records.push(parsed);
      }
    } catch {
      // Tolerate a partially written trailing line or manual edits.
    }
  }
  return records;
}

/**
 * Rewrite the log keeping only records at or after `cutoffTs`, collapsing the
 * rotated backup into the active file. Best-effort; returns the number of
 * records dropped. Used by `book tool-stats --prune`.
 */
export async function pruneToolUseRecords(
  cutoffTs: number,
  root = defaultToolTelemetryDir(),
): Promise<{ kept: number; dropped: number }> {
  const all = await readToolUseRecords(root);
  const kept = all.filter((record) => (record.ts ?? 0) >= cutoffTs);
  const dropped = all.length - kept.length;
  if (dropped === 0) return { kept: kept.length, dropped: 0 };
  const target = logPath(root);
  try {
    await mkdir(root, { recursive: true });
    await writeFile(
      target,
      kept.map((record) => JSON.stringify(record)).join('\n') + (kept.length > 0 ? '\n' : ''),
      'utf8',
    );
    await rm(`${target}.1`, { force: true });
  } catch (error) {
    log.warn('tool telemetry prune failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return { kept: kept.length, dropped };
}

function percentile(sortedAsc: number[], p: number): number | undefined {
  if (sortedAsc.length === 0) return undefined;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (p / 100) * (sortedAsc.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sortedAsc[low];
  const weight = rank - low;
  return Math.round(sortedAsc[low] * (1 - weight) + sortedAsc[high] * weight);
}

/** Roll a flat record list into per-tool, per-model, and error-code summaries. */
export function aggregateToolUse(records: ToolUseRecord[]): ToolUseAggregate {
  const sessions = new Set<string>();
  const errorCodes = new Map<string, number>();
  const modelAgg = new Map<string, { calls: number; failures: number }>();
  const toolAgg = new Map<
    string,
    {
      calls: number;
      failures: number;
      retried: number;
      durations: number[];
      errorCodes: Map<string, number>;
    }
  >();

  let totalFailures = 0;
  let firstTs: number | undefined;
  let lastTs: number | undefined;

  for (const record of records) {
    if (record.session) sessions.add(record.session);
    if (typeof record.ts === 'number') {
      firstTs = firstTs === undefined ? record.ts : Math.min(firstTs, record.ts);
      lastTs = lastTs === undefined ? record.ts : Math.max(lastTs, record.ts);
    }

    const tool = toolAgg.get(record.tool) ?? {
      calls: 0,
      failures: 0,
      retried: 0,
      durations: [],
      errorCodes: new Map<string, number>(),
    };
    tool.calls++;
    if (typeof record.durationMs === 'number') tool.durations.push(record.durationMs);
    if (record.retries > 0) tool.retried++;

    const modelKey = record.model || 'unknown';
    const model = modelAgg.get(modelKey) ?? { calls: 0, failures: 0 };
    model.calls++;

    if (record.isFailure) {
      totalFailures++;
      tool.failures++;
      model.failures++;
      const code = record.errorCode ?? record.status;
      errorCodes.set(code, (errorCodes.get(code) ?? 0) + 1);
      tool.errorCodes.set(code, (tool.errorCodes.get(code) ?? 0) + 1);
    }

    toolAgg.set(record.tool, tool);
    modelAgg.set(modelKey, model);
  }

  const tools: ToolStatRow[] = [...toolAgg.entries()]
    .map(([tool, agg]) => {
      const sorted = [...agg.durations].sort((a, b) => a - b);
      return {
        tool,
        calls: agg.calls,
        failures: agg.failures,
        failRate: agg.calls > 0 ? agg.failures / agg.calls : 0,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        retried: agg.retried,
        retryRate: agg.calls > 0 ? agg.retried / agg.calls : 0,
        errorCodes: Object.fromEntries(agg.errorCodes),
      };
    })
    // Failing tools first so a low-volume failing tool is never buried.
    .sort((a, b) => b.failures - a.failures || b.calls - a.calls || a.tool.localeCompare(b.tool));

  const models: ModelStatRow[] = [...modelAgg.entries()]
    .map(([model, agg]) => ({
      model,
      calls: agg.calls,
      failures: agg.failures,
      failRate: agg.calls > 0 ? agg.failures / agg.calls : 0,
    }))
    .sort((a, b) => b.calls - a.calls || a.model.localeCompare(b.model));

  const codeRows = [...errorCodes.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));

  return {
    totalCalls: records.length,
    totalFailures,
    sessions: sessions.size,
    firstTs,
    lastTs,
    tools,
    models,
    errorCodes: codeRows,
  };
}

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function ms(value: number | undefined): string {
  if (value === undefined) return '-';
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

/** Render an aggregate as a fixed-width text report for `book tool-stats`. */
export function formatToolStatsReport(aggregate: ToolUseAggregate): string {
  if (aggregate.totalCalls === 0) {
    return 'Tool use — no telemetry recorded yet.\n\nRun a session (tool telemetry is on by default) and try again.';
  }

  const lines: string[] = [];
  const span =
    aggregate.firstTs && aggregate.lastTs
      ? ` (${new Date(aggregate.firstTs).toISOString().slice(0, 10)} → ${new Date(aggregate.lastTs).toISOString().slice(0, 10)})`
      : '';
  lines.push(
    `Tool use — ${aggregate.totalCalls.toLocaleString()} calls across ${aggregate.sessions} session${aggregate.sessions === 1 ? '' : 's'}${span}`,
  );
  lines.push(
    `${aggregate.totalFailures.toLocaleString()} failed (${pct(aggregate.totalCalls > 0 ? aggregate.totalFailures / aggregate.totalCalls : 0)})`,
  );
  lines.push('');

  const toolWidth = Math.max(4, ...aggregate.tools.map((row) => row.tool.length));
  const columns = (
    tool: string,
    calls: string,
    fail: string,
    rate: string,
    p50: string,
    p95: string,
    retry: string,
  ): string =>
    `${tool.padEnd(toolWidth)}  ${calls.padStart(6)}  ${fail.padStart(5)}  ${rate.padStart(6)}  ${p50.padStart(7)}  ${p95.padStart(7)}  ${retry.padStart(7)}`;
  lines.push(columns('TOOL', 'CALLS', 'FAIL', 'FAIL%', 'P50', 'P95', 'RETRY%'));
  for (const row of aggregate.tools) {
    lines.push(
      columns(
        row.tool,
        String(row.calls),
        String(row.failures),
        pct(row.failRate),
        ms(row.p50Ms),
        ms(row.p95Ms),
        pct(row.retryRate),
      ),
    );
  }

  if (aggregate.models.length > 1) {
    lines.push('');
    lines.push('By model:');
    for (const row of aggregate.models) {
      lines.push(
        `  ${row.model}: ${row.calls} calls, ${row.failures} failed (${pct(row.failRate)})`,
      );
    }
  }

  if (aggregate.errorCodes.length > 0) {
    const top = aggregate.errorCodes.slice(0, 6).map((row) => `${row.code}(${row.count})`);
    lines.push('');
    lines.push(`Top error codes: ${top.join(', ')}`);
  }

  return lines.join('\n');
}
