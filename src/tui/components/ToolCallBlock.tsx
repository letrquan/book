import { Text, Box, type DOMElement } from 'ink';
import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Spinner } from './Spinner.js';
import { useTheme } from '../theme.js';
import { DiffBlock } from './Diff.js';
import { MarkdownBlock } from './MarkdownBlock.js';
import { highlightCode } from './syntax-highlight.js';
import { prepareToolOutputDisplay } from './tool-output.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';
import { isRenderableFileMutationDiff } from '../file-mutation-display.js';
import {
  deriveToolPresentation,
  formatDuration,
  type ToolPresentationStatus,
} from '../tool-presentation.js';
import { useToolRowInteractionRegistry } from './tool-row-interactions.js';
import type { ToolResult } from '../../types.js';

interface ToolCallBlockProps {
  toolId?: string;
  name: string;
  args: Record<string, unknown>;
  result?: ToolResult;
  isExpanded: boolean;
  isPending?: boolean;
  nestedActivityCount?: number;
  agentColor?: string;
  reducedMotion?: boolean;
  /** When true, renders flat, complete text without decorations. */
  screenReader?: boolean;
  /** When true, expanded tool results show the large rendering ceiling. */
  showAllToolOutput?: boolean;
  /** Available terminal width, including this block's outer indentation. */
  terminalWidth?: number;
}

/** Compatibility export used by existing consumers and tests. */
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
    Task: 'Run subagent',
    InvokeSkill: 'Use skill',
  };
  return labels[name] ?? name;
}

function statusColor(status: ToolPresentationStatus, theme: ReturnType<typeof useTheme>): string {
  if (status === 'success') return theme.success;
  if (status === 'failure') return theme.error;
  if (status === 'skipped' || status === 'pending') return theme.warning;
  return theme.brand;
}

function statusSymbol(status: ToolPresentationStatus): string {
  if (status === 'success') return '✓';
  if (status === 'failure') return '×';
  if (status === 'skipped') return '–';
  if (status === 'pending') return '?';
  return '◌';
}

function stringifyArg(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function useRunningElapsed(isRunning: boolean): number {
  const startedAtRef = useRef(Date.now());
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (!isRunning) return;
    const update = () => setElapsedMs(Date.now() - startedAtRef.current);
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [isRunning]);

  return elapsedMs;
}

function ScreenReaderTool({
  presentation,
  args,
  result,
}: {
  presentation: ReturnType<typeof deriveToolPresentation>;
  args: Record<string, unknown>;
  result?: ToolResult;
}) {
  const status =
    presentation.status === 'running'
      ? '[Running]'
      : presentation.status === 'pending'
        ? '[needs approval]'
        : presentation.status === 'success'
          ? '[OK]'
          : presentation.status === 'skipped'
            ? '[SKIPPED]'
            : '[ERR]';
  const accessibleSummary =
    presentation.previewType === 'diff' || presentation.canonicalName.startsWith('mcp__')
      ? presentation.summary
      : `${toolLabel(presentation.canonicalName)}${presentation.target ? ` ${presentation.target}` : ''}${
          presentation.metadata.length > 0 ? ` · ${presentation.metadata.join(' ')}` : ''
        }`;
  return (
    <Box flexDirection="column">
      <Text>
        {status} {accessibleSummary}
      </Text>
      {(presentation.showArguments ? Object.entries(args) : []).map(([key, value]) => (
        <Text key={key}>
          {key}: {stringifyArg(value)}
        </Text>
      ))}
      {result?.output ? <Text>{result.output}</Text> : null}
      {result?.error && !result.error.startsWith('SKIPPED') ? (
        <Text>Error: {result.error}</Text>
      ) : null}
    </Box>
  );
}

function ToolCallBlockInner({
  toolId,
  name,
  args,
  result,
  isExpanded,
  isPending = false,
  nestedActivityCount = 0,
  agentColor,
  reducedMotion = false,
  screenReader = false,
  showAllToolOutput = false,
  terminalWidth = 80,
}: ToolCallBlockProps) {
  const theme = useTheme();
  const registry = useToolRowInteractionRegistry();
  const summaryRef = useRef<DOMElement>(null);
  const blockWidth = Math.max(12, Math.floor(terminalWidth) - 2);
  const detailWidth = Math.max(8, blockWidth - 6);
  const presentation = useMemo(
    () => deriveToolPresentation(name, args, result, { isPending, nestedActivityCount }),
    [args, isPending, name, nestedActivityCount, result],
  );
  const isRunning = presentation.status === 'running';
  const runningElapsedMs = useRunningElapsed(isRunning);
  const elapsed = isRunning ? formatDuration(runningElapsedMs) : undefined;
  const inlineError =
    result?.error && !result.error.startsWith('SKIPPED') ? result.error : undefined;
  const elapsedSuffix = elapsed ? ` · ${elapsed}` : '';
  const iconPrefixWidth = displayWidth('○ ');
  const summaryWidth = Math.max(4, blockWidth - iconPrefixWidth);
  const summary = inlineError
    ? (() => {
        const errorWidth = Math.max(
          8,
          Math.min(Math.floor(summaryWidth / 2), displayWidth(inlineError)),
        );
        const prefixWidth = Math.max(4, summaryWidth - errorWidth - 3);
        return `${truncateDisplay(presentation.summary, prefixWidth)} · ${truncateDisplay(inlineError, errorWidth)}`;
      })()
    : truncateDisplay(`${presentation.summary}${elapsedSuffix}`, summaryWidth);

  useLayoutEffect(() => {
    if (!registry || !toolId) return;
    return registry.register({
      id: toolId,
      element: summaryRef,
      expandable: presentation.hasHiddenContent,
    });
  }, [presentation.hasHiddenContent, registry, toolId]);

  if (screenReader) {
    return (
      <Box flexDirection="column" marginLeft={2} width={blockWidth}>
        <ScreenReaderTool presentation={presentation} args={args} result={result} />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginLeft={2}>
      <Box ref={summaryRef} height={1}>
        {isRunning ? (
          <>
            <Spinner
              active
              style="dots"
              color={agentColor ?? theme.brand}
              reducedMotion={reducedMotion}
            />
            <Text> </Text>
          </>
        ) : (
          <Text color={statusColor(presentation.status, theme)}>
            {statusSymbol(presentation.status)}{' '}
          </Text>
        )}
        <Text color={presentation.status === 'failure' ? theme.error : theme.text}>{summary}</Text>
      </Box>
      {isExpanded && presentation.showArguments && Object.keys(args).length > 0 ? (
        <Box
          marginLeft={4}
          flexDirection="column"
          borderLeft
          borderLeftColor={theme.toolRail}
          paddingLeft={1}
        >
          {Object.entries(args).map(([key, value]) => {
            const prefix = `${key}: `;
            return (
              <Box key={key}>
                <Text color={theme.subtle} dimColor>
                  {prefix}
                </Text>
                <Text color={theme.text}>
                  {truncateDisplay(
                    stringifyArg(value),
                    Math.max(4, detailWidth - displayWidth(prefix)),
                  )}
                </Text>
              </Box>
            );
          })}
        </Box>
      ) : null}

      {isExpanded && result && isDiffOutput(name, result) ? (
        <DiffBlock
          output={result.output}
          filePath={presentation.filePath}
          collapsed={!showAllToolOutput}
          terminalWidth={blockWidth}
        />
      ) : isExpanded && result?.output ? (
        <OutputBlock
          output={result.output}
          success={result.success}
          theme={theme}
          showAllToolOutput={showAllToolOutput}
          toolName={presentation.canonicalName}
          terminalWidth={blockWidth}
        />
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
  success,
  theme,
  showAllToolOutput,
  toolName,
  terminalWidth,
}: {
  output: string;
  success: boolean;
  theme: ReturnType<typeof useTheme>;
  showAllToolOutput: boolean;
  toolName: string;
  terminalWidth: number;
}) {
  // A two-column indent plus the border/padding rail live inside the budget.
  const contentWidth = Math.max(8, Math.floor(terminalWidth) - 6);
  const footerWidth = contentWidth;
  const display = useMemo(
    () =>
      prepareToolOutputDisplay(output, {
        maxLines: showAllToolOutput ? 2000 : success ? 6 : 10,
        maxLineWidth: contentWidth,
        hint: showAllToolOutput ? undefined : 'Ctrl+E shows all',
        strategy: showAllToolOutput ? 'head' : success ? 'head-tail' : 'tail',
      }),
    [contentWidth, output, showAllToolOutput, success],
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
        borderLeftColor={theme.toolRail}
        paddingLeft={1}
        paddingRight={1}
        backgroundColor={theme.surface}
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
      borderLeftColor={theme.toolRail}
      paddingLeft={1}
      paddingRight={1}
      backgroundColor={theme.surface}
    >
      {display.lines.map((line, index) => (
        <Box key={index}>
          {highlighted ? (
            <Text>
              {highlighted[index]?.map((segment, segmentIndex) => (
                <Text
                  key={segmentIndex}
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
