import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverProjectInstructions, renderProjectInstructions } from './claude-md.js';

let dir: string;
let home: string;
let workspace: string;

function write(path: string, body: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf-8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-claude-md-'));
  home = join(dir, 'home');
  workspace = join(dir, 'repo', 'sub');
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('discoverProjectInstructions', () => {
  it('returns no sources when no instruction files exist in the test tree', () => {
    const sources = discoverProjectInstructions(workspace, home).filter((s) =>
      s.path.startsWith(dir),
    );
    expect(sources).toEqual([]);
  });

  it('loads user instructions before broad and specific project instructions', () => {
    write(join(home, '.claude', 'CLAUDE.md'), 'user rules');
    write(join(home, '.book', 'AGENTS.md'), 'book user rules');
    write(join(dir, 'repo', 'AGENTS.md'), 'repo agent rules');
    write(join(dir, 'repo', 'CLAUDE.md'), 'repo rules');
    write(join(workspace, 'CLAUDE.md'), 'workspace rules');

    const bodies = discoverProjectInstructions(workspace, home)
      .filter((s) => s.path.startsWith(dir))
      .map((s) => s.body);

    expect(bodies).toEqual([
      'user rules',
      'book user rules',
      'repo agent rules',
      'repo rules',
      'workspace rules',
    ]);
  });

  it('loads .claude/CLAUDE.md after CLAUDE.md in the same directory', () => {
    write(join(workspace, 'CLAUDE.md'), 'top-level');
    write(join(workspace, '.claude', 'CLAUDE.md'), 'dot-claude');

    const bodies = discoverProjectInstructions(workspace, home)
      .filter((s) => s.path.startsWith(dir))
      .map((s) => s.body);

    expect(bodies).toEqual(['top-level', 'dot-claude']);
  });

  it('loads local instructions and sorted rules last', () => {
    write(join(workspace, 'CLAUDE.md'), 'project');
    write(join(workspace, 'CLAUDE.local.md'), 'local');
    write(join(workspace, '.claude', 'rules', 'b.md'), 'rule b');
    write(join(workspace, '.claude', 'rules', 'a.md'), 'rule a');

    const bodies = discoverProjectInstructions(workspace, home)
      .filter((s) => s.path.startsWith(dir))
      .map((s) => s.body);

    expect(bodies).toEqual(['project', 'local', 'rule a', 'rule b']);
  });
});

describe('renderProjectInstructions', () => {
  it('renders a labeled instruction block', () => {
    const rendered = renderProjectInstructions([
      { path: '/x/AGENTS.md', layer: 'project', body: 'Use short diffs.' },
    ]);

    expect(rendered).toContain('## Project instructions');
    expect(rendered).toContain('### project: /x/AGENTS.md');
    expect(rendered).toContain('Use short diffs.');
  });
});
