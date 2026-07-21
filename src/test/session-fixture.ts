import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../session/store.js';

export interface SessionFixture {
  root: string;
  store: SessionStore;
  cleanup(): void;
}

export function createSessionFixture(prefix = 'book-session-'): SessionFixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  return {
    root,
    store: new SessionStore(root),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
