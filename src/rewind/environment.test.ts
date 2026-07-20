import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createEphemeralRewindEnvironment } from './environment.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('createEphemeralRewindEnvironment', () => {
  it('provides a temporary timeline and removes all rewind data on dispose', () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), 'book-rewind-environment-'));
    roots.push(temporaryRoot);
    const workspace = join(temporaryRoot, 'workspace');
    mkdirSync(workspace);
    const environment = createEphemeralRewindEnvironment(workspace, temporaryRoot);
    const sessionId = environment.timelineStore.create({ cwd: workspace });
    environment.timelineStore.append(sessionId, {
      type: 'turn_checkpoint',
      timestamp: Date.now(),
      data: {},
    });
    expect(environment.snapshotStore.capture().ok).toBe(true);
    expect(existsSync(environment.root)).toBe(true);

    environment.dispose();

    expect(existsSync(environment.root)).toBe(false);
    expect(() => environment.timelineStore.readRecords(sessionId)).toThrow('Session not found');
  });
});
