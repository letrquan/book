import { Component } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { createUiDebugLogger } from '../../debug-log.js';
import { useTheme } from '../theme.js';

const uiLog = createUiDebugLogger('tui:errorboundary');

interface ErrorBoundaryProps {
  children: React.ReactNode;
  /**
   * The command that reopens this conversation, shown so a render crash does not
   * read as lost work. The session file is durable by the time anything can
   * crash — `SessionStore.create` appends the `session_meta` header
   * synchronously at startup and every record after it lands the same way — so
   * for a persisted session this is a promise the store can keep.
   *
   * Left undefined when persistence is off, and when the session holds nothing
   * worth reopening. A resume line that fails, or that reopens an empty
   * conversation, is worse than no resume line at all.
   */
  resumeCommand?: string;
  /**
   * How the host leaves. The fallback has to own this itself: the app's global
   * key handler is still mounted and still holds whatever state it had when the
   * render blew up, so it swallows Ctrl+C whenever a picker was open and turns
   * it into a stream interrupt whenever a turn was in flight. Neither reaches
   * an exit, and Ink runs with `exitOnCtrlC: false` with no SIGINT handler
   * behind it, so nothing else would either.
   */
  onExit?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  /** First frames of the stack, kept for the box — see `componentDidCatch`. */
  origin: string | null;
}

const CLEAR_STATE: ErrorBoundaryState = { hasError: false, error: null, origin: null };

/** Longest stack frame the box will print before it starts costing more than it tells. */
const ORIGIN_WIDTH = 72;

/**
 * The single most useful line of a stack: where the throw came from, and which
 * component was rendering. Node stacks carry absolute paths, which on Windows
 * are long enough to wrap the box on their own, so only the tail of the path
 * survives.
 */
function describeOrigin(error: Error, componentStack?: string | null): string | null {
  const shorten = (line: string) =>
    line.replace(/(?:file:\/\/)?(?:[A-Za-z]:)?[\\/][^\s)]*[\\/]/g, '').trim();
  const component = componentStack
    ?.split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  const frame = error.stack
    ?.split('\n')
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line.startsWith('at '));
  // The component stack usually carries the location too, and for a throw in
  // the component's own body both name the same symbol — so the raw frame is
  // only worth the width when it points somewhere else.
  const symbol = (line?: string) => line?.replace(/^at\s+/, '').split(/[\s(]/)[0] ?? '';
  const best = component ? shorten(component) : frame ? shorten(frame) : '';
  const extra = frame && component && symbol(frame) !== symbol(component) ? shorten(frame) : '';
  const line = [best, extra].filter(Boolean).join(' — ');
  if (!line) return null;
  return line.length > ORIGIN_WIDTH ? `${line.slice(0, ORIGIN_WIDTH - 1)}…` : line;
}

function ErrorReport({
  error,
  origin,
  resumeCommand,
  onExit,
  onRetry,
}: {
  error: Error | null;
  origin: string | null;
  resumeCommand?: string;
  onExit?: () => void;
  onRetry: () => void;
}) {
  const theme = useTheme();
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      (onExit ?? exit)();
      return;
    }
    if (input.toLowerCase() === 'r') onRetry();
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.error} padding={1}>
      <Text bold color={theme.error}>
        Something went wrong
      </Text>
      <Text color={theme.subtle}>{error?.message ?? 'Unknown error'}</Text>
      {origin ? <Text color={theme.subtle}>{origin}</Text> : null}
      {resumeCommand ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.text}>This conversation is saved. Reopen it with:</Text>
          <Text color={theme.brand}>{resumeCommand}</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text color={theme.subtle}>Restart Book to recover.</Text>
        </Box>
      )}
      <Text color={theme.subtle}>Press R to try again, or Ctrl+C to exit.</Text>
    </Box>
  );
}

/**
 * React error boundary for the Ink TUI. Catches render errors in child
 * components and displays a friendly error message instead of crashing
 * the entire terminal UI.
 *
 * The fallback is a component rather than inline JSX so that it can hold the
 * keyboard: once the boundary is showing, it is the only thing on screen, and
 * it has to be able to both leave and retry. Retrying is worth offering because
 * plenty of render throws are transient — one bad message, a momentarily zero
 * width — and the surrounding app has kept running the whole time.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = CLEAR_STATE;
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // No `console.warn` here: it printed `error.message` — already the second
    // line of the box — as raw text over the alternate screen, so a crashing
    // user's first sight was a smeared frame with a duplicated message. Its
    // diagnostic value is replaced rather than dropped. `uiLog` is a no-op
    // unless BOOK_DEBUG is set, so it cannot be the only record; the box itself
    // carries the throw site, which is what a bug report actually needs.
    this.setState({ origin: describeOrigin(error, errorInfo.componentStack) });
    uiLog.warn('caught', {
      name: error.name,
      message: error.message,
      stack: error.stack?.split('\n').slice(0, 3).join(' | '),
      componentStack: errorInfo.componentStack
        ?.split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 6)
        .join(' > '),
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <ErrorReport
          error={this.state.error}
          origin={this.state.origin}
          resumeCommand={this.props.resumeCommand}
          onExit={this.props.onExit}
          onRetry={() => this.setState(CLEAR_STATE)}
        />
      );
    }

    return this.props.children;
  }
}
