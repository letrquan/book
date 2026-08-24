import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
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
  it('uses the product default 272k fallback budget', () => {
    const view = render(
      withTheme(
        <StatusLine
          model="gpt-4o"
          tokenCount={136_000}
          mode="default"
          taskCount={0}
          activeTaskCount={0}
          terminalWidth={100}
          reducedMotion
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('ctx 50%');
  });

  it('renders full status on wide terminals', () => {
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
    expect(output).toContain('ctx 9%');
    expect(output).toContain('default');
    expect(output).toContain('tasks 1/3');
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

  it('folds context warning into compact status', () => {
    const view = render(
      withTheme(
        <StatusLine
          model="model"
          tokenCount={124_000}
          maxTokens={128_000}
          mode="plan"
          taskCount={0}
          activeTaskCount={0}
          terminalWidth={44}
          compact
          reducedMotion
        />,
      ),
    );

    const output = stripAnsi(view.lastFrame());
    expect(output).toContain('ctx 97%');
    expect(output).not.toContain('Context nearly full');
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
