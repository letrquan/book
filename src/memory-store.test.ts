import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  approveMemoryCandidate,
  countMemoryCandidates,
  discardMemoryCandidate,
  getMemoryHealth,
  getMemoryInboxDir,
  getNewestMemoryWriteTime,
  getProjectMemoryDir,
  listMemoryCandidates,
  listMemoryFiles,
  loadMemoryContext,
  slugifyWorkspace,
  writeMemoryCandidate,
} from './memory-store.js';

let bookRoot: string;

beforeEach(() => {
  bookRoot = mkdtempSync(join(tmpdir(), 'book-memory-'));
});

afterEach(() => {
  rmSync(bookRoot, { recursive: true, force: true });
});

describe('memory store paths', () => {
  it('slugifies workspace paths using the existing convention', () => {
    expect(slugifyWorkspace('C:\\fake\\book test')).toBe('C-fake-book-test');
    expect(slugifyWorkspace('/home/me/project')).toBe('home-me-project');
    expect(slugifyWorkspace('weird ! name')).toBe('weird---name');
  });

  it('resolves memory and inbox directories under injected book root', () => {
    const ws = 'C:\\fake\\book-test-ws';
    expect(getProjectMemoryDir(ws, { bookRoot })).toBe(
      join(bookRoot, 'projects', 'C-fake-book-test-ws', 'memory'),
    );
    expect(getMemoryInboxDir(ws, { bookRoot })).toBe(
      join(bookRoot, 'projects', 'C-fake-book-test-ws', 'memory', '.inbox'),
    );
  });
});

describe('loadMemoryContext', () => {
  it('returns an empty context when the directory is absent', () => {
    const ctx = loadMemoryContext('C:\\fake\\missing', { bookRoot });
    expect(ctx.indexLoaded).toBe(false);
    expect(ctx.files).toEqual([]);
    expect(ctx.candidates).toEqual([]);
  });

  it('loads only the first 200 lines of MEMORY.md', () => {
    const ws = 'C:\\fake\\with-index';
    const dir = getProjectMemoryDir(ws, { bookRoot });
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'MEMORY.md'),
      Array.from({ length: 205 }, (_, i) => `line ${i + 1}`).join('\n'),
      'utf-8',
    );

    const ctx = loadMemoryContext(ws, { bookRoot });
    expect(ctx.indexLoaded).toBe(true);
    expect(ctx.indexLineCount).toBe(205);
    expect(ctx.loadedLineCount).toBe(200);
    expect(ctx.indexText).toContain('line 200');
    expect(ctx.indexText).not.toContain('line 201');
  });

  it('lists approved files and excludes inbox files from active memory', () => {
    const ws = 'C:\\fake\\files';
    const dir = getProjectMemoryDir(ws, { bookRoot });
    const inbox = getMemoryInboxDir(ws, { bookRoot });
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(dir, 'MEMORY.md'), '# Book memory index\n', 'utf-8');
    writeFileSync(
      join(dir, 'a.md'),
      '---\ntype: project\nstatus: approved\n---\n# A\nBody',
      'utf-8',
    );
    writeFileSync(
      join(inbox, 'candidate.md'),
      '---\ntype: user\nstatus: pending\n---\n# Candidate\nBody',
      'utf-8',
    );

    const files = listMemoryFiles(ws, { bookRoot });
    const ctx = loadMemoryContext(ws, { bookRoot });
    expect(files.map((f) => f.name)).toContain('a.md');
    expect(files.map((f) => f.name)).not.toContain('candidate.md');
    // The index file itself must not be counted as an approved memory file.
    expect(files.map((f) => f.name)).not.toContain('MEMORY.md');
    expect(ctx.candidates).toHaveLength(1);
    expect(ctx.candidates[0].status).toBe('pending');
  });
});

describe('candidate lifecycle', () => {
  it('writes candidates to the inbox', () => {
    const ws = 'C:\\fake\\candidate';
    const result = writeMemoryCandidate(
      ws,
      {
        type: 'user',
        title: 'User prefers concise summaries',
        body: 'The user prefers concise summaries.',
        source: 'auto',
        confidence: 'high',
        tags: ['explicit'],
      },
      { bookRoot, now: new Date('2026-07-04T12:34:56Z') },
    );

    expect(result.ok).toBe(true);
    expect(result.path).toContain('.inbox');
    expect(existsSync(result.path!)).toBe(true);
    expect(listMemoryCandidates(ws, { bookRoot })).toHaveLength(1);
  });

  it('approves candidates into active memory and updates MEMORY.md newest-first', () => {
    const ws = 'C:\\fake\\approve';
    const written = writeMemoryCandidate(
      ws,
      {
        type: 'project',
        title: 'Project uses pnpm',
        body: 'This repo uses pnpm.',
        source: 'auto',
      },
      { bookRoot, now: new Date('2026-07-04T12:34:56Z') },
    );

    const approved = approveMemoryCandidate(ws, written.path!, {
      bookRoot,
      now: new Date('2026-07-04T13:00:00Z'),
    });
    expect(approved.ok).toBe(true);
    expect(approved.path).toContain('project-uses-pnpm');
    expect(
      readFileSync(join(getProjectMemoryDir(ws, { bookRoot }), 'MEMORY.md'), 'utf-8'),
    ).toContain('[Project uses pnpm]');
    expect(loadMemoryContext(ws, { bookRoot }).candidates).toHaveLength(0);
  });

  it('rejects traversal and symlink candidates', () => {
    const ws = 'C:\\fake\\safe';
    const dir = getMemoryInboxDir(ws, { bookRoot });
    mkdirSync(dir, { recursive: true });
    expect(approveMemoryCandidate(ws, '../evil.md', { bookRoot }).ok).toBe(false);

    const target = join(bookRoot, 'target.md');
    writeFileSync(target, '---\ntype: user\n---\n# Secret', 'utf-8');
    const link = join(dir, 'link.md');
    try {
      symlinkSync(target, link);
      expect(approveMemoryCandidate(ws, 'link.md', { bookRoot }).ok).toBe(false);
    } catch {
      // Symlink creation can be unavailable on Windows without privileges.
    }
  });

  it('discards candidates into the discarded inbox folder', () => {
    const ws = 'C:\\fake\\discard';
    const written = writeMemoryCandidate(
      ws,
      {
        type: 'feedback',
        title: 'That worked',
        body: 'User confirmed the approach worked.',
        source: 'auto',
      },
      { bookRoot },
    );

    const discarded = discardMemoryCandidate(ws, written.path!, { bookRoot });
    expect(discarded.ok).toBe(true);
    expect(discarded.path).toContain('discarded');
    expect(listMemoryCandidates(ws, { bookRoot })).toHaveLength(0);
  });

  it('writes memory markdown with blank-line spacers between frontmatter, heading, and body', () => {
    const ws = 'C:\\fake\\render';
    const written = writeMemoryCandidate(
      ws,
      {
        type: 'user',
        title: 'Prefers concise summaries',
        body: 'The user prefers concise summaries.',
        source: 'auto',
        confidence: 'high',
        tags: ['explicit'],
      },
      { bookRoot, now: new Date('2026-07-04T12:34:56Z') },
    );

    const raw = readFileSync(written.path!, 'utf-8');
    // Blank line between the closing --- fence and the # heading.
    expect(raw).toContain('---\n\n# ');
    // Blank line between the heading and the body text.
    expect(raw).toMatch(/# [^\n]+\n\nThe user prefers/);
    // Frontmatter fields are populated, not collapsed into the fence.
    expect(raw).toContain('type: user');
    expect(raw).toContain('confidence: high');
  });

  describe('getNewestMemoryWriteTime and memory health', () => {
    it('does not hang on a symlink loop and ignores discarded candidates and dotfiles', () => {
      const ws = 'C:\\fake\\symlink-loop';
      const memoryDir = getProjectMemoryDir(ws, { bookRoot });
      mkdirSync(memoryDir, { recursive: true });

      // Write an approved file
      const approvedFile = join(memoryDir, 'approved.md');
      writeFileSync(approvedFile, '# Approved fact', 'utf-8');

      // Create a symlink loop inside memoryDir
      const loopLink = join(memoryDir, 'loop-link');
      try {
        symlinkSync(memoryDir, loopLink);
      } catch {
        // May be restricted on Windows without admin, continue if so
      }

      // Write a dotfile (like .extraction-state.json) with recent timestamp
      const dotFile = join(memoryDir, '.extraction-state.json');
      writeFileSync(dotFile, '{"watermark": "recent"}', 'utf-8');

      // Write a discarded candidate inside .inbox/discarded/
      const inboxDir = getMemoryInboxDir(ws, { bookRoot });
      const discardedDir = join(inboxDir, 'discarded');
      mkdirSync(discardedDir, { recursive: true });
      const discardedFile = join(discardedDir, 'discarded.md');
      writeFileSync(discardedFile, '# Discarded fact', 'utf-8');

      const newest = getNewestMemoryWriteTime(memoryDir);
      expect(newest).not.toBeNull();
      // Should see approvedFile, and neither hang on loop-link nor count .extraction-state.json or discarded.md
    });

    it('counts approved files with status approved or absent, excluding pending/discarded and MEMORY.md', () => {
      const ws = 'C:\\fake\\health-status';
      const memoryDir = getProjectMemoryDir(ws, { bookRoot });
      mkdirSync(memoryDir, { recursive: true });

      writeFileSync(join(memoryDir, 'MEMORY.md'), '# Index\n- [A](a.md)\n- [B](b.md)\n', 'utf-8');
      writeFileSync(
        join(memoryDir, 'approved-explicit.md'),
        '---\nstatus: approved\ntype: project\n---\n# Expl',
        'utf-8',
      );
      writeFileSync(
        join(memoryDir, 'approved-absent.md'),
        '---\ntype: project\n---\n# Absent status is approved',
        'utf-8',
      );
      writeFileSync(
        join(memoryDir, 'pending.md'),
        '---\nstatus: pending\ntype: project\n---\n# Pending',
        'utf-8',
      );
      writeFileSync(
        join(memoryDir, 'discarded.md'),
        '---\nstatus: discarded\ntype: project\n---\n# Discarded',
        'utf-8',
      );

      // Also write one candidate to inbox
      writeMemoryCandidate(
        ws,
        {
          type: 'user',
          title: 'Candidate in inbox',
          body: 'Candidate body.',
          source: 'auto',
        },
        { bookRoot },
      );

      const health = getMemoryHealth(ws, { bookRoot });
      expect(health.approvedCount).toBe(2); // approved-explicit.md and approved-absent.md
      expect(health.inboxCount).toBe(1);
      expect(health.indexLineCount).toBe(3); // non-empty lines in MEMORY.md
      expect(health.lastWrite).not.toBeNull();
    });

    it('cheaply counts candidates in inbox without parsing frontmatter', () => {
      const ws = 'C:\\fake\\cheap-count';
      const inboxDir = getMemoryInboxDir(ws, { bookRoot });
      mkdirSync(inboxDir, { recursive: true });

      writeFileSync(join(inboxDir, 'cand1.md'), 'not valid frontmatter', 'utf-8');
      writeFileSync(join(inboxDir, 'cand2.md'), 'also raw text', 'utf-8');
      writeFileSync(join(inboxDir, 'other.txt'), 'txt file', 'utf-8');
      writeFileSync(join(inboxDir, '.dotfile.md'), 'dotfile', 'utf-8');

      expect(countMemoryCandidates(ws, { bookRoot })).toBe(2);
      expect(countMemoryCandidates(ws, { dir: memoryDirOrInbox(ws, bookRoot) })).toBe(2);
    });
  });
});

function memoryDirOrInbox(ws: string, root: string): string {
  return getProjectMemoryDir(ws, { bookRoot: root });
}
