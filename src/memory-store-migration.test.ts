import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { basename, join, relative } from 'path';
import type { FileObservation, ToolContext } from './types/tools.js';
import {
  findLegacyMemoryBackup,
  getProjectMemoryDir,
  loadMemoryContext,
  migrateLegacyMemoryFormat,
} from './memory-store.js';
import { buildMemoryReport } from './memory-display.js';
import { fileTools } from './tools/file.js';
import { observeFile } from './tools/file-provenance.js';

// The backup-failure test makes the copy of one file fail; every other call goes through.
const fault = vi.hoisted(() => ({ failCopy: false }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    copyFileSync: ((...args: Parameters<typeof actual.copyFileSync>) => {
      if (fault.failCopy) throw new Error('ENOSPC: simulated backup failure');
      return actual.copyFileSync(...args);
    }) as typeof actual.copyFileSync,
  };
});

const edit = fileTools.find((t) => t.name === 'Edit')!;

let root: string;
/** `<root>/projects/p/memory`, whose siblings are where backups go. */
let dir: string;
/** A workspace of its own, so a memory path is never also a workspace path. */
let workspaceRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'book-memory-migration-'));
  workspaceRoot = mkdtempSync(join(tmpdir(), 'book-memory-migration-ws-'));
  dir = join(root, 'projects', 'p', 'memory');
  mkdirSync(dir, { recursive: true });
  fault.failCopy = false;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(workspaceRoot, { recursive: true, force: true });
});

/** Every file under `base` (dot-entries included), by relative path. Directories are `<dir>`. */
function snapshot(base: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const key = relative(base, full);
      if (entry.isDirectory()) {
        out[key] = '<dir>';
        walk(full);
      } else if (entry.isSymbolicLink()) {
        out[key] = '<link>';
      } else {
        out[key] = readFileSync(full, 'utf-8');
      }
    }
  };
  walk(base);
  return out;
}

const backups = (): string[] =>
  readdirSync(join(root, 'projects', 'p')).filter((name) => name.startsWith('memory.legacy-'));

/** `text` cut to `max` characters at a word boundary, `…` last; written independently of the store. */
function fitWords(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const word of text.split(' ')) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > max - 1) break;
    out = next;
  }
  return `${out}…`;
}

const LONG_HOOK = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');

const PNPM = '2026-10-01-feedback-prefer-pnpm-1a2b3c4d.md';
const BUILD = '2026-10-03-project-build-command-9f8e7d6c.md';
const DASHBOARD = '2026-10-04-reference-dashboard-aaaa1111.md';
const SUPERSEDED = '2026-09-01-project-old-rule-bbbb2222.md';
const TABS = '2026-10-05-user-tabs-over-spaces-cccc3333.md';

/** A directory as the old save tool left it. */
function writeLegacyStore(): void {
  writeFileSync(
    join(dir, PNPM),
    [
      '---',
      'type: feedback',
      'status: approved',
      'origin: user-text',
      'source: manual',
      'externalContext: false',
      'created: 2026-10-01T09:00:00.000Z',
      'updated: 2026-10-02T09:00:00.000Z',
      'sessionId: sess-1',
      'confidence: high',
      '---',
      '',
      '# Prefer pnpm',
      '',
      'Use pnpm, not npm.',
      '',
      '**Why:** lockfile.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, BUILD),
    [
      '---',
      'type: project',
      'status: approved',
      'origin: agent-inferred',
      'source: auto',
      'externalContext: false',
      'created: 2026-10-03T08:00:00.000Z',
      'updated: 2026-10-03T08:00:00.000Z',
      'driver: agent',
      'evidence:',
      '- src/build.ts',
      '- user said: use tsup',
      'tags:',
      '- build',
      '---',
      '',
      '# Build command',
      '',
      'Run npm run build before tests.',
      '',
    ].join('\n'),
  );
  // No `status`: an approved file written before the field existed.
  writeFileSync(
    join(dir, DASHBOARD),
    [
      '---',
      'type: reference',
      'created: 2026-10-04T10:00:00.000Z',
      '---',
      '# Dashboard',
      'Grafana: latency board at grafana.example/d/latency.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, TABS),
    [
      '---',
      'type: user',
      'status: approved',
      'updated: 2026-10-05T10:00:00.000Z',
      '---',
      '',
      '# Tabs over spaces',
      '',
      'Use tabs.',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, SUPERSEDED),
    '---\ntype: project\nstatus: superseded\nsupersededBy: x.md\n---\n\n# Old rule\n\nGone.\n',
  );
  mkdirSync(join(dir, '.inbox', 'discarded'), { recursive: true });
  writeFileSync(
    join(dir, '.inbox', 'pending.md'),
    '---\ntype: project\nstatus: pending\n---\n\n# Candidate: Maybe\n\nMaybe.\n',
  );
  writeFileSync(
    join(dir, '.inbox', 'discarded', 'old.md'),
    '---\ntype: user\nstatus: discarded\n---\n\n# Nope\n\nNope.\n',
  );
  writeFileSync(join(dir, '.extraction-state.json'), '{"offset":3}');
  writeFileSync(join(dir, '.extraction.lock'), '');
  writeFileSync(
    join(dir, 'MEMORY.md'),
    [
      '# Book memory index',
      '',
      'Hand-written: see docs/ first.',
      `- [Dashboard](${DASHBOARD}) — reference — 2026-10-04 — ${LONG_HOOK}`,
      `- [Prefer pnpm](${PNPM}) — feedback — 2026-10-02 — Use pnpm, never npm`,
      `- [Old rule](${SUPERSEDED}) — project — 2026-09-01 — gone`,
      'A second hand-written line.',
      '',
    ].join('\n'),
  );
}

describe('migrateLegacyMemoryFormat', () => {
  it('converts a full legacy store: backup, files, drops, index, marker', () => {
    writeLegacyStore();
    const before = snapshot(dir);

    migrateLegacyMemoryFormat(dir);

    // The backup is a sibling copy, dot-entries included, byte for byte.
    const [backupName] = backups();
    expect(backups()).toHaveLength(1);
    expect(backupName).toMatch(/^memory\.legacy-\d{8}$/);
    expect(snapshot(join(root, 'projects', 'p', backupName))).toEqual(before);
    expect(findLegacyMemoryBackup(dir)).toBe(join(root, 'projects', 'p', backupName));

    // The converted files, exactly.
    const description = fitWords(LONG_HOOK, 150);
    expect(readFileSync(join(dir, 'prefer-pnpm.md'), 'utf-8')).toBe(
      [
        '---',
        'name: prefer-pnpm',
        'description: Use pnpm, never npm',
        'metadata:',
        '  type: feedback',
        '  originSessionId: sess-1',
        '  modified: 2026-10-02T09:00:00.000Z',
        '---',
        'Use pnpm, not npm.',
        '',
        '**Why:** lockfile.',
        '',
      ].join('\n'),
    );
    expect(readFileSync(join(dir, 'build-command.md'), 'utf-8')).toBe(
      [
        '---',
        'name: build-command',
        'description: Run npm run build before tests.',
        'metadata:',
        '  type: project',
        '  modified: 2026-10-03T08:00:00.000Z',
        '  driver: agent',
        '  evidence:',
        '    - src/build.ts',
        '    - "user said: use tsup"',
        '---',
        'Run npm run build before tests.',
        '',
      ].join('\n'),
    );
    expect(readFileSync(join(dir, 'dashboard.md'), 'utf-8')).toBe(
      [
        '---',
        'name: dashboard',
        `description: ${description}`,
        'metadata:',
        '  type: reference',
        '  modified: 2026-10-04T10:00:00.000Z',
        '---',
        'Grafana: latency board at grafana.example/d/latency.',
        '',
      ].join('\n'),
    );
    expect(description.length).toBeLessThanOrEqual(150);
    expect(readFileSync(join(dir, 'tabs-over-spaces.md'), 'utf-8')).toBe(
      [
        '---',
        'name: tabs-over-spaces',
        'description: Use tabs.',
        'metadata:',
        '  type: user',
        '  modified: 2026-10-05T10:00:00.000Z',
        '---',
        'Use tabs.',
        '',
      ].join('\n'),
    );

    // Everything else is gone from memory/, and only the backup keeps it.
    expect(readdirSync(dir).sort()).toEqual([
      '.format',
      'MEMORY.md',
      'build-command.md',
      'dashboard.md',
      'prefer-pnpm.md',
      'tabs-over-spaces.md',
    ]);
    expect(readFileSync(join(dir, '.format'), 'utf-8').trim()).toBe('2');

    // Hand-written lines first, then the old index's order, then the unlisted files newest first.
    const index = readFileSync(join(dir, 'MEMORY.md'), 'utf-8');
    const dashboardHead = '- [Dashboard](dashboard.md) — ';
    expect(index.split('\n')).toEqual([
      'Hand-written: see docs/ first.',
      'A second hand-written line.',
      `${dashboardHead}${fitWords(description, 200 - dashboardHead.length)}`,
      '- [Prefer pnpm](prefer-pnpm.md) — Use pnpm, never npm',
      '- [Tabs over spaces](tabs-over-spaces.md) — Use tabs.',
      '- [Build command](build-command.md) — Run npm run build before tests.',
      '',
    ]);
    for (const line of index.split('\n')) expect(line.length).toBeLessThanOrEqual(200);
  });

  it('keeps a long title whole and ends the hook and the slug on a whole word', () => {
    const old =
      '2026-10-15-project-memory-format-migration-detect-legacy-keys-at-column-0-and-m-a7c6c141.md';
    const title =
      'Memory format migration: detect legacy keys at column 0, and mark test dirs with .format';
    const hook =
      '`migrateLegacyMemoryFormat` src/memory-store.ts runs from `loadMemoryContext`, so any test that load…';
    writeFileSync(
      join(dir, old),
      `---\ntype: project\nstatus: approved\n---\n\n# ${title}\n\nBody.\n`,
    );
    writeFileSync(
      join(dir, 'MEMORY.md'),
      `- [${title}](${old}) — project — 2026-10-15 — ${hook}\n`,
    );

    migrateLegacyMemoryFormat(dir);

    const slug = 'memory-format-migration-detect-legacy-keys-at-column-0-and';
    expect(readdirSync(dir).sort()).toEqual(['.format', 'MEMORY.md', `${slug}.md`]);
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf-8')).toBe(
      `- [${title}](${slug}.md) — \`migrateLegacyMemoryFormat\`…\n`,
    );
    // The hook gave way (the link takes most of the line), and not inside the backtick span.
    const file = readFileSync(join(dir, `${slug}.md`), 'utf-8');
    expect(file).toContain(`name: ${slug}\n`);
    expect(file).toContain(`description: "${hook}"\n`);
    expect(slug.length).toBeLessThanOrEqual(60);
  });

  it('does nothing on a second call, and leaves no second backup', () => {
    writeLegacyStore();
    migrateLegacyMemoryFormat(dir);
    const after = snapshot(dir);

    migrateLegacyMemoryFormat(dir);

    expect(snapshot(dir)).toEqual(after);
    expect(backups()).toHaveLength(1);
  });

  it('does not migrate a directory marked as format 2, even with legacy files in it', () => {
    writeLegacyStore();
    writeFileSync(join(dir, '.format'), '2\n');
    const before = snapshot(dir);

    migrateLegacyMemoryFormat(dir);

    expect(snapshot(dir)).toEqual(before);
    expect(backups()).toEqual([]);
  });

  it('names a second backup on the same day -2', () => {
    writeLegacyStore();
    migrateLegacyMemoryFormat(dir);
    const [first] = backups();
    // A later legacy leftover (say, a downgrade then an upgrade) migrates again.
    rmSync(join(dir, '.format'));
    writeFileSync(join(dir, '.extraction.lock'), '');

    migrateLegacyMemoryFormat(dir);

    expect(backups().sort()).toEqual([first, `${first}-2`]);
    expect(findLegacyMemoryBackup(dir)).toBe(join(root, 'projects', 'p', `${first}-2`));
  });

  it('gives a slug already taken a -2, -3, … suffix', () => {
    const legacy = (title: string): string =>
      `---\ntype: project\nstatus: approved\n---\n\n# ${title}\n\nBody of ${title}.\n`;
    writeFileSync(join(dir, '2026-01-01-project-a-11111111.md'), legacy('Same Title'));
    writeFileSync(join(dir, '2026-01-02-project-b-22222222.md'), legacy('Same Title!'));
    writeFileSync(join(dir, '2026-01-03-project-c-33333333.md'), legacy('same title'));
    // A name a current file already holds, and the index's own name.
    writeFileSync(
      join(dir, 'docs.md'),
      '---\nname: docs\ndescription: d\nmetadata:\n  type: project\n---\nB\n',
    );
    writeFileSync(join(dir, '2026-01-04-project-d-44444444.md'), legacy('Docs'));
    writeFileSync(join(dir, '2026-01-05-project-e-55555555.md'), legacy('Memory'));
    const long = `${'long '.repeat(30)}title`;
    writeFileSync(join(dir, '2026-01-06-project-f-66666666.md'), legacy(long));
    writeFileSync(join(dir, '2026-01-07-project-g-77777777.md'), legacy(long));

    migrateLegacyMemoryFormat(dir);

    const names = readdirSync(dir)
      .filter((n) => n.endsWith('.md') && n !== 'MEMORY.md')
      .sort();
    expect(names).toEqual(
      expect.arrayContaining([
        'same-title.md',
        'same-title-2.md',
        'same-title-3.md',
        'docs.md',
        'docs-2.md',
        'memory-2.md',
      ]),
    );
    expect(names).toHaveLength(8);
    // The file that already held `docs.md` is untouched.
    expect(readFileSync(join(dir, 'docs.md'), 'utf-8')).toContain('description: d');
    for (const name of names) {
      expect(name.slice(0, -3)).toMatch(/^[a-z0-9-]{1,60}$/);
    }
    // Two over-long titles still end up distinct, within 60 characters, `name` matching the file.
    const longs = names.filter((n) => n.startsWith('long-long'));
    expect(longs).toHaveLength(2);
    for (const name of longs) {
      expect(readFileSync(join(dir, name), 'utf-8')).toContain(`name: ${name.slice(0, -3)}\n`);
    }
  });

  it('names a file with no title from its file name, without the date, type and hash', () => {
    writeFileSync(
      join(dir, '2026-03-04-reference-grafana-board-0a1b2c3d.md'),
      '---\ntype: reference\nstatus: approved\n---\n\nJust a body.\n',
    );

    migrateLegacyMemoryFormat(dir);

    const text = readFileSync(join(dir, 'grafana-board.md'), 'utf-8');
    expect(text).toContain('name: grafana-board\ndescription: Just a body.\n');
    expect(readFileSync(join(dir, 'MEMORY.md'), 'utf-8')).toBe(
      '- [grafana board](grafana-board.md) — Just a body.\n',
    );
  });

  it('strips control characters from the description and keeps it on one line', () => {
    writeFileSync(
      join(dir, '2026-03-04-project-ctl-0a1b2c3d.md'),
      '---\ntype: project\nstatus: approved\n---\n\n# Ctl\n\nKeep\x07 this\x1b[0m line: ok\n',
    );

    migrateLegacyMemoryFormat(dir);

    const text = readFileSync(join(dir, 'ctl.md'), 'utf-8');
    // Control characters go; the colon makes the value need quoting to stay valid YAML.
    expect(text).toContain('description: "Keep this[0m line: ok"\n');
    expect(text.split('\n')[2]).not.toMatch(/[\x00-\x1f]/);
  });

  describe('when the backup cannot be written', () => {
    it('changes nothing in memory/, and leaves no partial backup or marker', () => {
      writeLegacyStore();
      const before = snapshot(dir);
      fault.failCopy = true;

      expect(() => migrateLegacyMemoryFormat(dir)).not.toThrow();

      expect(snapshot(dir)).toEqual(before);
      expect(backups()).toEqual([]);
      expect(existsSync(join(dir, '.format'))).toBe(false);

      // The next load, with the disk back, migrates.
      fault.failCopy = false;
      migrateLegacyMemoryFormat(dir);
      expect(backups()).toHaveLength(1);
      expect(existsSync(join(dir, 'prefer-pnpm.md'))).toBe(true);
    });
  });

  describe('symlinks', () => {
    it('skips symlinked entries: nothing is read, copied, converted or removed through them', () => {
      const outside = mkdtempSync(join(tmpdir(), 'book-memory-outside-'));
      try {
        const legacyText = '---\ntype: project\nstatus: approved\n---\n\n# Outside\n\nOutside.\n';
        writeFileSync(join(outside, 'target.md'), legacyText);
        mkdirSync(join(outside, 'inbox'));
        writeFileSync(join(outside, 'inbox', 'c.md'), legacyText);
        writeFileSync(join(outside, 'index.md'), '- [Outside](target.md) — hook\n');
        symlinkSync(join(outside, 'target.md'), join(dir, 'linked.md'));
        symlinkSync(join(outside, 'inbox'), join(dir, '.inbox'));
        symlinkSync(join(outside, 'target.md'), join(dir, '.extraction.lock'));
        // One real legacy file, so there is something to migrate.
        writeFileSync(
          join(dir, 'real.md'),
          '---\ntype: project\nstatus: approved\n---\n\n# Real\n\nReal.\n',
        );

        migrateLegacyMemoryFormat(dir);

        expect(readFileSync(join(outside, 'target.md'), 'utf-8')).toBe(legacyText);
        expect(readdirSync(join(outside, 'inbox'))).toEqual(['c.md']);
        for (const name of ['linked.md', '.inbox', '.extraction.lock']) {
          expect(lstatSync(join(dir, name)).isSymbolicLink()).toBe(true);
        }
        expect(readFileSync(join(dir, 'real.md'), 'utf-8')).toContain('name: real\n');
        // The backup holds no link and nothing that was behind one.
        const [backup] = backups();
        expect(Object.keys(snapshot(join(root, 'projects', 'p', backup))).sort()).toEqual([
          'real.md',
        ]);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('does not rewrite a MEMORY.md that is a symlink', () => {
      const outside = mkdtempSync(join(tmpdir(), 'book-memory-outside-'));
      try {
        writeFileSync(join(outside, 'index.md'), '- [Real](real.md) — project — 2026-01-01 — x\n');
        symlinkSync(join(outside, 'index.md'), join(dir, 'MEMORY.md'));
        writeFileSync(
          join(dir, 'real.md'),
          '---\ntype: project\nstatus: approved\n---\n\n# Real\n\nReal.\n',
        );

        migrateLegacyMemoryFormat(dir);

        expect(readFileSync(join(outside, 'index.md'), 'utf-8')).toBe(
          '- [Real](real.md) — project — 2026-01-01 — x\n',
        );
        expect(lstatSync(join(dir, 'MEMORY.md')).isSymbolicLink()).toBe(true);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('treats a directory holding only links as having nothing to migrate', () => {
      const outside = mkdtempSync(join(tmpdir(), 'book-memory-outside-'));
      try {
        writeFileSync(join(outside, 't.md'), '---\ntype: project\n---\n# T\n');
        symlinkSync(join(outside, 't.md'), join(dir, 'linked.md'));

        migrateLegacyMemoryFormat(dir);

        expect(backups()).toEqual([]);
        expect(readdirSync(dir).sort()).toEqual(['.format', 'linked.md']);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it('does not migrate a memory directory that is itself a symlink', () => {
      const outside = mkdtempSync(join(tmpdir(), 'book-memory-outside-'));
      try {
        writeFileSync(join(outside, 'a.md'), '---\ntype: project\nstatus: approved\n---\n# A\n');
        const linked = join(root, 'projects', 'q', 'memory');
        mkdirSync(join(root, 'projects', 'q'));
        symlinkSync(outside, linked);

        migrateLegacyMemoryFormat(linked);

        expect(readdirSync(outside)).toEqual(['a.md']);
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  });

  describe('a directory that needs no migration', () => {
    it('writes only .format for an empty directory', () => {
      migrateLegacyMemoryFormat(dir);

      expect(readdirSync(dir)).toEqual(['.format']);
      expect(backups()).toEqual([]);
    });

    it('writes only .format for files already in the current layout', () => {
      const current =
        '---\nname: a\ndescription: A fact\nmetadata:\n  type: project\n  driver: agent\n---\nBody\n';
      writeFileSync(join(dir, 'a.md'), current);
      writeFileSync(join(dir, 'MEMORY.md'), '- [A](a.md) — A fact\n');
      writeFileSync(join(dir, 'bare.md'), '# A bare note\n');

      migrateLegacyMemoryFormat(dir);

      expect(readdirSync(dir).sort()).toEqual(['.format', 'MEMORY.md', 'a.md', 'bare.md']);
      expect(readFileSync(join(dir, 'a.md'), 'utf-8')).toBe(current);
      expect(readFileSync(join(dir, 'MEMORY.md'), 'utf-8')).toBe('- [A](a.md) — A fact\n');
      expect(backups()).toEqual([]);
    });

    it('creates nothing for a directory that does not exist', () => {
      const missing = join(root, 'projects', 'none', 'memory');

      migrateLegacyMemoryFormat(missing);

      expect(existsSync(join(root, 'projects', 'none'))).toBe(false);
    });
  });

  it('runs from loadMemoryContext, so the first session after the upgrade sees the new layout', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-memory-migration-ws-'));
    try {
      const memoryDir = getProjectMemoryDir(workspace, { bookRoot: root });
      mkdirSync(memoryDir, { recursive: true });
      const original = '---\ntype: project\nstatus: approved\n---\n\n# Rule\n\nUse rules.\n';
      writeFileSync(join(memoryDir, '2026-01-01-project-rule-aaaaaaaa.md'), original);
      writeFileSync(
        join(memoryDir, 'MEMORY.md'),
        '# Book memory index\n- [Rule](2026-01-01-project-rule-aaaaaaaa.md) — project — 2026-01-01 — Use rules\n',
      );

      const ctx = loadMemoryContext(workspace, { bookRoot: root });

      expect(ctx.files.map((f) => f.name)).toEqual(['rule.md']);
      expect(ctx.indexText).toBe('- [Rule](rule.md) — Use rules');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  describe('after the migration', () => {
    function context(scope: 'full' | 'learnings'): ToolContext {
      return {
        workspaceRoot,
        env: {},
        fileObservationLedger: new Map<string, FileObservation>(),
        memoryWrite: { root: dir, scope, sessionId: 'session-2' },
      };
    }

    it('lets the write guard accept an Edit of a migrated file, and keeps its provenance', async () => {
      writeLegacyStore();
      migrateLegacyMemoryFormat(dir);
      const ctx = context('full');
      const path = join(dir, 'prefer-pnpm.md');
      await observeFile(ctx, path, 'read');

      const result = await edit.execute(
        { filePath: path, oldString: 'Use pnpm, not npm.', newString: 'Use pnpm.' },
        ctx,
      );

      expect(result.status).toBe('success');
      const text = readFileSync(path, 'utf-8');
      expect(text).toContain('Use pnpm.\n');
      expect(text).toContain('  originSessionId: sess-1\n');
      expect(text).toMatch(/\n {2}modified: \d{4}-\d{2}-\d{2}T/);
    });

    it('keeps a file migrated from `driver: agent` agent-owned, and a person’s file off limits', async () => {
      writeLegacyStore();
      migrateLegacyMemoryFormat(dir);
      const ctx = context('learnings');

      const own = join(dir, 'build-command.md');
      await observeFile(ctx, own, 'read');
      const ok = await edit.execute(
        {
          filePath: own,
          oldString: '---\nRun npm run build before tests.',
          newString: '---\nRun npm run build first.',
        },
        ctx,
      );
      expect(ok.status).toBe('success');
      expect(readFileSync(own, 'utf-8')).toContain('  driver: agent\n');
      expect(readFileSync(own, 'utf-8')).toContain('    - "user said: use tsup"\n');

      const person = join(dir, 'dashboard.md');
      await observeFile(ctx, person, 'read');
      const refused = await edit.execute(
        { filePath: person, oldString: 'latency board', newString: 'board' },
        ctx,
      );
      expect(refused.structuredError?.code).toBe('memory_owned_by_person');
      expect(readFileSync(person, 'utf-8')).toContain('latency board');
    });
  });
});

describe('the backup notice', () => {
  it('shows in /memory status once the migration has left a backup, and not before', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-memory-migration-ws-'));
    try {
      const memoryDir = getProjectMemoryDir(workspace, { bookRoot: root });
      mkdirSync(memoryDir, { recursive: true });
      writeFileSync(
        join(memoryDir, 'current.md'),
        '---\nname: current\ndescription: d\nmetadata:\n  type: project\n---\nB\n',
      );
      expect(buildMemoryReport({ workspace, bookRoot: root })).not.toContain('Migrated to');

      rmSync(join(memoryDir, '.format'));
      writeFileSync(
        join(memoryDir, 'old.md'),
        '---\ntype: project\nstatus: approved\n---\n\n# Old\n\nOld.\n',
      );
      const report = buildMemoryReport({ workspace, bookRoot: root });
      const backup = findLegacyMemoryBackup(memoryDir)!;

      expect(backup).toMatch(/memory\.legacy-\d{8}$/);
      expect(report).toContain(
        `Migrated to the new memory format; the old files are in ${backup}.`,
      );
      expect(report.match(/Migrated to the new memory format/g)).toHaveLength(1);
      // A second report neither migrates again nor drops the notice.
      expect(buildMemoryReport({ workspace, bookRoot: root })).toContain(backup);
      expect(
        readdirSync(join(memoryDir, '..')).filter((n) => n.startsWith('memory.legacy-')),
      ).toEqual([basename(backup)]);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
