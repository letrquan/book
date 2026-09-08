import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkArchitecture } from './check-architecture.js';

describe('checkArchitecture', () => {
  it('rejects a new non-TUI import from tui/', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      mkdirSync(join(dir, 'tui'));
      writeFileSync(join(dir, 'worker.ts'), "import './tui/view.js';\n");
      writeFileSync(join(dir, 'tui', 'view.ts'), 'export {};\n');
      expect(checkArchitecture(dir)).toEqual([
        expect.objectContaining({ kind: 'layer', source: 'worker.ts', target: 'tui/view.ts' }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects every import cycle without an exception ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      writeFileSync(join(dir, 'first.ts'), "import './second.js';\n");
      writeFileSync(join(dir, 'second.ts'), "import './first.js';\n");

      expect(checkArchitecture(dir)).toEqual([
        expect.objectContaining({
          kind: 'cycle',
          detail: 'Import cycle: first.ts -> second.ts -> first.ts',
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects reintroducing the removed compatibility type hub', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      writeFileSync(join(dir, 'types.ts'), 'export interface Everything {}\n');
      expect(checkArchitecture(dir)).toEqual([
        expect.objectContaining({ kind: 'type-hub', source: 'types.ts', target: 'types/' }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects blocking child-process APIs in production source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      writeFileSync(
        join(dir, 'worker.ts'),
        "import { execFileSync } from 'node:child_process';\nexecFileSync('git', ['status']);\n",
      );
      expect(checkArchitecture(dir)).toEqual([
        expect.objectContaining({
          kind: 'blocking-process',
          source: 'worker.ts',
          target: 'child_process',
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('checkArchitecture process termination', () => {
  it('rejects a direct process.exit() outside the exit abstraction', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      mkdirSync(join(dir, 'cli'));
      writeFileSync(join(dir, 'cli', 'thing.ts'), 'export function f() {\n  process.exit(1);\n}\n');

      expect(checkArchitecture(dir)).toEqual([
        expect.objectContaining({
          kind: 'process-exit',
          source: 'cli/thing.ts',
          target: 'cli/exit.ts',
        }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Entry points are spawned as their own process, so they own when it ends.
  it('allows a build entry point to terminate its own process', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      writeFileSync(join(dir, 'job-runner.ts'), 'process.exit(1);\n');

      expect(checkArchitecture(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Documentation that names the banned call must not read as a violation.
  it('ignores process.exit() mentioned in a comment', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      writeFileSync(
        join(dir, 'note.ts'),
        '/**\n * Prefer exit() instead of calling process.exit() directly.\n */\nexport {};\n',
      );

      expect(checkArchitecture(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
