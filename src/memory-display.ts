import type { ResolvedSettings } from './settings.js';
import type { SessionDriver } from './types/runtime.js';
import {
  type LoadedMemoryContext,
  DEFAULT_MAX_INDEX_LINES,
  MAX_INDEX_BYTES,
  findLegacyMemoryBackup,
  legacyBackupNotice,
  getMemoryHealth,
  memoryWriteScope,
  loadMemoryContext,
  type MemoryStoreOptions,
} from './memory-store.js';

interface MemoryReportInput extends MemoryStoreOptions {
  workspace: string;
  settings?: ResolvedSettings;
  sessionDriver?: SessionDriver;
}

export interface MemoryIndex {
  dir: string;
  indexFile: string | null;
  indexLineCount: number;
  files: Array<{ name: string; size: number }>;
}

/** Compatibility helper for older callers/tests. Prefer loadMemoryContext(). */
export function getMemoryIndex(workspace: string, opts?: MemoryStoreOptions): MemoryIndex {
  const ctx = loadMemoryContext(workspace, opts);
  return {
    dir: ctx.dir,
    indexFile: ctx.indexFile,
    indexLineCount: ctx.indexLineCount,
    files: ctx.files.map((file) => ({ name: file.name, size: file.size })),
  };
}

const formatCount = (n: number): string => n.toLocaleString('en-US');

/** `MEMORY.md` against both load limits, saying so when a session loads only part of it. */
export function describeIndexLoad(
  ctx: Pick<
    LoadedMemoryContext,
    | 'indexLineCount'
    | 'loadedLineCount'
    | 'indexByteCount'
    | 'wasLineTruncated'
    | 'wasByteTruncated'
  >,
): string {
  const sizes = `${formatCount(ctx.indexLineCount)}/${DEFAULT_MAX_INDEX_LINES} lines, ${formatCount(ctx.indexByteCount)}/${formatCount(MAX_INDEX_BYTES)} bytes`;
  if (!ctx.wasLineTruncated && !ctx.wasByteTruncated) return sizes;
  const cuts: string[] = [];
  if (ctx.wasLineTruncated) {
    cuts.push(
      `over the ${DEFAULT_MAX_INDEX_LINES}-line limit, first ${ctx.loadedLineCount} of ${ctx.indexLineCount} non-empty lines loaded`,
    );
  }
  if (ctx.wasByteTruncated) {
    cuts.push(`over the ${formatCount(MAX_INDEX_BYTES)}-byte limit`);
  }
  return `${sizes} — cut (${cuts.join('; ')}); the model sees a warning where it stops`;
}

/** The link text of each `MEMORY.md` line, by the file it links to. */
function indexTitles(indexText: string): Map<string, string> {
  const titles = new Map<string, string>();
  for (const line of indexText.split('\n')) {
    const link = /^\s*[-*]\s+\[([^\]]+)\]\(([^()]+)\)/.exec(line);
    const target = link?.[2].replace(/^\.\//, '');
    if (link && target && !titles.has(target)) titles.set(target, link[1].trim());
  }
  return titles;
}

export function buildMemoryReport(inputOrWorkspace: MemoryReportInput | string): string {
  const input: MemoryReportInput =
    typeof inputOrWorkspace === 'string' ? { workspace: inputOrWorkspace } : inputOrWorkspace;
  // Read the store from disk every time. The session-start snapshot this used
  // to prefer goes stale the moment the session or the model writes a memory,
  // and a status report showing yesterday's counts is worse than a re-read.
  const ctx = loadMemoryContext(input.workspace, input);
  const settings = input.settings;
  const enabled = settings?.memory.enabled ?? true;
  const health = getMemoryHealth(ctx, input);
  const lastWrite = health.lastWrite ? health.lastWrite.toISOString() : 'never';

  const scope = memoryWriteScope({ settings, sessionDriver: input.sessionDriver });
  const modelWrites =
    scope === 'none'
      ? 'disabled'
      : scope === 'learnings'
        ? 'learnings only (session driven by another agent: project/reference, never its instructions)'
        : 'enabled (files in the memory directory)';
  const lines: string[] = [
    `Memory: ${enabled ? 'loaded each session' : 'not loaded'} · model writes ${modelWrites}`,
    `Health: ${health.fileCount} ${health.fileCount === 1 ? 'memory' : 'memories'}, ${health.indexLineCount}/${DEFAULT_MAX_INDEX_LINES} index lines, last write: ${lastWrite}`,
  ];
  if (ctx.indexFile) {
    lines.push(`Index: ${describeIndexLoad(ctx)}`);
  }
  lines.push(`Location: \`${ctx.dir}\``);
  const backup = findLegacyMemoryBackup(ctx.dir);
  if (backup) lines.push(legacyBackupNotice(backup));

  lines.push('');
  if (ctx.files.length === 0) {
    lines.push('No memories yet.');
  } else {
    const titles = indexTitles(ctx.indexText);
    for (const file of ctx.files) {
      // The index line's title, else the description: the slug is the file, shown after it.
      const title = titles.get(file.name) ?? file.description ?? file.title ?? file.name;
      // A delegated run's learning is marked, so the user can tell it apart and prune it.
      const from = file.driver === 'agent' ? ' · from a delegated run' : '';
      // The retired save tool's superseded files load like any other now.
      const legacy = file.legacySuperseded ? ' · legacy, superseded' : '';
      lines.push(`- ${title} (${file.type ?? 'unknown'}${from}${legacy}) — ${file.name}`);
    }
  }

  lines.push('');
  lines.push('`/memory path` · `delete <file>` · `on` · `off`');
  return lines.join('\n');
}
