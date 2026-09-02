import { Box, Text, useInput } from 'ink';
import { useState } from 'react';
import { useKeyState } from '../hooks/useKeyState.js';
import { useTheme } from '../theme.js';
import type { McpHostServerSnapshot } from '../../mcp-host.js';
import { SelectionRow, SoftPanel, PanelTitle } from './chrome.js';

interface McpServerApprovalPromptProps {
  server: McpHostServerSnapshot;
  /** Additional servers still waiting after this one. */
  remainingCount: number;
  onApprove: () => { ok: boolean; error?: string };
  onReject: () => { ok: boolean; error?: string };
  onDefer: () => void;
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

  return (
    <SoftPanel tone="permission">
      <PanelTitle>Use MCP server “{server.name}” from this project?</PanelTitle>
      <Text color={theme.subtle}>
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
          <Text color={theme.subtle}>target </Text>
          {server.target}
        </Text>
        {server.envKeys.length > 0 ? (
          <Text color={theme.subtle}>env {server.envKeys.join(', ')}</Text>
        ) : null}
        {server.headerKeys.length > 0 ? (
          <Text color={theme.subtle}>headers {server.headerKeys.join(', ')} (values hidden)</Text>
        ) : null}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {OPTIONS.map((option, index) => (
          <SelectionRow key={option.key} selected={index === selected}>
            {index === selected ? '›' : ' '} {option.label.padEnd(22)}{' '}
            <Text color={theme.subtle}>{option.hint}</Text>
          </SelectionRow>
        ))}
      </Box>
      <Text color={theme.subtle} dimColor>
        ↑↓ select · Enter confirm · y approve · n reject · Esc not now
        {remainingCount > 0
          ? ` · ${remainingCount} more server${remainingCount === 1 ? '' : 's'} waiting`
          : ''}
      </Text>
      {error ? <Text color={theme.error}>✕ {error}</Text> : null}
    </SoftPanel>
  );
}
