import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { marked } from 'marked';
import { buildMemoryReport, getMemoryIndex } from './memory-display.js';
import { getProjectMemoryDir, loadMemoryContext } from './memory-store.js';
import { DEFAULT_SETTINGS } from './settings.js';

let bookRoot: string;
const workspace = 'C:\\fake\\book-test-ws';

beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'book-memory-display-'));
});

afterEach(() => {
  rmSync(bookRoot, { recursive: true, force: true });
});

/**
 * The memory directory of `workspace`, created and marked as already in the current layout, so
 * loading it leaves the legacy-layout files these tests list as they are.
 */
function memoryDir(): string {
  const dir = getProjectMemoryDir(workspace, { bookRoot });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.format'), '2\n');
  return dir;
}

/** A memory file as the model writes it: its own `name`, `description` and `metadata` block. */
function memoryFile(name: string, type: string, extra = ''): string {
  return `---\nname: ${name}\ndescription: About ${name}\nmetadata:\n  type: ${type}\n${extra}---\nBody of ${name}.\n`;
}

describe('buildMemoryReport', () => {
  it('reports no memories when the memory dir is absent', () => {
    const report = buildMemoryReport({ workspace, bookRoot, settings: DEFAULT_SETTINGS });
    expect(report).not.toContain('Index:');
    expect(report).toMatch(/Health: 0 memories, 0\/200 index lines/);
    expect(report).toContain('No memories yet.');
    expect(report).toContain('model writes enabled (files in the memory directory)');
    // The inbox, its approval and the supersede history are gone from the report.
    expect(report).not.toMatch(/inbox|approve|discard|superseded/i);
  });

  it('lists a memory from its frontmatter: metadata.type, or the legacy top-level type', () => {
    const dir = memoryDir();
    writeFileSync(join(dir, 'new-style.md'), memoryFile('new-style', 'feedback'));
    writeFileSync(
      join(dir, 'old-style.md'),
      '---\ntype: project\nstatus: approved\n---\n# Old style rule\nBody',
    );
    const report = buildMemoryReport({ workspace, bookRoot, settings: DEFAULT_SETTINGS });
    expect(report).toContain('- About new-style (feedback) — new-style.md');
    expect(report).toContain('- Old style rule (project) — old-style.md');
    expect(report).toMatch(/Health: 2 memories,/);
  });

  it('titles a memory from its MEMORY.md line, else its description, not its slug', () => {
    const dir = memoryDir();
    writeFileSync(
      join(dir, 'MEMORY.md'),
      '- [Prefer pnpm over npm](prefer-pnpm.md) — lockfile rule\n',
    );
    writeFileSync(join(dir, 'prefer-pnpm.md'), memoryFile('prefer-pnpm', 'feedback'));
    writeFileSync(join(dir, 'unlisted.md'), memoryFile('unlisted', 'project'));
    const report = buildMemoryReport({ workspace, bookRoot, settings: DEFAULT_SETTINGS });
    expect(report).toContain('- Prefer pnpm over npm (feedback) — prefer-pnpm.md');
    expect(report).toContain('- About unlisted (project) — unlisted.md');
    expect(report).not.toContain('- prefer-pnpm (');
  });

  it('says a delegated session keeps learnings only, and marks what delegated runs saved', () => {
    const dir = memoryDir();
    writeFileSync(join(dir, 'heap.md'), memoryFile('heap', 'project', '  driver: agent\n'));
    // The legacy layout marks it with a top-level `driver`.
    writeFileSync(join(dir, 'legacy.md'), '---\ntype: project\ndriver: agent\n---\n# Legacy\nBody');
    writeFileSync(join(dir, 'mine.md'), memoryFile('mine', 'user'));
    const report = buildMemoryReport({
      workspace,
      bookRoot,
      settings: DEFAULT_SETTINGS,
      sessionDriver: 'agent',
    });
    expect(report).toContain('model writes learnings only (session driven by another agent');
    expect(report).toContain('About heap (project · from a delegated run)');
    expect(report).toContain('Legacy (project · from a delegated run)');
    expect(report).toContain('About mine (user) — mine.md');
  });

  it('lists a legacy superseded file as legacy, without hiding it', () => {
    const dir = memoryDir();
    writeFileSync(
      join(dir, 'old.md'),
      '---\ntype: project\nstatus: superseded\nsupersededBy: new.md\n---\n# Old\nBody',
    );
    const report = buildMemoryReport({ workspace, bookRoot, settings: DEFAULT_SETTINGS });
    expect(report).toContain('Old (project · legacy, superseded) — old.md');
    expect(report).toMatch(/Health: 1 memory,/);
  });

  it('leaves dot-entries and the index out of the listing', () => {
    const dir = memoryDir();
    writeFileSync(join(dir, 'MEMORY.md'), '- [A](a.md) — hook\n');
    writeFileSync(join(dir, 'a.md'), memoryFile('a', 'project'));
    writeFileSync(join(dir, '.hidden.md'), memoryFile('hidden', 'project'));
    mkdirSync(join(dir, '.inbox'));
    writeFileSync(join(dir, '.inbox', 'pending.md'), memoryFile('pending', 'user'));
    const report = buildMemoryReport({ workspace, bookRoot, settings: DEFAULT_SETTINGS });
    expect(report).toMatch(/Health: 1 memory,/);
    expect(report).not.toContain('hidden');
    expect(report).not.toContain('pending');
  });

  it('lists memory and reports the line cap', () => {
    const dir = memoryDir();
    writeFileSync(
      join(dir, 'MEMORY.md'),
      Array.from({ length: 205 }, (_, i) => `line ${i + 1}`).join('\n'),
      'utf-8',
    );
    writeFileSync(
      join(dir, 'a.md'),
      '---\ntype: project\nstatus: approved\n---\n# Project rule\nBody',
      'utf-8',
    );

    const report = buildMemoryReport({ workspace, bookRoot, settings: DEFAULT_SETTINGS });
    expect(report).toContain('first 200 of 205');
    expect(report).toContain('Project rule (project)');
  });

  it('reports lines and bytes against both limits when the index fits', () => {
    const dir = memoryDir();
    writeFileSync(join(dir, 'MEMORY.md'), '- [A](a.md) — hook\n', 'utf-8');
    const report = buildMemoryReport({ workspace, bookRoot, settings: DEFAULT_SETTINGS });
    expect(report).toContain('Index: 1/200 lines, 20/25,000 bytes\n');
    expect(report).not.toContain('cut');
  });

  it('says when the line limit cut the index', () => {
    const dir = memoryDir();
    writeFileSync(
      join(dir, 'MEMORY.md'),
      Array.from({ length: 205 }, (_, i) => `line ${i + 1}`).join('\n'),
      'utf-8',
    );
    const report = buildMemoryReport({ workspace, bookRoot, settings: DEFAULT_SETTINGS });
    expect(report).toContain('Index: 205/200 lines, 1,736/25,000 bytes — cut (over the 200-line');
    expect(report).toContain('first 200 of 205 non-empty lines loaded');
  });

  it('says when the byte limit cut the index', () => {
    const dir = memoryDir();
    writeFileSync(
      join(dir, 'MEMORY.md'),
      Array.from({ length: 100 }, () => 'z'.repeat(300)).join('\n'),
      'utf-8',
    );
    const report = buildMemoryReport({ workspace, bookRoot, settings: DEFAULT_SETTINGS });
    expect(report).toContain(
      'Index: 100/200 lines, 30,099/25,000 bytes — cut (over the 25,000-byte limit)',
    );
    expect(report).not.toContain('-line limit');
  });

  it('shows disabled model writes when autoSave is off', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.memory.autoSave = false;

    const report = buildMemoryReport({ workspace, bookRoot, settings });
    expect(report).toContain('model writes disabled');
  });

  it('keeps getMemoryIndex compatibility', () => {
    const dir = memoryDir();
    writeFileSync(join(dir, 'MEMORY.md'), '- [A](a.md) — hook\n', 'utf-8');
    const idx = getMemoryIndex(workspace, { bookRoot });
    expect(idx.indexFile).toBe(join(dir, 'MEMORY.md'));
    expect(idx.indexLineCount).toBe(1);
  });

  it('reports memory health line with the memory and index line counts, and last write', () => {
    const dir = memoryDir();
    writeFileSync(join(dir, 'MEMORY.md'), '- [Rule](rule.md) — project rule\n', 'utf-8');
    writeFileSync(
      join(dir, 'rule.md'),
      '---\ntype: project\nstatus: approved\n---\n# Rule\nUse TypeScript.',
      'utf-8',
    );

    const report = buildMemoryReport({ workspace, bookRoot, settings: DEFAULT_SETTINGS });
    expect(report).toMatch(/Health: 1 memory, 1\/200 index lines, last write: \d{4}-\d{2}-\d{2}T/);
  });

  it('reads the store from disk so a memory written in-session shows up at once', () => {
    // The session-start snapshot, taken before anything was written.
    const sessionStart = loadMemoryContext(workspace, { bookRoot });
    expect(sessionStart.files).toHaveLength(0);

    writeFileSync(join(memoryDir(), 'fresh-fact.md'), memoryFile('fresh-fact', 'project'));

    const report = buildMemoryReport({ workspace, bookRoot, settings: DEFAULT_SETTINGS });
    expect(report).toContain('fresh-fact (project)');
    expect(report).toMatch(/Health: 1 memory,/);
  });

  it('renders paths in inline code spans so marked preserves backslashes', () => {
    const winBookRoot = 'C:\\Users\\test\\.book';
    const report = buildMemoryReport({
      workspace,
      bookRoot: winBookRoot,
      settings: DEFAULT_SETTINGS,
    });

    // The report wraps its path in an inline code span (`...`)
    expect(report).toContain(`Location: \`${winBookRoot}`);
    // The directory is printed once; it used to repeat as `Path:` at the end.
    expect(report.split(winBookRoot).length - 1).toBe(1);

    // When processed through marked, the backslashes survive inside <code> blocks
    const parsed = marked.parse(report);
    expect(parsed).toContain(`<code>${winBookRoot}`);
  });
});
