import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { committedFileStates } from './committed-files.js';
import { partialClone } from '../test/git-fixtures.js';
import { MISSING_OBJECTS_NOTE } from '../tools/git.js';

describe('committedFileStates in a partial clone', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'book-committed-files-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  // The fixture needs a POSIX shell.
  it.skipIf(process.platform === 'win32')(
    'fails without fetching a missing tree, and says what to do',
    async () => {
      const fixture = await partialClone(root);

      await expect(committedFileStates(fixture.repo, ['d/a.txt'])).rejects.toThrow(
        MISSING_OBJECTS_NOTE,
      );
      expect(fixture.packs()).toBe(0);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'answers as usual in a complete partial clone',
    async () => {
      const fixture = await partialClone(root, { missingTree: false });

      const states = await committedFileStates(fixture.repo, ['d/a.txt']);

      expect(states.get('d/a.txt')).toBe('unchanged');
    },
  );
});
