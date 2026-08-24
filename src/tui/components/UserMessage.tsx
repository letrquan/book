import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from '../theme.js';
import { CONTENT_COLUMN, transcriptGrid } from '../layout.js';
import { TurnRule } from './TurnRule.js';
import type { ImageAttachment } from '../../types/messages.js';

interface UserMessageProps {
  content: string;
  attachments?: ImageAttachment[];
  terminalWidth?: number;
  /** Turn start time, shown at the right edge of the turn rule. */
  timestamp?: number;
  screenReader?: boolean;
}

function formatTurnTime(timestamp?: number): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
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
 * A user turn: a labelled rule, then the prompt on the content column.
 *
 * The rule is what makes a long transcript scannable — it is the only element
 * that marks where one exchange ended and the next began. The prompt itself
 * needs no tint or rail; @mentions stay accented for quick scanning.
 */
function UserMessageInner({
  content,
  attachments = [],
  terminalWidth = 80,
  timestamp,
  screenReader = false,
}: UserMessageProps) {
  const theme = useTheme();
  const grid = transcriptGrid(terminalWidth);
  const width = grid.width;
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
    <Box flexDirection="column" width={width}>
      <TurnRule
        label="you"
        trailing={formatTurnTime(timestamp)}
        width={width - 1}
        accent={theme.userAccent}
      />
      <Box marginLeft={CONTENT_COLUMN} width={grid.content} flexDirection="column">
        {content ? (
          <Text wrap="wrap">
            {segments.map((seg, i) =>
              seg.isMention ? (
                <Text key={i} color={theme.userAccent}>
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
          <Text color={theme.userAccent}>
            {attachments.map((_, index) => `[image ${index + 1}]`).join(' ')}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
}

export const UserMessage = React.memo(UserMessageInner);
