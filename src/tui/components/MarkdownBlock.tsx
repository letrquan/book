import { Text, Box } from 'ink';
import React from 'react';
import { marked, Tokens, Token } from 'marked';
import { useTheme } from '../theme.js';

interface MarkdownBlockProps {
  /** Raw markdown string to render. */
  content: string;
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
): React.ReactNode[] {
  return tokens.map((token, i) => {
    const key = `${keyPrefix}-${i}`;

    switch (token.type) {
      case 'text': {
        const t = token as Tokens.Text;
        return (
          <Text key={key} color={theme.text}>
            {t.text}
          </Text>
        );
      }
      case 'strong': {
        const t = token as Tokens.Strong;
        return (
          <Text key={key} bold color={theme.text}>
            {renderInlineTokens(t.tokens, theme, key)}
          </Text>
        );
      }
      case 'em': {
        const t = token as Tokens.Em;
        return (
          <Text key={key} italic color={theme.text}>
            {renderInlineTokens(t.tokens, theme, key)}
          </Text>
        );
      }
      case 'del': {
        const t = token as Tokens.Del;
        return (
          <Text key={key} strikethrough color={theme.subtle}>
            {renderInlineTokens(t.tokens, theme, key)}
          </Text>
        );
      }
      case 'codespan': {
        const t = token as Tokens.Codespan;
        return (
          <Text
            key={key}
            backgroundColor={theme.mdInlineCodeBg}
            color={theme.mdInlineCodeText}
          >
            {t.text}
          </Text>
        );
      }
      case 'link': {
        const t = token as Tokens.Link;
        return (
          <Text key={key} color={theme.mdLink} underline>
            {renderInlineTokens(t.tokens, theme, key)}
          </Text>
        );
      }
      case 'image': {
        const t = token as Tokens.Image;
        // Terminals can't display images; render alt text instead.
        return (
          <Text key={key} color={theme.mdLink} dimColor>
            [Image: {t.text || t.href}]
          </Text>
        );
      }
      case 'br': {
        return (
          <Box key={key} height={1} />
        );
      }
      case 'escape': {
        const t = token as Tokens.Escape;
        return (
          <Text key={key} color={theme.text}>
            {t.text}
          </Text>
        );
      }
      case 'html': {
        // Strip inline HTML tags — render plain text content if available.
        const t = token as Tokens.HTML;
        if (t.text && !t.block) {
          return (
            <Text key={key} color={theme.subtle} dimColor>
              {t.text}
            </Text>
          );
        }
        return null;
      }
      default:
        return null;
    }
  });
}

/**
 * Render a block-level token into an Ink Box/Text component tree.
 */
function renderBlockToken(
  token: Token,
  theme: ReturnType<typeof useTheme>,
  index: number,
): React.ReactNode {
  switch (token.type) {
    case 'heading': {
      const t = token as Tokens.Heading;
      return (
        <Box key={`h-${index}`} flexDirection="column" marginTop={1} marginBottom={1}>
          <Text bold color={theme.mdHeading}>
            {renderInlineTokens(t.tokens, theme, `h-${index}`)}
          </Text>
        </Box>
      );
    }

    case 'paragraph': {
      const t = token as Tokens.Paragraph;
      return (
        <Box key={`p-${index}`} flexDirection="row" marginBottom={1}>
          <Text wrap="wrap">
            {renderInlineTokens(t.tokens, theme, `p-${index}`)}
          </Text>
        </Box>
      );
    }

    case 'code': {
      const t = token as Tokens.Code;
      const lines = t.text.split('\n');
      // Skip trailing empty line if present from backtick fence.
      const displayLines =
        lines.length > 0 && lines[lines.length - 1] === ''
          ? lines.slice(0, -1)
          : lines;

      return (
        <Box
          key={`code-${index}`}
          flexDirection="column"
          paddingX={1}
          borderStyle="round"
          borderColor={theme.mdCodeBorder}
          backgroundColor={theme.mdCodeBackground}
        >
          {t.lang ? (
            <Box marginBottom={1}>
              <Text color={theme.mdCodeBorder} dimColor>
                {t.lang}
              </Text>
            </Box>
          ) : null}
          {displayLines.map((line, li) => (
            <Box key={`code-${index}-l${li}`}>
              <Text color={theme.mdCodeText}>{line}</Text>
            </Box>
          ))}
        </Box>
      );
    }

    case 'blockquote': {
      const t = token as Tokens.Blockquote;
      return (
        <Box
          key={`bq-${index}`}
          flexDirection="column"
          borderLeft
          borderLeftColor={theme.mdBlockquoteBorder}
          paddingLeft={1}
        >
          {t.tokens.map((childToken, ci) =>
            renderBlockToken(childToken, theme, index * 1000 + ci),
          )}
        </Box>
      );
    }

    case 'list': {
      const t = token as Tokens.List;
      return (
        <Box key={`list-${index}`} flexDirection="column">
          {t.items.map((item, ii) => {
            const marker = t.ordered
              ? `${(typeof t.start === 'number' ? t.start : 1) + ii}.`
              : '•';
            return (
              <Box key={`li-${index}-${ii}`} flexDirection="row" marginLeft={2}>
                <Box width={3} flexShrink={0}>
                  <Text color={theme.mdListMarker}>{marker}</Text>
                </Box>
                <Box flexDirection="column" flexGrow={1}>
                  {/* List item's tokens: typically a text token or nested blocks */}
                  {item.tokens.map((childToken, ci) => {
                    if (childToken.type === 'text') {
                      return (
                        <Box key={`lit-${index}-${ii}-${ci}`}>
                          <Text wrap="wrap">
                            {renderInlineTokens(
                              [childToken],
                              theme,
                              `lit-${index}-${ii}-${ci}`,
                            )}
                          </Text>
                        </Box>
                      );
                    }
                    return renderBlockToken(
                      childToken,
                      theme,
                      index * 1000 + ii * 100 + ci,
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
      return (
        <Box key={`hr-${index}`}>
          <Text color={theme.mdHr} dimColor>
            {'─'.repeat(40)}
          </Text>
        </Box>
      );
    }

    case 'table': {
      const t = token as Tokens.Table;
      // Basic table rendering with column padding. Terminal lacks grid drawing.
      // Build a simple aligned text table.
      const allRows = [t.header, ...t.rows];
      if (allRows.length === 0) return null;

      const colWidths: number[] = [];
      for (const row of allRows) {
        for (let ci = 0; ci < row.length; ci++) {
          const len = row[ci].text.length;
          colWidths[ci] = Math.max(colWidths[ci] ?? 3, len);
        }
      }

      return (
        <Box key={`table-${index}`} flexDirection="column">
          {allRows.map((row, ri) => (
            <Box key={`tr-${index}-${ri}`} flexDirection="row">
              {row.map((cell, ci) => {
                const padding = ' '.repeat(
                  Math.max(0, (colWidths[ci] ?? 3) - cell.text.length + 2),
                );
                return (
                  <Text
                    key={`tc-${index}-${ri}-${ci}`}
                    bold={cell.header}
                    color={theme.text}
                  >
                    {cell.text}
                    {padding}
                  </Text>
                );
              })}
            </Box>
          ))}
        </Box>
      );
    }

    case 'space': {
      // Skip space tokens — blocks handle their own spacing.
      return null;
    }

    case 'html': {
      const t = token as Tokens.HTML;
      // HTML blocks: render the text content if available.
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
 *
 * Supported markdown features:
 * - Headings (h1-h6) — rendered as bold text
 * - Paragraphs — wrapped text
 * - Fenced/indented code blocks — bordered box with background
 * - Inline code — background-highlighted text
 * - Bold, italic, strikethrough text
 * - Blockquotes — left-border box
 * - Ordered and unordered lists
 * - Horizontal rules
 * - Links — underlined colored text
 * - Tables — basic aligned columns
 * - Images — alt-text placeholder (terminals can't render images)
 */
export function MarkdownBlock({ content }: MarkdownBlockProps) {
  const theme = useTheme();

  if (!content) return null;

  const tokens = marked.lexer(content);

  return (
    <Box flexDirection="column">
      {tokens.map((token, i) => renderBlockToken(token, theme, i))}
    </Box>
  );
}
