import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { discoverCommands, resolveCommandBody } from './loader.js';
import { parseFrontmatter } from '../frontmatter.js';

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
    const { resolved, shellErrors } = await resolveCommandBody(cmdShell, '');
    expect(resolved).toContain('hello_from_shell');
    expect(shellErrors).toHaveLength(0);
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
