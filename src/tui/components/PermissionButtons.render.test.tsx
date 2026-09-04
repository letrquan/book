import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import stripAnsi from 'strip-ansi';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { PermissionButtons, toolRiskLevel, wrapPayload } from './PermissionButtons.js';

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

const workspaces: string[] = [];
function makeWorkspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'book-permission-preview-'));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
  workspaces.push(root);
  return root;
}

async function frameContaining(
  view: ReturnType<typeof render>,
  needle: string,
  attempts = 200,
): Promise<string> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const frame = stripAnsi(view.lastFrame() ?? '');
    if (frame.includes(needle)) return frame;
    await waitForImmediate();
  }
  throw new Error(`frame never contained ${JSON.stringify(needle)}:\n${view.lastFrame()}`);
}

afterEach(() => {
  cleanup();
  for (const root of workspaces.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PermissionButtons', () => {
  it('resolves consecutive tool prompts rendered in the same slot', async () => {
    const onResolveRead = vi.fn();
    const onResolveGlob = vi.fn();
    const view = render(
      withTheme(
        <PermissionButtons
          toolCall={{ id: 'read-1', name: 'Read', arguments: { file_path: 'README.md' } }}
          onResolve={onResolveRead}
        />,
      ),
    );

    view.stdin.write('\r');
    await waitForImmediate();

    view.rerender(
      withTheme(
        <PermissionButtons
          toolCall={{ id: 'glob-1', name: 'Glob', arguments: { pattern: '**/*.ts' } }}
          onResolve={onResolveGlob}
        />,
      ),
    );
    await waitForImmediate();
    view.stdin.write('\r');
    await waitForImmediate();

    expect(onResolveRead).toHaveBeenCalledOnce();
    expect(onResolveRead).toHaveBeenCalledWith('allow');
    expect(onResolveGlob).toHaveBeenCalledOnce();
    expect(onResolveGlob).toHaveBeenCalledWith('allow');
  });

  it('resolves only once when multiple approval keys arrive for one tool', () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(
        <PermissionButtons
          toolCall={{ id: 'read-1', name: 'Read', arguments: { file_path: 'README.md' } }}
          onResolve={onResolve}
        />,
      ),
    );

    view.stdin.write('r');
    view.stdin.write('s');
    view.stdin.write('\r');

    expect(onResolve).toHaveBeenCalledOnce();
    expect(onResolve).toHaveBeenCalledWith('allow');
  });

  // `always` is the only choice here that writes a rule to disk, and nothing in
  // the UI removes one. A lone `a` used to grant it outright: with the composer
  // below still reading "Type a follow-up", one letter of an ordinary sentence
  // persisted a shell allow with no visible trace.
  it('arms "Always allow" on A but does not grant it without a deliberate Enter', () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(
        <PermissionButtons
          toolCall={{ id: 'bash-1', name: 'Bash', arguments: { command: 'echo one' } }}
          onResolve={onResolve}
        />,
      ),
    );

    view.stdin.write('a');
    expect(onResolve).not.toHaveBeenCalled();

    // Space used to activate too, which left `always` reachable by "a ".
    view.stdin.write(' ');
    expect(onResolve).not.toHaveBeenCalled();

    view.stdin.write('\r');
    expect(onResolve).toHaveBeenCalledOnce();
    // `always` carries the rule, because the ladder means it is not always the
    // exact command.
    expect(onResolve).toHaveBeenCalledWith({ result: 'always', rule: 'Bash(echo one)' });
  });

  // The exact rule matches that byte sequence and nothing else, so a user who
  // pressed "Always allow" to stop being asked was asked again next call.
  it('steps the Always allow scope on repeated A and writes the chosen rule', async () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(
        <PermissionButtons
          toolCall={{ id: 'bash-3', name: 'Bash', arguments: { command: 'npm run check' } }}
          onResolve={onResolve}
        />,
      ),
    );

    view.stdin.write('a'); // arm
    await waitForImmediate();
    view.stdin.write('a'); // widen once
    await waitForImmediate();
    expect(stripAnsi(view.lastFrame() ?? '')).toContain('Bash(npm run *)');
    expect(onResolve).not.toHaveBeenCalled();

    view.stdin.write('\r');
    expect(onResolve).toHaveBeenCalledExactlyOnceWith({
      result: 'always',
      rule: 'Bash(npm run *)',
    });
  });

  it('wraps back to the exact rule rather than committing one', async () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(
        <PermissionButtons
          toolCall={{ id: 'bash-4', name: 'Bash', arguments: { command: 'npm run check' } }}
          onResolve={onResolve}
        />,
      ),
    );

    // Arm, then a full cycle back round to the exact rule.
    for (let i = 0; i < 4; i++) {
      view.stdin.write('a');
      await waitForImmediate();
    }
    expect(stripAnsi(view.lastFrame() ?? '')).toContain('Bash(npm run check)');
    expect(onResolve).not.toHaveBeenCalled();
  });

  // The armed choice used to be carried by background colour and bold alone —
  // the only selection surface in the TUI without a glyph. `A` now arms the
  // Always allow button rather than firing it, so seeing which one is armed is
  // the whole interaction.
  it('marks the armed button with the same glyph the plan card uses', async () => {
    const view = render(
      withTheme(
        <PermissionButtons
          toolCall={{ id: 'bash-5', name: 'Bash', arguments: { command: 'npm run check' } }}
          onResolve={vi.fn()}
        />,
      ),
    );

    const armed = (frame: string) =>
      frame
        .split('\n')
        .find((line) => line.includes('▸'))
        ?.trim();

    expect(armed(stripAnsi(view.lastFrame() ?? ''))).toContain('▸ Run once');

    view.stdin.write('\u001b[C');
    await waitForImmediate();
    const moved = armed(stripAnsi(view.lastFrame() ?? ''));
    expect(moved).toContain('▸ Skip');
    // Exactly one marker: two would read as two armed buttons.
    expect((stripAnsi(view.lastFrame() ?? '').match(/▸/g) ?? []).length).toBe(1);
  });

  it('keeps R and S as single-key shortcuts', () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(
        <PermissionButtons
          toolCall={{ id: 'bash-2', name: 'Bash', arguments: { command: 'echo two' } }}
          onResolve={onResolve}
        />,
      ),
    );

    view.stdin.write('s');
    expect(onResolve).toHaveBeenCalledExactlyOnceWith('deny');
  });
});

// The card is where consent is given, so it has to show what is being
// consented to. A fixed 72-character slice hid the tail of every longer command
// with nothing marking the cut, and a file mutation showed only its path.
describe('PermissionButtons payload', () => {
  const command =
    "find . -type f -name '*.log' -mtime +30 -print0 | xargs -0 rm -f && echo cleaned up every old log file in this tree";

  it('shows the whole command, wrapped to the card, instead of a silent 72-char cut', () => {
    const view = render(
      withTheme(
        <PermissionButtons
          toolCall={{ id: 'bash-long', name: 'Bash', arguments: { command } }}
          onResolve={vi.fn()}
          terminalWidth={80}
        />,
      ),
    );
    const frame = stripAnsi(view.lastFrame() ?? '');
    // Every character of the command is on screen, across rows.
    const joined = frame
      .split('\n')
      .map((line) => line.replace(/^│ ?/, '').replace(/ ?│$/, ''))
      .join('');
    expect(joined).toContain('echo cleaned up every old log file in this tree');
    expect(frame).not.toContain('more rows');
    // No row spills past the terminal.
    for (const line of frame.split('\n')) expect(line.length).toBeLessThanOrEqual(80);
  });

  it('keeps a short argument on the header row', () => {
    const view = render(
      withTheme(
        <PermissionButtons
          toolCall={{ id: 'read-1', name: 'Read', arguments: { file_path: 'README.md' } }}
          onResolve={vi.fn()}
          terminalWidth={80}
        />,
      ),
    );
    expect(stripAnsi(view.lastFrame() ?? '')).toContain('Permission required · Read README.md');
  });

  it('marks a cut it has to make and opens it on D', async () => {
    const script = Array.from({ length: 12 }, (_, index) => `echo line ${index + 1}`).join('\n');
    const view = render(
      withTheme(
        <PermissionButtons
          toolCall={{ id: 'bash-script', name: 'Bash', arguments: { command: script } }}
          onResolve={vi.fn()}
          terminalWidth={80}
          terminalRows={40}
        />,
      ),
    );
    const collapsed = stripAnsi(view.lastFrame() ?? '');
    expect(collapsed).toContain('echo line 1');
    expect(collapsed).not.toContain('echo line 12');
    expect(collapsed).toMatch(/… \d+ more rows · D shows all/);
    expect(collapsed).toContain('D more');

    view.stdin.write('d');
    const expanded = await frameContaining(view, 'echo line 12');
    expect(expanded).not.toContain('D shows all');
    expect(expanded).toContain('D less');
  });

  it('shows the diff an Edit would make before anything is written', async () => {
    const root = makeWorkspace({ 'notes.txt': 'alpha\nbeta\ngamma\n' });
    const view = render(
      withTheme(
        <PermissionButtons
          toolCall={{
            id: 'edit-1',
            name: 'Edit',
            arguments: { file_path: 'notes.txt', old_string: 'beta', new_string: 'delta' },
          }}
          onResolve={vi.fn()}
          terminalWidth={80}
          workspaceRoot={root}
        />,
      ),
    );
    const frame = await frameContaining(view, '+ delta');
    expect(frame).toContain('- beta');
    expect(frame).toContain('update notes.txt +1 −1');
  });

  it('says why a mutation cannot be previewed instead of hiding it', async () => {
    const root = makeWorkspace({ 'notes.txt': 'alpha\n' });
    const view = render(
      withTheme(
        <PermissionButtons
          toolCall={{
            id: 'edit-2',
            name: 'Edit',
            arguments: { filePath: 'notes.txt', oldString: 'zeta', newString: 'eta' },
          }}
          onResolve={vi.fn()}
          terminalWidth={80}
          workspaceRoot={root}
        />,
      ),
    );
    const frame = await frameContaining(view, 'Cannot preview');
    expect(frame).toContain('oldString not found');
  });

  it('still answers the prompt while the preview is pending or absent', () => {
    const onResolve = vi.fn();
    const view = render(
      withTheme(
        <PermissionButtons
          toolCall={{
            id: 'write-1',
            name: 'Write',
            arguments: { filePath: 'new.txt', content: 'hello\n' },
          }}
          onResolve={onResolve}
          terminalWidth={80}
        />,
      ),
    );
    // No workspace root: the card names the path and nothing else.
    const frame = stripAnsi(view.lastFrame() ?? '');
    expect(frame).toContain('Write new.txt');
    expect(frame).not.toContain('Computing diff');
    view.stdin.write('r');
    expect(onResolve).toHaveBeenCalledExactlyOnceWith('allow');
  });

  it('reads the whole command and the change summary to a screen reader', async () => {
    const root = makeWorkspace({ 'notes.txt': 'alpha\nbeta\n' });
    const shell = render(
      withTheme(
        <PermissionButtons
          toolCall={{ id: 'bash-sr', name: 'Bash', arguments: { command } }}
          onResolve={vi.fn()}
          screenReader
        />,
      ),
    );
    // The test terminal wraps long rows; compare the text, not the layout.
    const spoken = stripAnsi(shell.lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(spoken).toContain(`Command: ${command}`);

    const edit = render(
      withTheme(
        <PermissionButtons
          toolCall={{
            id: 'edit-sr',
            name: 'Edit',
            arguments: { filePath: 'notes.txt', oldString: 'beta', newString: 'delta' },
          }}
          onResolve={vi.fn()}
          screenReader
          workspaceRoot={root}
        />,
      ),
    );
    const frame = await frameContaining(edit, 'Will update notes.txt');
    expect(frame).toContain('1 lines added, 1 lines removed');
  });
});

describe('wrapPayload', () => {
  it('hard-wraps by display width and never drops text that fits the budget', () => {
    const wrapped = wrapPayload('a'.repeat(25), 10, 5);
    expect(wrapped.rows).toEqual(['a'.repeat(10), 'a'.repeat(10), 'aaaaa']);
    expect(wrapped.hiddenRows).toBe(0);
  });

  it('keeps a row for the cut marker when the budget is exceeded', () => {
    const wrapped = wrapPayload(['1', '2', '3', '4', '5'].join('\n'), 10, 3);
    expect(wrapped.rows).toEqual(['1', '2']);
    expect(wrapped.hiddenRows).toBe(3);
  });

  it('preserves spacing inside a command', () => {
    expect(wrapPayload('echo "a  b"', 40, 3).rows).toEqual(['echo "a  b"']);
  });
});

describe('toolRiskLevel', () => {
  it('classifies shell tools as shell-risk', () => {
    expect(toolRiskLevel({ id: '1', name: 'Bash', arguments: { command: 'pwd' } })).toBe('shell');
    expect(toolRiskLevel({ id: '2', name: 'BashOutput', arguments: { shell_id: 'shell_1' } })).toBe(
      'shell',
    );
    expect(toolRiskLevel({ id: '3', name: 'KillShell', arguments: { shell_id: 'shell_1' } })).toBe(
      'shell',
    );
  });

  it('classifies file writes separately from safe tools', () => {
    expect(toolRiskLevel({ id: '4', name: 'Write', arguments: { filePath: 'a.txt' } })).toBe(
      'write',
    );
    expect(
      toolRiskLevel({
        id: '5',
        name: 'NotebookEdit',
        arguments: { notebook_path: 'analysis.ipynb' },
      }),
    ).toBe('write');
    expect(toolRiskLevel({ id: '6', name: 'Read', arguments: { filePath: 'a.txt' } })).toBe('safe');
  });
});
