import { Component } from 'react';
import { Box, Text } from 'ink';
import { createUiDebugLogger } from '../../debug-log.js';
import { ThemeContext } from '../theme.js';

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
   * Left undefined when persistence is off. There is nothing to reopen then, and
   * a resume line that fails is worse than no resume line at all.
   */
  resumeCommand?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

/**
 * React error boundary for the Ink TUI. Catches render errors in child
 * components and displays a friendly error message instead of crashing
 * the entire terminal UI.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Deliberately no `console.warn` here. It printed `error.message` — the same
    // string the box below already shows — as raw text above the alternate
    // screen, so the first thing a crashing user saw was a smeared frame with a
    // duplicated message. The structured record below keeps the stack and the
    // component stack, which the console line never carried.
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
      const { resumeCommand } = this.props;
      return (
        <ThemeContext.Consumer>
          {(theme) => (
            <Box flexDirection="column" borderStyle="round" borderColor={theme.error} padding={1}>
              <Text bold color={theme.error}>
                Something went wrong
              </Text>
              <Text color={theme.subtle}>{this.state.error?.message ?? 'Unknown error'}</Text>
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
              <Text color={theme.subtle}>Press Ctrl+C to exit.</Text>
            </Box>
          )}
        </ThemeContext.Consumer>
      );
    }

    return this.props.children;
  }
}
