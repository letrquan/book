import { execFileSync } from 'child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { basename, dirname, join } from 'path';
import { tmpdir } from 'os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  expandShellCommands,
  expandUserInput,
  expandUserInputDetailed,
  formatRefusedMentionNotice,
} from './input-expansion.js';

/** The files a typed `input` inlines, observed as `expandUserInput` records them. */
async function observed(input: string, ws: string, options = {}) {
  return (await expandUserInputDetailed(input, ws, { sourceRef: 'ref', ...options })).observations;
}

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

describe('expandUserInput — mentions', () => {
  it('expands a basic workspace-relative file mention', async () => {
    const ws = workspace();
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src', 'app.ts'), 'export const value = 1;');

    const result = await expandUserInput('Explain @src/app.ts', ws);

    expect(result).toContain('Contents of src/app.ts:');
    expect(result).toContain('export const value = 1;');
  });

  it('expands a quoted path containing spaces', async () => {
    const ws = workspace();
    writeFileSync(join(ws, 'my file.md'), '# Notes');

    const result = await expandUserInput('Read @"my file.md" please', ws);

    expect(result).toContain('Contents of my file.md:');
    expect(result).toContain('# Notes');
  });

  it("leaves a missing file's mention as written", async () => {
    const ws = workspace();

    const result = await expandUserInput('Read @missing.ts', ws);

    expect(result).toBe('Read @missing.ts');
  });

  it('leaves a directory mention as written', async () => {
    const ws = workspace();
    mkdirSync(join(ws, 'src'));
    mkdirSync(join(ws, 'test'));

    expect(await expandUserInput('Read @src', ws)).toBe('Read @src');
    // An annotation that happens to name a directory (case-insensitively on Windows and
    // macOS) must not become a marker either (#261 review).
    expect(await expandUserInput('Add a @Test annotation', ws)).toBe('Add a @Test annotation');
  });

  it('leaves a missing path outside the workspace as written', async () => {
    const ws = workspace();

    const result = await expandUserInput('Read @../secret.txt', ws);

    expect(result).toBe('Read @../secret.txt');
  });

  it('adds an explicit truncation notice for large files', async () => {
    const ws = workspace();
    writeFileSync(join(ws, 'large.txt'), 'x'.repeat(20_100));

    const result = await expandUserInput('Read @large.txt', ws);

    expect(result).toContain('File truncated at 20000 characters');
  });

  it('does not rewrite emails or incidental @ text', async () => {
    const ws = workspace();

    const result = await expandUserInput('Email dev@example.com and say @ hello', ws);

    expect(result).toBe('Email dev@example.com and say @ hello');
  });
});

describe('expandUserInput — only real paths outside code (#261)', () => {
  function codeWorkspace(): string {
    const dir = workspace();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'app.ts'), 'export const value = 1;');
    return dir;
  }

  it('leaves a mention of a path that does not exist as written', async () => {
    const ws = codeWorkspace();
    expect(await expandUserInput('Read @missing.ts please', ws)).toBe('Read @missing.ts please');
  });

  it('leaves JSDoc tags, decorators and npm scopes as written', async () => {
    const ws = codeWorkspace();
    const input =
      'Add {@link AgentSpawnRequest.resumeAfterRestart}, keep @Injectable() and install @types/node.';
    expect(await expandUserInput(input, ws)).toBe(input);
  });

  it('does not expand a mention inside a fenced code block', async () => {
    const ws = codeWorkspace();
    const input = 'Spec:\n```ts\n/** See @src/app.ts */\n```\n';
    expect(await expandUserInput(input, ws)).toBe(input);
  });

  it('does not expand a mention inside a tilde fence, or an unclosed fence', async () => {
    const ws = codeWorkspace();
    const tilde = '~~~\n@src/app.ts\n~~~';
    expect(await expandUserInput(tilde, ws)).toBe(tilde);
    const unclosed = 'Code:\n```\n@src/app.ts\nstill code';
    expect(await expandUserInput(unclosed, ws)).toBe(unclosed);
  });

  it('does not expand a mention inside an inline code span', async () => {
    const ws = codeWorkspace();
    const single = 'Call it as `read @src/app.ts now` in the prompt.';
    expect(await expandUserInput(single, ws)).toBe(single);
    const double = 'Or ``x @src/app.ts ` y`` there.';
    expect(await expandUserInput(double, ws)).toBe(double);
  });

  it('still expands a real mention after a closed fence and beside a lone backtick', async () => {
    const ws = codeWorkspace();
    const afterFence = await expandUserInput('```\ncode\n```\nExplain @src/app.ts', ws);
    expect(afterFence).toContain('Contents of src/app.ts:');
    const loneTick = await expandUserInput('a ` b @src/app.ts', ws);
    expect(loneTick).toContain('Contents of src/app.ts:');
  });

  it('leaves an existing file outside the workspace as written, without a note', async () => {
    const ws = workspace();
    const outside = join(dirname(ws), `${basename(ws)}-secret.txt`);
    writeFileSync(outside, 'secret');
    dirs.push(outside);
    const input = `Read @../${basename(outside)}`;
    expect(await expandUserInput(input, ws)).toBe(input);
  });

  it('leaves network paths as written', async () => {
    const ws = workspace();
    const unc = ['Read @', '\\', '\\', 'server', '\\', 'share', '\\', 'x.txt'].join('');
    for (const input of ['Read @//server/share/x.txt', unc]) {
      expect(await expandUserInput(input, ws)).toBe(input);
    }
  });

  it('does not take a line that opens with a closed inline span for a fence', async () => {
    const ws = codeWorkspace();
    const result = await expandUserInput('```npm test``` fails\nsee @src/app.ts', ws);
    expect(result).toContain('Contents of src/app.ts:');
  });

  it('does not pair backticks across a blank line', async () => {
    const ws = codeWorkspace();
    const result = await expandUserInput('press the ` key\n\nthen read @src/app.ts and `x`', ws);
    expect(result).toContain('Contents of src/app.ts:');
  });

  it('expands a file whose name starts with two dots, which is no parent step', async () => {
    const ws = codeWorkspace();
    writeFileSync(join(ws, '..notes.md'), 'dot-dot notes');

    expect(await expandUserInput('Read @..notes.md', ws)).toContain('dot-dot notes');
    expect(await observed('Read @..notes.md', ws)).toEqual([
      expect.objectContaining({ path: '..notes.md' }),
    ]);
  });

  it('leaves a mention outside the workspace that does not exist as written', async () => {
    const ws = codeWorkspace();
    expect(await expandUserInput('Read @../nope-not-here.txt', ws)).toBe(
      'Read @../nope-not-here.txt',
    );
  });

  it('records no observation for a mention inside code', async () => {
    const ws = codeWorkspace();
    expect(await observed('See `read @src/app.ts now`', ws)).toEqual([]);
    expect(await observed('See @src/app.ts', ws)).toEqual([
      expect.objectContaining({ path: 'src/app.ts', operation: 'mention', sourceRef: 'ref' }),
    ]);
  });

  it('decides a mention after a `!` line once the line has run', async () => {
    const ws = workspace();
    const input = `!node -e "require('fs').writeFileSync('new.md', 'MADE-BY-THE-LINE')"\n@new.md`;

    const expanded = await expandUserInputDetailed(input, ws, { expandShell: true });

    expect(expanded.text).toContain('MADE-BY-THE-LINE');
  });

  it('records no observation for a mention inside a `!` line, which is run, not inlined', async () => {
    const ws = codeWorkspace();
    expect(await observed('!echo @src/app.ts', ws, { expandShell: true })).toEqual([]);
    expect(await observed('!echo @src/app.ts', ws)).toHaveLength(1);
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

// #559, #567. A repository can commit `docs/conventions.txt -> ../../.ssh/id_rsa` and mention it in a
// project command, and the target would be inlined into the turn sent to the provider. A mention is
// inlined only when Read would open it: its real path inside the workspace or an
// `additionalDirectories` entry. A file refused for that stays as written and is reported.
describe.skipIf(process.platform === 'win32')('expandUserInput — links (#559, #567)', () => {
  function write(path: string, body: string) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, 'utf-8');
  }

  it('leaves a mention of a committed link to a file outside the repository as written, with a notice', async () => {
    const top = workspace();
    const repo = join(top, 'repo');
    mkdirSync(join(repo, '.git'), { recursive: true });
    write(join(top, 'secret_id_rsa'), 'SECRET-PRIVATE-KEY');
    mkdirSync(join(repo, 'docs'));
    symlinkSync(join('..', '..', 'secret_id_rsa'), join(repo, 'docs', 'conventions.txt'));
    const input = 'Follow @docs/conventions.txt when editing.';

    expect(await expandUserInput(input, repo)).toBe(input);
    const expanded = await expandUserInputDetailed(input, repo);
    expect(expanded.text).toBe(input);
    expect(expanded.observations).toEqual([]);
    expect(expanded.refused).toEqual([{ path: 'docs/conventions.txt', reason: 'outside' }]);
    expect(formatRefusedMentionNotice(expanded.refused[0])).toBe(
      '⚠  Left @docs/conventions.txt as written: it is outside the workspace and additionalDirectories.',
    );
  });

  it('leaves a file reached through a directory linked outside the workspace as written', async () => {
    const top = workspace();
    const ws = join(top, 'ws');
    write(join(top, 'outside', 'id_rsa'), 'SECRET-PRIVATE-KEY');
    mkdirSync(ws);
    symlinkSync(join(top, 'outside'), join(ws, 'linkdir'));
    const input = 'Read @linkdir/id_rsa and @linkdir';

    expect(await expandUserInput(input, ws)).toBe(input);
    const expanded = await expandUserInputDetailed(input, ws);
    expect(expanded.observations).toEqual([]);
    // The directory would not have been inlined anyway, so only the file is reported.
    expect(expanded.refused).toEqual([{ path: 'linkdir/id_rsa', reason: 'outside' }]);
  });

  it('reports nothing for a mention that names nothing, inside or outside the workspace', async () => {
    const ws = workspace();
    const expanded = await expandUserInputDetailed('Add @Override, email a@b.c, see @../nope', ws);
    expect(expanded.refused).toEqual([]);
  });

  it('expands a link to a file inside the workspace, under the name it was mentioned by', async () => {
    const ws = workspace();
    write(join(ws, 'STYLE.txt'), 'in-repo style');
    mkdirSync(join(ws, 'docs'));
    symlinkSync(join('..', 'STYLE.txt'), join(ws, 'docs', 'style.txt'));

    const result = await expandUserInput('Follow @docs/style.txt', ws);

    expect(result).toContain('Contents of docs/style.txt:');
    expect(result).toContain('in-repo style');
    // Filed under the path Read and Edit look the file up by, the canonical one, so a later Edit
    // of `docs/style.txt` counts it as seen.
    expect(await observed('@docs/style.txt', ws)).toEqual([
      expect.objectContaining({ path: 'STYLE.txt', operation: 'mention' }),
    ]);
  });

  // #567: Read refuses `packages/a/conventions.txt -> ../shared/conventions.txt` from the package
  // workspace as outside it, and so does a mention now. Declaring the shared directory serves both.
  it('follows Read for a monorepo link from a package workspace to a shared file', async () => {
    const repo = workspace();
    mkdirSync(join(repo, '.git'));
    write(join(repo, 'packages', 'shared', 'conventions.txt'), 'shared conventions');
    const pkg = join(repo, 'packages', 'a');
    mkdirSync(pkg);
    symlinkSync(join('..', 'shared', 'conventions.txt'), join(pkg, 'conventions.txt'));
    write(join(pkg, 'README.txt'), 'package readme');
    const shared = realpathSync(join(repo, 'packages', 'shared'));

    expect(await expandUserInput('Follow @conventions.txt', pkg)).toBe('Follow @conventions.txt');
    expect((await expandUserInputDetailed('Follow @conventions.txt', pkg)).refused).toEqual([
      { path: 'conventions.txt', reason: 'outside' },
    ]);
    expect(await expandUserInput('Follow @README.txt', pkg)).toContain('package readme');

    const declared = { additionalRoots: [shared] };
    const expanded = await expandUserInputDetailed('Follow @conventions.txt', pkg, declared);
    expect(expanded.text).toContain('shared conventions');
    expect(expanded.refused).toEqual([]);
    expect(expanded.observations).toEqual([
      expect.objectContaining({ path: '../shared/conventions.txt' }),
    ]);
    // Its absolute path there is a file Read opens too.
    const absolute = join(shared, 'conventions.txt');
    expect(await expandUserInput(`Follow @${absolute}`, pkg, declared)).toContain(
      'shared conventions',
    );
    // A relative path stays anchored to the workspace, as it does for Read.
    expect(await expandUserInput('Follow @../shared/conventions.txt', pkg, declared)).toBe(
      'Follow @../shared/conventions.txt',
    );
  });

  it('measures from the workspace when there is no repository', async () => {
    const top = workspace();
    const ws = join(top, 'ws');
    write(join(top, 'sibling.txt'), 'SIBLING-SECRET');
    mkdirSync(ws);
    symlinkSync(join('..', 'sibling.txt'), join(ws, 'notes.txt'));

    expect(await expandUserInput('Read @notes.txt', ws)).toBe('Read @notes.txt');
  });
});

function git(cwd: string, ...args: string[]): void {
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Book Test',
      '-c',
      'user.email=book@example.com',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.autocrlf=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

// #564. A checked-in `.book/commands/*.md` body is the repository's text, so a mention in it may
// inline only a file git has committed, unchanged: never the user's `.git/config`,
// `.book/settings.local.json` or `.env`.
describe('expandUserInput — a project command body (#564)', () => {
  function repository(): string {
    const repo = workspace();
    git(repo, 'init', '-q');
    mkdirSync(join(repo, '.book'));
    mkdirSync(join(repo, 'docs'));
    writeFileSync(join(repo, 'docs', 'style.md'), 'COMMITTED-STYLE\n');
    writeFileSync(join(repo, 'docs', 'edited.md'), 'COMMITTED-EDITED\n');
    writeFileSync(join(repo, 'docs', 'staged.md'), 'COMMITTED-STAGED\n');
    writeFileSync(join(repo, '.gitignore'), '.env\n.book/settings.local.json\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    writeFileSync(
      join(repo, '.git', 'config'),
      readGitConfig(repo) +
        '[remote "origin"]\n\turl = https://u:ghp_FAKE-TOKEN@example.com/x.git\n',
    );
    writeFileSync(join(repo, '.book', 'settings.local.json'), '{"apiKey":"sk-FAKE-LOCAL"}\n');
    writeFileSync(join(repo, '.env'), 'API_TOKEN=FAKE-ENV\n');
    writeFileSync(join(repo, 'docs', 'edited.md'), 'LOCAL-EDIT\n');
    writeFileSync(join(repo, 'docs', 'staged.md'), 'STAGED-EDIT\n');
    git(repo, 'add', 'docs/staged.md');
    writeFileSync(join(repo, 'docs', 'staged.md'), 'COMMITTED-STAGED\n');
    writeFileSync(join(repo, 'docs', 'untracked.md'), 'UNTRACKED\n');
    return repo;
  }

  function readGitConfig(repo: string): string {
    return readFileSync(join(repo, '.git', 'config'), 'utf-8');
  }

  const body =
    'Follow @.git/config, @.book/settings.local.json, @.env, @docs/edited.md, @docs/staged.md, ' +
    '@docs/untracked.md and @docs/style.md.';

  it('inlines only a file git has committed, unchanged', async () => {
    const repo = repository();

    const expanded = await expandUserInputDetailed(body, repo, { projectCommand: true });

    expect(expanded.text).toContain('COMMITTED-STYLE');
    for (const secret of [
      'ghp_FAKE-TOKEN',
      'sk-FAKE-LOCAL',
      'FAKE-ENV',
      'LOCAL-EDIT',
      'UNTRACKED',
    ]) {
      expect(expanded.text).not.toContain(secret);
    }
    // A change staged and then undone in the working tree is still a local change.
    expect(expanded.text).not.toContain('COMMITTED-STAGED');
    expect(expanded.refused).toEqual([
      { path: '.git/config', reason: 'untracked' },
      { path: '.book/settings.local.json', reason: 'untracked' },
      { path: '.env', reason: 'untracked' },
      { path: 'docs/edited.md', reason: 'changed' },
      { path: 'docs/staged.md', reason: 'changed' },
      { path: 'docs/untracked.md', reason: 'untracked' },
    ]);
    expect(expanded.observations).toEqual([expect.objectContaining({ path: 'docs/style.md' })]);
    expect(formatRefusedMentionNotice(expanded.refused[2])).toBe(
      '⚠  Left @.env as written: a project command inlines only files committed to git, and git does not track it.',
    );
  });

  it('runs no `!` line in a project command body', async () => {
    const repo = repository();
    const body = `!node -e "require('fs').writeFileSync('ran.txt', 'x')"\nFollow @docs/style.md`;

    const expanded = await expandUserInputDetailed(body, repo, {
      projectCommand: true,
      expandShell: true,
    });

    expect(existsSync(join(repo, 'ran.txt'))).toBe(false);
    expect(expanded.text).toContain('!node -e');
    expect(expanded.text).toContain('COMMITTED-STYLE');
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses only the file git cannot read, not the rest of the body',
    async () => {
      const repo = repository();
      chmodSync(join(repo, 'docs', 'untracked.md'), 0o000);
      try {
        const expanded = await expandUserInputDetailed('@docs/untracked.md @docs/style.md', repo, {
          projectCommand: true,
        });

        expect(expanded.text).toContain('COMMITTED-STYLE');
        expect(expanded.refused).toEqual([{ path: 'docs/untracked.md', reason: 'git-failed' }]);
      } finally {
        chmodSync(join(repo, 'docs', 'untracked.md'), 0o644);
      }
    },
  );

  it('leaves typed text and a user command body alone', async () => {
    const repo = repository();

    const typed = await expandUserInput(body, repo);

    for (const text of ['FAKE-ENV', 'LOCAL-EDIT', 'UNTRACKED', 'COMMITTED-STYLE']) {
      expect(typed).toContain(text);
    }
  });

  it('refuses a local change git status would not report (skip-worktree)', async () => {
    const repo = repository();
    git(repo, 'update-index', '--skip-worktree', 'docs/style.md');
    writeFileSync(join(repo, 'docs', 'style.md'), 'LOCAL-CREDENTIALS\n');

    const expanded = await expandUserInputDetailed('@docs/style.md', repo, {
      projectCommand: true,
    });

    expect(expanded.text).toBe('@docs/style.md');
    expect(expanded.refused).toEqual([{ path: 'docs/style.md', reason: 'changed' }]);
  });

  it.skipIf(process.platform === 'win32')(
    'judges the file a link serves, not the committed link',
    async () => {
      const repo = repository();
      symlinkSync(join('..', '.env'), join(repo, 'docs', 'env.md'));
      symlinkSync('style.md', join(repo, 'docs', 'alias.md'));
      git(repo, 'add', 'docs/env.md', 'docs/alias.md');
      git(repo, 'commit', '-q', '-m', 'links');

      const expanded = await expandUserInputDetailed('@docs/env.md and @docs/alias.md', repo, {
        projectCommand: true,
      });

      expect(expanded.text).not.toContain('FAKE-ENV');
      expect(expanded.text).toContain('COMMITTED-STYLE');
      expect(expanded.refused).toEqual([{ path: 'docs/env.md', reason: 'untracked' }]);
    },
  );

  it('inlines nothing with no repository, or before the first commit', async () => {
    const plain = workspace();
    writeFileSync(join(plain, 'notes.md'), 'PLAIN-NOTES\n');
    const unborn = workspace();
    git(unborn, 'init', '-q');
    writeFileSync(join(unborn, 'notes.md'), 'UNBORN-NOTES\n');
    git(unborn, 'add', 'notes.md');

    const none = await expandUserInputDetailed('@notes.md', plain, { projectCommand: true });
    const empty = await expandUserInputDetailed('@notes.md', unborn, { projectCommand: true });

    expect(none.text).toBe('@notes.md');
    expect(none.refused).toEqual([{ path: 'notes.md', reason: 'no-repository' }]);
    expect(empty.text).toBe('@notes.md');
    expect(empty.refused).toEqual([{ path: 'notes.md', reason: 'git-failed' }]);
  });

  // A dotfiles `~/.git` is not the repository a project under the home directory is in.
  it('treats a dotfiles .git in the home directory as no repository', async () => {
    const home = workspace();
    git(home, 'init', '-q');
    const project = join(home, 'proj');
    mkdirSync(project);
    writeFileSync(join(project, 'notes.md'), 'HOME-NOTES\n');
    git(home, 'add', 'proj/notes.md');
    git(home, 'commit', '-q', '-m', 'dotfiles');
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);

    const expanded = await expandUserInputDetailed('@notes.md', project, { projectCommand: true });

    expect(expanded.text).toBe('@notes.md');
    expect(expanded.refused).toEqual([{ path: 'notes.md', reason: 'no-repository' }]);
  });
});
