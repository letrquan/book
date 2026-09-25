import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { FileObservation, ToolContext } from '../types/tools.js';
import { fileTools } from './file.js';
import { seedObservationLedger } from './file-provenance.js';

const read = fileTools.find((tool) => tool.name === 'Read')!;
const edit = fileTools.find((tool) => tool.name === 'Edit')!;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-provenance-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A Read and an outline of `x.ts`, as a live session recorded them. */
async function observeBoth(): Promise<{ readSeen: FileObservation; outlineSeen: FileObservation }> {
  writeFileSync(join(dir, 'x.ts'), 'export const a = 1;\n');
  const live: ToolContext = { workspaceRoot: dir, env: {}, fileObservationLedger: new Map() };
  const full = await read.execute({ filePath: 'x.ts' }, live);
  const outlined = await read.execute({ filePath: 'x.ts', outline: true }, live);
  return {
    readSeen: full.artifacts!.fileObservations![0],
    outlineSeen: outlined.artifacts!.fileObservations![0],
  };
}

describe('seedObservationLedger: a resumed parallel batch', () => {
  it('keeps the Read when the outline of the same file came first in the batch and finished last', async () => {
    const { readSeen, outlineSeen } = await observeBoth();
    // One batch, `[Read{x.ts, outline: true}, Read{x.ts}]`: the results are
    // recorded in call order, and the outline finished after the Read.
    const transcript = [
      { fileObservations: [{ ...outlineSeen, timestamp: readSeen.timestamp + 5 }, readSeen] },
    ];
    const resumed: ToolContext = {
      workspaceRoot: dir,
      env: {},
      fileObservationLedger: seedObservationLedger(new Map(), transcript),
    };

    const edited = await edit.execute(
      { filePath: 'x.ts', oldString: 'a = 1', newString: 'a = 2' },
      resumed,
    );
    expect(edited.structuredError?.message).toBeUndefined();
    expect(edited.status).toBe('success');
    expect(readFileSync(join(dir, 'x.ts'), 'utf-8')).toBe('export const a = 2;\n');
  });

  it('keeps the Read in either recorded order, and the newer of two of a kind', async () => {
    const { readSeen, outlineSeen } = await observeBoth();
    const at = (observation: FileObservation, timestamp: number) => ({ ...observation, timestamp });
    const seeded = (...observations: FileObservation[]) => [
      ...seedObservationLedger(new Map(), [{ fileObservations: observations }]).values(),
    ];

    expect(seeded(at(outlineSeen, 2), at(readSeen, 1))).toEqual([at(readSeen, 1)]);
    expect(seeded(at(readSeen, 1), at(outlineSeen, 2))).toEqual([at(readSeen, 1)]);
    expect(seeded(at(readSeen, 2), at(readSeen, 1))).toEqual([at(readSeen, 2)]);
    expect(seeded(at(outlineSeen, 1), at(outlineSeen, 2))).toEqual([at(outlineSeen, 2)]);
  });
});
