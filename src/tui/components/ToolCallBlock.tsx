import { Text, Box } from 'ink';
import { useMemo } from 'react';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { Spinner } from './Spinner.js';
import { useTheme } from '../theme.js';
import { DiffBlock, isUnifiedDiffLike } from './Diff.js';
import { prepareToolOutputDisplay } from './tool-output.js';
import { truncateDisplay } from './word-wrap.js';
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
  /** When true, expanded tool results show the larger output cap instead of a short preview. */
  showAllToolOutput?: boolean;
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

function getDiffStats(output?: string): { added: number; removed: number } {
  if (!output) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  const lines = output.split('\n');
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed++;
    }
  }
  return { added, removed };
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
export function ToolCallBlock({ name, args, result, isExpanded, onToggle, isPending, agentColor, reducedMotion = false, screenReader = false, showAllToolOutput = false }: ToolCallBlockProps) {
  const theme = useTheme();
  const isRunning = !result && !isPending;
  const canonical = canonicalToolName(name);
  const primaryArg = getPrimaryArg(args);
  const { label, color } = getResultLabel(result);
  const toolColor = agentColor || theme.brand;

  const isFileModifying = canonical === 'Write' || canonical === 'Edit' || canonical === 'MultiEdit';
  const filePathStr = (args.filePath as string) || '';

  const checkIsCreate = () => {
    if (canonical === 'Edit' || canonical === 'MultiEdit') return false;
    if (result && result.isCreate !== undefined) return result.isCreate;
    if (!filePathStr) return false;
    try {
      return !existsSync(resolve(filePathStr));
    } catch {
      return false;
    }
  };
  const isCreate = checkIsCreate();
  const actionName = isCreate ? 'Create' : 'Update';

  // Screen reader mode: flat text without any decorations, spinners, or box art.
  if (screenReader) {
    if (isFileModifying) {
      const statusText = isRunning
        ? 'running'
        : isPending
        ? 'needs approval'
        : result?.success
        ? 'succeeded'
        : 'failed';
      const stats = result?.success ? getDiffStats(result.output) : { added: 0, removed: 0 };
      const statsText = result?.success
        ? stats.added > 0 && stats.removed > 0
          ? `, Added ${stats.added} line${stats.added > 1 ? 's' : ''}, removed ${stats.removed} line${stats.removed > 1 ? 's' : ''}`
          : stats.added > 0
          ? `, Added ${stats.added} line${stats.added > 1 ? 's' : ''}`
          : stats.removed > 0
          ? `, Removed ${stats.removed} line${stats.removed > 1 ? 's' : ''}`
          : ''
        : '';
      return (
        <Box flexDirection="column" marginLeft={2}>
          <Text>
            {actionName}({filePathStr}) {statusText}{statsText}
          </Text>
          {result?.error ? <Text>  Error: {result.error}</Text> : null}
          {isExpanded && result?.success && result.output ? (
            <Box flexDirection="column">
              {result.output.split('\n').map((line, i) => (
                <Box key={i}>
                  <Text>  {line}</Text>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      );
    }

    const srOutput = result?.output
      ? prepareToolOutputDisplay(result.output, {
          maxLines: showAllToolOutput ? 200 : 10,
          maxLineWidth: 120,
          hint: showAllToolOutput ? undefined : 'Ctrl+E shows more',
        })
      : undefined;

    return (
      <Box flexDirection="column" marginLeft={2}>
        <Text>
          {isRunning ? '[Running] ' : `${label} `}{toolLabel(canonical)}{primaryArg ? ` ${truncateDisplay(primaryArg, 80)}` : ''}
        </Text>
        {isPending ? (
          <Text>[needs approval]</Text>
        ) : null}
        {isExpanded && srOutput ? (
          <Box flexDirection="column">
            {srOutput.lines.map((line, i) => (
              <Box key={i}>
                <Text>  {line}</Text>
              </Box>
            ))}
            {srOutput.footer ? <Text>  {srOutput.footer}</Text> : null}
          </Box>
        ) : null}
        {isExpanded && result?.error && !result.error.startsWith('SKIPPED') ? (
          <Text color="red">  Error: {truncateDisplay(result.error, 120)}</Text>
        ) : null}
      </Box>
    );
  }

  // Visual mode: Claude Code-style styled blocks with spinners, colors, and toggle icons.

  if (isFileModifying) {
    let bulletColor = theme.subtle;
    if (result) {
      bulletColor = result.success ? theme.success : theme.error;
    } else {
      bulletColor = theme.warning;
    }
    const bulletSymbol = isRunning || isPending ? '○' : '●';

    const stats = result?.success ? getDiffStats(result.output) : { added: 0, removed: 0 };
    const showStats = result?.success && (stats.added > 0 || stats.removed > 0);

    return (
      <Box flexDirection="column" marginLeft={2}>
        {/* Summary line: toggle + status + action name + filePath */}
        <Box>
          <Text color={theme.subtle}>
            {isExpanded ? '▼' : '▶'}{' '}
          </Text>
          <Text color={bulletColor} bold>{bulletSymbol} </Text>
          <Text color={theme.text} bold>{actionName}({filePathStr})</Text>
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

        {/* Stats or error line */}
        {result ? (
          !result.success ? (
            <Box marginLeft={4}>
              <Text color={theme.error}>{result.error || 'Error editing file'}</Text>
            </Box>
          ) : showStats ? (
            <Box marginLeft={4}>
              <Text color={theme.subtle}>
                {stats.added > 0 && stats.removed > 0
                  ? `Added ${stats.added} line${stats.added > 1 ? 's' : ''}, removed ${stats.removed} line${stats.removed > 1 ? 's' : ''}`
                  : stats.added > 0
                  ? `Added ${stats.added} line${stats.added > 1 ? 's' : ''}`
                  : `Removed ${stats.removed} line${stats.removed > 1 ? 's' : ''}`}
              </Text>
            </Box>
          ) : null
        ) : isPending ? (
          <Box marginLeft={4}>
            <Text color={theme.warning}>[needs approval]</Text>
          </Box>
        ) : null}

        {/* Expanded: show diff block */}
        {isExpanded && result?.success && isDiffOutput(name, result) ? (
          <DiffBlock output={result.output} collapsed={!showAllToolOutput} />
        ) : null}
      </Box>
    );
  }

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
          <Text color={theme.subtle}> {truncateDisplay(primaryArg, 80)}</Text>
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
                <Text color={theme.text}>{truncateDisplay(valStr, 120)}</Text>
              </Box>
            );
          })}
        </Box>
      ) : null}
      {/* Expanded: show result output */}
      {isExpanded && result && isDiffOutput(name, result) ? (
        <DiffBlock output={result.output} collapsed={!showAllToolOutput} />
      ) : isExpanded && result?.output ? (
        <OutputBlock output={result.output} theme={theme} showAllToolOutput={showAllToolOutput} />
      ) : null}
      {/* Expanded: show error */}
      {isExpanded && result?.error && !result.error.startsWith('SKIPPED') ? (
        <Box marginLeft={4}>
          <Text color={theme.error}>{'│'} {truncateDisplay(result.error, 120)}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

function OutputBlock({
  output,
  theme,
  showAllToolOutput,
}: {
  output: string;
  theme: ReturnType<typeof useTheme>;
  showAllToolOutput: boolean;
}) {
  const display = useMemo(
    () => prepareToolOutputDisplay(output, {
      maxLines: showAllToolOutput ? 200 : 5,
      maxLineWidth: 120,
      hint: showAllToolOutput ? undefined : 'Ctrl+E shows all',
    }),
    [output, showAllToolOutput],
  );

  return (
    <Box marginLeft={4} flexDirection="column">
      {display.lines.map((line, i) => (
        <Box key={i}>
          <Text color={theme.subtle} dimColor>{'│'} </Text>
          <Text color={theme.text}>{line}</Text>
        </Box>
      ))}
      {display.footer ? (
        <Box>
          <Text color={theme.subtle} dimColor>{'│'} {display.footer}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export { isDiffOutput, getResultLabel, toolLabel };
