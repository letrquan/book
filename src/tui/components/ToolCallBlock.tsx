import { Text, Box, type DOMElement } from 'ink';
import React, { createContext, useContext, useLayoutEffect, useMemo, useRef } from 'react';
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
  commandOutputPreview,
  composeResultErrorDetail,
  composeToolHeading,
  deriveToolPresentation,
  EXPAND_KEY,
  isCommandTool,
  labelFailure,
  mutationDiffPreviewInput,
  mutationResultSummary,
  showsErrorMessage,
  toolItemGrids,
  toolOutputContentWidth,
  toolOutputDisplay,
  toolResultSummary,
  type TranscriptMode,
} from '../tool-presentation.js';
import { CONTENT_COLUMN } from '../layout.js';
import { formatToolOutputFooter } from './tool-output.js';
import { ItemMark, ResultBox, ResultLine } from './transcript-item.js';
import { foldControlCharacters, stripTerminalControls } from '../../control-characters.js';
import { useToolRowInteractionRegistry } from './tool-row-interactions.js';
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
  reducedMotion?: boolean;
  /** When true, renders flat, complete text without decorations. */
  screenReader?: boolean;
  /** When true, expanded tool results show the large rendering ceiling. */
  showAllToolOutput?: boolean;
  /** Which transcript this row is drawn in; the detailed one previews diffs more widely. */
  transcriptMode?: TranscriptMode;
  /** Available terminal width, including this block's outer indentation. */
  terminalWidth?: number;
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
  reducedMotion = false,
  screenReader = false,
  showAllToolOutput = false,
  transcriptMode = 'compact',
  terminalWidth = 80,
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
  // The heading sits on the item's own grid, its mark in the gutter; the result's rows sit
  // past `⎿  `, on the grid the result's width and its error detail are measured on.
  const grids = useMemo(() => toolItemGrids(terminalWidth), [terminalWidth]);
  const resultWidth = grids.result.content;
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
  const heading = useMemo(
    () => composeToolHeading(presentation, grids.item.content),
    [grids.item.content, presentation],
  );
  const isRunning = presentation.status === 'running';
  const inlineError = showsErrorMessage(result) ? result?.structuredError?.message : undefined;
  const mutationSummary = useMemo(
    () => getFileMutationDisplaySummary(name, args, result),
    [args, name, result],
  );
  // One new file previews its first lines; any other diff is previewed as mutationDiffPreview
  // says: the compact transcript's changed rows, the detailed one's wider ones.
  const diffPreview = mutationDiffPreview(
    mutationDiffPreviewInput(mutationSummary, { transcriptMode, screenReader }),
  );
  // The output block under the row renders exactly when this holds. It draws a command's stdout in
  // full, so an expanded error detail must not draw the same lines again.
  const rendersOutputBlock = isExpanded && Boolean(result?.content) && !isDiffOutput(name, result);
  // The detail shows everything only while its row is itself expanded: the ids that ask for it are
  // never removed, so a row folded back (a click, or Ctrl+O out of detailed mode) must fold it too.
  const showFullError = showAllToolOutput && isExpanded;
  const exitCode = presentation.metadata.find((part) => /^exit -?\d+$/.test(part));
  // A command's failure says its exit code on the result's first row, and its output's last
  // lines follow. Any other failure is a sentence, which opens on what kind of stop it was.
  const errorMessage =
    inlineError?.trim() && !exitCode ? labelFailure(inlineError, presentation.status) : inlineError;
  const errorDetails = useMemo(() => {
    if (!errorMessage?.trim()) return undefined;
    const compose = (expanded: boolean) =>
      composeResultErrorDetail({
        presentation: { title: '', target: undefined },
        message: errorMessage,
        result,
        rowGrid: grids.result,
        isFileChild: false,
        expanded,
        stdoutShownBelow: rendersOutputBlock,
        expandHint,
      });
    return {
      collapsed: compose(false),
      expanded: showFullError ? compose(true) : undefined,
    };
  }, [errorMessage, expandHint, grids.result, rendersOutputBlock, result, showFullError]);
  const errorDetail = showFullError ? errorDetails?.expanded : errorDetails?.collapsed;
  // A successful command that is not open previews its first lines under the heading.
  const commandPreview = useMemo(
    () =>
      !isExpanded && result?.status === 'success' && isCommandTool(presentation.canonicalName)
        ? commandOutputPreview(result.content ?? '', resultWidth)
        : undefined,
    [isExpanded, presentation.canonicalName, result, resultWidth],
  );
  // A failure whose collapsed detail hides lines can be expanded even when the row's own output
  // has nothing to reveal: stderr is not in `result.content`.
  const expandable = presentation.hasHiddenContent || Boolean(errorDetails?.collapsed?.hint);

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
      <Box flexDirection="column" marginLeft={CONTENT_COLUMN} width={grids.item.content}>
        <ScreenReaderTool presentation={presentation} result={result} />
      </Box>
    );
  }

  const failed = presentation.status === 'failure' || presentation.status === 'skipped';
  // A call refused before it ran is the model's slip, not an event in your workspace: grey.
  const errorColor = presentation.rejected
    ? theme.inactive
    : presentation.status === 'skipped'
      ? theme.warning
      : theme.error;
  const summary = mutationSummary
    ? mutationResultSummary(mutationSummary)
    : toolResultSummary(presentation);
  // The result's opening row, when the state is not already told by the rows under it.
  const statusLine: { text: string; color: string } | undefined = isRunning
    ? { text: 'Running…', color: theme.inactive }
    : presentation.status === 'pending'
      ? { text: 'Waiting for your approval', color: theme.warning }
      : failed && (exitCode || !errorDetail)
        ? {
            text: exitCode
              ? `Error: ${exitCode}`
              : presentation.status === 'skipped'
                ? 'Skipped'
                : 'Error',
            color: errorColor,
          }
        : summary && !failed
          ? { text: summary, color: theme.subtle }
          : undefined;
  const errorHint = errorDetail?.hint ? (
    <ResultLine text={errorDetail.hint} color={theme.inactive} />
  ) : null;
  const previewRows = commandPreview
    ? commandPreview.lines.length > 0
      ? commandPreview.lines
      : ['(No output)']
    : [];
  const drawsDiff = isExpanded && result !== undefined && isDiffOutput(name, result);
  const hasResult =
    statusLine !== undefined ||
    errorDetail !== undefined ||
    previewRows.length > 0 ||
    drawsDiff ||
    rendersOutputBlock;

  return (
    <Box flexDirection="column">
      {/* The heading is one line by contract; it must truncate, never wrap, because a wrapped line is drawn outside the box and the render cull relies on rows drawing inside their own box. */}
      <Box ref={summaryRef} height={1}>
        <ItemMark
          state={presentation.rejected ? 'quiet' : presentation.status}
          reducedMotion={reducedMotion}
        />
        <Text wrap="truncate-end" bold color={theme.text}>
          {heading.name}
        </Text>
        {heading.target ? (
          <>
            <Text color={theme.inactive}>(</Text>
            <TargetText
              target={heading.target}
              failed={false}
              path={Boolean(presentation.filePath)}
              wrap="truncate-end"
            />
            <Text color={theme.inactive}>)</Text>
          </>
        ) : null}
      </Box>
      {hasResult ? (
        <ResultBox width={resultWidth}>
          {statusLine ? <ResultLine text={statusLine.text} color={statusLine.color} /> : null}
          {/* The message is hard-wrapped into one-line rows for the same reason the
              heading truncates: every row draws inside its own box. */}
          {errorDetail ? (
            <>
              {errorDetail.hintBelow ? null : errorHint}
              {errorDetail.lines.map((line, index) => (
                <ResultLine key={index} text={line} color={errorColor} />
              ))}
              {errorDetail.note?.map((line, index) => (
                <ResultLine key={`note-${index}`} text={line} color={errorColor} />
              ))}
              {errorDetail.hintBelow ? errorHint : null}
            </>
          ) : null}
          {previewRows.map((line, index) => (
            <ResultLine key={`preview-${index}`} text={line} color={theme.subtle} />
          ))}
          {commandPreview && commandPreview.hiddenLines > 0 ? (
            <ResultLine
              text={formatToolOutputFooter({
                hiddenLines: commandPreview.hiddenLines,
                truncatedLines: 0,
                hint: expandHint || undefined,
              })}
              color={theme.inactive}
            />
          ) : null}
          {drawsDiff ? (
            <DiffBlock
              output={result.content}
              filePath={presentation.filePath}
              collapsed={!showAllToolOutput}
              preview={diffPreview.preview}
              maxRows={diffPreview.maxRows}
              contextRows={diffPreview.contextRows}
              expandHint={expandHint}
              terminalWidth={resultWidth}
            />
          ) : rendersOutputBlock && result ? (
            <OutputBlock
              output={result.content}
              success={result.status === 'success'}
              theme={theme}
              showAllToolOutput={showAllToolOutput}
              toolName={presentation.canonicalName}
              terminalWidth={resultWidth}
              expandHint={expandHint}
            />
          ) : null}
        </ResultBox>
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
      <Box flexDirection="column" width={contentWidth}>
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
    <Box flexDirection="column" width={contentWidth}>
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
