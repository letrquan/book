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
});
