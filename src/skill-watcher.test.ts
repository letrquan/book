import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { setTimeout as wait } from 'node:timers/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillWatcher } from './skill-watcher.js';

let workspace: string;

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for skill change');
    await wait(20);
  }
}

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'book-skill-watcher-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe('SkillWatcher', () => {
  it('detects newly created roots and later edits with debouncing', async () => {
    let changes = 0;
    const watcher = new SkillWatcher(workspace, {
      includeUser: false,
      projectRoot: workspace,
      debounceMs: 20,
      onDirty: () => changes++,
    });
    watcher.start();
    try {
      const root = join(workspace, '.book', 'skills', 'review');
      mkdirSync(root, { recursive: true });
      const entry = join(root, 'SKILL.md');
      writeFileSync(
        entry,
        ['---', 'name: review', 'description: Review changes', '---', 'First body'].join('\n'),
      );
      await waitFor(() => changes >= 1);

      const afterCreate = changes;
      writeFileSync(
        entry,
        ['---', 'name: review', 'description: Review changes', '---', 'Second body'].join('\n'),
      );
      await waitFor(() => changes > afterCreate);

      const afterEdit = changes;
      const renamed = join(workspace, '.book', 'skills', 'renamed-review');
      renameSync(root, renamed);
      await waitFor(() => changes > afterEdit);

      const afterRename = changes;
      rmSync(join(renamed, 'SKILL.md'), { force: true });
      await waitFor(() => changes > afterRename);
      rmSync(renamed, { recursive: true, force: true });
    } finally {
      watcher.close();
    }
  });

  it('stops delivering changes after close', async () => {
    let changes = 0;
    const watcher = new SkillWatcher(workspace, {
      includeUser: false,
      projectRoot: workspace,
      debounceMs: 20,
      onDirty: () => changes++,
    });
    watcher.start();
    watcher.close();
    mkdirSync(join(workspace, '.book', 'skills'), { recursive: true });
    await wait(80);
    expect(changes).toBe(0);
  });
});
