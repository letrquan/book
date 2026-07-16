import { Text, Box } from 'ink';
import React, { useMemo, useRef, useState, useEffect } from 'react';
import { marked, Tokens, Token } from 'marked';
import { useTheme } from '../theme.js';
import { wordWrap } from './word-wrap.js';
import { highlightCode, type StyledLine } from './syntax-highlight.js';
import {
  layoutCodeBlock,
  layoutHeadingChrome,
  layoutHorizontalRule,
  layoutTable,
  nestedContentWidth,
  sliceStyledLine,
} from './markdown-layout.js';

interface MarkdownBlockProps {
  /** Raw markdown string to render. */
  content: string;
  /** Terminal width in columns for word-boundary wrapping. */
  terminalWidth?: number;
  /** While streaming, keep expensive final-pass decoration such as syntax highlighting disabled. */
  isStreaming?: boolean;
}

type InlineStyle = {
  color?: string;
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  dimColor?: boolean;
  backgroundColor?: string;
};

type InlineRun = InlineStyle & { text: string };

interface RenderContext {
  textColor?: string;
  depth: number;
  isStreaming: boolean;
  /** Nested blockquote depth for width budgeting. */
  blockquoteDepth: number;
}

export function wrapParagraphLines(rawText: string, terminalWidth: number): string[] {
  if (terminalWidth <= 0) return rawText.split('\n');
  // wordWrap already hard-wraps overlong tokens with displayWidth semantics;
  // scanning every completed line a second time doubles paragraph render cost.
  return wordWrap(rawText, terminalWidth).split('\n');
}

/**
 * Throttle a rapidly-changing value onto a fixed cadence, with an immediate
 * first render and a guaranteed trailing emit.
 *
 * Why: during streaming, `content` grows ~every 16ms (the accumulator flush).
 * `marked.lexer(content)` on every flush re-parses the whole string ~60×/sec
 * — the main CPU sink while a large assistant reply streams in. Throttling the
 * value React actually parses caps re-lex work to ~17×/sec regardless of how
 * fast `content` changes, and the trailing emit guarantees the final, complete
 * markdown always renders.
 *
 * Semantics:
 *   - First value passed is emitted synchronously (no delayed first frame).
 *   - A change while within `interval` of the last emit is held; it is flushed
 *     on a trailing timer so the newest value always wins.
 *   - A change after `interval` emits immediately.
 *
 * `ponytail:` no leading-edge coalesce on the very first call. If a future
 * caller streams a value that changes mid-first-frame and needs the leading
 * edge deferred too, pass an explicit `startPending` flag. Ceiling: none —
 * this is the standard throttle shape.
 */
export function useThrottledValue<T>(next: T, intervalMs: number): T {
  const [value, setValue] = useState<T>(next);
  const lastEmitRef = useRef<number | null>(null);
  const mountedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextRef = useRef<T>(next);

  useEffect(() => {
    nextRef.current = next;
    if (!mountedRef.current) {
      mountedRef.current = true;
      lastEmitRef.current = Date.now();
      return;
    }
    if (next === value) return;
    const now = Date.now();
    const elapsed = now - (lastEmitRef.current ?? now);
    if (elapsed >= intervalMs) {
      lastEmitRef.current = now;
      setValue(next);
      return;
    }
    if (timerRef.current === null) {
      const remaining = intervalMs - elapsed;
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        lastEmitRef.current = Date.now();
        setValue(nextRef.current);
      }, remaining);
    }
  }, [next, intervalMs]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  return value;
}

function mergeStyle(base: InlineStyle, next: InlineStyle): InlineStyle {
  return { ...base, ...next };
}

function appendRun(runs: InlineRun[], text: string, style: InlineStyle) {
  if (!text) return;
  const previous = runs[runs.length - 1];
  if (
    previous &&
    previous.color === style.color &&
    previous.bold === style.bold &&
    previous.italic === style.italic &&
    previous.strikethrough === style.strikethrough &&
    previous.underline === style.underline &&
    previous.dimColor === style.dimColor &&
    previous.backgroundColor === style.backgroundColor
  ) {
    previous.text += text;
    return;
  }
  // Style first, then text — callers may pass an InlineRun as `style`, and the
  // sliced `text` argument must win over any previous `style.text`.
  runs.push({ ...style, text });
}

function plainTextFromTokens(tokens: Token[]): string {
  const runs = inlineRunsFromTokens(tokens, { color: undefined }, undefined);
  return runs.map((run) => run.text).join('');
}

function inlineRunsFromTokens(
  tokens: Token[],
  style: InlineStyle,
  theme: ReturnType<typeof useTheme> | undefined,
): InlineRun[] {
  const runs: InlineRun[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text & { tokens?: Token[] };
        if (t.tokens?.length) {
          runs.push(...inlineRunsFromTokens(t.tokens, style, theme));
        } else {
          appendRun(runs, t.text, style);
        }
        break;
      }
      case 'strong': {
        const t = token as Tokens.Strong;
        runs.push(...inlineRunsFromTokens(t.tokens, mergeStyle(style, { bold: true }), theme));
        break;
      }
      case 'em': {
        const t = token as Tokens.Em;
        runs.push(...inlineRunsFromTokens(t.tokens, mergeStyle(style, { italic: true }), theme));
        break;
      }
      case 'del': {
        const t = token as Tokens.Del;
        runs.push(
          ...inlineRunsFromTokens(
            t.tokens,
            mergeStyle(style, {
              strikethrough: true,
              color: theme?.subtle ?? style.color,
            }),
            theme,
          ),
        );
        break;
      }
      case 'codespan': {
        const t = token as Tokens.Codespan;
        appendRun(
          runs,
          t.text,
          mergeStyle(style, {
            color: theme?.mdInlineCodeText ?? style.color,
            backgroundColor: theme?.mdInlineCodeBg,
          }),
        );
        break;
      }
      case 'link': {
        const t = token as Tokens.Link;
        const linkRuns = inlineRunsFromTokens(
          t.tokens,
          mergeStyle(style, { color: theme?.mdLink ?? style.color, underline: true }),
          theme,
        );
        runs.push(...linkRuns);
        const label = linkRuns.map((run) => run.text).join('');
        if (t.href && t.href !== label) {
          appendRun(
            runs,
            ` (${t.href})`,
            mergeStyle(style, { color: theme?.mdLink ?? style.color }),
          );
        }
        break;
      }
      case 'image': {
        const t = token as Tokens.Image;
        appendRun(
          runs,
          `[Image: ${t.text || t.href}]`,
          mergeStyle(style, { color: theme?.mdLink ?? style.color, dimColor: true }),
        );
        break;
      }
      case 'br':
        appendRun(runs, '\n', style);
        break;
      case 'escape': {
        const t = token as Tokens.Escape;
        appendRun(runs, t.text, style);
        break;
      }
      case 'html': {
        const t = token as Tokens.HTML;
        if (t.text && !t.block) appendRun(runs, t.text, mergeStyle(style, { dimColor: true }));
        break;
      }
      default:
        break;
    }
  }
  return runs;
}

function sliceRunsForLine(runs: InlineRun[], line: string, offset: number): InlineRun[] {
  const lineRuns: InlineRun[] = [];
  let remaining = line.length;
  let cursor = 0;

  for (const run of runs) {
    const runStart = cursor;
    const runEnd = cursor + run.text.length;
    const lineStart = offset;
    const lineEnd = offset + line.length;
    const overlapStart = Math.max(runStart, lineStart);
    const overlapEnd = Math.min(runEnd, lineEnd);
    if (overlapStart < overlapEnd) {
      appendRun(lineRuns, run.text.slice(overlapStart - runStart, overlapEnd - runStart), run);
      remaining -= overlapEnd - overlapStart;
      if (remaining <= 0) break;
    }
    cursor = runEnd;
  }

  return lineRuns;
}

function wrappedInlineRuns(runs: InlineRun[], terminalWidth: number): InlineRun[][] {
  const rawText = runs.map((run) => run.text).join('');
  const lines = wrapParagraphLines(rawText, terminalWidth);
  let searchOffset = 0;
  return lines.map((line) => {
    // wordWrap may collapse spaces or replace an original newline with a visual
    // line break. Locate each rendered slice in the source instead of assuming
    // every break consumed exactly one space; otherwise style offsets drift and
    // later lines can lose their final character.
    const locatedOffset = rawText.indexOf(line, searchOffset);
    const lineOffset = locatedOffset === -1 ? searchOffset : locatedOffset;
    const lineRuns = sliceRunsForLine(runs, line, lineOffset);
    searchOffset = lineOffset + line.length;
    return lineRuns;
  });
}

function InlineRuns({ runs }: { runs: InlineRun[] }) {
  // Parent already soft/hard-wrapped to terminal width — disable Ink re-wrap.
  return (
    <Text wrap="truncate">
      {runs.map((run, i) => (
        <Text
          key={i}
          color={run.color}
          bold={run.bold}
          italic={run.italic}
          strikethrough={run.strikethrough}
          underline={run.underline}
          dimColor={run.dimColor}
          backgroundColor={run.backgroundColor}
        >
          {run.text}
        </Text>
      ))}
    </Text>
  );
}

/**
 * Render a single inline token (or array of inline tokens) into Text elements.
 * These are tokens that appear within paragraphs, headings, list items, etc.
 * They never produce block-level layout like Box borders or margins.
 */
function renderInlineTokens(
  tokens: Token[],
  theme: ReturnType<typeof useTheme>,
  keyPrefix: string,
  textColor?: string,
): React.ReactNode[] {
  const runs = inlineRunsFromTokens(tokens, { color: textColor ?? theme.text }, theme);
  return runs.map((run, i) => (
    <Text
      key={`${keyPrefix}-${i}`}
      color={run.color}
      bold={run.bold}
      italic={run.italic}
      strikethrough={run.strikethrough}
      underline={run.underline}
      dimColor={run.dimColor}
      backgroundColor={run.backgroundColor}
    >
      {run.text}
    </Text>
  ));
}

function renderStyledLine(line: StyledLine, keyPrefix: string) {
  return (
    <Text>
      {line.map((segment, i) => (
        <Text
          key={`${keyPrefix}-${i}`}
          color={segment.color}
          bold={segment.bold}
          italic={segment.italic}
          dimColor={segment.dimColor}
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}

function renderTableCells(
  cells: string[],
  key: string,
  theme: ReturnType<typeof useTheme>,
  bold = false,
) {
  return (
    <Box key={key} flexDirection="row">
      <Text color={theme.mdTableBorder}>│ </Text>
      {cells.map((cell, ci) => (
        <React.Fragment key={`${key}-${ci}`}>
          <Text bold={bold} color={theme.text}>
            {cell}
          </Text>
          <Text color={theme.mdTableBorder}> │ </Text>
        </React.Fragment>
      ))}
    </Box>
  );
}

/**
 * Render a block-level token into an Ink Box/Text component tree.
 */
function renderBlockToken(
  token: Token,
  theme: ReturnType<typeof useTheme>,
  index: number,
  terminalWidth: number | undefined,
  context: RenderContext,
): React.ReactNode {
  switch (token.type) {
    case 'heading': {
      const t = token as Tokens.Heading;
      const text = plainTextFromTokens(t.tokens);
      const chrome = layoutHeadingChrome(text, t.depth, terminalWidth);
      if (t.depth === 1) {
        return (
          <Box key={`h-${index}`} flexDirection="column" marginTop={1} marginBottom={1}>
            <Text bold color={theme.mdHeadingH1}>
              {chrome.prefix}
              {chrome.text}
              {chrome.suffix}
            </Text>
          </Box>
        );
      }
      if (t.depth === 2) {
        return (
          <Box key={`h-${index}`} flexDirection="column" marginTop={1} marginBottom={1}>
            <Text bold color={theme.mdHeadingH2}>
              {chrome.prefix}
              {chrome.text}
              {chrome.suffix}
            </Text>
          </Box>
        );
      }
      return (
        <Box key={`h-${index}`} flexDirection="column" marginTop={1} marginBottom={1}>
          <Text bold={t.depth <= 4} color={theme.mdHeading} dimColor={t.depth >= 5}>
            {chrome.prefix}
            {chrome.text}
          </Text>
        </Box>
      );
    }

    case 'paragraph': {
      const t = token as Tokens.Paragraph;
      const runs = inlineRunsFromTokens(
        t.tokens,
        { color: context.textColor ?? theme.text },
        theme,
      );
      if (terminalWidth) {
        const wrappedLines = wrappedInlineRuns(runs, terminalWidth);
        return (
          <Box key={`p-${index}`} flexDirection="column" flexGrow={1} marginBottom={1}>
            {wrappedLines.map((lineRuns, li) => (
              <Box key={`pw-${index}-${li}`} flexDirection="row">
                <InlineRuns runs={lineRuns} />
              </Box>
            ))}
          </Box>
        );
      }
      return (
        <Box key={`p-${index}`} flexDirection="row" flexGrow={1} marginBottom={1}>
          <InlineRuns runs={runs} />
        </Box>
      );
    }

    case 'code': {
      const t = token as Tokens.Code;
      const lines = t.text.split('\n');
      const displayLines =
        lines.length > 0 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
      const layout = layoutCodeBlock(displayLines, terminalWidth, {
        lang: t.lang,
        preferLineNumbers: displayLines.length > 5,
      });
      const highlighted = context.isStreaming
        ? undefined
        : highlightCode(displayLines.join('\n'), t.lang, theme);

      const widthProp =
        terminalWidth && terminalWidth > 0 ? { width: Math.max(1, Math.floor(terminalWidth)) } : {};

      const boxProps = layout.showBorder
        ? {
            ...widthProp,
            paddingX: 1 as const,
            borderStyle: 'round' as const,
            borderColor: theme.mdCodeBorder,
            backgroundColor: theme.mdCodeBackground,
          }
        : {
            ...widthProp,
            backgroundColor: theme.mdCodeBackground,
          };

      return (
        <Box key={`code-${index}`} flexDirection="column" {...boxProps}>
          {layout.langLabel ? (
            <Box marginBottom={1}>
              <Text color={theme.mdCodeBorder} dimColor>
                {layout.langLabel}
              </Text>
            </Box>
          ) : null}
          {layout.lines.map((visual, vi) => {
            const highlightedLine = highlighted?.[visual.sourceLineIndex];
            const segments: StyledLine = highlightedLine
              ? sliceStyledLine(highlightedLine, visual.sourceStart, visual.sourceEnd)
              : [{ text: visual.text, color: theme.mdCodeText }];
            const safeSegments: StyledLine =
              segments.length > 0 ? segments : [{ text: visual.text, color: theme.mdCodeText }];

            return (
              <Box key={`code-${index}-v${vi}`}>
                {layout.showLineNumbers ? (
                  <Text color={theme.mdCodeLineNumber} dimColor>
                    {visual.gutter}
                  </Text>
                ) : null}
                {highlighted ? (
                  renderStyledLine(safeSegments, `code-${index}-${vi}`)
                ) : (
                  <Text color={theme.mdCodeText}>{visual.text}</Text>
                )}
              </Box>
            );
          })}
        </Box>
      );
    }

    case 'blockquote': {
      const t = token as Tokens.Blockquote;
      // Incremental budget: border + paddingLeft ≈ 2 columns per quote level.
      const childWidth =
        terminalWidth !== undefined ? Math.max(1, Math.floor(terminalWidth) - 2) : undefined;
      return (
        <Box
          key={`bq-${index}`}
          flexDirection="column"
          borderLeft
          borderLeftColor={theme.mdBlockquoteBorder}
          paddingLeft={1}
        >
          {t.tokens.map((childToken, ci) =>
            renderBlockToken(childToken, theme, index * 1000 + ci, childWidth, {
              ...context,
              textColor: theme.mdBlockquoteText,
              blockquoteDepth: context.blockquoteDepth + 1,
            }),
          )}
        </Box>
      );
    }

    case 'list': {
      const t = token as Tokens.List;
      return (
        <Box key={`list-${index}`} flexDirection="column" marginLeft={context.depth > 0 ? 2 : 0}>
          {t.items.map((item, ii) => {
            const marker = item.task
              ? item.checked
                ? '[x]'
                : '[ ]'
              : t.ordered
                ? `${(typeof t.start === 'number' ? t.start : 1) + ii}.`
                : '•';
            const markerColor = item.task
              ? item.checked
                ? theme.mdCheckboxChecked
                : theme.mdCheckboxUnchecked
              : theme.mdListMarker;
            // Incremental: marker column + margins. Nested lists receive an already-reduced width.
            const itemWidth = nestedContentWidth(terminalWidth, {
              depth: 0,
              listGutter: 5,
              blockquoteDepth: 0,
            });
            return (
              <Box key={`li-${index}-${ii}`} flexDirection="row" marginLeft={2}>
                <Box width={3} flexShrink={0}>
                  <Text color={markerColor}>{marker}</Text>
                </Box>
                <Box flexDirection="column" flexGrow={1}>
                  {item.tokens.map((childToken, ci) => {
                    if (childToken.type === 'text') {
                      const textToken = childToken as Tokens.Text & { tokens?: Token[] };
                      const childRuns = textToken.tokens?.length
                        ? inlineRunsFromTokens(
                            textToken.tokens,
                            { color: context.textColor ?? theme.text },
                            theme,
                          )
                        : [{ text: textToken.text, color: context.textColor ?? theme.text }];
                      if (itemWidth) {
                        const wrapped = wrappedInlineRuns(childRuns, itemWidth);
                        return (
                          <Box key={`lit-${index}-${ii}-${ci}`} flexDirection="column">
                            {wrapped.map((lineRuns, li) => (
                              <Box key={`lit-${index}-${ii}-${ci}-l${li}`}>
                                <InlineRuns runs={lineRuns} />
                              </Box>
                            ))}
                          </Box>
                        );
                      }
                      return (
                        <Box key={`lit-${index}-${ii}-${ci}`}>
                          <InlineRuns runs={childRuns} />
                        </Box>
                      );
                    }
                    return renderBlockToken(
                      childToken,
                      theme,
                      index * 1000 + ii * 100 + ci,
                      itemWidth,
                      { ...context, depth: context.depth + 1 },
                    );
                  })}
                </Box>
              </Box>
            );
          })}
        </Box>
      );
    }

    case 'hr': {
      const rule = layoutHorizontalRule(terminalWidth);
      return (
        <Box key={`hr-${index}`}>
          <Text color={theme.mdHr} dimColor>
            {rule}
          </Text>
        </Box>
      );
    }

    case 'table': {
      const t = token as Tokens.Table;
      if (t.header.length === 0 && t.rows.length === 0) return null;

      const layout = layoutTable({
        header: t.header.map((cell) => ({ text: cell.text })),
        rows: t.rows.map((row) => row.map((cell) => ({ text: cell.text }))),
        align: t.align ?? [],
        terminalWidth: terminalWidth ?? 80,
      });

      if (layout.mode === 'stacked') {
        return (
          <Box key={`table-${index}`} flexDirection="column" marginBottom={1}>
            {layout.lines.map((line, li) => (
              <Text key={`table-${index}-s${li}`} color={theme.text}>
                {line}
              </Text>
            ))}
          </Box>
        );
      }

      return (
        <Box key={`table-${index}`} flexDirection="column" marginBottom={1}>
          <Text color={theme.mdTableBorder}>{layout.top}</Text>
          {layout.headerRows.map((row, ri) =>
            renderTableCells(row, `tr-${index}-h${ri}`, theme, true),
          )}
          <Text color={theme.mdTableBorder}>{layout.middle}</Text>
          {layout.bodyRows.map((row, ri) => renderTableCells(row, `tr-${index}-${ri}`, theme))}
          <Text color={theme.mdTableBorder}>{layout.bottom}</Text>
        </Box>
      );
    }

    case 'space':
      return null;

    case 'html': {
      const t = token as Tokens.HTML;
      if (t.block && t.text) {
        return (
          <Box key={`html-${index}`}>
            <Text color={theme.subtle} dimColor>
              {t.text}
            </Text>
          </Box>
        );
      }
      return null;
    }

    default:
      return null;
  }
}

/**
 * Renders markdown content into Ink components.
 *
 * Uses marked.lexer() to tokenize the markdown string, then maps each
 * block-level token to Ink Box/Text components with appropriate styling
 * from the current theme (mdCodeBackground, mdHeading, mdLink, etc.).
 */
export function MarkdownBlock({ content, terminalWidth, isStreaming = false }: MarkdownBlockProps) {
  const theme = useTheme();

  const parsedContent = useThrottledValue(content, 60);
  const effectiveContent = parsedContent || content;

  if (!effectiveContent) return null;

  const tokens = useMemo(() => marked.lexer(effectiveContent), [effectiveContent]);

  return (
    <Box flexDirection="column">
      {tokens.map((token, i) =>
        renderBlockToken(token, theme, i, terminalWidth, {
          depth: 0,
          isStreaming,
          blockquoteDepth: 0,
        }),
      )}
    </Box>
  );
}
