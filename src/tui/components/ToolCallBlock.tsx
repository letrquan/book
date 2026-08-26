import { Text, Box, type DOMElement } from 'ink';
import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { Spinner } from './Spinner.js';
import { useTheme } from '../theme.js';
import { DiffBlock } from './Diff.js';
import { MarkdownBlock } from './MarkdownBlock.js';
import { highlightCode } from './syntax-highlight.js';
import { prepareToolOutputDisplay } from './tool-output.js';
import { truncateDisplay } from './word-wrap.js';
import {
  getFileMutationDisplaySummary,
  isRenderableFileMutationDiff,
} from '../file-mutation-display.js';
import {
  composeToolRow,
  deriveToolPresentation,
  type ToolPresentationStatus,
} from '../tool-presentation.js';
import {
  CONTENT_COLUMN,
  GUTTER_WIDTH,
  indentedGrid,
  nestedGrid,
  transcriptGrid,
  withLabelColumn,
} from '../layout.js';
import { formatElapsedDuration } from './SubagentRow.js';
import { useToolRowInteractionRegistry } from './tool-row-interactions.js';
import { useUiClock } from '../ui-clock.js';
import type { ToolResult } from '../../types/tools.js';

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
  /** Render a file path as a child row under an aggregate mutation heading. */
  summaryVariant?: 'default' | 'file-child';
  /** Available terminal width, including this block's outer indentation. */
  terminalWidth?: number;
  /**
   * Width of the label column, measured across the sibling rows of this turn.
   * Omitted, the row uses the grid's default column.
   */
  labelWidth?: number;
}

/** Compatibility export used by existing consumers and tests. */
function getResultLabel(result?: ToolResult): { label: string; color: string } {
  if (!result) return { label: '', color: 'gray' };
  if (result.status === 'blocked') return { label: '[SKIPPED]', color: 'yellow' };
  if (result.status !== 'success') return { label: '[ERR]', color: 'red' };
  return { label: '[OK]', color: 'green' };
}

function isDiffOutput(toolName: string, result: ToolResult | undefined): boolean {
  return isRenderableFileMutationDiff(toolName, result);
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    Read: 'Read file',
    ApplyPatch: 'Apply patch',
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

function useRunningElapsed(isRunning: boolean): number {
  const startedAtRef = useRef(Date.now());
  // The 1s clock keeps a running row to one re-render per second; the fast
  // clock forced 10 renders + full Yoga layouts per second for every running
  // tool. Second granularity in the label (formatElapsedDuration) matches.
  const tick = useUiClock('slow', isRunning);

  useEffect(() => {
    startedAtRef.current = Date.now();
  }, [isRunning]);

  void tick;
  return isRunning ? Date.now() - startedAtRef.current : 0;
}

function ScreenReaderTool({
  presentation,
  result,
}: {
  presentation: ReturnType<typeof deriveToolPresentation>;
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
      {result?.content ? <Text>{result.content}</Text> : null}
      {result?.structuredError && result.status !== 'blocked' ? (
        <Text>Error: {result.structuredError.message}</Text>
      ) : null}
    </Box>
  );
}

/**
 * Render a target so the part that identifies it carries the weight.
 *
 * Two ramps at once. Across the row: a path's directory is context and its
 * basename is the thing being acted on, and in a column of twenty rows the
 * directories are largely identical. Against the rest of the turn: a tool row
 * is machinery, and it sits a step below prose so the answer is the brightest
 * thing on screen rather than one more row of the same weight.
 */
export function TargetText({
  target,
  failed,
  path = false,
}: {
  target: string;
  failed: boolean;
  /** Split the directory prefix off. Only meaningful for filesystem paths. */
  path?: boolean;
}) {
  const theme = useTheme();
  if (failed) return <Text color={theme.error}>{target}</Text>;
  const split = path ? target.lastIndexOf('/') : -1;
  // A trailing slash leaves no basename, which would paint the whole target in
  // the dim prefix colour and make the row's only content the faintest thing
  // on screen.
  if (split < 0 || split === target.length - 1) {
    return <Text color={theme.subtle}>{target}</Text>;
  }
  return (
    <Text>
      <Text color={theme.inactive} dimColor>
        {target.slice(0, split + 1)}
      </Text>
      <Text color={theme.subtle}>{target.slice(split + 1)}</Text>
    </Text>
  );
}

/** `+12` / `-3`: churn counts, which read faster in the diff colours. */
const CHURN_TOKEN = /^([+-])(\d+)$/;

/**
 * Render right-aligned metadata, colouring churn counts.
 *
 * Everything else stays recessive — the figures a reader scans for are the
 * lines added and removed, and an error.
 */
export function MetaText({ meta, failed }: { meta: string; failed: boolean }) {
  const theme = useTheme();
  if (failed) return <Text color={theme.error}>{meta}</Text>;
  if (!CHURN_TOKEN.test(meta.split(' ')[0] ?? '')) {
    return (
      <Text color={theme.subtle} dimColor>
        {meta}
      </Text>
    );
  }
  return (
    <Text>
      {meta.split(' ').map((token, index) => {
        const churn = CHURN_TOKEN.exec(token);
        const color = !churn ? theme.subtle : churn[1] === '+' ? theme.success : theme.error;
        return (
          <Text key={index} color={color} dimColor={!churn}>
            {index > 0 ? ' ' : ''}
            {token}
          </Text>
        );
      })}
    </Text>
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
  summaryVariant = 'default',
  terminalWidth = 80,
  labelWidth,
}: ToolCallBlockProps) {
  const theme = useTheme();
  const registry = useToolRowInteractionRegistry();
  const summaryRef = useRef<DOMElement>(null);
  const grid = useMemo(() => {
    const base = transcriptGrid(terminalWidth);
    return labelWidth === undefined ? base : withLabelColumn(base, labelWidth);
  }, [labelWidth, terminalWidth]);
  // The row nests one gutter under the prose it belongs to, so its own grid is
  // the indented one; `grid` stays the message-level measure the label column
  // was negotiated against.
  const rowGrid = useMemo(() => indentedGrid(grid), [grid]);
  const blockWidth = rowGrid.content;
  const presentation = useMemo(
    () => deriveToolPresentation(name, args, result, { isPending, nestedActivityCount }),
    [args, isPending, name, nestedActivityCount, result],
  );
  const isRunning = presentation.status === 'running';
  // Under reducedMotion the row must not tick at all: the spinner is frozen,
  // so a changing elapsed label would be the only remaining animation.
  const runningElapsedMs = useRunningElapsed(isRunning && !reducedMotion);
  const elapsed =
    isRunning && !reducedMotion
      ? formatElapsedDuration(Math.floor(runningElapsedMs / 1000))
      : undefined;
  const inlineError = result?.status !== 'blocked' ? result?.structuredError?.message : undefined;
  const mutationSummary = useMemo(
    () => getFileMutationDisplaySummary(name, args, result),
    [args, name, result],
  );
  const isFileChild = summaryVariant === 'file-child';
  // A child row sits under an aggregate heading that already named the verb, so
  // it drops the label column and renders on the nested grid.
  const row = useMemo(() => {
    if (isFileChild && mutationSummary) {
      return composeToolRow(
        {
          title: '',
          target: mutationSummary.filePath,
          metadata: [`+${mutationSummary.addedLines}`, `-${mutationSummary.removedLines}`],
        },
        nestedGrid(rowGrid),
        { error: inlineError },
      );
    }
    return composeToolRow(presentation, isFileChild ? nestedGrid(rowGrid) : rowGrid, {
      elapsed,
      error: inlineError,
    });
  }, [elapsed, rowGrid, inlineError, isFileChild, mutationSummary, presentation]);

  useLayoutEffect(() => {
    if (!registry || !toolId) return;
    return registry.register({
      id: toolId,
      element: summaryRef,
      expandable: presentation.hasHiddenContent,
      expanded: isExpanded,
    });
  }, [isExpanded, presentation.hasHiddenContent, registry, toolId]);

  if (screenReader) {
    return (
      <Box flexDirection="column" marginLeft={CONTENT_COLUMN} width={blockWidth}>
        <ScreenReaderTool presentation={presentation} result={result} />
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      marginLeft={isFileChild ? CONTENT_COLUMN + GUTTER_WIDTH : CONTENT_COLUMN}
    >
      <Box ref={summaryRef} height={1}>
        {/* The gutter carries status; content always begins on the next column. */}
        {isFileChild ? (
          <Text color={theme.toolRail}>└ </Text>
        ) : isRunning ? (
          <>
            {/* Spinner emits its own trailing space, so the gutter stays two
                columns wide and the verb does not shift when the tool ends. */}
            <Spinner
              active
              style="dots"
              color={agentColor ?? theme.assistantAccent}
              reducedMotion={reducedMotion}
            />
          </>
        ) : (
          <Text color={statusColor(presentation.status, theme)}>
            {statusSymbol(presentation.status)}{' '}
          </Text>
        )}
        {row.label ? (
          <Text color={theme.inactive} dimColor>
            {row.label}{' '}
          </Text>
        ) : null}
        <TargetText
          target={row.target}
          failed={presentation.status === 'failure'}
          path={Boolean(presentation.filePath) || isFileChild}
        />
        <Text>{row.gap}</Text>
        <MetaText meta={row.meta} failed={Boolean(inlineError)} />
      </Box>
      {isExpanded && result && isDiffOutput(name, result) ? (
        <DiffBlock
          output={result.content}
          filePath={presentation.filePath}
          terminalWidth={blockWidth}
        />
      ) : isExpanded && result?.content ? (
        <OutputBlock
          output={result.content}
          success={result.status === 'success'}
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
  // The rail's border plus its padding occupy the nested gutter.
  const contentWidth = Math.max(8, Math.floor(terminalWidth) - CONTENT_COLUMN - 2);
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
  // The markdown sniff regex scans the whole output string; memoize it so an
  // expanded multi-MB result pays that once per output, not once per render.
  const renderAsMarkdown = useMemo(
    () => !language && looksLikeMarkdown(output, toolName),
    [language, output, toolName],
  );

  if (renderAsMarkdown) {
    return (
      <Box
        marginLeft={CONTENT_COLUMN}
        flexDirection="column"
        borderStyle="single"
        borderLeft
        borderTop={false}
        borderRight={false}
        borderBottom={false}
        borderLeftColor={theme.toolRail}
        paddingLeft={1}
        paddingRight={1}
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
      marginLeft={CONTENT_COLUMN}
      flexDirection="column"
      borderStyle="single"
      borderLeft
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderLeftColor={theme.toolRail}
      paddingLeft={1}
      paddingRight={1}
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
                  dimColor
                >
                  {segment.text}
                </Text>
              ))}
            </Text>
          ) : (
            <Text color={theme.text} dimColor>
              {line}
            </Text>
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
