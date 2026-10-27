import { Box, Text, useInput } from 'ink';
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
  /** Other held messages besides this one. */
  remainingCount: number;
  onApprove: () => void;
  onDeny: () => void;
  onDefer: () => void;
  /** Terminal columns; the sheet's rule spans them. */
  terminalWidth?: number;
}

type OptionKey = 'approve' | 'deny' | 'later';

/** The clock time a held message expires at, as the sheet names it. */
function clockTime(epochMs: number): string {
  const date = new Date(epochMs);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

/**
 * The approval sheet for a peer message the receive policy held (#620 PR 5): deliver it now, deny
 * it, or decide later. Everything the peer wrote is shown as sanitized spans (`peerTextSpan`), so
 * its text cannot draw a choice or a hint of its own.
 *
 * "Later" is the choice the sheet opens on, and no letter key answers it: a sheet that appears
 * under a typed-ahead Enter, or a word that starts with `y`, must never deliver anything.
 */
export function PeerMessageApprovalPrompt({
  held,
  remainingCount,
  onApprove,
  onDeny,
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
    { key: 'later', label: 'Later', hint: `stays held; expires at ${clockTime(held.expiresAt)}` },
  ];
  const [selected, setSelected, currentSelected] = useKeyState(options.length - 1);

  const decide = (key: OptionKey) => {
    if (key === 'approve') onApprove();
    else if (key === 'deny') onDeny();
    else onDefer();
  };

  useInput((_input, key) => {
    if (key.escape) return onDefer();
    if (key.upArrow) return setSelected((currentSelected() + options.length - 1) % options.length);
    if (key.downArrow) return setSelected((currentSelected() + 1) % options.length);
    // `currentSelected()`, not `selected`: a batched arrow and Enter must answer the row the arrow
    // moved to (see McpServerApprovalPrompt).
    if (key.return) return decide(options[currentSelected()].key);
  });

  const width = frameGrid(Math.max(20, Math.floor(terminalWidth))).width;
  const contentWidth = Math.max(12, width - PANEL_CHROME);
  const waiting = remainingCount > 0 ? ` · ${remainingCount} more held` : '';
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
