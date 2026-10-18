import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  collectSkippedCommandNotices,
  discoverCommands,
  generateCommandListing,
  inspectCommands,
  resolveCommandBody,
} from './loader.js';
import { projectCommandFingerprint } from '../command-approvals.js';
import { parseFrontmatter } from '../frontmatter.js';
import type { SlashCommand } from '../types/commands.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'book-cmds-'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

describe('parseFrontmatter', () => {
  it('returns empty frontmatter for plain text', () => {
    const { body, frontmatter } = parseFrontmatter('hello world');
    expect(frontmatter).toEqual({});
    expect(body).toBe('hello world');
  });

  it('parses key-value pairs', () => {
    const raw = [
      '---',
      'description: Say hello',
      'argument-hint: [name]',
      '---',
      'Hello, $ARGUMENTS!',
    ].join('\n');
    const { body, frontmatter } = parseFrontmatter(raw);
    expect(frontmatter).toEqual({
      description: 'Say hello',
      'argument-hint': '[name]',
    });
    expect(body).toBe('Hello, $ARGUMENTS!');
  });

  it('parses array values', () => {
    const raw = [
      '---',
      'allowed-tools:',
      '- Read',
      '- Bash(git *)',
      '- Grep',
      'description: Commit helper',
      '---',
      'Run git commit -m "$ARGUMENTS"',
    ].join('\n');
    const { body, frontmatter } = parseFrontmatter(raw);
    expect(frontmatter['allowed-tools']).toEqual(['Read', 'Bash(git *)', 'Grep']);
    expect(frontmatter.description).toBe('Commit helper');
    expect(body).toBe('Run git commit -m "$ARGUMENTS"');
  });

  it('handles quoted values', () => {
    const raw = '---\ndescription: "Hello, world"\n---\nbody';
    const { frontmatter } = parseFrontmatter(raw);
    expect(frontmatter.description).toBe('Hello, world');
  });
});

describe('resolveCommandBody', () => {
  const cmd = {
    name: 'test',
    description: 'test',
    body: 'echo $ARGUMENTS and first is $1 and second is $2',
    source: 'project' as const,
  };

  it('substitutes $ARGUMENTS', async () => {
    const { resolved } = await resolveCommandBody(cmd, 'hello world');
    expect(resolved).toContain('echo hello world');
    expect(resolved).toContain('first is hello');
    expect(resolved).toContain('second is world');
  });

  it('substitutes $* as alias for $ARGUMENTS', async () => {
    const cmd2 = { ...cmd, body: 'run $*' };
    const { resolved } = await resolveCommandBody(cmd2, 'a b c');
    expect(resolved).toBe('run a b c');
  });

  it('substitutes positional args', async () => {
    const { resolved } = await resolveCommandBody(cmd, 'alpha beta');
    expect(resolved).toContain('first is alpha');
    expect(resolved).toContain('second is beta');
  });

  it('handles empty args', async () => {
    const { resolved } = await resolveCommandBody(cmd, '');
    expect(resolved).toBe('echo  and first is  and second is ');
  });

  it('resolves named arguments from $name', async () => {
    const cmdNamed = {
      ...cmd,
      body: 'File: $file, Focus: $focus',
      arguments: ['file', 'focus'] as string[],
    };
    const { resolved } = await resolveCommandBody(cmdNamed, 'src/app.ts performance');
    expect(resolved).toContain('File: src/app.ts');
    expect(resolved).toContain('Focus: performance');
  });

  it('resolves ${BOOK_DATE} env var', async () => {
    const cmdEnv = { ...cmd, body: 'Today is ${BOOK_DATE}' };
    const { resolved } = await resolveCommandBody(cmdEnv, '');
    const today = new Date().toISOString().split('T')[0];
    expect(resolved).toContain(today);
  });

  it('resolves ${BOOK_WORKSPACE} from context', async () => {
    const cmdEnv = { ...cmd, body: 'Workspace: ${BOOK_WORKSPACE}' };
    const { resolved } = await resolveCommandBody(cmdEnv, '', { workspace: '/test/path' });
    expect(resolved).toContain('Workspace: /test/path');
  });

  it('resolves shell injection from !`cmd`', async () => {
    const cmdShell = { ...cmd, body: 'Output: !`echo hello_from_shell`' };
    const { resolved, shellErrors } = await resolveCommandBody(cmdShell, '', {
      projectCommands: {
        [cmdShell.name]: {
          fingerprint: projectCommandFingerprint(cmdShell.body),
          choice: 'approved',
        },
      },
    });
    expect(resolved).toContain('hello_from_shell');
    expect(shellErrors).toHaveLength(0);
  });

  it('refuses shell injection the user has not approved', async () => {
    const cmdShell = { ...cmd, body: 'Output: !`echo hello_from_shell`' };
    await expect(resolveCommandBody(cmdShell, '')).rejects.toThrow(/has not been approved/);
  });

  it('respects shell-style quoting', async () => {
    const cmdQuoted = { ...cmd, body: 'First: $1, Second: $2' };
    const { resolved } = await resolveCommandBody(cmdQuoted, '"hello world" arg2');
    expect(resolved).toContain('First: hello world');
    expect(resolved).toContain('Second: arg2');
  });
});

describe('discoverCommands', () => {
  it('returns empty array when no commands directory exists', () => {
    const result = discoverCommands(dir);
    expect(result).toEqual([]);
  });

  it('discovers user commands from BOOK_HOME', () => {
    const bookHome = join(dir, 'isolated-book-home');
    const commandsDir = join(bookHome, 'commands');
    const workspace = join(dir, 'workspace');
    mkdirSync(commandsDir, { recursive: true });
    mkdirSync(workspace);
    writeFileSync(
      join(commandsDir, 'global.md'),
      '---\ndescription: Isolated user command\n---\nGlobal body',
    );
    vi.stubEnv('BOOK_HOME', bookHome);

    expect(discoverCommands(workspace)).toEqual([
      expect.objectContaining({ name: 'global', source: 'user' }),
    ]);
  });

  it('discovers commands from .book/commands/*.md', () => {
    const cmdsDir = join(dir, '.book', 'commands');
    mkdirSync(cmdsDir, { recursive: true });
    writeFileSync(join(cmdsDir, 'greet.md'), '---\ndescription: Say hello\n---\nHello!');
    writeFileSync(
      join(cmdsDir, 'commit.md'),
      '---\ndescription: Git commit\nargument-hint: <message>\nallowed-tools:\n- Bash(git *)\n---\nCommit changes.',
    );

    const result = discoverCommands(dir);
    expect(result).toHaveLength(2);
    expect(result.find((c) => c.name === 'greet')?.description).toBe('Say hello');
    expect(result.find((c) => c.name === 'commit')?.allowedTools).toEqual(['Bash(git *)']);
  });

  it('ignores non-md files', () => {
    const cmdsDir = join(dir, '.book', 'commands');
    mkdirSync(cmdsDir, { recursive: true });
    writeFileSync(join(cmdsDir, 'notes.txt'), 'ignored');
    writeFileSync(join(cmdsDir, 'valid.md'), '---\ndescription: ok\n---\nbody');

    const result = discoverCommands(dir);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('valid');
  });

  it('project commands override user commands with same name', () => {
    const bookHome = join(dir, 'isolated-book-home');
    const userCommandsDir = join(bookHome, 'commands');
    mkdirSync(userCommandsDir, { recursive: true });
    writeFileSync(
      join(userCommandsDir, 'same.md'),
      '---\ndescription: User version\n---\nUser body',
    );
    const cmdsDir = join(dir, '.book', 'commands');
    mkdirSync(cmdsDir, { recursive: true });
    writeFileSync(join(cmdsDir, 'same.md'), '---\ndescription: Project version\n---\nProject body');
    vi.stubEnv('BOOK_HOME', bookHome);

    const result = discoverCommands(dir);
    expect(result.find((c) => c.name === 'same')?.description).toBe('Project version');
  });
});

// #543. A repository can commit a command file as a link to a file outside it, and the target would
// be sent to the provider when `/name` is run.
describe.skipIf(process.platform === 'win32')('command files that are links', () => {
  let repo: string;
  let bookHome: string;
  const real = (path: string) => realpathSync.native(path);
  const write = (path: string, body: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body, 'utf-8');
  };

  beforeEach(() => {
    repo = join(dir, 'repo');
    bookHome = join(dir, 'book-home');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(bookHome, 'commands'), { recursive: true });
    vi.stubEnv('BOOK_HOME', bookHome);
  });

  it('does not load a project command linked outside the repository, and reports it', () => {
    write(join(dir, 'outside', 'secret.md'), 'TOP-SECRET\n');
    mkdirSync(join(repo, '.book', 'commands'), { recursive: true });
    symlinkSync(join(dir, 'outside', 'secret.md'), join(repo, '.book', 'commands', 'leak.md'));

    expect(discoverCommands(repo)).toEqual([]);
    expect(inspectCommands(repo)).toEqual({
      commands: [],
      skipped: [
        {
          path: join(repo, '.book', 'commands', 'leak.md'),
          target: real(join(dir, 'outside', 'secret.md')),
          root: real(repo),
          reason: 'outside',
        },
      ],
    });
    expect(collectSkippedCommandNotices(repo)).toEqual([
      `⚠  Skipped project command ${join('.book', 'commands', 'leak.md')}: it links to ${real(
        join(dir, 'outside', 'secret.md'),
      )}, outside ${real(repo)}.`,
    ]);
  });

  it('loads a project command linked to a Markdown file inside the repository', () => {
    write(join(repo, 'docs', 'shared.md'), '---\ndescription: Shared\n---\nShared body');
    mkdirSync(join(repo, '.book', 'commands'), { recursive: true });
    symlinkSync(
      join('..', '..', 'docs', 'shared.md'),
      join(repo, '.book', 'commands', 'shared-link.md'),
    );

    const { commands, skipped } = inspectCommands(repo);

    expect(commands).toEqual([
      expect.objectContaining({
        name: 'shared-link',
        description: 'Shared',
        body: 'Shared body',
        source: 'project',
      }),
    ]);
    expect(skipped).toEqual([]);
  });

  it('does not load a project command linked to a file that is not Markdown', () => {
    write(join(repo, '.env'), 'TOKEN=abc');
    mkdirSync(join(repo, '.book', 'commands'), { recursive: true });
    symlinkSync(join('..', '..', '.env'), join(repo, '.book', 'commands', 'env.md'));

    const { commands, skipped } = inspectCommands(repo);

    expect(commands).toEqual([]);
    expect(skipped.map((s) => [s.path, s.reason])).toEqual([
      [join(repo, '.book', 'commands', 'env.md'), 'not-markdown'],
    ]);
  });

  it('reports each file of a linked .book/commands directory that points outside', () => {
    write(join(dir, 'outside', 'a.md'), 'A secret');
    write(join(dir, 'outside', 'b.md'), 'B secret');
    mkdirSync(join(repo, '.book'), { recursive: true });
    symlinkSync(join(dir, 'outside'), join(repo, '.book', 'commands'));

    const { commands, skipped } = inspectCommands(repo);

    expect(commands).toEqual([]);
    expect(skipped.map((s) => [s.path, s.target])).toEqual([
      [join(repo, '.book', 'commands', 'a.md'), real(join(dir, 'outside', 'a.md'))],
      [join(repo, '.book', 'commands', 'b.md'), real(join(dir, 'outside', 'b.md'))],
    ]);
  });

  it('reports each file of a linked .book directory that points outside', () => {
    write(join(dir, 'outside-book', 'commands', 'a.md'), 'A secret');
    symlinkSync(join(dir, 'outside-book'), join(repo, '.book'));

    const { commands, skipped } = inspectCommands(repo);

    expect(commands).toEqual([]);
    expect(skipped.map((s) => s.path)).toEqual([join(repo, '.book', 'commands', 'a.md')]);
  });

  it('measures from the repository root, so a package command may link to a shared file', () => {
    write(join(repo, 'shared', 'cmd.md'), 'Shared body');
    const pkg = join(repo, 'packages', 'a');
    mkdirSync(join(pkg, '.book', 'commands'), { recursive: true });
    symlinkSync(
      join('..', '..', '..', '..', 'shared', 'cmd.md'),
      join(pkg, '.book', 'commands', 'cmd.md'),
    );

    expect(discoverCommands(pkg).map((c) => c.body)).toEqual(['Shared body']);
  });

  it('measures from the workspace root when there is no repository', () => {
    const plain = join(dir, 'plain');
    write(join(dir, 'outside', 'x.md'), 'secret');
    mkdirSync(join(plain, '.book', 'commands'), { recursive: true });
    symlinkSync(join(dir, 'outside', 'x.md'), join(plain, '.book', 'commands', 'x.md'));

    expect(inspectCommands(plain).skipped.map((s) => s.root)).toEqual([real(plain)]);
  });

  it('never checks a user command, which may link anywhere', () => {
    write(join(dir, 'dotfiles', 'mine.md'), '---\ndescription: Mine\n---\nUser body');
    write(join(dir, 'dotfiles', 'notes.txt'), 'Text body');
    symlinkSync(join(dir, 'dotfiles', 'mine.md'), join(bookHome, 'commands', 'mine.md'));
    symlinkSync(join(dir, 'dotfiles', 'notes.txt'), join(bookHome, 'commands', 'notes.md'));

    const { commands, skipped } = inspectCommands(repo);

    expect(commands.map((c) => [c.name, c.body, c.source]).sort()).toEqual([
      ['mine', 'User body', 'user'],
      ['notes', 'Text body', 'user'],
    ]);
    expect(skipped).toEqual([]);
  });

  it('does not check the project entries when the project commands directory is the user one', () => {
    // The workspace is the home directory: `<home>/.book/commands` is both.
    const home = join(dir, 'home');
    write(join(dir, 'dotfiles', 'mine.md'), 'User body');
    mkdirSync(join(home, '.book', 'commands'), { recursive: true });
    symlinkSync(join(dir, 'dotfiles', 'mine.md'), join(home, '.book', 'commands', 'mine.md'));
    vi.stubEnv('BOOK_HOME', join(home, '.book'));

    const { commands, skipped } = inspectCommands(home);

    expect(commands.map((c) => c.body)).toEqual(['User body']);
    expect(skipped).toEqual([]);
  });

  it('does not check the project entries when the commands directory is a link to the user one', () => {
    write(join(dir, 'dotfiles', 'mine.md'), 'User body');
    symlinkSync(join(dir, 'dotfiles', 'mine.md'), join(bookHome, 'commands', 'mine.md'));
    mkdirSync(join(repo, '.book'), { recursive: true });
    symlinkSync(join(bookHome, 'commands'), join(repo, '.book', 'commands'));

    const { commands, skipped } = inspectCommands(repo);

    expect(commands.map((c) => c.body)).toEqual(['User body']);
    expect(skipped).toEqual([]);
  });

  it('ignores a dangling link without a skipped entry', () => {
    mkdirSync(join(repo, '.book', 'commands'), { recursive: true });
    symlinkSync(join(dir, 'missing.md'), join(repo, '.book', 'commands', 'gone.md'));

    expect(inspectCommands(repo)).toEqual({ commands: [], skipped: [] });
  });
});

describe('generateCommandListing', () => {
  const command = (name: string, description: string): SlashCommand => ({
    name,
    description,
    body: '',
    source: 'project',
  });

  it('describes how the host actually dispatches a command', () => {
    const listing = generateCommandListing([command('review', 'Review the diff')]);

    // No command bodies follow the listing, and neither headless nor the SDK
    // resolves a bare `/name`, so the old "execute its instructions below" was
    // a mechanism the model could not use.
    expect(listing).not.toContain('execute its instructions below');
    expect(listing).toContain('The host expands an invoked command into the conversation');
    expect(listing).toContain('treat it as a reference');
    expect(listing).toContain('- **/review**: Review the diff');
  });

  it('marks how many commands the budget cut', () => {
    const commands = Array.from({ length: 40 }, (_, index) =>
      command(`cmd${index}`, 'A reasonably long description that eats into the char budget.'),
    );

    const listing = generateCommandListing(commands, 600);

    expect(listing).toContain('not shown');
    const shown = listing.split('\n').filter((line) => line.startsWith('- **/')).length;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(commands.length);
    expect(listing).toContain(`- …and ${commands.length - shown} more not shown`);
  });

  it('marks nothing when every command fits', () => {
    const listing = generateCommandListing([command('review', 'Review the diff')], 4096);

    expect(listing).not.toContain('not shown');
  });
});
