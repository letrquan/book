import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { Text } from 'ink';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { ErrorBoundary } from './ErrorBoundary.js';

afterEach(cleanup);

/**
 * React logs the caught error to `console.error` before the boundary renders.
 * That is expected here, so it is silenced rather than left to look like a
 * failure in the run.
 */
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function Exploding(): never {
  throw new Error('render blew up');
}

function renderBoundary(resumeCommand?: string) {
  return render(
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <ErrorBoundary resumeCommand={resumeCommand}>
        <Exploding />
      </ErrorBoundary>
    </ThemeContext.Provider>,
  );
}

describe('ErrorBoundary', () => {
  it('renders children while nothing has thrown', () => {
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ErrorBoundary>
          <Text>still working</Text>
        </ErrorBoundary>
      </ThemeContext.Provider>,
    );

    expect(view.lastFrame()).toContain('still working');
  });

  it('tells the user their conversation survived and how to reopen it', () => {
    const view = renderBoundary('book --resume 0d6f1b2a');
    const frame = view.lastFrame() ?? '';

    expect(frame).toContain('Something went wrong');
    expect(frame).toContain('render blew up');
    // A crash that only says "restart" leaves the user unable to tell whether an
    // hour of work is gone. The session file is appended synchronously, so this
    // is a promise the store keeps.
    expect(frame).toContain('This conversation is saved');
    expect(frame).toContain('book --resume 0d6f1b2a');
  });

  it('promises nothing when there is no session to reopen', () => {
    const frame = renderBoundary().lastFrame() ?? '';

    expect(frame).toContain('Something went wrong');
    expect(frame).toContain('Restart Book to recover.');
    expect(frame).not.toContain('conversation is saved');
    expect(frame).not.toContain('--resume');
  });

  it('always says how to get out', () => {
    expect(renderBoundary('book --resume abc').lastFrame()).toContain('Press Ctrl+C to exit');
    expect(renderBoundary().lastFrame()).toContain('Press Ctrl+C to exit');
  });
});
