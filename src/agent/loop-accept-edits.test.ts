import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedMemoryContext } from '../memory-store.js';
import type { Provider } from '../provider/index.js';
import { defaultConfig } from '../test/fixtures.js';
import { isolateBookHome } from '../test/isolated-book-home.js';
import { createDefaultRegistry } from '../tools/registry.js';
import type { AgentLoopCallbacks } from '../types/providers.js';
import type { AgentConfig, PermissionMode } from '../types/runtime.js';
import type { PermissionDecision, PermissionResult, ToolResult } from '../types/tools.js';
import { runAgentLoop } from './loop.js';

const git = promisify(execFile);
const onWindows = process.platform === 'win32';

type ScriptedCall = { id: string; name: string; arguments: Record<string, unknown> };

/** One turn per entry, then a turn of text. */
function scripted(turns: ScriptedCall[][]): Provider {
  let turn = 0;
  return {
    id: 'scripted',
    stream: async function* () {
      const calls = turns[turn++];
      if (calls) for (const toolCall of calls) yield { type: 'tool_call' as const, toolCall };
      else yield { type: 'text' as const, content: 'done' };
      yield { type: 'done' as const };
    },
  };
}

isolateBookHome('book-accept-edits-home-');

let dirs: string[] = [];
let workspace: string;

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

function put(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

beforeEach(() => {
  workspace = tempDir('book-accept-edits-');
  put(join(workspace, 'src', 'x.ts'), 'old\n');
  put(join(workspace, 'src', 'y.ts'), 'old\n');
  put(join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  put(join(workspace, '.git', 'config'), '[core]\n');
  mkdirSync(join(workspace, '.git', 'objects'));
  mkdirSync(join(workspace, '.git', 'hooks'));
});

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
  vi.unstubAllEnvs();
});

interface Driven {
  results: ToolResult[];
  prompt: ReturnType<typeof vi.fn>;
}

async function drive(
  mode: PermissionMode,
  turns: ScriptedCall[][],
  options: {
    answer?: PermissionResult | PermissionDecision;
    configure?: (config: AgentConfig) => void;
    root?: string;
  } = {},
): Promise<Driven> {
  const config = defaultConfig({
    workspace: options.root ?? workspace,
    maxTurns: turns.length + 1,
  });
  options.configure?.(config);
  const results: ToolResult[] = [];
  const answer = options.answer ?? 'deny';
  const prompt = vi.fn(async () => answer);
  const callbacks: AgentLoopCallbacks = {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: (result) => results.push(result),
    onError: () => {},
    onTurnStart: () => {},
    onDone: () => {},
    onPermissionRequired: prompt,
  };
  await runAgentLoop(config, createDefaultRegistry(), 'go', [], callbacks, mode, {
    provider: scripted(turns),
    isNewSession: false,
  });
  return { results, prompt };
}

function write(path: string, id = 'w'): ScriptedCall {
  return { id, name: 'Write', arguments: { filePath: path, content: 'new\n' } };
}

function read(path: string, id = 'r'): ScriptedCall {
  return { id, name: 'Read', arguments: { filePath: path } };
}

function byId(results: ToolResult[], id: string): ToolResult | undefined {
  return results.find((result) => result.toolCallId === id);
}

/** Asks exactly once, and with the answer `deny` leaves `file` as it was. */
async function expectAsks(call: ScriptedCall, file?: string, options = {}): Promise<void> {
  const before = file && existsSync(file) ? readFileSync(file, 'utf8') : undefined;
  const { results, prompt } = await drive('accept-edits', [[call]], options);
  expect(prompt).toHaveBeenCalledTimes(1);
  expect(byId(results, call.id)?.structuredError?.code).toBe('permission_denied');
  if (file) {
    expect(existsSync(file) ? readFileSync(file, 'utf8') : undefined).toBe(before);
  }
}

describe('acceptEdits and control files', () => {
  describe('every spelling of a control path asks', () => {
    it.each([
      ['the local settings', '.book/settings.local.json'],
      ['the project settings', '.book/settings.json'],
      ['a project command', '.book/commands/deploy.md'],
      ['a project agent', '.book/agents/helper.md'],
      ['a project skill', '.book/skills/tidy/SKILL.md'],
      ['the legacy config', '.bookrc.json'],
      ['the git config', '.git/config'],
      ['a hook', '.git/hooks/pre-commit'],
      ['a new file in the git dir', '.git/brand-new'],
      ['a dot segment', './.git/config'],
      ['a climbing spelling', 'src/../.git/config'],
      ['another case', '.GIT/config'],
      ['another case of the settings', '.Book/settings.json'],
      ['a trailing dot', '.git./config'],
      ['a trailing space', '.book /settings.json'],
      ['a stream suffix', '.git::$INDEX_ALLOCATION/config'],
      ['an ignorable code point', '.g‌it/config'],
      ['a nested repository', 'vendor/lib/.git/config'],
      ['a nested settings directory', 'vendor/lib/.book/settings.json'],
    ])('%s: %s', async (_label, target) => {
      await expectAsks(write(target), join(workspace, target));
    });

    it('an absolute spelling', async () => {
      await expectAsks(write(join(workspace, '.git', 'config')), join(workspace, '.git', 'config'));
    });

    it('a new .git in a workspace that has none', async () => {
      rmSync(join(workspace, '.git'), { recursive: true });
      await expectAsks(write('.git/config'), join(workspace, '.git', 'config'));
    });

    it('a new .book/ in a workspace that has none', async () => {
      await expectAsks(write('.book/settings.json'), join(workspace, '.book', 'settings.json'));
    });

    it('a file the config includes', async () => {
      put(join(workspace, '.git', 'config'), '[include]\n\tpath = ../shared.gitconfig\n');
      put(join(workspace, 'shared.gitconfig'), '[user]\n');
      await expectAsks(write('shared.gitconfig'), join(workspace, 'shared.gitconfig'));
    });

    it('the directory core.hooksPath names, and a new file in it', async () => {
      put(join(workspace, '.git', 'config'), '[core]\n\thooksPath = tools/hooks\n');
      await expectAsks(write('tools/hooks/pre-push'), join(workspace, 'tools/hooks/pre-push'));
    });

    it('a directory core.hooksPath names in an included file', async () => {
      put(join(workspace, '.git', 'config'), '[include]\n\tpath = extra\n');
      put(join(workspace, '.git', 'extra'), '[core]\n\thooksPath = tools/hooks\n');
      await expectAsks(write('tools/hooks/pre-push'), join(workspace, 'tools/hooks/pre-push'));
    });
  });

  describe.skipIf(onWindows)('a link in the workspace', () => {
    it('to the git config', async () => {
      symlinkSync(join('.git', 'config'), join(workspace, 'plain.txt'));
      await expectAsks(write('plain.txt'), join(workspace, '.git', 'config'));
    });

    it('to the git dir', async () => {
      symlinkSync('.git', join(workspace, 'plain'));
      await expectAsks(write('plain/config'), join(workspace, '.git', 'config'));
    });

    it('to the settings directory, with a file not there yet', async () => {
      mkdirSync(join(workspace, '.book'));
      symlinkSync('.book', join(workspace, 'plain'));
      await expectAsks(write('plain/settings.json'), join(workspace, '.book', 'settings.json'));
    });

    it('standing in for the settings directory', async () => {
      mkdirSync(join(workspace, 'real-settings'));
      symlinkSync('real-settings', join(workspace, '.book'));
      await expectAsks(write('real-settings/settings.json'));
      await expectAsks(write('.book/settings.json'));
    });

    it('that dangles', async () => {
      symlinkSync(join('.git', 'hooks', 'post-commit'), join(workspace, 'plain.txt'));
      await expectAsks(write('plain.txt'), join(workspace, '.git', 'hooks', 'post-commit'));
    });

    it('that dangles, partway down', async () => {
      symlinkSync(join('.git', 'not-yet'), join(workspace, 'plain'));
      await expectAsks(write('plain/file'), join(workspace, '.git', 'not-yet', 'file'));
    });
  });

  describe('every file tool asks', () => {
    it.each([
      ['Edit', { filePath: '.git/config', oldString: '[core]', newString: '[core] ' }],
      [
        'MultiEdit',
        { filePath: '.git/config', edits: [{ oldString: '[core]', newString: '[core] ' }] },
      ],
    ])('%s', async (name, args) => {
      const { results, prompt } = await drive('accept-edits', [
        [read('.git/config')],
        [{ id: 'e', name, arguments: args }],
      ]);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(byId(results, 'e')?.structuredError?.code).toBe('permission_denied');
      expect(readFileSync(join(workspace, '.git', 'config'), 'utf8')).toBe('[core]\n');
    });

    it('NotebookEdit', async () => {
      const notebook = JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 });
      put(join(workspace, '.book', 'notes.ipynb'), notebook);
      const { results, prompt } = await drive('accept-edits', [
        [read('.book/notes.ipynb')],
        [
          {
            id: 'n',
            name: 'NotebookEdit',
            arguments: { notebook_path: '.book/notes.ipynb', new_source: 'x', edit_mode: 'insert' },
          },
        ],
      ]);
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(byId(results, 'n')?.structuredError?.code).toBe('permission_denied');
      expect(readFileSync(join(workspace, '.book', 'notes.ipynb'), 'utf8')).toBe(notebook);
    });

    const patch = (...operations: string[]): ScriptedCall => ({
      id: 'p',
      name: 'ApplyPatch',
      arguments: { patch: ['*** Begin Patch', ...operations, '*** End Patch'].join('\n') },
    });
    const update = (path: string): string =>
      [`*** Update File: ${path}`, '@@', '-old', '+new'].join('\n');
    const add = (path: string): string => [`*** Add File: ${path}`, '+new'].join('\n');

    it('ApplyPatch, adding a file', async () => {
      await expectAsks(
        patch(add('.git/hooks/pre-commit')),
        join(workspace, '.git/hooks/pre-commit'),
      );
    });

    it('ApplyPatch, updating a file', async () => {
      put(join(workspace, '.book', 'settings.json'), 'old\n');
      await expectAsks(
        patch(update('.book/settings.json')),
        join(workspace, '.book/settings.json'),
      );
    });

    it('ApplyPatch, deleting a file', async () => {
      await expectAsks(patch('*** Delete File: .git/config'), join(workspace, '.git', 'config'));
    });

    it('ApplyPatch with one control path among many writes nothing', async () => {
      await expectAsks(patch(update('src/x.ts'), add('.git/config'), update('src/y.ts')));
      expect(readFileSync(join(workspace, 'src', 'x.ts'), 'utf8')).toBe('old\n');
      expect(readFileSync(join(workspace, 'src', 'y.ts'), 'utf8')).toBe('old\n');
    });

    it('ApplyPatch of ordinary files stays silent', async () => {
      const { results, prompt } = await drive('accept-edits', [
        [read('src/x.ts', 'r1'), read('src/y.ts', 'r2')],
        [patch(update('src/x.ts'), update('src/y.ts'), add('src/z.ts'))],
      ]);
      expect(prompt).not.toHaveBeenCalled();
      expect(byId(results, 'p')?.status).toBe('success');
      expect(readFileSync(join(workspace, 'src', 'z.ts'), 'utf8')).toBe('new\n');
    });
  });

  describe('ordinary edits stay silent', () => {
    it.each([
      ['a source file', 'src/new.ts'],
      ['a git-adjacent name', '.gitignore'],
      ['the CI folder', '.github/workflows/ci.yml'],
      ['a name that only starts the same', '.git-backup/config'],
      ['a folder named like the settings', '.books/settings.json'],
      ['a folder with no dot', 'book/settings.json'],
      ['a file named git', 'docs/git'],
    ])('%s: %s', async (_label, target) => {
      const { results, prompt } = await drive('accept-edits', [[write(target)]]);
      expect(prompt).not.toHaveBeenCalled();
      expect(byId(results, 'w')?.status).toBe('success');
      expect(readFileSync(join(workspace, target), 'utf8')).toBe('new\n');
    });

    it('Edit and MultiEdit of a source file', async () => {
      const { results, prompt } = await drive('accept-edits', [
        [read('src/x.ts', 'r1'), read('src/y.ts', 'r2')],
        [
          {
            id: 'e',
            name: 'Edit',
            arguments: { filePath: 'src/x.ts', oldString: 'old', newString: 'new' },
          },
          {
            id: 'm',
            name: 'MultiEdit',
            arguments: { filePath: 'src/y.ts', edits: [{ oldString: 'old', newString: 'new' }] },
          },
        ],
      ]);
      expect(prompt).not.toHaveBeenCalled();
      expect(byId(results, 'e')?.status).toBe('success');
      expect(byId(results, 'm')?.status).toBe('success');
    });

    it('a target outside every root is the tool refusal it always was', async () => {
      const outside = tempDir('book-accept-edits-out-');
      const { results, prompt } = await drive('accept-edits', [
        [write(join(outside, '.git', 'config'))],
      ]);
      expect(prompt).not.toHaveBeenCalled();
      expect(byId(results, 'w')?.structuredError?.code).toBe('path_outside_workspace');
    });
  });

  describe('the other deciders', () => {
    it('default asks for a control file and an ordinary file alike', async () => {
      const { prompt } = await drive('default', [
        [write('.git/config', 'a')],
        [write('src/n.ts', 'b')],
      ]);
      expect(prompt).toHaveBeenCalledTimes(2);
    });

    it('an approval at the prompt lets the write through', async () => {
      const { results, prompt } = await drive(
        'accept-edits',
        [[read('.git/config')], [write('.git/config')]],
        { answer: 'allow' },
      );
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(byId(results, 'w')?.status).toBe('success');
      expect(readFileSync(join(workspace, '.git', 'config'), 'utf8')).toBe('new\n');
    });

    it('an allow rule decides without a prompt', async () => {
      const { results, prompt } = await drive(
        'accept-edits',
        [[read('.git/config')], [write('.git/config')]],
        {
          configure: (config) => {
            config.settings.permissions.allow = ['Write(.git/config)'];
          },
        },
      );
      expect(prompt).not.toHaveBeenCalled();
      expect(byId(results, 'w')?.status).toBe('success');
    });

    it('bypassPermissions runs it without a prompt', async () => {
      const { results, prompt } = await drive('bypassPermissions', [
        [read('.git/config')],
        [write('.git/config')],
      ]);
      expect(prompt).not.toHaveBeenCalled();
      expect(byId(results, 'w')?.status).toBe('success');
    });

    it('a deny rule still blocks it, with no prompt', async () => {
      const { results, prompt } = await drive('accept-edits', [[write('.git/config')]], {
        configure: (config) => {
          config.settings.permissions.deny = ['Write(.git/config)'];
        },
      });
      expect(prompt).not.toHaveBeenCalled();
      expect(byId(results, 'w')?.structuredError?.code).toBe('permission_denied');
    });

    it('dontAsk refuses it, as it refuses every write', async () => {
      const { results, prompt } = await drive('dontAsk', [[write('.git/config')]]);
      expect(prompt).not.toHaveBeenCalled();
      expect(byId(results, 'w')?.structuredError?.code).toBe('permission_denied');
      expect(readFileSync(join(workspace, '.git', 'config'), 'utf8')).toBe('[core]\n');
    });

    it('with nobody to answer, the refusal names the rule that would allow it', async () => {
      const { results, prompt } = await drive('accept-edits', [[write('.git/config')]], {
        answer: { result: 'deny', reason: 'no_approver' },
      });
      expect(prompt).toHaveBeenCalledTimes(1);
      const result = byId(results, 'w');
      expect(result?.structuredError?.code).toBe('permission_denied');
      expect(result?.content).toContain('Write(.git/config)');
    });
  });

  describe('memory', () => {
    function memoryContext(dir: string): LoadedMemoryContext {
      return {
        dir,
        indexFile: join(dir, 'MEMORY.md'),
        indexLoaded: false,
        indexLineCount: 0,
        loadedLineCount: 0,
        indexByteCount: 0,
        wasLineTruncated: false,
        wasByteTruncated: false,
        indexText: '',
        files: [],
      };
    }

    const memoryFile = (id = 'w'): ScriptedCall[] => [
      {
        id,
        name: 'Write',
        arguments: {
          filePath: join(process.env.BOOK_HOME!, 'memory', 'topic.md'),
          content:
            '---\nname: topic\ndescription: a topic\nmetadata:\n  type: project\n---\n\nnote\n',
        },
      },
    ];

    it('a memory write needs no prompt', async () => {
      const dir = join(process.env.BOOK_HOME!, 'memory');
      mkdirSync(dir, { recursive: true });
      const { results, prompt } = await drive('accept-edits', [memoryFile()], {
        configure: (config) => {
          config.memoryContext = memoryContext(dir);
        },
      });
      expect(prompt).not.toHaveBeenCalled();
      expect(byId(results, 'w')?.status).toBe('success');
    });

    it('nor in a workspace that holds the home', async () => {
      const dir = join(process.env.BOOK_HOME!, 'memory');
      mkdirSync(dir, { recursive: true });
      const { results, prompt } = await drive('accept-edits', [memoryFile()], {
        root: process.env.BOOK_HOME!,
        configure: (config) => {
          config.memoryContext = memoryContext(dir);
        },
      });
      expect(prompt).not.toHaveBeenCalled();
      expect(byId(results, 'w')?.status).toBe('success');
    });
  });
});

describe('acceptEdits and a home directory a root holds', () => {
  it('a workspace at the home asks for a write, as it does for a read', async () => {
    const home = process.env.BOOK_HOME!;
    put(join(home, 'existing.txt'), 'x\n');
    const asked = await drive('accept-edits', [[write(join(home, 'new.txt'))]], { root: home });
    expect(asked.prompt).toHaveBeenCalledTimes(1);
    expect(existsSync(join(home, 'new.txt'))).toBe(false);
    const read1 = await drive('accept-edits', [[read(join(home, 'existing.txt'))]], { root: home });
    expect(read1.prompt).toHaveBeenCalledTimes(1);
  });

  it('a workspace holding the home asks for everything under it', async () => {
    const holder = tempDir('book-accept-edits-holder-');
    const home = join(holder, 'home');
    mkdirSync(home);
    vi.stubEnv('BOOK_HOME', home);
    const inside = await drive('accept-edits', [[write(join(home, 'new.txt'))]], { root: holder });
    expect(inside.prompt).toHaveBeenCalledTimes(1);
    const beside = await drive('accept-edits', [[write(join(holder, 'beside.txt'))]], {
      root: holder,
    });
    expect(beside.prompt).toHaveBeenCalledTimes(1);
  });

  it('an approved directory holding the home asks inside the home only', async () => {
    const holder = tempDir('book-accept-edits-holder-');
    const home = join(holder, 'home');
    mkdirSync(home);
    vi.stubEnv('BOOK_HOME', home);
    const configure = (config: AgentConfig): void => {
      config.settings.additionalDirectories = [holder];
    };
    const inside = await drive('accept-edits', [[write(join(home, 'new.txt'))]], { configure });
    expect(inside.prompt).toHaveBeenCalledTimes(1);
    expect(existsSync(join(home, 'new.txt'))).toBe(false);
    const beside = await drive('accept-edits', [[write(join(holder, 'beside.txt'))]], {
      configure,
    });
    expect(beside.prompt).not.toHaveBeenCalled();
    expect(readFileSync(join(holder, 'beside.txt'), 'utf8')).toBe('new\n');
  });

  it('an approved directory carries the same control paths', async () => {
    const approved = tempDir('book-accept-edits-approved-');
    const configure = (config: AgentConfig): void => {
      config.settings.additionalDirectories = [approved];
    };
    for (const target of ['.git/config', '.book/settings.json', '.bookrc.json']) {
      const { prompt } = await drive('accept-edits', [[write(join(approved, target))]], {
        configure,
      });
      expect(prompt).toHaveBeenCalledTimes(1);
      expect(existsSync(join(approved, target))).toBe(false);
    }
  });

  it('a workspace below a home is not guarded by it', async () => {
    const root = join(process.env.BOOK_HOME!, 'worktrees', 'one');
    put(join(root, 'src', 'x.ts'), 'old\n');
    const { results, prompt } = await drive('accept-edits', [[write('src/new.ts')]], { root });
    expect(prompt).not.toHaveBeenCalled();
    expect(byId(results, 'w')?.status).toBe('success');
  });
});

describe('acceptEdits in a linked git worktree', () => {
  let repo: string;
  let linked: string;

  beforeEach(async () => {
    repo = tempDir('book-accept-edits-repo-');
    const run = (...args: string[]) => git('git', args, { cwd: repo });
    await run('init', '-q', '-b', 'main');
    await run('config', 'user.email', 'book@example.com');
    await run('config', 'user.name', 'Book');
    put(join(repo, 'src', 'x.ts'), 'old\n');
    await run('add', '-A');
    await run('commit', '-q', '-m', 'first');
    // Where a managed patcher's worktree sits: under Book's home, which it does not hold.
    linked = join(process.env.BOOK_HOME!, 'worktrees', 'patcher');
    await run('worktree', 'add', '-q', '-b', 'patcher', linked);
    linked = realpathSync(linked);
  });

  it('edits the work tree without a prompt', async () => {
    const { results, prompt } = await drive(
      'accept-edits',
      [
        [read('src/x.ts')],
        [
          {
            id: 'e',
            name: 'Edit',
            arguments: { filePath: 'src/x.ts', oldString: 'old', newString: 'new' },
          },
        ],
      ],
      { root: linked },
    );
    expect(prompt).not.toHaveBeenCalled();
    expect(byId(results, 'e')?.status).toBe('success');
    expect(readFileSync(join(linked, 'src', 'x.ts'), 'utf8')).toBe('new\n');
  });

  it('asks for the pointer file', async () => {
    await expectAsks(write('.git'), join(linked, '.git'), { root: linked });
  });

  it('asks for the shared git dir, when an approved directory reaches it', async () => {
    const configure = (config: AgentConfig): void => {
      config.settings.additionalDirectories = [repo];
    };
    const target = join(repo, '.git', 'config');
    await expectAsks(write(target), target, { root: linked, configure });
    const admin = join(repo, '.git', 'worktrees', 'patcher', 'config.worktree');
    await expectAsks(write(admin), admin, { root: linked, configure });
  });

  it('a source file of the repository in the approved directory stays silent', async () => {
    const { prompt } = await drive('accept-edits', [[write(join(repo, 'src', 'new.ts'))]], {
      root: linked,
      configure: (config) => {
        config.settings.additionalDirectories = [repo];
      },
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(readFileSync(join(repo, 'src', 'new.ts'), 'utf8')).toBe('new\n');
  });
});
