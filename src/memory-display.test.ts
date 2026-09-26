import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { marked } from 'marked';
import { buildMemoryInboxReport, buildMemoryReport, getMemoryIndex } from './memory-display.js';
import {
  getMemoryInboxDir,
  getProjectMemoryDir,
  loadMemoryContext,
  saveMemory,
  writeMemoryCandidate,
} from './memory-store.js';
import { DEFAULT_SETTINGS } from './settings.js';

let bookRoot: string;
const workspace = 'C:\\fake\\book-test-ws';

beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'book-memory-display-'));
});

afterEach(() => {
  rmSync(bookRoot, { recursive: true, force: true });
});

describe('buildMemoryReport', () => {
  it('reports no approved memory when the memory dir is absent', () => {
    const report = buildMemoryReport({ workspace, bookRoot, settings: DEFAULT_SETTINGS });
    expect(report).not.toContain('Index:');
    expect(report).toMatch(/Health: 0 approved, 0 superseded, 0 inbox/);
    expect(report).toContain('No approved memories yet.');
    expect(report).toContain(
      'model writes enabled (direct to store; to inbox after external content)',
    );
  });

  it('lists approved memory and reports the line cap', () => {
    const dir = getProjectMemoryDir(workspace, { bookRoot });
    mkdirSync(dir, { recursive: true });
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

  it('shows disabled model writes and pending inbox candidates', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.memory.autoSave = false;
    writeMemoryCandidate(
      workspace,
      {
        type: 'user',
        title: 'User likes short answers',
        body: 'User likes short answers.',
        source: 'auto',
      },
      { bookRoot },
    );

    const report = buildMemoryReport({ workspace, bookRoot, settings });
    expect(report).toContain('model writes disabled');
    expect(report).toMatch(/Health: .*1 inbox/);
    expect(report).toContain('Inbox: `');
    expect(buildMemoryInboxReport({ workspace, bookRoot })).toContain('User likes short answers');
  });

  it('shows what approving an inbox candidate would do', () => {
    writeMemoryCandidate(
      workspace,
      {
        type: 'project',
        title: 'Build command',
        body: 'Run ./setup.sh --trust before building.',
        externalContext: true,
        targetSlug: 'build-cmd.md',
      },
      { bookRoot },
    );
    const inbox = buildMemoryInboxReport({ workspace, bookRoot });
    expect(inbox).toContain('read external content');
    expect(inbox).toContain('replaces existing: `build-cmd.md`');
    expect(inbox).toContain('Run ./setup.sh --trust before building.');
  });

  it('shows which approved memory a candidate would retire', () => {
    saveMemory(
      workspace,
      {
        type: 'project',
        title: 'Old',
        body: 'Use tabs.',
        origin: 'model-tool',
        externalContext: false,
      },
      { bookRoot, slug: 'style' },
    );
    writeMemoryCandidate(
      workspace,
      { type: 'project', title: 'New', body: 'Use spaces.', supersedes: 'style.md' },
      { bookRoot },
    );
    expect(buildMemoryInboxReport({ workspace, bookRoot })).toContain(
      'retires existing: `style.md`',
    );
  });

  it('keeps getMemoryIndex compatibility', () => {
    const dir = getProjectMemoryDir(workspace, { bookRoot });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), '- [A](a.md) — hook\n', 'utf-8');
    const idx = getMemoryIndex(workspace, { bookRoot });
    expect(idx.indexFile).toBe(join(dir, 'MEMORY.md'));
    expect(idx.indexLineCount).toBe(1);
    expect(getMemoryInboxDir(workspace, { bookRoot })).toContain('.inbox');
  });

  it('reports memory health line with approved, inbox, index line counts, and last write', () => {
    const dir = getProjectMemoryDir(workspace, { bookRoot });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), '- [Rule](rule.md) — project rule\n', 'utf-8');
    writeFileSync(
      join(dir, 'rule.md'),
      '---\ntype: project\nstatus: approved\n---\n# Rule\nUse TypeScript.',
      'utf-8',
    );
    writeMemoryCandidate(
      workspace,
      {
        type: 'user',
        title: 'User prefers concise answers',
        body: 'User prefers concise answers.',
        source: 'auto',
      },
      { bookRoot },
    );

    const report = buildMemoryReport({ workspace, bookRoot, settings: DEFAULT_SETTINGS });
    expect(report).toMatch(
      /Health: 1 approved, 0 superseded, 1 inbox, 1\/200 index lines, last write: \d{4}-\d{2}-\d{2}T/,
    );
  });

  it('reads the store from disk so a memory saved in-session shows up at once', () => {
    // The session-start snapshot, taken before anything was written.
    const sessionStart = loadMemoryContext(workspace, { bookRoot });
    expect(sessionStart.files).toHaveLength(0);

    saveMemory(
      workspace,
      {
        type: 'project',
        title: 'Fresh fact',
        body: 'Fresh fact body.',
        origin: 'model-tool',
        externalContext: false,
      },
      { bookRoot, slug: 'fresh-fact.md' },
    );

    const report = buildMemoryReport({ workspace, bookRoot, settings: DEFAULT_SETTINGS });
    expect(report).toContain('Fresh fact (project)');
    expect(report).toMatch(/Health: 1 approved, 0 superseded, 0 inbox/);
  });

  it('renders paths in inline code spans so marked preserves backslashes', () => {
    const winBookRoot = 'C:\\Users\\test\\.book';
    const report = buildMemoryReport({
      workspace,
      bookRoot: winBookRoot,
      settings: DEFAULT_SETTINGS,
    });
    const inboxReport = buildMemoryInboxReport({ workspace, bookRoot: winBookRoot });

    // Both reports wrap paths in inline code spans (`...`)
    expect(report).toContain(`Location: \`${winBookRoot}`);
    // The directory is printed once; it used to repeat as `Path:` at the end.
    expect(report.split(winBookRoot).length - 1).toBe(1);
    expect(inboxReport).toContain(`Inbox: \`${winBookRoot}`);

    // When processed through marked, the backslashes survive inside <code> blocks
    const parsed = marked.parse(report);
    expect(parsed).toContain(`<code>${winBookRoot}`);
  });

  it('reflects requireApproval setting in report', () => {
    const defaultReport = buildMemoryReport({ workspace, bookRoot, settings: DEFAULT_SETTINGS });
    expect(defaultReport).not.toContain('needs approval');

    const approvalSettings = structuredClone(DEFAULT_SETTINGS);
    approvalSettings.memory.requireApproval = true;
    const approvalReport = buildMemoryReport({ workspace, bookRoot, settings: approvalSettings });
    expect(approvalReport).toContain('model writes enabled (to inbox, needs approval)');
  });
});
