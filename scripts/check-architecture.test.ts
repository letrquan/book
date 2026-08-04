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

  it('keeps offline harness evaluation out of the live runtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      mkdirSync(join(dir, 'agent'));
      mkdirSync(join(dir, 'harness'));
      mkdirSync(join(dir, 'harness', 'evaluation'));
      writeFileSync(
        join(dir, 'agent', 'loop.ts'),
        "import type { Report } from '../harness/evaluation/report.js';\nexport type LoopReport = Report;\n",
      );
      writeFileSync(
        join(dir, 'harness', 'evaluation', 'report.ts'),
        'export interface Report {}\n',
      );

      expect(checkArchitecture(dir)).toContainEqual(
        expect.objectContaining({
          kind: 'harness-boundary',
          source: 'agent/loop.ts',
          target: 'harness/evaluation/report.ts',
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prevents offline evaluation from importing the live runtime', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      mkdirSync(join(dir, 'agent'));
      mkdirSync(join(dir, 'harness'));
      mkdirSync(join(dir, 'harness', 'evaluation'));
      writeFileSync(join(dir, 'agent', 'loop.ts'), 'export const run = () => {};\n');
      writeFileSync(
        join(dir, 'harness', 'evaluation', 'replay.ts'),
        "import { run } from '../../agent/loop.js';\nrun();\n",
      );

      expect(checkArchitecture(dir)).toContainEqual(
        expect.objectContaining({
          kind: 'harness-boundary',
          source: 'harness/evaluation/replay.ts',
          target: 'agent/loop.ts',
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the trusted kernel independent from harness policy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'book-architecture-'));
    try {
      mkdirSync(join(dir, 'harness'));
      writeFileSync(join(dir, 'permissions.ts'), "import './harness/policy.js';\n");
      writeFileSync(join(dir, 'harness', 'policy.ts'), 'export {};\n');

      expect(checkArchitecture(dir)).toContainEqual(
        expect.objectContaining({
          kind: 'harness-boundary',
          source: 'permissions.ts',
          target: 'harness/policy.ts',
        }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
