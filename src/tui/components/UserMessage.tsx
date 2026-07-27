import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from '../theme.js';
import type { ImageAttachment } from '../../types/messages.js';

interface UserMessageProps {
  content: string;
  attachments?: ImageAttachment[];
  terminalWidth?: number;
  screenReader?: boolean;
}

/**
 * Split content into text segments and @mention tokens.
 * Matches the same pattern as input-expansion's findMentionTokens
 * but without filesystem dependencies — just identifies @path and @"path"
 * tokens for color highlighting.
 */
function parseMentionSegments(content: string): Array<{ text: string; isMention: boolean }> {
  const segments: Array<{ text: string; isMention: boolean }> = [];
  let i = 0;
  let textStart = 0;

  function isBoundary(idx: number): boolean {
    if (idx === 0) return true;
    return /[\s([{<"']/.test(content[idx - 1]);
  }

  while (i < content.length) {
    if (content[i] !== '@' || !isBoundary(i)) {
      i++;
      continue;
    }

    const afterAt = i + 1;
    if (afterAt >= content.length || /\s/.test(content[afterAt])) {
      i++;
      continue;
    }

    let mentionEnd: number | null = null;

    if (content[afterAt] === '"') {
      const close = content.indexOf('"', afterAt + 1);
      if (close !== -1) {
        const filePath = content.slice(afterAt + 1, close);
        if (filePath) {
          mentionEnd = close + 1;
        } else {
          i = close + 1;
          continue;
        }
      } else {
        i++;
        continue;
      }
    } else {
      let end = afterAt;
      while (end < content.length && !/\s/.test(content[end])) end++;
      // Strip trailing punctuation
      let cleanEnd = end;
      while (cleanEnd > afterAt && /[.,;:!?)]/.test(content[cleanEnd - 1])) cleanEnd--;
      if (cleanEnd > afterAt) {
        mentionEnd = cleanEnd;
      } else {
        i = end;
        continue;
      }
    }

    if (mentionEnd !== null) {
      // Flush preceding plain text
      if (textStart < i) {
        segments.push({ text: content.slice(textStart, i), isMention: false });
      }
      segments.push({ text: content.slice(i, mentionEnd), isMention: true });
      i = mentionEnd;
      textStart = i;
    }
  }

  // Flush remaining plain text
  if (textStart < content.length) {
    segments.push({ text: content.slice(textStart), isMention: false });
  }

  return segments;
}

/**
 * User message card with an inset paper tint and a warm accent rail.
 * @mentions keep the brand color for quick scanning.
 */
function UserMessageInner({
  content,
  attachments = [],
  terminalWidth = 80,
  screenReader = false,
}: UserMessageProps) {
  const theme = useTheme();
  const width = Math.max(20, Math.floor(terminalWidth));
  const cardWidth = Math.max(18, width - 2);
  const segments = parseMentionSegments(content);

  if (screenReader) {
    return (
      <Box width={width}>
        <Text wrap="wrap">
          {content}
          {attachments.length > 0
            ? `${content ? '\n' : ''}${attachments.length} image attachment${attachments.length === 1 ? '' : 's'}`
            : ''}
        </Text>
      </Box>
    );
  }

  return (
    <Box
      width={cardWidth}
      marginX={1}
      paddingX={1}
      borderStyle="single"
      borderColor={theme.userAccent}
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      backgroundColor={theme.userBg}
    >
      <Box width={Math.max(1, cardWidth - 3)}>
        <Box flexDirection="column">
          {content ? (
            <Text wrap="wrap">
              {segments.map((seg, i) =>
                seg.isMention ? (
                  <Text key={i} color={theme.brand}>
                    {seg.text}
                  </Text>
                ) : (
                  <Text key={i} color={theme.text}>
                    {seg.text}
                  </Text>
                ),
              )}
            </Text>
          ) : null}
          {attachments.length > 0 ? (
            <Text color={theme.brand}>
              {attachments.map((_, index) => `[image ${index + 1}]`).join(' ')}
            </Text>
          ) : null}
        </Box>
      </Box>
    </Box>
  );
}

export const UserMessage = React.memo(UserMessageInner);
