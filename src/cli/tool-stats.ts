import { resolveSettings } from '../settings-loader.js';
import {
  aggregateToolUse,
  formatToolStatsReport,
  pruneToolUseRecords,
  readToolUseRecords,
} from '../tool-telemetry.js';

export interface ToolStatsCommandOptions {
  workspace: string;
  /** Emit the raw aggregate as JSON instead of a text report. */
  json?: boolean;
  /** Only include records from the last N days (overrides the retention window). */
  since?: string;
  /** Include every record regardless of the retention window. */
  all?: boolean;
  /** Drop records older than the window from disk before reporting. */
  prune?: boolean;
}

const DAY_MS = 86_400_000;

/**
 * `book tool-stats` — read the persistent tool-use telemetry log and report
 * calls, failure rates, durations, retries, and a per-model breakdown.
 */
export async function runToolStatsCommand(options: ToolStatsCommandOptions): Promise<void> {
  const settings = resolveSettings(options.workspace);
  const retentionDays = settings.observability.toolTelemetryRetentionDays;

  let windowDays: number | undefined;
  if (options.all) {
    windowDays = undefined;
  } else if (options.since !== undefined) {
    const parsed = Number(options.since);
    // A non-finite --since falls back to the configured window; 0 is honored as "today only".
    windowDays = Number.isFinite(parsed) ? Math.max(0, parsed) : retentionDays;
  } else {
    windowDays = retentionDays;
  }
  const cutoffTs = windowDays === undefined ? 0 : Date.now() - windowDays * DAY_MS;

  if (options.prune) {
    const result = await pruneToolUseRecords(cutoffTs);
    console.error(
      `Pruned ${result.dropped} record${result.dropped === 1 ? '' : 's'} older than ${windowDays ?? 0} days (${result.kept} kept).`,
    );
  }

  const all = await readToolUseRecords();
  const records = all.filter((record) => (record.ts ?? 0) >= cutoffTs);
  const aggregate = aggregateToolUse(records);

  if (options.json) {
    console.log(JSON.stringify(aggregate, null, 2));
    return;
  }

  console.log(formatToolStatsReport(aggregate));
  if (windowDays !== undefined && aggregate.totalCalls > 0) {
    console.log(
      `\n(Window: last ${windowDays} days. Use --all for full history, --since <days> to change.)`,
    );
  }
}
