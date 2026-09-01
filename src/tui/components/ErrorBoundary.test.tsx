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
  exploding = true;
});

let exploding = true;

function Exploding() {
  if (exploding) throw new Error('render blew up');
  return <Text>recovered</Text>;
}

function renderBoundary(options: { resumeCommand?: string; onExit?: () => void } = {}) {
  return render(
    <ThemeContext.Provider value={DEFAULT_THEME}>
      <ErrorBoundary resumeCommand={options.resumeCommand} onExit={options.onExit}>
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
    const view = renderBoundary({ resumeCommand: 'book --resume 0d6f1b2a' });
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

  it('names where the throw came from, because uiLog is off by default', () => {
    // `createUiDebugLogger` is a no-op unless BOOK_DEBUG is set, so on a default
    // run the box is the only artifact a bug report can be built from. Without
    // the origin line it carries a message and nothing else.
    const frame = renderBoundary().lastFrame() ?? '';
    expect(frame).toContain('Exploding');
  });

  it('exits through the host when Ctrl+C is pressed', () => {
    // The app's own handler is still mounted and still holds the state it had
    // when the render blew up, so it swallows Ctrl+C behind a modal guard or
    // spends it on a stream interrupt. Ink runs with exitOnCtrlC disabled and
    // there is no SIGINT handler, so the box has to own its own exit.
    const onExit = vi.fn();
    const view = renderBoundary({ onExit });

    expect(view.lastFrame()).toContain('Ctrl+C to exit');
    view.stdin.write('\u0003');
    expect(onExit).toHaveBeenCalledOnce();
  });

  it('retries the render on R, recovering a transient failure', async () => {
    const view = renderBoundary();
    expect(view.lastFrame()).toContain('Something went wrong');

    exploding = false;
    view.stdin.write('r');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(view.lastFrame()).toContain('recovered');
    expect(view.lastFrame()).not.toContain('Something went wrong');
  });

  it('shows the box again when a retry hits the same failure', () => {
    const view = renderBoundary();
    view.stdin.write('r');
    expect(view.lastFrame()).toContain('Something went wrong');
  });
});
