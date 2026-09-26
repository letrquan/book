import type { ResolvedSettings } from './settings.js';
import {
  DEFAULT_MAX_INDEX_LINES,
  getMemoryHealth,
  getMemoryInboxDir,
  isMemorySaveAvailable,
  listMemoryCandidates,
  loadMemoryContext,
  readMemoryFile,
  type MemoryStoreOptions,
} from './memory-store.js';

interface MemoryReportInput extends MemoryStoreOptions {
  workspace: string;
  settings?: ResolvedSettings;
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

export function buildMemoryInboxReport(input: MemoryReportInput): string {
  const candidates = listMemoryCandidates(input.workspace, input);
  if (candidates.length === 0) {
    return [
      'Memory inbox: no pending candidates.',
      '',
      `Inbox: \`${getMemoryInboxDir(input.workspace, input)}\``,
      '',
      'New auto-memory candidates appear here for review before they are loaded.',
    ].join('\n');
  }

  const lines = ['Memory inbox candidates:', ''];
  candidates.forEach((candidate, i) => {
    lines.push(
      `${i + 1}. ${candidate.title ?? candidate.name} (${candidate.type ?? 'unknown'}) — ${candidate.name}`,
    );
    // What approving would do, so the review is not blind: the text, which approved entry it
    // replaces, and whether it came from a session that read external content.
    const full = readMemoryFile(candidate.path);
    if (!full) return;
    if (full.externalContext) {
      lines.push('   ⚠ saved in a session that read external content (web, MCP, or another agent)');
    }
    if (full.targetSlug) lines.push(`   replaces existing: \`${full.targetSlug}\``);
    if (full.supersedes) {
      lines.push(
        `   retires existing: \`${full.supersedes}\` (kept on disk, removed from the index)`,
      );
    }
    const preview = full.body.replace(/\s+/g, ' ').trim();
    lines.push(`   ${preview.length > 200 ? `${preview.slice(0, 200)}…` : preview}`);
  });
  lines.push('');
  lines.push('Use /memory approve <number-or-file> or /memory discard <number-or-file>.');
  return lines.join('\n');
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
  const requireApproval = settings?.memory.requireApproval ?? false;
  const health = getMemoryHealth(ctx, input);
  const lastWrite = health.lastWrite ? health.lastWrite.toISOString() : 'never';

  // One line per fact. The report used to print the memory directory twice
  // (Location, Path), a Loading line, an Approval line the writes line already
  // implied, and a pending count the health line already held.
  const quarantineExternal = settings?.memory.quarantineExternal ?? true;
  const modelWrites = !isMemorySaveAvailable(settings)
    ? 'disabled'
    : requireApproval
      ? 'enabled (to inbox, needs approval)'
      : quarantineExternal
        ? 'enabled (direct to store; to inbox after external content)'
        : 'enabled (direct to store)';
  const lines: string[] = [
    `Memory: ${enabled ? 'loaded each session' : 'not loaded'} · model writes ${modelWrites}`,
    `Health: ${health.approvedCount} approved, ${health.supersededCount} superseded, ${health.inboxCount} inbox, ${health.indexLineCount}/${DEFAULT_MAX_INDEX_LINES} index lines, last write: ${lastWrite}`,
  ];
  if (ctx.indexFile) {
    const cap =
      ctx.loadedLineCount < ctx.indexLineCount
        ? `first ${ctx.loadedLineCount} of ${ctx.indexLineCount} non-empty lines`
        : `${ctx.loadedLineCount} non-empty lines`;
    lines.push(`Index: ${cap}`);
  }
  lines.push(`Location: \`${ctx.dir}\``);
  if (health.inboxCount > 0 || ctx.candidates.length > 0) {
    lines.push(`Inbox: \`${getMemoryInboxDir(input.workspace, input)}\``);
  }

  const approvedFiles = ctx.files.filter((file) => file.name !== 'MEMORY.md');
  lines.push('');
  if (approvedFiles.length === 0) {
    lines.push('No approved memories yet.');
  } else {
    for (const file of approvedFiles) {
      lines.push(`- ${file.title ?? file.name} (${file.type ?? 'unknown'}) — ${file.name}`);
    }
  }

  lines.push('');
  lines.push(
    '`/memory inbox` · `approve <n|file>` · `discard <n|file>` · `delete <file>` · `on` · `off`',
  );
  return lines.join('\n');
}
