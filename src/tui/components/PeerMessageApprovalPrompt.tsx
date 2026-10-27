import { Box, Text, useInput } from 'ink';
import { useRef } from 'react';
import { useKeyState } from '../hooks/useKeyState.js';
import { useTheme } from '../theme.js';
import {
  APPROVAL_PREVIEW_CHARS,
  heldBody,
  holdCauseText,
  peerTextSpan,
  type HeldPeerMessage,
} from '../../messaging/hold.js';
import { ChoiceList, DecisionSheet, type Choice } from './chrome.js';
import { PANEL_CHROME, frameGrid } from '../layout.js';

interface PeerMessageApprovalPromptProps {
  held: HeldPeerMessage;
  /** Messages held from this message's sender, this one included: the sheet asks once per sender. */
  fromSender: number;
  /** Messages held from other senders. */
  fromOthers: number;
  onApprove: () => void;
  onDeny: () => void;
  /** Deny everything held from this sender, and refuse what it sends from the other class later. */
  onDenyAllFromSender: () => void;
  /** Deny everything held, from every sender. */
  onDenyAll: () => void;
  onDefer: () => void;
  /** Terminal columns; the sheet's rule spans them. */
  terminalWidth?: number;
}

type OptionKey = 'approve' | 'deny' | 'deny-sender' | 'deny-all' | 'later';

/** How long the sheet ignores keys after it appears: a typed-ahead Enter must answer nothing. */
export const PEER_APPROVAL_ARM_MS = 500;

/** When a held message expires, as the sheet names it: the time, and the date when it is far off. */
function expiryTime(epochMs: number, now = Date.now()): string {
  const date = new Date(epochMs);
  return epochMs - now > 12 * 60 * 60_000 ? date.toLocaleString() : date.toLocaleTimeString();
}

/**
 * The approval sheet for a peer message the receive policy held (#620 PR 5): deliver it now, deny
 * it, or decide later. Everything the peer wrote is shown as sanitized spans (`peerTextSpan`), so
 * its text cannot draw a choice or a hint of its own.
 *
 * "Later" is the choice the sheet opens on, no letter key answers it, and it ignores every key for
 * {@link PEER_APPROVAL_ARM_MS} after it appears: a sheet that appears under a typed-ahead Enter,
 * or a word that starts with `y`, must never deliver anything.
 */
export function PeerMessageApprovalPrompt({
  held,
  fromSender,
  fromOthers,
  onApprove,
  onDeny,
  onDenyAllFromSender,
  onDenyAll,
  onDefer,
  terminalWidth = 80,
}: PeerMessageApprovalPromptProps) {
  const theme = useTheme();
  const options: Array<{ key: OptionKey; label: string; hint: string }> = [
    {
      key: 'approve',
      label: 'Deliver now',
      hint: 'as a peer turn, under prompting-mode rules',
    },
    { key: 'deny', label: 'Deny', hint: 'not delivered; its sender is told' },
    {
      key: 'deny-sender',
      label: 'Deny all from this sender',
      hint: 'and refuse what it sends from the other class from now on',
    },
    { key: 'deny-all', label: 'Deny all held', hint: 'from every sender' },
    {
      key: 'later',
      label: 'Later',
      hint: `everything from this sender; asked again when idle, expires at ${expiryTime(held.expiresAt)}`,
    },
  ];
  const [selected, setSelected, currentSelected] = useKeyState(options.length - 1);
  const shownAt = useRef(Date.now());

  const decide = (key: OptionKey) => {
    if (key === 'approve') onApprove();
    else if (key === 'deny') onDeny();
    else if (key === 'deny-sender') onDenyAllFromSender();
    else if (key === 'deny-all') onDenyAll();
    else onDefer();
  };

  useInput((_input, key) => {
    if (Date.now() - shownAt.current < PEER_APPROVAL_ARM_MS) return;
    if (key.escape) return onDefer();
    // The arrows stop at the ends rather than wrap: from Later, one stray ↓ must not reach
    // Deliver now.
    if (key.upArrow) return setSelected(Math.max(0, currentSelected() - 1));
    if (key.downArrow) return setSelected(Math.min(options.length - 1, currentSelected() + 1));
    // `currentSelected()`, not `selected`: a batched arrow and Enter must answer the row the arrow
    // moved to (see McpServerApprovalPrompt).
    if (key.return) return decide(options[currentSelected()].key);
  });

  const width = frameGrid(Math.max(20, Math.floor(terminalWidth))).width;
  const contentWidth = Math.max(12, width - PANEL_CHROME);
  const waiting =
    (fromSender > 1 ? ` · ${fromSender} held from this sender` : '') +
    (fromOthers > 0 ? ` · ${fromOthers} from others` : '');
  const choices: Choice[] = options.map((option) => ({
    label: option.label,
    detail: option.hint,
  }));
  return (
    <DecisionSheet
      label="Peer message"
      tone={theme.permission}
      meta={`${held.sender}${waiting}`}
      width={width}
    >
      <Text bold color={theme.text}>
        Deliver a message another session sent?
      </Text>
      <Text color={theme.subtle} wrap="wrap">
        {holdCauseText(held.cause)} It is not delivered until you approve it.
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text wrap="wrap">
          <Text color={theme.inactive}>{'from     '}</Text>
          <Text color={theme.text}>{held.sender}</Text>
          {held.claimedName !== undefined ? (
            <Text color={theme.inactive}> (peer claims name: {held.claimedName})</Text>
          ) : null}
          <Text color={theme.inactive}> · address not verified</Text>
        </Text>
        <Text wrap="wrap">
          <Text color={theme.inactive}>{'message  '}</Text>
          <Text color={theme.text}>
            {peerTextSpan(heldBody(held.message), APPROVAL_PREVIEW_CHARS)}
          </Text>
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <ChoiceList choices={choices} selected={selected} width={contentWidth} numbered={false} />
      </Box>
      <Box marginTop={1}>
        <Text color={theme.inactive}>↑↓ select · Enter confirm · Esc later</Text>
      </Box>
    </DecisionSheet>
  );
}
