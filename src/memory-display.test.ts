import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { buildMemoryReport, getMemoryIndex } from './memory-display.js';

// We cannot easily stub homedir(), so we test the report against a workspace
// and assert the "no memory yet" branch — the realistic state today, since
// 1d's auto-write isn't wired and no ~/.book/projects/... dir exists on CI.

describe('buildMemoryReport', () => {
  it('reports no memory when the memory dir is absent', () => {
    const report = buildMemoryReport(join(tmpdir(), 'book-test-no-such-ws-' + crypto.randomUUID()));
    expect(report).toContain('no memory files found');
    expect(report).toContain('Auto-write is not yet wired');
  });

  it('lists existing memory files when present', () => {
    // Use a workspace slug we control by writing into the resolved dir.
    const fakeWs = 'C:\\fake\\book-test-ws';
    const idx = getMemoryIndex(fakeWs);
    mkdirSync(idx.dir, { recursive: true });
    writeFileSync(join(idx.dir, 'MEMORY.md'), '- [A](a.md) — hook\n- [B](b.md) — hook2\n', 'utf-8');
    writeFileSync(join(idx.dir, 'a.md'), 'body', 'utf-8');

    try {
      const report = buildMemoryReport(fakeWs);
      expect(report).toContain('Auto-memory for this workspace');
      expect(report).toContain('MEMORY.md (index)');
      expect(report).toContain('a.md');
      expect(report).toContain('2 non-empty lines');
    } finally {
      rmSync(idx.dir, { recursive: true, force: true });
    }
  });
});
