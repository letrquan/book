import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { useKeyState } from '../hooks/useKeyState.js';
import { useTheme } from '../theme.js';
import type { McpHostServerSnapshot } from '../../mcp-host.js';
import { ChoiceList, DecisionSheet, type Choice } from './chrome.js';
import { PANEL_CHROME, frameGrid } from '../layout.js';

interface McpServerApprovalPromptProps {
  server: McpHostServerSnapshot;
  /** Additional servers still waiting after this one. */
  remainingCount: number;
  onApprove: () => { ok: boolean; error?: string };
  onReject: () => { ok: boolean; error?: string };
  onDefer: () => void;
  /** Terminal columns; the sheet's rule spans them. */
  terminalWidth?: number;
}

const OPTIONS = [
  {
    key: 'approve' as const,
    label: 'Approve and connect',
    hint: 'saved to .book/settings.local.json',
  },
  { key: 'reject' as const, label: 'Reject', hint: 'saved; will not connect in this project' },
];

/**
 * One-time trust prompt for a server declared in the workspace `.mcp.json`.
 * The full non-secret connection target is always shown. Header names are
 * listed separately while their values remain redacted.
 */
export function McpServerApprovalPrompt({
  server,
  remainingCount,
  onApprove,
  onReject,
  onDefer,
  terminalWidth = 80,
}: McpServerApprovalPromptProps) {
  const theme = useTheme();
  const [selected, setSelected, currentSelected] = useKeyState(0);
  const [error, setError] = useState<string>();

  const decide = (key: (typeof OPTIONS)[number]['key']) => {
    const result = key === 'approve' ? onApprove() : onReject();
    if (!result.ok) setError(result.error ?? 'Could not save the decision.');
  };

  useInput((input, key) => {
    if (key.escape) return onDefer();
    if (key.upArrow || key.downArrow) {
      setSelected((currentSelected() + 1) % OPTIONS.length);
      setError(undefined);
      return;
    }
    // `currentSelected()`, not `selected`: a batched `↓`+Enter — one paste, one
    // fast repeat — used to confirm the option armed before the arrow, which on
    // a two-option trust gate means approving the server the user moved off.
    if (key.return) return decide(OPTIONS[currentSelected()].key);
    if (input === 'y' || input === 'Y') return decide('approve');
    if (input === 'n' || input === 'N') return decide('reject');
  });

  const width = frameGrid(Math.max(20, Math.floor(terminalWidth))).width;
  const contentWidth = Math.max(12, width - PANEL_CHROME);
  const waiting =
    remainingCount > 0
      ? ` · ${remainingCount} more server${remainingCount === 1 ? '' : 's'} waiting`
      : '';
  const choices: Choice[] = OPTIONS.map((option) => ({ label: option.label, detail: option.hint }));
  // Trusting a server a repository declares is a permission like any other, so
  // it gets the permission sheet's tone.
  return (
    <DecisionSheet
      label="MCP server"
      tone={theme.permission}
      meta={`${server.name}${waiting}`}
      width={width}
    >
      <Text bold color={theme.text}>
        Use “{server.name}” from this project?
      </Text>
      <Text color={theme.subtle} wrap="wrap">
        {server.path} declares this server. Approving connects using the configuration below.
      </Text>
      {server.configChangedSinceApproval ? (
        <Text color={theme.warning}>
          ! Its connection configuration changed since you last decided, so approval is required
          again.
        </Text>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        <Text wrap="wrap">
          <Text color={theme.inactive}>{'target   '}</Text>
          <Text color={theme.text}>{server.target}</Text>
        </Text>
        {server.envKeys.length > 0 ? (
          <Text wrap="wrap">
            <Text color={theme.inactive}>{'env      '}</Text>
            <Text color={theme.text}>{server.envKeys.join(', ')}</Text>
          </Text>
        ) : null}
        {server.headerKeys.length > 0 ? (
          <Text wrap="wrap">
            <Text color={theme.inactive}>{'headers  '}</Text>
            <Text color={theme.text}>{server.headerKeys.join(', ')}</Text>
            <Text color={theme.inactive}> (values hidden)</Text>
          </Text>
        ) : null}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        <ChoiceList choices={choices} selected={selected} width={contentWidth} numbered={false} />
      </Box>
      {error ? <Text color={theme.error}>✕ {error}</Text> : null}
      <Box marginTop={1}>
        <Text color={theme.inactive}>
          ↑↓ select · Enter confirm · y approve · n reject · Esc not now
        </Text>
      </Box>
    </DecisionSheet>
  );
}
