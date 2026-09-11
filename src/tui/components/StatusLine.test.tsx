import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import chalk from 'chalk';
import { APPLE_THEME, DEFAULT_THEME, ThemeContext } from '../theme.js';
import { buildColoredSegments, StatusLine } from './StatusLine.js';
import { displayWidth } from './word-wrap.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

afterEach(() => cleanup());

describe('buildColoredSegments', () => {
  it('skips an oversized middle segment and keeps a later segment that fits', () => {
    const runs = buildColoredSegments(
      [
        { text: 'xxxxxxxxxx', color: 'white' },
        { text: 'tok 50%', color: 'white' },
        { text: 'accept edits', color: 'green' },
        { text: 'tasks 1/3', color: 'white' },
      ],
      34,
    );

    expect(runs.map((run) => run.text).join('')).toBe('xxxxxxxxxx · tok 50% · tasks 1/3');
  });
});

describe('StatusLine', () => {
  it('strips provider prefix from the model name in footer', () => {
    const view = render(
      withTheme(
        <StatusLine
          model="9router/ag/gemini-3.8-flash-high"
          mode="default"
          taskCount={0}
          activeTaskCount={0}
          terminalWidth={100}
          reducedMotion
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('gemini-3.8-flash-high');
    expect(output).not.toContain('9router');
  });

  it('omits context percentage and remaining token info from footer', () => {
    const view = render(
      withTheme(
        <StatusLine
          model="gemini-3.8-flash-high"
          tokenCount={104_857}
          maxTokens={1_048_576}
          maxTokensSource="family"
          mode="default"
          taskCount={0}
          activeTaskCount={0}
          terminalWidth={100}
          reducedMotion
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).not.toContain('ctx');
    expect(output).not.toContain('(family)');
    expect(output).toContain('gemini-3.8-flash-high');
  });

  it('omits context source annotations on wide terminals', () => {
    for (const source of ['default', 'learned', 'family'] as const) {
      const view = render(
        withTheme(
          <StatusLine
            model="test-model"
            tokenCount={27_200}
            maxTokens={272_000}
            maxTokensSource={source}
            mode="default"
            taskCount={0}
            activeTaskCount={0}
            terminalWidth={100}
            reducedMotion
          />,
        ),
      );

      const output = stripAnsi(view.lastFrame());
      expect(output).not.toContain(`(${source})`);
      expect(output).toContain('test-model');
    }
  });

  it('omits cost calculation from footer even on wide terminals', () => {
    const view = render(
      withTheme(
        <StatusLine
          model="gemini"
          tokenCount={104_857}
          maxTokens={1_048_576}
          mode="default"
          taskCount={0}
          activeTaskCount={0}
          terminalWidth={100}
          reducedMotion
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).not.toContain('$');
  });

  it('preserves the stripped model name at 72 and 74 columns with long branch', () => {
    for (const width of [72, 74]) {
      const view = render(
        withTheme(
          <StatusLine
            model="mp/gemini-3.8-flash-high"
            mode="default"
            taskCount={0}
            activeTaskCount={0}
            gitBranch="research/next-task"
            gitStatus="+1"
            terminalWidth={width}
            reducedMotion
          />,
        ),
      );

      const output = stripAnsi(view.lastFrame());
      expect(output).toContain('gemini-3.8-flash-high');
      expect(output).not.toContain('mp/');
      view.unmount();
    }
  });

  it('renders full status on wide terminals without ctx or cost', () => {
    const view = render(
      withTheme(
        <StatusLine
          model="claude-sonnet-5"
          tokenCount={12_000}
          maxTokens={128_000}
          mode="default"
          taskCount={3}
          activeTaskCount={1}
          terminalWidth={100}
          reducedMotion
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('claude-sonnet-5');
    expect(output).toContain('default');
    expect(output).toContain('tasks 1/3');
    expect(output).not.toContain('ctx');
    expect(output).not.toContain('$');
    expect(output.split('\n')).toHaveLength(1);
  });

  it('prioritizes managed agents needing input', () => {
    const view = render(
      withTheme(
        <StatusLine
          model="main-model"
          tokenCount={0}
          mode="default"
          taskCount={0}
          activeTaskCount={0}
          agentCount={3}
          activeAgentCount={2}
          needsInputAgentCount={1}
          terminalWidth={100}
          reducedMotion
        />,
      ),
    );
    expect(stripAnsi(view.lastFrame())).toContain('agents 2 | 1 needs input');
  });

  it('keeps narrow output within terminal width', () => {
    const width = 36;
    const view = render(
      withTheme(
        <StatusLine
          model="very-long-model-name-that-needs-truncation"
          tokenCount={64_000}
          maxTokens={128_000}
          mode="accept-edits"
          taskCount={0}
          activeTaskCount={0}
          terminalWidth={width}
          compact
          reducedMotion
        />,
      ),
    );

    for (const line of stripAnsi(view.lastFrame()).split('\n').filter(Boolean)) {
      expect(displayWidth(line)).toBeLessThanOrEqual(width);
    }
  });

  // Both are identity, but the branch is the one that changes under you: a
  // rebase or a checkout in a sibling worktree moves it without asking, while
  // the model stays where you put it. The old budgets cut `research/next-task`
  // to `research/ne…` at 56 columns and left `scripted/scripted` whole.
  it('spends a tight row on the branch before the model, without losing either', () => {
    const view = render(
      withTheme(
        <StatusLine
          model="scripted/scripted"
          tokenCount={0}
          mode="default"
          taskCount={0}
          activeTaskCount={0}
          gitBranch="research/next-task"
          gitStatus="✓"
          terminalWidth={56}
          reducedMotion
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('research/next-t');
    // The model is shortened rather than skipped: first-fit packing drops a
    // segment whole, so a branch budget that crowds it loses it entirely.
    expect(output).toContain('scripted');
    expect(displayWidth(output.split('\n')[0])).toBeLessThanOrEqual(56);
  });

  it('does not render activity text in the model/token row', () => {
    const view = render(
      withTheme(
        <StatusLine
          model="model"
          tokenCount={1_000}
          maxTokens={128_000}
          mode="default"
          taskCount={0}
          activeTaskCount={0}
          terminalWidth={80}
          reducedMotion
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).not.toContain('Thinking');
    expect(output).not.toContain('Retrying');
  });

  describe('mode color labels', () => {
    const modes: Array<{ mode: Parameters<typeof StatusLine>[0]['mode']; label: string }> = [
      { mode: 'default', label: 'default' },
      { mode: 'plan', label: 'plan' },
      { mode: 'accept-edits', label: 'accept edits' },
      { mode: 'auto', label: 'auto' },
      { mode: 'dontAsk', label: "don't ask" },
      { mode: 'bypassPermissions', label: 'bypass' },
    ];

    for (const { mode, label } of modes) {
      it(`renders "${label}" for mode="${mode}"`, () => {
        const view = render(
          withTheme(
            <StatusLine
              model="model"
              tokenCount={1_000}
              maxTokens={128_000}
              mode={mode}
              taskCount={0}
              activeTaskCount={0}
              terminalWidth={80}
              reducedMotion
            />,
          ),
        );

        const output = stripAnsi(view.lastFrame());
        expect(output).toContain(label);
      });
    }
  });
});

describe('StatusLine git segment', () => {
  function statusFor(props: Partial<React.ComponentProps<typeof StatusLine>>): string {
    const view = render(
      withTheme(
        <StatusLine
          model="claude-opus-5"
          tokenCount={1_000}
          mode="default"
          taskCount={0}
          activeTaskCount={0}
          terminalWidth={100}
          reducedMotion
          {...props}
        />,
      ),
    );
    return stripAnsi(view.lastFrame());
  }

  it('shows the branch when the workspace is a repository', () => {
    expect(statusFor({ gitBranch: 'feat/improve-ui', gitStatus: '✓' })).toContain(
      'feat/improve-ui',
    );
  });

  it('marks a dirty tree so an uncommitted change is visible at a glance', () => {
    expect(statusFor({ gitBranch: 'main', gitStatus: '+2 ~1' })).toContain('main*');
  });

  it('leaves a clean tree unmarked', () => {
    const output = statusFor({ gitBranch: 'main', gitStatus: '✓' });
    expect(output).toContain('main');
    expect(output).not.toContain('main*');
  });

  it('omits the segment outside a repository', () => {
    const output = statusFor({ gitBranch: '?', gitStatus: '' });
    expect(output).not.toContain('?');
  });

  it('leads with the permission mode chip', () => {
    expect(statusFor({ mode: 'plan' })).toContain('◆ plan');
  });
});

describe('StatusLine colour budget', () => {
  /**
   * Ink colours through chalk, which emits nothing off a TTY. Forcing
   * truecolor is the only way to read which token a segment took; a hex colour
   * renders as `38;2;r;g;b`, so a token is matched by its own bytes.
   */
  function sgrFor(hex: string): string {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `\x1b[38;2;${r};${g};${b}m`;
  }

  function runFor(text: string, frame: string): string {
    // The SGR that opens a run sits right before its text; a run for `text`
    // is the colour introduced most recently before it.
    const at = frame.indexOf(text);
    expect(at, `${text} is not on the row`).toBeGreaterThan(-1);
    const opens = frame.slice(0, at).match(/\x1b\[38;2;\d+;\d+;\d+m/g) ?? [];
    return opens.at(-1) ?? '';
  }

  function colouredFrame(props: Partial<React.ComponentProps<typeof StatusLine>>): string {
    const level = chalk.level;
    chalk.level = 3;
    try {
      const view = render(
        <ThemeContext.Provider value={APPLE_THEME}>
          <StatusLine
            model="claude-opus-5"
            tokenCount={10_000}
            maxTokens={100_000}
            mode="default"
            taskCount={0}
            activeTaskCount={0}
            terminalWidth={100}
            reducedMotion
            {...props}
          />
        </ThemeContext.Provider>,
      );
      const frame = view.lastFrame() ?? '';
      view.unmount();
      return frame;
    } finally {
      chalk.level = level;
    }
  }

  it('keeps a healthy default session entirely grey', () => {
    // The footer is metadata. When nothing needs a decision, nothing on it
    // may be louder than the model name -- the row used to tint `default`
    // and a 10% context reading, which made the whole footer read as status.
    const frame = colouredFrame({ gitBranch: 'main', gitStatus: '✓' });

    for (const text of ['default', 'main', 'claude-opus-5']) {
      expect(runFor(text, frame), text).toBe(sgrFor(APPLE_THEME.subtle));
    }
    for (const token of ['modeDefault', 'warning', 'error'] as const) {
      if (APPLE_THEME[token] === APPLE_THEME.subtle) continue;
      expect(frame, `${token} leaked into a healthy row`).not.toContain(sgrFor(APPLE_THEME[token]));
    }
  });

  it('colours a permission mode that is not the default', () => {
    const frame = colouredFrame({ mode: 'plan' });
    expect(runFor('plan', frame)).toBe(sgrFor(APPLE_THEME.modePlan));
  });

  it('marks a dirty tree in the warning colour', () => {
    const frame = colouredFrame({ gitBranch: 'main', gitStatus: '+2 ~1' });
    expect(runFor('main*', frame)).toBe(sgrFor(APPLE_THEME.warning));
  });
});

describe('StatusLine narrow packing', () => {
  it('packs mode and branch on a narrow row', () => {
    const view = render(
      withTheme(
        <StatusLine
          model="claude-opus-5"
          tokenCount={13_600}
          maxTokens={272_000}
          mode="default"
          taskCount={0}
          activeTaskCount={0}
          gitBranch="main"
          gitStatus="✓"
          terminalWidth={20}
          reducedMotion
        />,
      ),
    );

    expect(stripAnsi(view.lastFrame())).toContain('default');
  });
});
