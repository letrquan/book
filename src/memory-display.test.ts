import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { buildMemoryInboxReport, buildMemoryReport, getMemoryIndex } from './memory-display.js';
import { getMemoryInboxDir, getProjectMemoryDir, writeMemoryCandidate } from './memory-store.js';
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
    expect(report).toContain('Loaded index: none found');
    expect(report).toContain('Pending candidates: 0');
    expect(report).toContain('Auto-capture: enabled');
  });

  it('lists approved memory and reports the line cap', () => {
    const dir = getProjectMemoryDir(workspace, { bookRoot });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), Array.from({ length: 205 }, (_, i) => `line ${i + 1}`).join('\n'), 'utf-8');
    writeFileSync(join(dir, 'a.md'), '---\ntype: project\nstatus: approved\n---\n# Project rule\nBody', 'utf-8');

    const report = buildMemoryReport({ workspace, bookRoot, settings: DEFAULT_SETTINGS });
    expect(report).toContain('first 200 of 205');
    expect(report).toContain('Project rule (project)');
  });

  it('shows disabled auto-capture and pending inbox candidates', () => {
    const settings = structuredClone(DEFAULT_SETTINGS);
    settings.memory.autoSave = false;
    writeMemoryCandidate(workspace, {
      type: 'user',
      title: 'User likes short answers',
      body: 'User likes short answers.',
      source: 'auto',
    }, { bookRoot });

    const report = buildMemoryReport({ workspace, bookRoot, settings });
    expect(report).toContain('Auto-capture: disabled');
    expect(report).toContain('Pending candidates: 1');
    expect(buildMemoryInboxReport({ workspace, bookRoot })).toContain('User likes short answers');
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
});
