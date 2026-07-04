import { Text, Box } from 'ink';
import { useMemo } from 'react';
import { Spinner } from './Spinner.js';
import { useTheme } from '../theme.js';
import { DiffBlock, isUnifiedDiffLike } from './Diff.js';
import { getPrimaryArg } from '../../tools/primary-arg.js';
import { canonicalToolName } from '../../tools/aliases.js';
import type { ToolResult } from '../../types.js';

interface ToolCallBlockProps {
  name: string;
  args: Record<string, unknown>;
  result?: ToolResult;
  isExpanded: boolean;
  onToggle?: () => void;
  isPending?: boolean;
  agentColor?: string;
  reducedMotion?: boolean;
  /** When true, renders flat text without decorations. */
  screenReader?: boolean;
}

/**
 * Get the status badge for a tool result.
 * Claude Code uses: [OK] (green), [ERR] (red), [SKIPPED] (yellow).
 */
function getResultLabel(result?: ToolResult): { label: string; color: string } {
  if (!result) return { label: '', color: 'gray' };
  if (result.error?.startsWith('SKIPPED')) return { label: '[SKIPPED]', color: 'yellow' };
  if (!result.success) return { label: '[ERR]', color: 'red' };
  return { label: '[OK]', color: 'green' };
}

function isDiffOutput(toolName: string, result: ToolResult | undefined): boolean {
  if (!result?.success || !result.output) return false;
  const diffTools = new Set(['Edit', 'Write', 'MultiEdit']);
  return diffTools.has(canonicalToolName(toolName)) && isUnifiedDiffLike(result.output);
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    Read: 'Read file',
    Write: 'Write file',
    Edit: 'Edit file',
    MultiEdit: 'Edit file',
    Bash: 'Run command',
    Glob: 'Find files',
    Grep: 'Search files',
    WebFetch: 'Fetch URL',
    WebSearch: 'Search web',
    GitStatus: 'Git status',
    GitDiff: 'Git diff',
    GitLog: 'Git log',
    GitCommit: 'Git commit',
    GitBranch: 'Git branch',
    TodoWrite: 'Update todos',
    Task: 'Run subagent',
    InvokeSkill: 'Use skill',
  };
  return labels[name] ?? name.replace(/^mcp__([^_]+)__/, '$1:');
}

/**
 * Claude Code-style tool call block.
 *
 * Each tool call renders as:
 *   ▶ [OK] read_file path/to/file.ts
 * When expanded (▼), shows the full args and result output.
 * While running, shows a spinner instead of [OK]/[ERR].
 * Pending permission shows [needs approval] in yellow.
 */
export function ToolCallBlock({ name, args, result, isExpanded, onToggle, isPending, agentColor, reducedMotion = false, screenReader = false }: ToolCallBlockProps) {
  const theme = useTheme();
  const isRunning = !result && !isPending;
  const canonical = canonicalToolName(name);
  const primaryArg = getPrimaryArg(args);
  const { label, color } = getResultLabel(result);
  const toolColor = agentColor || theme.brand;

  // Screen reader mode: flat text without any decorations, spinners, or box art.
  if (screenReader) {
    return (
      <Box flexDirection="column" marginLeft={2}>
        <Text>
          {isRunning ? '[Running] ' : `${label} `}{toolLabel(canonical)}{primaryArg ? ` ${primaryArg.slice(0, 80)}` : ''}
        </Text>
        {isPending ? (
          <Text>[needs approval]</Text>
        ) : null}
        {isExpanded && result?.output ? (
          <Box flexDirection="column">
            {result.output.split('\n').slice(0, 10).map((line, i) => (
              <Box key={i}>
                <Text>  {line.slice(0, 120)}</Text>
              </Box>
            ))}
          </Box>
        ) : null}
        {isExpanded && result?.error && !result.error.startsWith('SKIPPED') ? (
          <Text color="red">  Error: {result.error.slice(0, 120)}</Text>
        ) : null}
      </Box>
    );
  }

  // Visual mode: Claude Code-style styled blocks with spinners, colors, and toggle icons.

  return (
    <Box flexDirection="column" marginLeft={2}>
      {/* Summary line: toggle + status + tool name + primary arg + duration */}
      <Box>
        <Text color={theme.subtle}>
          {isExpanded ? '▼' : '▶'}{' '}
        </Text>
        {isRunning ? (
          <Spinner active style="dots" reducedMotion={reducedMotion} />
        ) : (
          <Text color={color} bold>{label} </Text>
        )}
        <Text color={toolColor} bold>{toolLabel(canonical)}</Text>
        {primaryArg ? (
          <Text color={theme.subtle}> {primaryArg.slice(0, 80)}</Text>
        ) : null}
        {result?.retryAttempt && result.retryAttempt > 1 ? (
          <Text color={theme.subtle} dimColor> (retried, succeeded on attempt {result.retryAttempt})</Text>
        ) : null}
        {result?.durationMs !== undefined && result.durationMs > 0 ? (
          <Text color={theme.subtle} dimColor>
            {' '}
            {result.durationMs < 1000
              ? `${result.durationMs}ms`
              : `${(result.durationMs / 1000).toFixed(1)}s`}
          </Text>
        ) : null}
      </Box>
      {/* Expanded: show full args */}
      {isExpanded && !isRunning ? (
        <Box marginLeft={4} flexDirection="column">
          {Object.entries(args).map(([key, val]) => {
            const valStr = typeof val === 'string' ? val : JSON.stringify(val);
            return (
              <Box key={key}>
                <Text color={theme.subtle} dimColor>{key}: </Text>
                <Text color={theme.text}>{valStr.slice(0, 120)}</Text>
              </Box>
            );
          })}
        </Box>
      ) : null}
      {/* Expanded: show result output */}
      {isExpanded && result && isDiffOutput(name, result) ? (
        <DiffBlock output={result.output} />
      ) : isExpanded && result?.output ? (
        <OutputBlock output={result.output} theme={theme} />
      ) : null}
      {/* Expanded: show error */}
      {isExpanded && result?.error && !result.error.startsWith('SKIPPED') ? (
        <Box marginLeft={4}>
          <Text color={theme.error}>{'│'} {result.error.slice(0, 120)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function OutputBlock({ output, theme }: { output: string; theme: ReturnType<typeof useTheme> }) {
  const MAX_LINES = 200;
  const lines = useMemo(() => output.split('\n'), [output]);
  const displayLines = lines.slice(0, MAX_LINES);
  const truncated = lines.length > MAX_LINES;

  return (
    <Box marginLeft={4} flexDirection="column">
      {displayLines.map((line, i) => (
        <Box key={i}>
          <Text color={theme.subtle} dimColor>{'│'} </Text>
          <Text color={theme.text}>{line.slice(0, 120)}</Text>
        </Box>
      ))}
      {truncated ? (
        <Box marginLeft={2}>
          <Text color={theme.subtle} dimColor>
            ... ({lines.length - MAX_LINES} more lines, truncated)
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export { isDiffOutput, getResultLabel, toolLabel };
