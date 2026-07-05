import { Component } from 'react';
import { Box, Text } from 'ink';
import { createUiDebugLogger } from '../../debug-log.js';

const uiLog = createUiDebugLogger('tui:errorboundary');

interface ErrorBoundaryProps {
  children: React.ReactNode;
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
    console.warn('TUI render error caught by ErrorBoundary:', error.message);
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
        <Box flexDirection="column" borderStyle="round" borderColor="red" padding={1}>
          <Text bold color="red">
            Something went wrong
          </Text>
          <Text color="gray">{this.state.error?.message ?? 'Unknown error'}</Text>
          <Text color="gray">Restart Book to recover.</Text>
        </Box>
      );
    }

    return this.props.children;
  }
}
