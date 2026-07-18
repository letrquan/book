import { Text, Box } from 'ink';
import React, { useMemo } from 'react';
import { Spinner } from './Spinner.js';
import { useTheme } from '../theme.js';
import { DiffBlock } from './Diff.js';
import { MarkdownBlock } from './MarkdownBlock.js';
import { highlightCode } from './syntax-highlight.js';
import { prepareToolOutputDisplay } from './tool-output.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';
import { getPrimaryArg } from '../../tools/primary-arg.js';
import { canonicalToolName } from '../../tools/aliases.js';
import { isFileMutatingTool } from '../../tools/tool-capabilities.js';
import { isRenderableFileMutationDiff } from '../file-mutation-display.js';
import type { ToolResult } from '../../types.js';

interface ToolCallBlockProps {
  name: string;
  args: Record<string, unknown>;
  result?: ToolResult;
  isExpanded: boolean;
  isPending?: boolean;
  agentColor?: string;
  reducedMotion?: boolean;
  /** When true, renders flat text without decorations. */
  screenReader?: boolean;
  /** When true, expanded tool results show the larger output cap instead of a short preview. */
  showAllToolOutput?: boolean;
  /** Available terminal width, including this block's outer indentation. */
  terminalWidth?: number;
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
  return isRenderableFileMutationDiff(toolName, result);
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    Read: 'Read file',
    Write: 'Write file',
    Edit: 'Edit file',
    MultiEdit: 'Edit file',
    NotebookEdit: 'Edit notebook',
    Bash: 'Run command',
    BashOutput: 'Read shell output',
    KillShell: 'Kill shell',
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

function getDiffStats(output?: string): { addedLines: number; removedLines: number } {
  if (!output) return { addedLines: 0, removedLines: 0 };
  let addedLines = 0;
  let removedLines = 0;
  const lines = output.split('\n');
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLines++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removedLines++;
    }
  }
  return { addedLines, removedLines };
}

function formatFileMutationStats(addedLines: number, removedLines: number): string | undefined {
  const parts: string[] = [];
  if (addedLines > 0) {
    parts.push(`Added ${addedLines} ${addedLines === 1 ? 'line' : 'lines'}`);
  }
  if (removedLines > 0) {
    const label = `removed ${removedLines} ${removedLines === 1 ? 'line' : 'lines'}`;
    parts.push(parts.length === 0 ? label[0].toUpperCase() + label.slice(1) : label);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function formatCompactFileMutationStats(
  addedLines: number,
  removedLines: number,
): string | undefined {
  const parts: string[] = [];
  if (addedLines > 0) parts.push(`+${addedLines}`);
  if (removedLines > 0) parts.push(`-${removedLines}`);
  return parts.length > 0 ? parts.join(' ') : undefined;
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
function ToolCallBlockInner({
  name,
  args,
  result,
  isExpanded,
  isPending,
  agentColor,
  reducedMotion = false,
  screenReader = false,
  showAllToolOutput = false,
  terminalWidth = 120,
}: ToolCallBlockProps) {
  const theme = useTheme();
  const blockWidth = Math.max(12, Math.floor(terminalWidth) - 2);
  const detailWidth = Math.max(8, blockWidth - 6);
  const summaryWidth = Math.max(8, blockWidth - 4);
  const isRunning = !result && !isPending;
  const canonical = canonicalToolName(name);
  const primaryArg = getPrimaryArg(args);
  const { label, color } = getResultLabel(result);
  const toolColor = agentColor || theme.brand;

  const isFileModifying = isFileMutatingTool(canonical);
  const statusPrefix = isRunning ? '▶ ◌ ' : `▶ ${label} `;
  const primaryArgWidth = Math.max(
    4,
    blockWidth - displayWidth(statusPrefix) - displayWidth(toolLabel(canonical)) - 1,
  );
  const fileMutation = result?.fileMutation;
  const filePathStr = fileMutation?.filePath || primaryArg;
  const actionName = fileMutation?.kind === 'create' || result?.isCreate ? 'Create' : 'Update';

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
      const stats = result?.success
        ? (fileMutation ?? getDiffStats(result.output))
        : { addedLines: 0, removedLines: 0 };
      const statsLabel = result?.success
        ? formatFileMutationStats(stats.addedLines, stats.removedLines)
        : undefined;
      const statsText = statsLabel ? `, ${statsLabel}` : '';
      return (
        <Box flexDirection="column" marginLeft={2}>
          <Text>
            {truncateDisplay(`${actionName}(${filePathStr}) ${statusText}${statsText}`, blockWidth)}
          </Text>
          {result?.error ? <Text> Error: {result.error}</Text> : null}
          {isExpanded && result?.success && result.output
            ? (() => {
                const display = prepareToolOutputDisplay(result.output, {
                  maxLines: showAllToolOutput ? 200 : 5,
                  maxLineWidth: detailWidth,
                  hint: showAllToolOutput ? undefined : 'Ctrl+E shows all',
                });
                return (
                  <Box flexDirection="column">
                    {display.lines.map((line, i) => (
                      <Box key={i}>
                        <Text> {line}</Text>
                      </Box>
                    ))}
                    {display.footer ? <Text> {display.footer}</Text> : null}
                  </Box>
                );
              })()
            : null}
        </Box>
      );
    }

    const srOutput = result?.output
      ? prepareToolOutputDisplay(result.output, {
          maxLines: showAllToolOutput ? 200 : 10,
          maxLineWidth: detailWidth,
          hint: showAllToolOutput ? undefined : 'Ctrl+E shows more',
        })
      : undefined;

    return (
      <Box flexDirection="column" marginLeft={2}>
        <Text>
          {isRunning ? '[Running] ' : `${label} `}
          {toolLabel(canonical)}
          {primaryArg ? ` ${truncateDisplay(primaryArg, summaryWidth)}` : ''}
        </Text>
        {isPending ? <Text>[needs approval]</Text> : null}
        {isExpanded && srOutput ? (
          <Box flexDirection="column">
            {srOutput.lines.map((line, i) => (
              <Box key={i}>
                <Text> {line}</Text>
              </Box>
            ))}
            {srOutput.footer ? <Text> {srOutput.footer}</Text> : null}
          </Box>
        ) : null}
        {isExpanded && result?.error && !result.error.startsWith('SKIPPED') ? (
          <Text color="red"> Error: {truncateDisplay(result.error, detailWidth)}</Text>
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

    const stats = result?.success
      ? (fileMutation ?? getDiffStats(result.output))
      : { addedLines: 0, removedLines: 0 };
    const statsLabel = formatFileMutationStats(stats.addedLines, stats.removedLines);
    const compactStatsLabel = formatCompactFileMutationStats(stats.addedLines, stats.removedLines);
    const showStats = result?.success && Boolean(statsLabel);
    const durationLabel =
      result?.durationMs !== undefined && result.durationMs > 0
        ? result.durationMs < 1000
          ? `${result.durationMs}ms`
          : `${(result.durationMs / 1000).toFixed(1)}s`
        : undefined;
    const retryLabel =
      result?.retryAttempt && result.retryAttempt > 1 ? `retry ${result.retryAttempt}` : undefined;
    const baseSummary = `${actionName}(${filePathStr})`;
    const alwaysMetadata = [retryLabel, durationLabel].filter(Boolean).join(' ');
    const candidateMetadata = [compactStatsLabel, retryLabel, durationLabel]
      .filter(Boolean)
      .join(' ');
    const showInlineStats =
      showStats &&
      Boolean(compactStatsLabel) &&
      displayWidth(`${baseSummary} ${candidateMetadata}`) <= summaryWidth;
    const summaryMetadata = showInlineStats ? candidateMetadata : alwaysMetadata;
    const baseWidth = Math.max(
      4,
      summaryWidth - (summaryMetadata ? displayWidth(summaryMetadata) + 1 : 0),
    );

    return (
      <Box flexDirection="column" marginLeft={2}>
        {/* Summary line: toggle + status + action name + filePath */}
        <Box>
          <Text color={theme.subtle}>{isExpanded ? '▼' : '▶'} </Text>
          <Text color={bulletColor} bold>
            {bulletSymbol}{' '}
          </Text>
          <Text color={theme.text} bold>
            {truncateDisplay(baseSummary, baseWidth)}
          </Text>
          {summaryMetadata ? (
            <Text color={theme.subtle} dimColor>
              {' '}
              {summaryMetadata}
            </Text>
          ) : null}
        </Box>

        {/* Stats or error line */}
        {result ? (
          !result.success ? (
            <Box marginLeft={2}>
              <Text color={theme.error}>{result.error || 'Error editing file'}</Text>
            </Box>
          ) : showStats && !showInlineStats ? (
            <Box marginLeft={2}>
              <Text color={theme.subtle}>{truncateDisplay(statsLabel ?? '', detailWidth)}</Text>
            </Box>
          ) : null
        ) : isPending ? (
          <Box marginLeft={2}>
            <Text color={theme.warning}>[needs approval]</Text>
          </Box>
        ) : null}

        {/* Expanded: show diff block */}
        {isExpanded && result?.success && isDiffOutput(name, result) ? (
          <DiffBlock
            output={result.output}
            collapsed={!showAllToolOutput}
            terminalWidth={blockWidth}
          />
        ) : null}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginLeft={2}>
      {/* Summary line: toggle + status + tool name + primary arg + duration */}
      <Box>
        <Text color={theme.subtle}>{isExpanded ? '▼' : '▶'} </Text>
        {isRunning ? (
          <Spinner active style="dots" reducedMotion={reducedMotion} />
        ) : (
          <Text color={color} bold>
            {label}{' '}
          </Text>
        )}
        <Text color={toolColor} bold>
          {toolLabel(canonical)}
        </Text>
        {primaryArg ? (
          <Text color={theme.subtle}> {truncateDisplay(primaryArg, primaryArgWidth)}</Text>
        ) : null}
        {result?.retryAttempt && result.retryAttempt > 1 ? (
          <Text color={theme.subtle} dimColor>
            {' '}
            (retried, succeeded on attempt {result.retryAttempt})
          </Text>
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
        <Box marginLeft={2} flexDirection="column">
          {Object.entries(args).map(([key, val]) => {
            const valStr = typeof val === 'string' ? val : JSON.stringify(val);
            const valueWidth = Math.max(4, detailWidth - displayWidth(`${key}: `));
            return (
              <Box key={key}>
                <Text color={theme.subtle} dimColor>
                  {key}:{' '}
                </Text>
                <Text color={theme.text}>{truncateDisplay(valStr, valueWidth)}</Text>
              </Box>
            );
          })}
        </Box>
      ) : null}
      {/* Expanded: show result output */}
      {isExpanded && result && isDiffOutput(name, result) ? (
        <DiffBlock
          output={result.output}
          collapsed={!showAllToolOutput}
          terminalWidth={blockWidth}
        />
      ) : isExpanded && result?.output ? (
        <OutputBlock
          output={result.output}
          theme={theme}
          showAllToolOutput={showAllToolOutput}
          toolName={canonical}
          terminalWidth={blockWidth}
        />
      ) : null}
      {/* Expanded: show error */}
      {isExpanded && result?.error && !result.error.startsWith('SKIPPED') ? (
        <Box marginLeft={2}>
          <Text color={theme.error}>
            {'│'} {truncateDisplay(result.error, detailWidth)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export const ToolCallBlock = React.memo(ToolCallBlockInner);

function looksLikeMarkdown(output: string, toolName: string): boolean {
  if (toolName === 'WebFetch' || toolName === 'WebSearch') return true;
  return /(^|\n)\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```|\|.+\|)/.test(output);
}

function inferLanguage(output: string, toolName: string): string | undefined {
  if (toolName !== 'Read') return undefined;
  const firstLine = output.split('\n', 1)[0] ?? '';
  const match = firstLine.match(/\.(ts|tsx|js|jsx|json|py|rs|go|sh|bash|yml|yaml|css|html|sql)\b/i);
  return match?.[1]?.toLowerCase();
}

function OutputBlock({
  output,
  theme,
  showAllToolOutput,
  toolName,
  terminalWidth,
}: {
  output: string;
  theme: ReturnType<typeof useTheme>;
  showAllToolOutput: boolean;
  toolName: string;
  terminalWidth: number;
}) {
  // A two-column indent plus the border/padding rail live inside the budget.
  const contentWidth = Math.max(8, Math.floor(terminalWidth) - 4);
  const footerWidth = contentWidth;
  const display = useMemo(
    () =>
      prepareToolOutputDisplay(output, {
        maxLines: showAllToolOutput ? 200 : 5,
        maxLineWidth: contentWidth,
        hint: showAllToolOutput ? undefined : 'Ctrl+E shows all',
      }),
    [contentWidth, output, showAllToolOutput],
  );
  const language = inferLanguage(output, toolName);
  const displayText = display.lines.join('\n');
  const highlighted = useMemo(
    () => (language ? highlightCode(displayText, language, theme) : undefined),
    [displayText, language, theme],
  );

  if (looksLikeMarkdown(output, toolName) && !language) {
    return (
      <Box
        marginLeft={2}
        flexDirection="column"
        borderLeft
        borderLeftColor={theme.subtle}
        paddingLeft={1}
      >
        <MarkdownBlock content={display.lines.join('\n')} terminalWidth={contentWidth} />
        {display.footer ? (
          <Text color={theme.subtle} dimColor>
            {truncateDisplay(display.footer, footerWidth)}
          </Text>
        ) : null}
      </Box>
    );
  }

  return (
    <Box
      marginLeft={2}
      flexDirection="column"
      borderLeft
      borderLeftColor={theme.subtle}
      paddingLeft={1}
    >
      {display.lines.map((line, i) => (
        <Box key={i}>
          {highlighted ? (
            <Text>
              {highlighted[i]?.map((segment, si) => (
                <Text
                  key={si}
                  color={segment.color}
                  bold={segment.bold}
                  italic={segment.italic}
                  dimColor={segment.dimColor}
                >
                  {segment.text}
                </Text>
              ))}
            </Text>
          ) : (
            <Text color={theme.text}>{line}</Text>
          )}
        </Box>
      ))}
      {display.footer ? (
        <Box>
          <Text color={theme.subtle} dimColor>
            {truncateDisplay(display.footer, footerWidth)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export { isDiffOutput, getResultLabel, toolLabel };
