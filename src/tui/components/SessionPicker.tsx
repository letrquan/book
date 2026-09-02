import { Box, Text, useInput } from 'ink';
import { useMemo } from 'react';
import { useKeyState } from '../hooks/useKeyState.js';
import type { SessionMeta } from '../../types/sessions.js';
import { displaySessionName } from '../../session/name.js';
import { useTheme } from '../theme.js';
import { useDensityMetrics } from '../density.js';

interface SessionPickerProps {
  sessions: SessionMeta[];
  currentSessionId: string;
  onPick: (session: SessionMeta) => void;
  onCancel: () => void;
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function SessionPicker({
  sessions,
  currentSessionId,
  onPick,
  onCancel,
}: SessionPickerProps) {
  const theme = useTheme();
  const density = useDensityMetrics();
  const choices = useMemo(
    () => sessions.filter((session) => session.id !== currentSessionId),
    [currentSessionId, sessions],
  );
  const [selected, setSelected, currentSelected] = useKeyState(0);

  useInput(
    (_input, key) => {
      if (key.escape) return onCancel();
      if (choices.length === 0) return;
      if (key.upArrow) setSelected((currentSelected() - 1 + choices.length) % choices.length);
      if (key.downArrow) setSelected((currentSelected() + 1) % choices.length);
      if (key.return) onPick(choices[currentSelected()]);
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.brand}>
        Resume conversation
      </Text>
      {choices.length === 0 ? (
        <Text color={theme.subtle}>(no other sessions in this workspace)</Text>
      ) : (
        choices.slice(0, 12).map((session, index) => {
          const isSelected = index === selected;
          return (
            <Text
              key={session.id}
              backgroundColor={isSelected ? theme.surfaceActive : undefined}
              color={isSelected ? theme.selectionText : theme.subtle}
              bold={isSelected}
            >
              {isSelected ? '›' : ' '} {displaySessionName(session.name)} ·{' '}
              {formatAge(session.updatedAt)} · {session.messageCount} messages
            </Text>
          );
        })
      )}
      {density.showOptionalHelp ? (
        <Text color={theme.subtle} dimColor>
          ↑↓ select · Enter resume · Esc cancel
        </Text>
      ) : null}
    </Box>
  );
}
