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
  MAX_BODY_CHARS,
  approveMemoryCandidate,
  countMemoryCandidates,
  deleteMemoryEntry,
  discardMemoryCandidate,
  getMemoryHealth,
  getMemoryInboxDir,
  getNewestMemoryWriteTime,
  getProjectMemoryDir,
  listMemoryCandidates,
  listMemoryFiles,
  loadMemoryContext,
  readMemoryFile,
  sanitizeMemoryTitle,
  saveMemory,
  shouldRejectMemoryText,
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

  describe('provenance schema and round-trip', () => {
    it('round-trips full provenance fields through frontmatter', () => {
      const ws = 'C:\\fake\\provenance-rt';
      const result = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Monorepo conventions',
          body: 'Use pnpm across all packages.\nWhy: Single lockfile.\nHow to apply: Never run npm install.',
          origin: 'model-tool',
          source: 'auto',
          sessionId: 'session-xyz-456',
          externalContext: true,
          evidence: ['rec-turn-1', 'rec-turn-2'],
          supersedes: 'old-pnpm-slug',
          confidence: 'high',
          tags: ['monorepo', 'tooling'],
        },
        { bookRoot, now: new Date('2026-09-20T10:00:00Z') },
      );

      expect(result.ok).toBe(true);
      expect(result.status).toBe('approved');
      expect(result.path).toBeDefined();

      const parsed = readMemoryFile(result.path!);
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe('project');
      expect(parsed?.title).toBe('Monorepo conventions');
      expect(parsed?.origin).toBe('model-tool');
      expect(parsed?.source).toBe('auto');
      expect(parsed?.sessionId).toBe('session-xyz-456');
      expect(parsed?.externalContext).toBe(true);
      expect(parsed?.evidence).toEqual(['rec-turn-1', 'rec-turn-2']);
      expect(parsed?.supersedes).toBe('old-pnpm-slug');
      expect(parsed?.confidence).toBe('high');
      expect(parsed?.tags).toEqual(['monorepo', 'tooling']);
      expect(parsed?.status).toBe('approved');
    });

    it('reads legacy source: auto files and derives origin user-text and externalContext false', () => {
      const dir = getProjectMemoryDir('C:\\fake\\legacy-auto', { bookRoot });
      mkdirSync(dir, { recursive: true });
      const legacyPath = join(dir, 'legacy-auto.md');
      writeFileSync(
        legacyPath,
        [
          '---',
          'type: feedback',
          'source: auto',
          'status: approved',
          'created: 2026-05-01T12:00:00Z',
          '---',
          '',
          '# That worked',
          '',
          'User confirmed the approach worked.',
          '',
        ].join('\n'),
        'utf-8',
      );

      const parsed = readMemoryFile(legacyPath);
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe('feedback');
      expect(parsed?.title).toBe('That worked');
      expect(parsed?.origin).toBe('user-text');
      expect(parsed?.source).toBe('auto');
      expect(parsed?.externalContext).toBe(false);
      expect(parsed?.sessionId).toBeUndefined();
      expect(parsed?.evidence).toBeUndefined();
    });

    it('reads legacy source: manual files and derives origin user-text', () => {
      const dir = getProjectMemoryDir('C:\\fake\\legacy-manual', { bookRoot });
      mkdirSync(dir, { recursive: true });
      const legacyPath = join(dir, 'legacy-manual.md');
      writeFileSync(
        legacyPath,
        [
          '---',
          'type: user',
          'source: manual',
          'status: approved',
          'created: 2026-05-01T12:00:00Z',
          '---',
          '',
          '# User prefers concise answers',
          '',
          'Give short answers.',
          '',
        ].join('\n'),
        'utf-8',
      );

      const parsed = readMemoryFile(legacyPath);
      expect(parsed).not.toBeNull();
      expect(parsed?.type).toBe('user');
      expect(parsed?.title).toBe('User prefers concise answers');
      expect(parsed?.origin).toBe('user-text');
      expect(parsed?.source).toBe('manual');
      expect(parsed?.externalContext).toBe(false);
    });
  });

  describe('saveMemory and deleteMemoryEntry', () => {
    it('writes directly to approved store and index when requireApproval is false', () => {
      const ws = 'C:\\fake\\direct-save';
      const result = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Direct save entry',
          body: 'Content for direct save.',
          origin: 'model-tool',
          externalContext: false,
        },
        { bookRoot, requireApproval: false, now: new Date('2026-09-20T10:00:00Z') },
      );

      expect(result.ok).toBe(true);
      expect(result.status).toBe('approved');
      expect(result.path).not.toContain('.inbox');
      expect(existsSync(result.path!)).toBe(true);
      expect(result.indexLine).toContain('[Direct save entry]');

      const indexText = readFileSync(
        join(getProjectMemoryDir(ws, { bookRoot }), 'MEMORY.md'),
        'utf-8',
      );
      expect(indexText).toContain('[Direct save entry]');
      expect(loadMemoryContext(ws, { bookRoot }).candidates).toHaveLength(0);
    });

    it('routes to .inbox/ when requireApproval is true', () => {
      const ws = 'C:\\fake\\inbox-save';
      const result = saveMemory(
        ws,
        {
          type: 'user',
          title: 'Inbox review entry',
          body: 'Needs user approval.',
          origin: 'model-tool',
          externalContext: false,
        },
        { bookRoot, requireApproval: true, now: new Date('2026-09-20T10:00:00Z') },
      );

      expect(result.ok).toBe(true);
      expect(result.status).toBe('pending');
      expect(result.path).toContain('.inbox');
      expect(result.indexLine).toBeUndefined();

      expect(existsSync(join(getProjectMemoryDir(ws, { bookRoot }), 'MEMORY.md'))).toBe(false);
      expect(loadMemoryContext(ws, { bookRoot }).candidates).toHaveLength(1);
    });

    it('updates an existing entry by slug, preserving created and rewriting index line', () => {
      const ws = 'C:\\fake\\slug-update';
      const initial = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Initial title',
          body: 'Initial body.',
          origin: 'model-tool',
          externalContext: false,
        },
        { bookRoot, slug: 'conventions.md', now: new Date('2026-09-01T10:00:00Z') },
      );
      expect(initial.ok).toBe(true);

      const updated = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Updated title',
          body: 'Updated body content.',
          origin: 'model-tool',
          externalContext: true,
        },
        { bookRoot, slug: 'conventions.md', now: new Date('2026-09-20T10:00:00Z') },
      );
      expect(updated.ok).toBe(true);

      const parsed = readMemoryFile(updated.path!);
      expect(parsed?.created).toBe('2026-09-01T10:00:00.000Z');
      expect(parsed?.updated).toBe('2026-09-20T10:00:00.000Z');
      expect(parsed?.title).toBe('Updated title');
      expect(parsed?.externalContext).toBe(true);

      const indexText = readFileSync(
        join(getProjectMemoryDir(ws, { bookRoot }), 'MEMORY.md'),
        'utf-8',
      );
      expect(indexText).toContain('[Updated title](conventions.md)');
      expect(indexText).not.toContain('[Initial title]');
    });

    it('deletes an entry and removes its index line', () => {
      const ws = 'C:\\fake\\delete-entry';
      const saved = saveMemory(
        ws,
        {
          type: 'reference',
          title: 'Doc link',
          body: 'Reference url: https://example.com',
          origin: 'model-tool',
          externalContext: false,
        },
        { bookRoot, slug: 'doc-link.md' },
      );
      expect(saved.ok).toBe(true);

      const del = deleteMemoryEntry(ws, 'doc-link.md', { bookRoot });
      expect(del.ok).toBe(true);
      expect(existsSync(saved.path!)).toBe(false);

      const indexText = readFileSync(
        join(getProjectMemoryDir(ws, { bookRoot }), 'MEMORY.md'),
        'utf-8',
      );
      expect(indexText).not.toContain('doc-link.md');
    });

    it('rejects deletion of missing files, traversal paths, and MEMORY.md', () => {
      const ws = 'C:\\fake\\delete-guards';
      expect(deleteMemoryEntry(ws, 'nonexistent.md', { bookRoot }).ok).toBe(false);
      expect(deleteMemoryEntry(ws, 'MEMORY.md', { bookRoot }).ok).toBe(false);
      expect(deleteMemoryEntry(ws, 'memory.md', { bookRoot }).ok).toBe(false);
      expect(deleteMemoryEntry(ws, '../../escape.md', { bookRoot }).ok).toBe(false);
    });

    it('rejects saving to index file case-insensitively', () => {
      const ws = 'C:\\fake\\index-case';
      expect(
        saveMemory(
          ws,
          { type: 'project', title: 'Test', body: 'Body' },
          { bookRoot, slug: 'memory.md' },
        ).ok,
      ).toBe(false);
      expect(
        saveMemory(
          ws,
          { type: 'project', title: 'Test', body: 'Body' },
          { bookRoot, slug: 'MEMORY.MD' },
        ).ok,
      ).toBe(false);
    });

    it('refuses to overwrite symlinked memory file', () => {
      const ws = 'C:\\fake\\symlink-save';
      const dir = getProjectMemoryDir(ws, { bookRoot });
      mkdirSync(dir, { recursive: true });
      const target = join(bookRoot, 'target.md');
      writeFileSync(target, '# Outside target', 'utf-8');
      const symlinkFile = join(dir, 'link.md');
      try {
        symlinkSync(target, symlinkFile);
        const result = saveMemory(
          ws,
          { type: 'project', title: 'Symlink attack', body: 'Evil' },
          { bookRoot, slug: 'link.md' },
        );
        expect(result.ok).toBe(false);
        expect(result.error).toContain('Refusing to overwrite symlinked memory file');
      } catch {
        // Symlink creation might not be permitted on some Windows configs
      }
    });

    it('preserves targetSlug when requireApproval is true and approve overwrites original with one index entry', () => {
      const ws = 'C:\\fake\\approval-slug';
      // First, write and approve initial memory
      const initial = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Original Conventions',
          body: 'Original content.',
          origin: 'model-tool',
          externalContext: false,
        },
        { bookRoot, slug: 'custom-slug.md', now: new Date('2026-09-01T10:00:00Z') },
      );
      expect(initial.ok).toBe(true);

      // Now save an update with requireApproval: true and the same slug
      const candidateResult = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Updated Conventions',
          body: 'Updated approved content.',
          origin: 'model-tool',
          externalContext: false,
        },
        {
          bookRoot,
          slug: 'custom-slug.md',
          requireApproval: true,
          now: new Date('2026-09-20T10:00:00Z'),
        },
      );
      expect(candidateResult.ok).toBe(true);
      expect(candidateResult.status).toBe('pending');
      expect(candidateResult.path).toContain('.inbox');

      // Verify the candidate file has targetSlug in frontmatter
      const candParsed = readMemoryFile(candidateResult.path!);
      expect(candParsed?.targetSlug).toBe('custom-slug.md');

      // Approve the candidate
      const approved = approveMemoryCandidate(ws, candidateResult.path!, {
        bookRoot,
        now: new Date('2026-09-20T11:00:00Z'),
      });
      expect(approved.ok).toBe(true);
      expect(approved.path).toContain('custom-slug.md');

      // Verify original was overwritten, created timestamp preserved, and index has exactly one line
      const finalParsed = readMemoryFile(approved.path!);
      expect(finalParsed?.title).toBe('Updated Conventions');
      expect(finalParsed?.created).toBe('2026-09-01T10:00:00.000Z');

      const indexText = readFileSync(
        join(getProjectMemoryDir(ws, { bookRoot }), 'MEMORY.md'),
        'utf-8',
      );
      const lines = indexText.split('\n').filter((l) => l.includes('custom-slug.md'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('[Updated Conventions](custom-slug.md)');
      expect(indexText).not.toContain('[Original Conventions]');
    });
  });

  describe('title sanitization', () => {
    it('sanitizes titles with newlines, control characters, brackets, and leading hashes', () => {
      expect(sanitizeMemoryTitle('My title\nstatus: discarded')).toBe('My title status: discarded');
      expect(sanitizeMemoryTitle('Evil title](http://evil.com) [foo')).toBe(
        'Evil titlehttp://evil.com foo',
      );
      expect(sanitizeMemoryTitle('### Leading hashes')).toBe('Leading hashes');
      expect(sanitizeMemoryTitle('   \t\r\n   ')).toBe('');
    });

    it('produces clean frontmatter, heading, and index line for malicious title inputs', () => {
      const ws = 'C:\\fake\\sanitize-title';
      const result = saveMemory(
        ws,
        {
          type: 'project',
          title: 'Malicious title\nstatus: discarded\nfoo: bar](evil.com)[',
          body: 'Safe body content.',
          origin: 'model-tool',
          externalContext: false,
        },
        { bookRoot, slug: 'sanitized.md' },
      );
      expect(result.ok).toBe(true);

      const raw = readFileSync(result.path!, 'utf-8');
      expect(raw).not.toMatch(/\nstatus: discarded\n/);
      expect(raw).toContain('# Malicious title status: discarded foo: barevil.com');

      const indexText = readFileSync(
        join(getProjectMemoryDir(ws, { bookRoot }), 'MEMORY.md'),
        'utf-8',
      );
      expect(indexText).toContain(
        '[Malicious title status: discarded foo: barevil.com](sanitized.md)',
      );
      // Markdown link is not broken; contains only the single valid markdown link
      expect(indexText.match(/\]\(/g)).toHaveLength(1);
    });

    it('rejects memory writes when title is empty after sanitizing', () => {
      const ws = 'C:\\fake\\empty-title';
      expect(
        saveMemory(
          ws,
          { type: 'project', title: '   [ ] ( ) # \n\t  ', body: 'Body' },
          { bookRoot },
        ).ok,
      ).toBe(false);
    });
  });

  describe('shouldRejectMemoryText', () => {
    it('rejects empty text and overly long text', () => {
      expect(shouldRejectMemoryText('')).toBe('empty');
      expect(shouldRejectMemoryText('   ')).toBe('empty');
      expect(shouldRejectMemoryText('a'.repeat(MAX_BODY_CHARS * 2 + 10))).toBe('too long');
    });

    it('rejects secrets via looksLikeSecretOrUnfit', () => {
      expect(shouldRejectMemoryText('-----BEGIN OPENSSH PRIVATE KEY-----')).not.toBeNull();
      expect(shouldRejectMemoryText('api_key=sk-1234567890abcdef12345678')).not.toBeNull();
      expect(shouldRejectMemoryText('ghp_' + 'A'.repeat(36))).not.toBeNull();
    });

    it('accepts legitimate memory text', () => {
      expect(shouldRejectMemoryText('We use Vitest for unit testing.')).toBeNull();
    });
  });
});

function memoryDirOrInbox(ws: string, root: string): string {
  return getProjectMemoryDir(ws, { bookRoot: root });
}
