import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { basename, dirname, join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  collectAtMentionObservations,
  expandAtMentions,
  expandShellCommands,
  expandUserInput,
} from './input-expansion.js';

let dirs: string[] = [];

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'book-at-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

describe('expandAtMentions', () => {
  it('expands a basic workspace-relative file mention', () => {
    const ws = workspace();
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src', 'app.ts'), 'export const value = 1;');

    const result = expandAtMentions('Explain @src/app.ts', ws);

    expect(result).toContain('Contents of src/app.ts:');
    expect(result).toContain('export const value = 1;');
  });

  it('expands a quoted path containing spaces', () => {
    const ws = workspace();
    writeFileSync(join(ws, 'my file.md'), '# Notes');

    const result = expandAtMentions('Read @"my file.md" please', ws);

    expect(result).toContain('Contents of my file.md:');
    expect(result).toContain('# Notes');
  });

  it("leaves a missing file's mention as written", () => {
    const ws = workspace();

    const result = expandAtMentions('Read @missing.ts', ws);

    expect(result).toBe('Read @missing.ts');
  });

  it('leaves a directory mention as written', () => {
    const ws = workspace();
    mkdirSync(join(ws, 'src'));
    mkdirSync(join(ws, 'test'));

    expect(expandAtMentions('Read @src', ws)).toBe('Read @src');
    // An annotation that happens to name a directory (case-insensitively on Windows and
    // macOS) must not become a marker either (#261 review).
    expect(expandAtMentions('Add a @Test annotation', ws)).toBe('Add a @Test annotation');
  });

  it('leaves a missing path outside the workspace as written', () => {
    const ws = workspace();

    const result = expandAtMentions('Read @../secret.txt', ws);

    expect(result).toBe('Read @../secret.txt');
  });

  it('adds an explicit truncation notice for large files', () => {
    const ws = workspace();
    writeFileSync(join(ws, 'large.txt'), 'x'.repeat(20_100));

    const result = expandAtMentions('Read @large.txt', ws);

    expect(result).toContain('File truncated at 20000 characters');
  });

  it('does not rewrite emails or incidental @ text', () => {
    const ws = workspace();

    const result = expandAtMentions('Email dev@example.com and say @ hello', ws);

    expect(result).toBe('Email dev@example.com and say @ hello');
  });
});

describe('expandAtMentions — only real paths outside code (#261)', () => {
  function codeWorkspace(): string {
    const dir = workspace();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const value = 1;');
    return dir;
  }

  it('leaves a mention of a path that does not exist as written', () => {
    const ws = codeWorkspace();
    expect(expandAtMentions('Read @missing.ts please', ws)).toBe('Read @missing.ts please');
  });

  it('leaves JSDoc tags, decorators and npm scopes as written', () => {
    const ws = codeWorkspace();
    const input =
      'Add {@link AgentSpawnRequest.resumeAfterRestart}, keep @Injectable() and install @types/node.';
    expect(expandAtMentions(input, ws)).toBe(input);
  });

  it('does not expand a mention inside a fenced code block', () => {
    const ws = codeWorkspace();
    const input = 'Spec:\n```ts\n/** See @src/app.ts */\n```\n';
    expect(expandAtMentions(input, ws)).toBe(input);
  });

  it('does not expand a mention inside a tilde fence, or an unclosed fence', () => {
    const ws = codeWorkspace();
    const tilde = '~~~\n@src/app.ts\n~~~';
    expect(expandAtMentions(tilde, ws)).toBe(tilde);
    const unclosed = 'Code:\n```\n@src/app.ts\nstill code';
    expect(expandAtMentions(unclosed, ws)).toBe(unclosed);
  });

  it('does not expand a mention inside an inline code span', () => {
    const ws = codeWorkspace();
    const single = 'Call it as `read @src/app.ts now` in the prompt.';
    expect(expandAtMentions(single, ws)).toBe(single);
    const double = 'Or ``x @src/app.ts ` y`` there.';
    expect(expandAtMentions(double, ws)).toBe(double);
  });

  it('still expands a real mention after a closed fence and beside a lone backtick', () => {
    const ws = codeWorkspace();
    const afterFence = expandAtMentions('```\ncode\n```\nExplain @src/app.ts', ws);
    expect(afterFence).toContain('Contents of src/app.ts:');
    const loneTick = expandAtMentions('a ` b @src/app.ts', ws);
    expect(loneTick).toContain('Contents of src/app.ts:');
  });

  it('leaves an existing file outside the workspace as written, without a note', () => {
    const ws = workspace();
    const outside = join(dirname(ws), `${basename(ws)}-secret.txt`);
    writeFileSync(outside, 'secret');
    dirs.push(outside);
    const input = `Read @../${basename(outside)}`;
    expect(expandAtMentions(input, ws)).toBe(input);
  });

  it('leaves network paths as written', () => {
    const ws = workspace();
    const unc = ['Read @', '\\', '\\', 'server', '\\', 'share', '\\', 'x.txt'].join('');
    for (const input of ['Read @//server/share/x.txt', unc]) {
      expect(expandAtMentions(input, ws)).toBe(input);
    }
  });

  it('does not take a line that opens with a closed inline span for a fence', () => {
    const ws = codeWorkspace();
    const result = expandAtMentions('```npm test``` fails\nsee @src/app.ts', ws);
    expect(result).toContain('Contents of src/app.ts:');
  });

  it('does not pair backticks across a blank line', () => {
    const ws = codeWorkspace();
    const result = expandAtMentions('press the ` key\n\nthen read @src/app.ts and `x`', ws);
    expect(result).toContain('Contents of src/app.ts:');
  });

  it('expands a file whose name starts with two dots, which is no parent step', () => {
    const ws = codeWorkspace();
    writeFileSync(join(ws, '..notes.md'), 'dot-dot notes');

    expect(expandAtMentions('Read @..notes.md', ws)).toContain('dot-dot notes');
    expect(collectAtMentionObservations('Read @..notes.md', ws, 'ref')).toEqual([
      expect.objectContaining({ path: '..notes.md' }),
    ]);
  });

  it('leaves a mention outside the workspace that does not exist as written', () => {
    const ws = codeWorkspace();
    expect(expandAtMentions('Read @../nope-not-here.txt', ws)).toBe('Read @../nope-not-here.txt');
  });

  it('records no observation for a mention inside code', () => {
    const ws = codeWorkspace();
    expect(collectAtMentionObservations('See `read @src/app.ts now`', ws, 'ref')).toEqual([]);
    expect(collectAtMentionObservations('See @src/app.ts', ws, 'ref')).toHaveLength(1);
  });
});

describe('expandShellCommands', () => {
  it('runs without blocking the event loop', async () => {
    let timerFired = false;
    const command = `!"${process.execPath}" -e "setTimeout(() => console.log('done'), 30)"`;
    const pending = expandShellCommands(command, process.cwd());
    setTimeout(() => {
      timerFired = true;
    }, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(timerFired).toBe(true);
    await expect(pending).resolves.toBe('done');
  });

  it('cancels owned shell expansion work', async () => {
    const controller = new AbortController();
    const command = `!"${process.execPath}" -e "setTimeout(() => console.log('late'), 10000)"`;
    const pending = expandShellCommands(command, process.cwd(), controller.signal);

    controller.abort();

    await expect(pending).resolves.toMatch(/failed:.*abort/i);
  });
});

// #559. A repository can commit `docs/conventions.txt -> ../../.ssh/id_rsa` and mention it in a
// project command, and the target would be inlined into the turn sent to the provider. A mention is
// read only when its real path is inside the containment root: the repository root, else the
// workspace. A refused one stays as written, like `@../x`.
describe.skipIf(process.platform === 'win32')('expandAtMentions — links (#559)', () => {
  function write(path: string, body: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, 'utf-8');
  }

  it('leaves a mention of a committed link to a file outside the repository as written', async () => {
    const top = workspace();
    const repo = join(top, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    write(join(top, 'secret_id_rsa'), 'SECRET-PRIVATE-KEY');
    mkdirSync(join(repo, 'docs'));
    symlinkSync(join('..', '..', 'secret_id_rsa'), join(repo, 'docs', 'conventions.txt'));
    const input = 'Follow @docs/conventions.txt when editing.';

    expect(expandAtMentions(input, repo)).toBe(input);
    await expect(expandUserInput(input, repo)).resolves.toBe(input);
    expect(collectAtMentionObservations(input, repo, 'ref')).toEqual([]);
  });

  it('leaves a file reached through a directory linked outside the workspace as written', () => {
    const top = workspace();
    const ws = join(top, 'ws');
    write(join(top, 'outside', 'id_rsa'), 'SECRET-PRIVATE-KEY');
    mkdirSync(ws);
    symlinkSync(join(top, 'outside'), join(ws, 'linkdir'));
    const input = 'Read @linkdir/id_rsa and @linkdir';

    expect(expandAtMentions(input, ws)).toBe(input);
    expect(collectAtMentionObservations(input, ws, 'ref')).toEqual([]);
  });

  it('expands a link to a file inside the workspace, under the name it was mentioned by', () => {
    const ws = workspace();
    write(join(ws, 'STYLE.txt'), 'in-repo style');
    mkdirSync(join(ws, 'docs'));
    symlinkSync(join('..', 'STYLE.txt'), join(ws, 'docs', 'style.txt'));

    const result = expandAtMentions('Follow @docs/style.txt', ws);

    expect(result).toContain('Contents of docs/style.txt:');
    expect(result).toContain('in-repo style');
    expect(collectAtMentionObservations('@docs/style.txt', ws, 'ref')).toEqual([
      expect.objectContaining({ path: 'docs/style.txt', operation: 'mention' }),
    ]);
  });

  it('expands a monorepo link from a package workspace to a shared file in the repository', () => {
    const repo = workspace();
    mkdirSync(join(repo, '.git'));
    write(join(repo, 'packages', 'shared', 'conventions.txt'), 'shared conventions');
    const pkg = join(repo, 'packages', 'a');
    mkdirSync(pkg);
    symlinkSync(join('..', 'shared', 'conventions.txt'), join(pkg, 'conventions.txt'));

    expect(expandAtMentions('Follow @conventions.txt', pkg)).toContain('shared conventions');
    // The path as written is still measured from the workspace.
    expect(expandAtMentions('Follow @../shared/conventions.txt', pkg)).toBe(
      'Follow @../shared/conventions.txt',
    );
  });

  it('measures from the workspace when there is no repository', () => {
    const top = workspace();
    const ws = join(top, 'ws');
    write(join(top, 'sibling.txt'), 'SIBLING-SECRET');
    mkdirSync(ws);
    symlinkSync(join('..', 'sibling.txt'), join(ws, 'notes.txt'));

    expect(expandAtMentions('Read @notes.txt', ws)).toBe('Read @notes.txt');
  });

  // A dotfiles `~/.git` would otherwise make the whole home directory one repository.
  it('treats a dotfiles .git in the home directory as no repository', () => {
    const home = workspace();
    mkdirSync(join(home, '.git'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    write(join(home, 'other', 'secret.txt'), 'HOME-SECRET');
    const project = join(home, 'proj');
    mkdirSync(project);
    symlinkSync(join('..', 'other', 'secret.txt'), join(project, 'notes.txt'));
    // A project with its own repository under that home is measured from its own root.
    const repo = join(home, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    write(join(repo, 'shared', 'notes.txt'), 'repo notes');
    mkdirSync(join(repo, 'pkg'));
    symlinkSync(join('..', 'shared', 'notes.txt'), join(repo, 'pkg', 'notes.txt'));

    expect(expandAtMentions('Read @notes.txt', project)).toBe('Read @notes.txt');
    expect(expandAtMentions('Read @notes.txt', join(repo, 'pkg'))).toContain('repo notes');
  });
});
