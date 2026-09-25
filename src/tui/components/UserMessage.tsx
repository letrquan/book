import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from '../theme.js';
import { CONTENT_COLUMN, transcriptGrid } from '../layout.js';
import { displayWidth, wordWrap } from './word-wrap.js';
import { PILCROW } from '../marks.js';
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
 * Columns the prompt text wraps at.
 *
 * The row stops one column short of the terminal, spends the gutter on the
 * pilcrow, and keeps ` 19:13` clear at the right edge when the turn has a time.
 * The transcript's row estimate uses the same measure, so a wrapped prompt is
 * sized before it mounts exactly as it renders.
 */
export function userTurnTextWidth(terminalWidth: number, hasTime: boolean): number {
  const rowWidth = transcriptGrid(terminalWidth).width - 1;
  const timeColumn = hasTime ? TURN_TIME_WIDTH + 2 : 1;
  return Math.max(8, rowWidth - CONTENT_COLUMN - timeColumn);
}

/** `HH:MM`, the width of every turn time. */
const TURN_TIME_WIDTH = 5;

/**
 * A user turn, set the way a rubricated manuscript opens a paragraph.
 *
 * A red pilcrow hangs in the gutter and the prompt is set in italic, so your
 * words read as a different voice from the agent's roman prose without a band,
 * a box or a rule through the screen. The pilcrow is what a long transcript is
 * scanned by: it is the only red mark at the margin, and it is the same mark as
 * the composer's, so what you typed lands in the transcript under the glyph you
 * typed it after. The time sits at the right edge of the first row. @mentions
 * stay accented.
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

  const time = formatTurnTime(timestamp);
  // The row leaves the terminal's last column empty, like every other row.
  const rowWidth = width - 1;
  const textWidth = userTurnTextWidth(terminalWidth, Boolean(time));
  const lines = content ? wordWrap(content, textWidth).split('\n') : [];
  if (attachments.length > 0) {
    lines.push(attachments.map((_, index) => `[image ${index + 1}]`).join(' '));
  }
  if (lines.length === 0) lines.push('');

  return (
    <Box flexDirection="column" width={rowWidth}>
      {lines.map((line, index) => {
        const isAttachmentRow = attachments.length > 0 && index === lines.length - 1;
        const gap = Math.max(0, textWidth - displayWidth(line));
        return (
          <Box key={index} width={rowWidth}>
            <Text color={theme.userAccent}>{index === 0 ? `${PILCROW} ` : '  '}</Text>
            {isAttachmentRow ? (
              <Text color={theme.userAccent}>{line}</Text>
            ) : (
              <Text italic>
                {parseMentionSegments(line).map((seg, i) => (
                  <Text key={i} color={seg.isMention ? theme.userAccent : theme.text}>
                    {seg.text}
                  </Text>
                ))}
              </Text>
            )}
            {index === 0 && time ? (
              <>
                <Text>{' '.repeat(gap)}</Text>
                <Text color={theme.inactive}> {time}</Text>
              </>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

export const UserMessage = React.memo(UserMessageInner);
