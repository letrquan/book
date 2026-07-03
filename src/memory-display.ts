/**
 * /memory display helper.
 *
 * The Book auto-memory layout (mirroring the MEMORY.md convention) is:
 *   ~/.book/projects/<slug>/memory/MEMORY.md   (index)
 *   ~/.book/projects/<slug>/memory/<file>.md  (per-fact memory files)
 *
 * 1d (the auto-write path) is not yet implemented, so this command is read-only:
 * it surfaces which memory files exist for THIS workspace so the user can see
 * whether anything has been loaded. When 1d lands this command already does
 * the right thing and needs no change to display existing memories.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

/** Slugify a workspace path the same way the memory store would. */
function slugifyWorkspace(workspace: string): string {
  // Mirror the ~/.claude/projects convention used at the top of the repo:
  // replace non-alphanumeric with '-', strip leading separators.
  return workspace
    .replace(/[/\\:]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '');
}

interface MemoryIndex {
  dir: string;
  indexFile: string | null;
  indexLineCount: number;
  files: Array<{ name: string; size: number }>;
}

export function getMemoryIndex(workspace: string): MemoryIndex {
  const dir = join(homedir(), '.book', 'projects', slugifyWorkspace(workspace), 'memory');
  const result: MemoryIndex = { dir, indexFile: null, indexLineCount: 0, files: [] };
  if (!existsSync(dir)) return result;

  const indexFile = join(dir, 'MEMORY.md');
  if (existsSync(indexFile) && statSync(indexFile).isFile()) {
    result.indexFile = indexFile;
    try {
      result.indexLineCount = readFileSync(indexFile, 'utf-8')
        .split('\n')
        .filter((l) => l.trim().length > 0).length;
    } catch {
      result.indexLineCount = 0;
    }
  }

  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (!entry.endsWith('.md')) continue;
      try {
        if (!statSync(full).isFile()) continue;
      } catch {
        continue;
      }
      result.files.push({ name: entry, size: result.files.length + 1 });
    }
  } catch {
    // ignore unreadable dir
  }

  return result;
}

/**
 * Render the /memory report string shown in the TUI.
 * Honestly surfaces "no memories yet" when the dir is absent — this is the
 * right call before 1d's auto-write lands.
 */
export function buildMemoryReport(workspace: string): string {
  const idx = getMemoryIndex(workspace);
  if (!idx.indexFile && idx.files.length === 0) {
    return [
      'Auto-memory: no memory files found for this workspace yet.',
      '',
      `Expected location: ${idx.dir}`,
      '',
      'Auto-write is not yet wired (MILESTONES 1d). Memories will appear here once the',
      'agent starts saving user corrections/feedback across sessions.',
    ].join('\n');
  }

  const lines: string[] = ['Auto-memory for this workspace:', ''];
  lines.push(`Location: ${idx.dir}`);
  lines.push(
    `Index: ${idx.indexFile ?? '(MEMORY.md missing)'} (${idx.indexLineCount} non-empty lines)`,
  );
  lines.push('');
  lines.push('Memory files:');
  for (const f of idx.files) {
    const tag = f.name === 'MEMORY.md' ? ' (index)' : '';
    lines.push(`  - ${f.name}${tag}`);
  }
  lines.push('');
  lines.push('(Read-only view. Auto-save is not yet implemented — MILESTONES 1d.)');
  return lines.join('\n');
}
