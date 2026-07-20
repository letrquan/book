import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { SessionStore } from '../session/store.js';
import type { RewindSnapshotStoreInterface } from '../types.js';
import { createRewindSnapshotStore } from './snapshot-store.js';

export interface EphemeralRewindEnvironment {
  root: string;
  timelineStore: SessionStore;
  snapshotStore: RewindSnapshotStoreInterface;
  dispose: () => void;
}

export function createEphemeralRewindEnvironment(
  workspace: string,
  temporaryRoot = tmpdir(),
): EphemeralRewindEnvironment {
  const resolvedTemporaryRoot = resolve(temporaryRoot);
  const root = mkdtempSync(join(resolvedTemporaryRoot, 'book-rewind-'));
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const resolvedRoot = resolve(root);
    if (
      resolvedRoot.startsWith(`${resolvedTemporaryRoot}${sep}`) &&
      resolvedRoot.split(sep).at(-1)?.startsWith('book-rewind-') &&
      existsSync(resolvedRoot)
    ) {
      rmSync(resolvedRoot, { recursive: true, force: true });
    }
    process.off('exit', dispose);
  };
  process.once('exit', dispose);
  return {
    root,
    timelineStore: new SessionStore(join(root, 'sessions')),
    snapshotStore: createRewindSnapshotStore(workspace, join(root, 'snapshots')),
    dispose,
  };
}
