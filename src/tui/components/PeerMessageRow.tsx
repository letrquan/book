import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from '../theme.js';
import { resultContentWidth, transcriptGrid } from '../layout.js';
import { ItemMark, ResultBox } from './transcript-item.js';
import { displayWidth } from './word-wrap.js';
import { stripTerminalControls } from '../../control-characters.js';
import { peerSenderLabel } from '../../messaging/delivery.js';
import type { PeerMessageDisplay } from '../../types/messages.js';

/** The heading of one delivered message: who sent it, set apart from the user's own prompt. */
export function peerMessageHeading(peer: PeerMessageDisplay): string {
  return `Message from ${peerSenderLabel(peer)}${peer.attributed ? '' : ' (not a valid envelope)'}`;
}

/** The body as the row shows it: no escape sequence or bidi override reaches the terminal. */
function shownBody(peer: PeerMessageDisplay): string {
  return stripTerminalControls(peer.body).replace(/\s+$/, '');
}

/** Rows `text` wraps to at `width` columns. */
function wrappedRows(text: string, width: number): number {
  return text
    .split('\n')
    .reduce((rows, line) => rows + Math.max(1, Math.ceil(displayWidth(line) / width)), 0);
}

/**
 * Rows a `peer-message` turn takes at `terminalWidth`, for the transcript's row estimate: each
 * heading on the content column after its mark, each body in the result column under it, the
 * widths {@link PeerMessageRow} draws at.
 */
export function peerMessageRows(
  peers: readonly PeerMessageDisplay[],
  terminalWidth: number,
): number {
  const grid = transcriptGrid(terminalWidth);
  return peers.reduce(
    (rows, peer) =>
      rows +
      wrappedRows(peerMessageHeading(peer), grid.content) +
      wrappedRows(shownBody(peer), resultContentWidth(grid)),
    0,
  );
}

/**
 * Another session's message (#620), delivered as a turn: an item mark in the warning colour and
 * who it is from, then the message hung under it on the result rail, dim, the way a call's result
 * hangs under its heading. It is never drawn under the prompt mark, which is the user's alone.
 * Every column comes from the transcript grid (`tui/layout.ts`).
 */
export function PeerMessageRow({
  peers,
  terminalWidth = 80,
  screenReader = false,
}: {
  peers: readonly PeerMessageDisplay[];
  terminalWidth?: number;
  screenReader?: boolean;
}) {
  const theme = useTheme();
  const grid = transcriptGrid(terminalWidth);
  if (screenReader) {
    return (
      <Box flexDirection="column">
        {peers.map((peer, index) => (
          <Text key={`${peer.msgId ?? 'peer'}-${index}`} wrap="wrap">
            {`${peerMessageHeading(peer)}:\n${shownBody(peer)}`}
          </Text>
        ))}
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {peers.map((peer, index) => (
        <Box key={`${peer.msgId ?? 'peer'}-${index}`} flexDirection="column">
          <Box>
            <ItemMark state="pending" />
            <Box flexGrow={1} flexShrink={1}>
              <Text color={theme.warning} wrap="wrap">
                {peerMessageHeading(peer)}
              </Text>
            </Box>
          </Box>
          <ResultBox width={resultContentWidth(grid)}>
            <Text color={theme.subtle} wrap="wrap">
              {shownBody(peer)}
            </Text>
          </ResultBox>
        </Box>
      ))}
    </Box>
  );
}
