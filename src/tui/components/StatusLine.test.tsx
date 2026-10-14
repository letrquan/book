import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import chalk from 'chalk';
import { APPLE_THEME, DEFAULT_THEME, ThemeContext } from '../theme.js';
import { buildColoredSegments, romanFolio, StatusLine } from './StatusLine.js';
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
  it('shows the effort beside the model, so a change needs no announcement', () => {
    const view = render(
      withTheme(
        <StatusLine
          model="9router/oc/muse-spark"
          effort="high"
          mode="default"
          taskCount={0}
          activeTaskCount={0}
          terminalWidth={100}
        />,
      ),
    );
    expect(stripAnsi(view.lastFrame())).toMatch(/muse-spark {2}· {2}high effort/);
  });

  it('leaves the effort out for a model that takes none', () => {
    const view = render(
      withTheme(
        <StatusLine
          model="gpt-4o"
          mode="default"
          taskCount={0}
          activeTaskCount={0}
          terminalWidth={100}
        />,
      ),
    );
    expect(stripAnsi(view.lastFrame())).not.toContain('effort');
  });

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

  it('sets the plan’s step at the right edge, before the folio', () => {
    const view = render(
      withTheme(
        <StatusLine
          model="gpt-4o"
          mode="default"
          taskCount={0}
          activeTaskCount={0}
          turnCount={4}
          stepLabel="step 3/7"
          terminalWidth={100}
        />,
      ),
    );
    expect(stripAnsi(view.lastFrame())).toMatch(/step 3\/7 {3}iv\s*$/m);
  });

  it('gives up the folio before the step on a narrow row', () => {
    const view = render(
      withTheme(
        <StatusLine
          model="gpt-4o"
          mode="default"
          taskCount={0}
          activeTaskCount={0}
          turnCount={4}
          stepLabel="step 3/7"
          terminalWidth={50}
        />,
      ),
    );
    const frame = stripAnsi(view.lastFrame());
    expect(frame).toMatch(/step 3\/7\s*$/m);
    expect(frame).not.toMatch(/\biv\s*$/m);
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

  it('marks a dirty tree with an asterisk, not the warning colour', () => {
    // A dirty tree is the normal state of a working copy, not an alarm; the
    // warning hue beside a non-default mode read as two alerts at once.
    const frame = colouredFrame({ gitBranch: 'main', gitStatus: '+2 ~1' });
    expect(runFor('main*', frame)).toBe(sgrFor(APPLE_THEME.subtle));
  });

  it('draws an active goal in the brand colour', () => {
    const frame = colouredFrame({ goalSetAt: Date.now() });
    expect(runFor('/goal active', frame)).toBe(sgrFor(APPLE_THEME.brand));
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

describe('StatusLine folio', () => {
  it('numbers pages the way front matter does', () => {
    expect(romanFolio(0)).toBe('');
    expect(romanFolio(1)).toBe('i');
    expect(romanFolio(4)).toBe('iv');
    expect(romanFolio(9)).toBe('ix');
    expect(romanFolio(14)).toBe('xiv');
    expect(romanFolio(49)).toBe('xlix');
    expect(romanFolio(1994)).toBe('mcmxciv');
  });

  const folioRow = (turnCount: number, terminalWidth: number) => {
    const view = render(
      withTheme(
        <StatusLine
          model="claude-opus-5"
          mode="default"
          taskCount={0}
          activeTaskCount={0}
          gitBranch="main"
          gitStatus="✓"
          turnCount={turnCount}
          terminalWidth={terminalWidth}
          reducedMotion
        />,
      ),
    );
    return stripAnsi(view.lastFrame());
  };

  it('sets the folio at the right edge of the row', () => {
    const row = folioRow(3, 80);
    expect(row.trimEnd().endsWith(' iii')).toBe(true);
    // The row keeps the terminal's last column empty, like every other row.
    expect(displayWidth(row.trimEnd())).toBe(79);
  });

  it('leaves the folio out before the first turn and on a narrow row', () => {
    expect(folioRow(0, 80)).not.toMatch(/ i+$/);
    expect(folioRow(3, 36)).not.toContain('iii');
  });
});

describe('StatusLine goal chip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
  });

  // Unmount while the fake clock is still installed, so the timer cleanup under test
  // runs against the timers that were actually set.
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function row(goalSetAt: number | undefined, terminalWidth = 100): React.ReactElement {
    return withTheme(
      <StatusLine
        model="claude-opus-5"
        mode="default"
        taskCount={0}
        activeTaskCount={0}
        terminalWidth={terminalWidth}
        goalSetAt={goalSetAt}
        reducedMotion
      />,
    );
  }

  const frameOf = (view: ReturnType<typeof render>): string => stripAnsi(view.lastFrame());

  // One act per advance: updates inside an act are batched, so a single large advance
  // paints once however many ticks it crossed.
  function elapse(ms: number): void {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  it('shows no chip, and sets no timer, without a goal', () => {
    const view = render(row(undefined));

    expect(frameOf(view)).not.toContain('/goal');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('names the goal right after the permission mode, with no duration yet', () => {
    const view = render(row(Date.now()));

    expect(frameOf(view)).toMatch(/◆ default {2}· {2}◎ \/goal active {2}· {2}claude-opus-5/);
    expect(frameOf(view)).not.toContain('(');
  });

  it('shows no duration for a goal under a second old, however it rounds', () => {
    expect(frameOf(render(row(Date.now() - 999)))).not.toContain('(');
  });

  it('counts whole seconds', () => {
    const view = render(row(Date.now()));

    elapse(1_000);
    expect(frameOf(view)).toContain('◎ /goal active (1s)');
    elapse(1_000);
    expect(frameOf(view)).toContain('◎ /goal active (2s)');
    elapse(43_000);
    expect(frameOf(view)).toContain('◎ /goal active (45s)');
  });

  it('counts whole minutes once a minute has passed', () => {
    const view = render(row(Date.now()));

    elapse(59_000);
    expect(frameOf(view)).toContain('(59s)');
    elapse(2_000);
    expect(frameOf(view)).toContain('(1m)');
    elapse(29_000);
    expect(frameOf(view)).toContain('(1m)');
    elapse(30_000);
    expect(frameOf(view)).toContain('(2m)');
  });

  it('reads hours the way the goal result does', () => {
    expect(frameOf(render(row(Date.now() - 72 * 60_000)))).toContain('(1h 12m)');
  });

  it('repaints once a second for the first minute', () => {
    const view = render(row(Date.now()));
    const before = view.frames.length;

    for (let second = 0; second < 5; second++) elapse(1_000);

    expect(view.frames.length - before).toBe(5);
  });

  it('repaints once a minute after the first, and only on the minute', () => {
    const view = render(row(Date.now()));
    elapse(60_000);
    const before = view.frames.length;

    elapse(59_999);
    expect(view.frames.length).toBe(before);
    elapse(1);
    expect(view.frames.length).toBe(before + 1);
    expect(frameOf(view)).toContain('(2m)');
  });

  it('waits out the rest of the second a goal is part way through', () => {
    const view = render(row(Date.now() - 1_400));
    expect(frameOf(view)).toContain('(1s)');
    const before = view.frames.length;

    elapse(599);
    expect(view.frames.length).toBe(before);
    elapse(1);
    expect(frameOf(view)).toContain('(2s)');
  });

  it('waits out the rest of the minute a goal is part way through', () => {
    // A goal resumed from an earlier session keeps its original start, so it can be
    // minutes old on the first paint and must tick on the minute, not a minute from now.
    const view = render(row(Date.now() - 4 * 60_000 - 30_000));
    expect(frameOf(view)).toContain('(4m)');
    const before = view.frames.length;

    elapse(29_999);
    expect(view.frames.length).toBe(before);
    elapse(1);
    expect(frameOf(view)).toContain('(5m)');
  });

  it('does not run a goal dated ahead of the clock backwards', () => {
    const view = render(row(Date.now() + 5_000));

    expect(frameOf(view)).toContain('◎ /goal active');
    expect(frameOf(view)).not.toContain('(');
    elapse(6_000);
    expect(frameOf(view)).toContain('(1s)');
  });

  it('keeps the chip on a row too narrow for the model', () => {
    // 44 columns leave 41 for the row: the mode and the model fit, the chip makes it three.
    expect(frameOf(render(row(undefined, 44)))).toContain('claude-opus-5');

    const narrow = frameOf(render(row(Date.now(), 44)));
    expect(narrow).toContain('◎ /goal active');
    expect(narrow).not.toContain('claude-opus-5');
    expect(displayWidth(narrow.split('\n')[0] ?? '')).toBeLessThanOrEqual(44);
  });

  it('stops its timer when the goal goes away', () => {
    const view = render(row(Date.now()));
    expect(vi.getTimerCount()).toBe(1);

    view.rerender(row(undefined));
    expect(frameOf(view)).not.toContain('/goal');
    expect(vi.getTimerCount()).toBe(0);

    const before = view.frames.length;
    elapse(10 * 60_000);
    expect(view.frames.length).toBe(before);
  });

  it('stops its timer on unmount', async () => {
    const view = render(row(Date.now()));
    expect(vi.getTimerCount()).toBe(1);

    view.unmount();
    // Ink queues a `setImmediate` of its own to settle an unmount. Let it run: the goal
    // timer is not due for a second, so a leaked one would still be counted.
    await vi.advanceTimersByTimeAsync(0);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('starts over for a new goal, leaving no second timer behind', () => {
    const view = render(row(Date.now()));
    elapse(30_000);
    expect(frameOf(view)).toContain('(30s)');

    view.rerender(row(Date.now()));
    expect(frameOf(view)).not.toContain('(');
    expect(vi.getTimerCount()).toBe(1);
    elapse(3_000);
    expect(frameOf(view)).toContain('(3s)');
  });
});
