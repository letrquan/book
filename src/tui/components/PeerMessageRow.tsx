import { Box, Text } from 'ink';
import React from 'react';
import { useTheme } from '../theme.js';
import { CONTENT_COLUMN, transcriptGrid } from '../layout.js';
import { ItemMark } from './transcript-item.js';
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

/** Rows a `peer-message` turn takes at `terminalWidth`, for the transcript's row estimate. */
export function peerMessageRows(
  peers: readonly PeerMessageDisplay[],
  terminalWidth: number,
): number {
  const grid = transcriptGrid(terminalWidth);
  return peers.reduce((rows, peer) => {
    const heading = Math.max(1, Math.ceil(displayWidth(peerMessageHeading(peer)) / grid.content));
    const body = shownBody(peer)
      .split('\n')
      .reduce(
        (total, line) => total + Math.max(1, Math.ceil(displayWidth(line) / grid.content)),
        0,
      );
    return rows + heading + body;
  }, 0);
}

/**
 * Another session's message (#620), delivered as a turn: an item mark in the warning colour and
 * who it is from, then the message on the content column, dim. It is never drawn under the
 * prompt mark, which is the user's alone.
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
  return (
    <Box flexDirection="column" width={grid.width - 1}>
      {peers.map((peer, index) => (
        <Box key={`${peer.msgId ?? 'peer'}-${index}`} flexDirection="column">
          <Box>
            {screenReader ? null : <ItemMark state="pending" />}
            <Box flexGrow={1} flexShrink={1}>
              <Text color={theme.warning} wrap="wrap">
                {peerMessageHeading(peer)}
              </Text>
            </Box>
          </Box>
          <Box marginLeft={screenReader ? 0 : CONTENT_COLUMN} width={grid.content}>
            <Text color={theme.subtle} wrap="wrap">
              {shownBody(peer)}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
