import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from '../theme.js';
import { CONTENT_COLUMN, transcriptGrid } from '../layout.js';
import { displayWidth, hardWrapLine } from './word-wrap.js';
import { PILCROW } from '../marks.js';
import { mentionTokenRanges } from '../../input/input-expansion.js';
import type { ImageAttachment } from '../../types/messages.js';

interface UserMessageProps {
  content: string;
  attachments?: ImageAttachment[];
  terminalWidth?: number;
  /** Turn start time, shown at the right edge of the turn rule. */
  timestamp?: number;
  screenReader?: boolean;
}

/** The turn's start time as the transcript prints it, in the system locale. */
export function formatTurnTime(timestamp?: number): string {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

/**
 * Split content into text segments and @mention tokens.
 * Shares `findMentionTokens` with input-expansion, so the TUI never accents an
 * at-sign the agent loop would not expand — an at-sign inside fenced or inline
 * code is left as plain text. The ranges are the ones `mentionTokenRanges`
 * found in the *whole* prompt: a fence or a code span that spans lines only
 * reads as code when the lines are taken together (#261).
 */
function parseMentionSegments(
  content: string,
  ranges: ReadonlyArray<[number, number]>,
): Array<{ text: string; isMention: boolean }> {
  const segments: Array<{ text: string; isMention: boolean }> = [];
  let cursor = 0;

  for (const [start, end] of ranges) {
    if (start > cursor) segments.push({ text: content.slice(cursor, start), isMention: false });
    segments.push({ text: content.slice(start, end), isMention: true });
    cursor = end;
  }
  if (cursor < content.length) {
    segments.push({ text: content.slice(cursor), isMention: false });
  }

  return segments;
}

/**
 * Columns the prompt text wraps at.
 *
 * The row stops one column short of the terminal, spends the gutter on the
 * pilcrow, and keeps the time clear at the right edge when the turn has one.
 * The time is measured, not assumed: `19:13` is five columns, but the system
 * locale can make it `19 h 13`, and a fixed five pushed that onto a second row
 * of every turn. The transcript's row estimate uses the same measure, so a
 * wrapped prompt is sized before it mounts exactly as it renders.
 */
export function userTurnTextWidth(terminalWidth: number, time: string): number {
  const rowWidth = transcriptGrid(terminalWidth).width - 1;
  const timeColumn = time ? displayWidth(time) + 2 : 1;
  return Math.max(8, rowWidth - CONTENT_COLUMN - timeColumn);
}

/** A run of prompt text, accented when it is an @mention. */
export interface PromptPiece {
  text: string;
  isMention: boolean;
}

const TAB = '    ';

/**
 * Wraps one hard line of a prompt into rows of at most `width` columns.
 *
 * `mentionRanges` are this line's, already resolved against the whole prompt and
 * given in columns of `line`. The line's indentation is kept, on its first row
 * and on every row it wraps onto, so a pasted code block keeps its shape. Words
 * break at whitespace, and a run of spaces at a break is dropped rather than
 * carried to the end of a row where it would push it past `width`. An @mention is
 * one unbreakable word, so a quoted path that wraps keeps its accent; only a word
 * wider than a whole row is cut.
 */
function wrapPromptLine(
  line: string,
  width: number,
  mentionRanges: ReadonlyArray<[number, number]>,
): PromptPiece[][] {
  const lead = /^[ \t]*/.exec(line)![0];
  const body = line.slice(lead.length);
  if (!body) return [[]];
  // The line's own columns, past the indent the rows open with.
  const bodyRanges = mentionRanges
    .filter(([start, end]) => start >= lead.length && end <= line.length)
    .map(([start, end]): [number, number] => [start - lead.length, end - lead.length]);
  // Leave at least half the row for text, however deep the indent.
  const indent = lead.replace(/\t/g, TAB).slice(0, Math.floor(width / 2));
  const indentWidth = displayWidth(indent);
  const room = Math.max(1, width - indentWidth);

  const rows: PromptPiece[][] = [];
  let row: PromptPiece[] = [];
  let used = 0;
  let space = '';
  const startRow = () => {
    row = indent ? [{ text: indent, isMention: false }] : [];
    used = 0;
  };
  const place = (word: PromptPiece) => {
    const chunks = hardWrapLine(word.text, room);
    chunks.forEach((chunk, index) => {
      if (index > 0) {
        rows.push(row);
        startRow();
      }
      row.push({ text: chunk, isMention: word.isMention });
      used = displayWidth(chunk);
    });
  };

  startRow();
  for (const segment of parseMentionSegments(body, bodyRanges)) {
    const tokens = segment.isMention ? [segment.text] : segment.text.split(/(\s+)/);
    for (const token of tokens) {
      if (!token) continue;
      if (!segment.isMention && /^\s+$/.test(token)) {
        space = token.replace(/\t/g, TAB);
        continue;
      }
      const word = { text: token, isMention: segment.isMention };
      const wordWidth = displayWidth(token);
      if (used === 0) {
        place(word);
      } else if (used + displayWidth(space) + wordWidth <= room) {
        if (space) row.push({ text: space, isMention: false });
        row.push(word);
        used += displayWidth(space) + wordWidth;
      } else {
        rows.push(row);
        startRow();
        place(word);
      }
      space = '';
    }
  }
  rows.push(row);
  return rows;
}

/** A prompt as the transcript sets it: one entry per row, each within `width`. */
export function wrapUserPrompt(content: string, width: number): PromptPiece[][] {
  if (!content) return [];
  // The whole prompt is scanned once, before it is split: a fence or a code span
  // that crosses a line break is only visible with the lines together (#261).
  const ranges = mentionTokenRanges(content);
  let offset = 0;
  return content.split('\n').flatMap((line) => {
    const lineRanges = ranges
      .filter(([start, end]) => start >= offset && end <= offset + line.length)
      .map(([start, end]): [number, number] => [start - offset, end - offset]);
    offset += line.length + 1;
    return wrapPromptLine(line, width, lineRanges);
  });
}

/** Rows a user turn takes at `terminalWidth`, for the transcript's row estimate. */
export function userTurnRows(
  content: string,
  terminalWidth: number,
  timestamp?: number,
  attachmentCount = 0,
): number {
  const width = userTurnTextWidth(terminalWidth, formatTurnTime(timestamp));
  return Math.max(1, wrapUserPrompt(content, width).length + (attachmentCount > 0 ? 1 : 0));
}

/**
 * A user turn, set the way a rubricated manuscript opens a paragraph.
 *
 * A red pilcrow hangs in the gutter and the prompt is set upright in the
 * brightest ink on screen, a step above the agent's prose, so your words read as
 * a different voice without a band, a box or a rule through the screen. The
 * pilcrow is what a long transcript is scanned by: it is the only red mark at
 * the margin, and it is the same mark as the composer's, so what you typed
 * lands in the transcript under the glyph you typed it after. The time sits at
 * the right edge of the first row. @mentions stay accented.
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
  const textWidth = userTurnTextWidth(terminalWidth, time);
  const rows: Array<{ pieces: PromptPiece[]; attachment?: string }> = wrapUserPrompt(
    content,
    textWidth,
  ).map((pieces) => ({ pieces }));
  if (attachments.length > 0) {
    rows.push({
      pieces: [],
      attachment: attachments.map((_, index) => `[image ${index + 1}]`).join(' '),
    });
  }
  if (rows.length === 0) rows.push({ pieces: [] });

  return (
    <Box flexDirection="column" width={rowWidth}>
      {rows.map((row, index) => {
        const rowText = row.attachment ?? row.pieces.map((piece) => piece.text).join('');
        const gap = Math.max(0, textWidth - displayWidth(rowText));
        return (
          <Box key={index} width={rowWidth}>
            <Text color={theme.userAccent}>{index === 0 ? `${PILCROW} ` : '  '}</Text>
            {row.attachment !== undefined ? (
              <Text color={theme.userAccent}>{row.attachment}</Text>
            ) : (
              row.pieces.map((piece, i) => (
                <Text key={i} color={piece.isMention ? theme.userAccent : theme.userText}>
                  {piece.text}
                </Text>
              ))
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
