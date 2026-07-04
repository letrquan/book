import type { ResolvedSettings } from './settings.js';
import {
  getMemoryInboxDir,
  getProjectMemoryDir,
  listMemoryCandidates,
  loadMemoryContext,
  type LoadedMemoryContext,
  type MemoryStoreOptions,
} from './memory-store.js';

interface MemoryReportInput extends MemoryStoreOptions {
  workspace: string;
  settings?: ResolvedSettings;
  loaded?: LoadedMemoryContext;
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
      `Inbox: ${getMemoryInboxDir(input.workspace, input)}`,
      '',
      'New auto-memory candidates appear here for review before they are loaded.',
    ].join('\n');
  }

  const lines = ['Memory inbox candidates:', ''];
  candidates.forEach((candidate, i) => {
    lines.push(
      `${i + 1}. ${candidate.title ?? candidate.name} (${candidate.type ?? 'unknown'}) — ${candidate.name}`,
    );
  });
  lines.push('');
  lines.push('Use /memory approve <number-or-file> or /memory discard <number-or-file>.');
  return lines.join('\n');
}

export function buildMemoryReport(inputOrWorkspace: MemoryReportInput | string): string {
  const input: MemoryReportInput =
    typeof inputOrWorkspace === 'string' ? { workspace: inputOrWorkspace } : inputOrWorkspace;
  // Prefer the caller-supplied snapshot (already current after /memory approve
  // refreshes liveConfig.memoryContext). Only walk the disk when no snapshot
  // is available — avoids a redundant full re-read on every /memory status.
  const ctx = input.loaded ?? loadMemoryContext(input.workspace, input);
  const settings = input.settings;
  const enabled = settings?.memory.enabled ?? true;
  const autoSave = settings?.memory.autoSave ?? true;
  const requireApproval = settings?.memory.requireApproval ?? true;

  const lines: string[] = ['Auto-memory for this workspace:', ''];
  lines.push(`Location: ${ctx.dir}`);
  lines.push(`Loading: ${enabled ? 'enabled' : 'disabled'}`);
  lines.push(`Auto-capture: ${autoSave ? 'enabled' : 'disabled'} (writes review candidates only)`);
  lines.push(`Approval required: ${requireApproval ? 'yes' : 'no'}`);
  lines.push(`Inbox: ${getMemoryInboxDir(input.workspace, input)}`);
  lines.push('');

  if (ctx.indexFile) {
    const cap =
      ctx.loadedLineCount < ctx.indexLineCount
        ? `first ${ctx.loadedLineCount} of ${ctx.indexLineCount} non-empty lines`
        : `${ctx.loadedLineCount} non-empty lines`;
    lines.push(`Loaded index: ${ctx.indexFile} (${cap})`);
  } else {
    lines.push('Loaded index: none found');
  }

  lines.push(`Pending candidates: ${ctx.candidates.length}`);
  lines.push('');

  const approvedFiles = ctx.files.filter((file) => file.name !== 'MEMORY.md');
  if (approvedFiles.length === 0) {
    lines.push('Approved memory files: none yet');
  } else {
    lines.push('Approved memory files:');
    for (const file of approvedFiles) {
      lines.push(`  - ${file.title ?? file.name} (${file.type ?? 'unknown'}) — ${file.name}`);
    }
  }

  lines.push('');
  lines.push(
    'Commands: /memory inbox, /memory approve <n|file>, /memory discard <n|file>, /memory on, /memory off, /memory path',
  );
  lines.push(`Path: ${getProjectMemoryDir(input.workspace, input)}`);
  return lines.join('\n');
}
