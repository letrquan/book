import { Text, Box, type DOMElement } from 'ink';
import React, {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
} from 'react';
import { Spinner } from './Spinner.js';
import { useTheme } from '../theme.js';
import { DiffBlock, mutationDiffPreview } from './Diff.js';
import { MarkdownBlock } from './MarkdownBlock.js';
import { highlightCode } from './syntax-highlight.js';
import { truncateDisplay } from './word-wrap.js';
import {
  getFileMutationDisplaySummary,
  isRenderableFileMutationDiff,
} from '../file-mutation-display.js';
import {
  composeResultErrorDetail,
  composeToolRow,
  deriveToolPresentation,
  EXPAND_KEY,
  mutationDiffPreviewInput,
  showsErrorMessage,
  toolOutputContentWidth,
  toolOutputDisplay,
  type ToolPresentation,
  type TranscriptMode,
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
import { foldControlCharacters, stripTerminalControls } from '../../control-characters.js';
import { useToolRowInteractionRegistry } from './tool-row-interactions.js';
import { useUiClock } from '../ui-clock.js';
import { useMemoryRoot } from '../memory-root.js';
import type { ToolResult } from '../../types/tools.js';

/**
 * The id of the tool row Ctrl+E acts on, computed once by `selectExpandTargetId` in app.tsx. In
 * the compact transcript only that row's truncated footer names the key. The default is "no
 * target" (`null`): a compact row outside a provider names no key, because it cannot know that
 * Ctrl+E would act on it. The detailed transcript names the key on every footer regardless.
 */
export const ToolExpandTargetContext = createContext<string | null>(null);

interface ToolCallBlockProps {
  toolId?: string;
  name: string;
  args: Record<string, unknown>;
  /** The argument text of a call the provider could not parse; its `args` are empty. */
  unparsedArguments?: { raw: string; error: string };
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
  /** Which transcript this row is drawn in; the detailed one previews diffs more widely. */
  transcriptMode?: TranscriptMode;
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

function statusColor(
  { status, rejected }: Pick<ToolPresentation, 'status' | 'rejected'>,
  theme: ReturnType<typeof useTheme>,
): string {
  // A column of green checks beside one rose `×` made every row shout. Success
  // is the default, so it is the exception — a failure or a pending row — that
  // takes colour. A call refused before it ran is the model's slip, not an
  // event in your workspace: its `×` is grey.
  if (status === 'success') return theme.inactive;
  if (status === 'failure') return rejected ? theme.inactive : theme.error;
  if (status === 'skipped' || status === 'pending') return theme.warning;
  return theme.brand;
}

function statusSymbol(status: ToolPresentation['status']): string {
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
      {result?.content ? <Text>{stripTerminalControls(result.content)}</Text> : null}
      {result?.structuredError && showsErrorMessage(result) ? (
        <Text>Error: {foldControlCharacters(result.structuredError.message)}</Text>
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
  wrap,
}: {
  target: string;
  failed: boolean;
  /** Split the directory prefix off. Only meaningful for filesystem paths. */
  path?: boolean;
  wrap?: React.ComponentProps<typeof Text>['wrap'];
}) {
  const theme = useTheme();
  if (failed)
    return (
      <Text wrap={wrap} color={theme.error}>
        {target}
      </Text>
    );
  const split = path ? target.lastIndexOf('/') : -1;
  // A trailing slash leaves no basename, which would paint the whole target in
  // the dim prefix colour and make the row's only content the faintest thing
  // on screen.
  if (split < 0 || split === target.length - 1) {
    return (
      <Text wrap={wrap} color={theme.subtle}>
        {target}
      </Text>
    );
  }
  return (
    <Text wrap={wrap}>
      <Text color={theme.inactive}>{target.slice(0, split + 1)}</Text>
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
 * lines added and removed. A failure's message is not metadata: it is laid out
 * under the row.
 */
export function MetaText({
  meta,
  wrap,
}: {
  meta: string;
  wrap?: React.ComponentProps<typeof Text>['wrap'];
}) {
  const theme = useTheme();
  if (!CHURN_TOKEN.test(meta.split(' ')[0] ?? '')) {
    return (
      <Text wrap={wrap} color={theme.inactive}>
        {meta}
      </Text>
    );
  }
  return (
    <Text wrap={wrap}>
      {meta.split(' ').map((token, index) => {
        const churn = CHURN_TOKEN.exec(token);
        const color = !churn ? theme.inactive : churn[1] === '+' ? theme.success : theme.error;
        return (
          <Text key={index} color={color}>
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
  unparsedArguments,
  result,
  isExpanded,
  isPending = false,
  nestedActivityCount = 0,
  agentColor,
  reducedMotion = false,
  screenReader = false,
  showAllToolOutput = false,
  transcriptMode = 'compact',
  summaryVariant = 'default',
  terminalWidth = 80,
  labelWidth,
}: ToolCallBlockProps) {
  const theme = useTheme();
  const registry = useToolRowInteractionRegistry();
  const expandTargetId = useContext(ToolExpandTargetContext);
  const memoryRoot = useMemoryRoot();
  // Ctrl+E in the detailed transcript shows everything, so every footer names it. In the compact
  // one it expands the target row only: the others keep the footer and drop the key.
  const expandHint =
    transcriptMode === 'detailed' || (toolId !== undefined && expandTargetId === toolId)
      ? EXPAND_KEY
      : '';
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
    () =>
      deriveToolPresentation(name, args, result, {
        isPending,
        nestedActivityCount,
        unparsedArguments,
        memoryRoot,
      }),
    [args, isPending, memoryRoot, name, nestedActivityCount, result, unparsedArguments],
  );
  const isRunning = presentation.status === 'running';
  // Under reducedMotion the row must not tick at all: the spinner is frozen,
  // so a changing elapsed label would be the only remaining animation.
  const runningElapsedMs = useRunningElapsed(isRunning && !reducedMotion);
  const elapsed =
    isRunning && !reducedMotion
      ? formatElapsedDuration(Math.floor(runningElapsedMs / 1000))
      : undefined;
  const inlineError = showsErrorMessage(result) ? result?.structuredError?.message : undefined;
  const mutationSummary = useMemo(
    () => getFileMutationDisplaySummary(name, args, result),
    [args, name, result],
  );
  // One new file previews its first lines; any other diff is previewed as mutationDiffPreview
  // says: the compact transcript's first rows in order, the detailed one's change-focused rows.
  const diffPreview = mutationDiffPreview(
    mutationDiffPreviewInput(mutationSummary, { transcriptMode, screenReader }),
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
      );
    }
    return composeToolRow(presentation, isFileChild ? nestedGrid(rowGrid) : rowGrid, {
      elapsed,
    });
  }, [elapsed, rowGrid, isFileChild, mutationSummary, presentation]);
  // The output block under the row renders exactly when this holds. It draws a command's stdout in
  // full, so an expanded error detail must not draw the same lines again.
  const rendersOutputBlock = isExpanded && Boolean(result?.content) && !isDiffOutput(name, result);
  // The detail shows everything only while its row is itself expanded: the ids that ask for it are
  // never removed, so a row folded back (a click, or Ctrl+O out of detailed mode) must fold it too.
  const showFullError = showAllToolOutput && isExpanded;
  // A failure's message goes under the row, on the grid the row was laid out on. The collapsed
  // detail is always composed: its hint says whether the row has lines to reveal.
  const errorDetails = useMemo(() => {
    if (!inlineError?.trim()) return undefined;
    const compose = (expanded: boolean) =>
      composeResultErrorDetail({
        presentation,
        message: inlineError,
        result,
        rowGrid,
        isFileChild,
        expanded,
        stdoutShownBelow: rendersOutputBlock,
        expandHint,
      });
    return {
      collapsed: compose(false),
      expanded: showFullError ? compose(true) : undefined,
    };
  }, [
    expandHint,
    inlineError,
    isFileChild,
    presentation,
    rendersOutputBlock,
    result,
    rowGrid,
    showFullError,
  ]);
  const errorDetail = showFullError ? errorDetails?.expanded : errorDetails?.collapsed;
  // A failure whose collapsed detail hides lines can be expanded even when the row's own output
  // has nothing to reveal: stderr is not in `result.content`.
  const expandable = presentation.hasHiddenContent || Boolean(errorDetails?.collapsed?.hint);
  // The footer counts what the rows cut and the stdout they leave out: above the rows while it
  // counts lines they cut, below them when it is the stdout's alone.
  const errorHint = errorDetail?.hint ? (
    <Box height={1}>
      <Text wrap="truncate-end" color={theme.inactive}>
        {errorDetail.hint}
      </Text>
    </Box>
  ) : null;

  useLayoutEffect(() => {
    if (!registry || !toolId) return;
    return registry.register({
      id: toolId,
      element: summaryRef,
      expandable,
      expanded: isExpanded,
    });
  }, [expandable, isExpanded, registry, toolId]);

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
      {/* The row is one line by contract; it must truncate, never wrap, because a wrapped line is drawn outside the box and the render cull relies on rows drawing inside their own box. */}
      <Box ref={summaryRef} height={1}>
        {/* The gutter carries status; content always begins on the next column. */}
        {isFileChild ? (
          <Text wrap="truncate-end" color={theme.toolRail}>
            └{' '}
          </Text>
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
          <Text wrap="truncate-end" color={statusColor(presentation, theme)}>
            {presentation.mark ?? statusSymbol(presentation.status)}{' '}
          </Text>
        )}
        {/* Recessive, but never faint: SGR 2 on an already-muted grey left the
            verb nearly invisible on a dark background. */}
        {row.label ? (
          <Text wrap="truncate-end" color={theme.inactive}>
            {row.label}{' '}
          </Text>
        ) : null}
        <TargetText
          target={row.target}
          failed={presentation.status === 'failure' && !presentation.rejected}
          path={Boolean(presentation.filePath) || isFileChild}
          wrap="truncate-end"
        />
        <Text wrap="truncate-end">{row.gap}</Text>
        <MetaText meta={row.meta} wrap="truncate-end" />
      </Box>
      {/* The message is hard-wrapped into one-line rows for the same reason the
          summary row truncates: every row draws inside its own box. */}
      {errorDetail ? (
        <Box flexDirection="column" marginLeft={errorDetail.column}>
          {errorDetail.hintBelow ? null : errorHint}
          {errorDetail.lines.map((line, index) => (
            <Box key={index} height={1}>
              <Text
                wrap="truncate-end"
                color={presentation.rejected ? theme.inactive : theme.error}
              >
                {line}
              </Text>
            </Box>
          ))}
          {errorDetail.note?.map((line, index) => (
            <Box key={`note-${index}`} height={1}>
              <Text
                wrap="truncate-end"
                color={presentation.rejected ? theme.inactive : theme.error}
              >
                {line}
              </Text>
            </Box>
          ))}
          {errorDetail.hintBelow ? errorHint : null}
        </Box>
      ) : null}
      {isExpanded && result && isDiffOutput(name, result) ? (
        <DiffBlock
          output={result.content}
          filePath={presentation.filePath}
          collapsed={!showAllToolOutput}
          preview={diffPreview.preview}
          maxRows={diffPreview.maxRows}
          expandHint={expandHint}
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
          expandHint={expandHint}
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
  expandHint,
}: {
  output: string;
  success: boolean;
  theme: ReturnType<typeof useTheme>;
  showAllToolOutput: boolean;
  toolName: string;
  terminalWidth: number;
  expandHint: string;
}) {
  const contentWidth = toolOutputContentWidth(terminalWidth);
  const footerWidth = contentWidth;
  const display = useMemo(
    () => toolOutputDisplay(output, { success, showAllToolOutput, terminalWidth, expandHint }),
    [expandHint, output, showAllToolOutput, success, terminalWidth],
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
        // An empty line is a row too: Ink gives a box whose text is empty no height of its own,
        // which dropped the blank lines between paragraphs, test sections and diff hunks.
        <Box key={index} minHeight={1}>
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
