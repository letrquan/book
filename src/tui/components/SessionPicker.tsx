import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import type { SessionMeta } from '../../types.js';
import { useTheme } from '../theme.js';

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
  const choices = useMemo(
    () => sessions.filter((session) => session.id !== currentSessionId),
    [currentSessionId, sessions],
  );
  const [selected, setSelected] = useState(0);

  useInput(
    (_input, key) => {
      if (key.escape) return onCancel();
      if (choices.length === 0) return;
      if (key.upArrow) setSelected((index) => (index - 1 + choices.length) % choices.length);
      if (key.downArrow) setSelected((index) => (index + 1) % choices.length);
      if (key.return) onPick(choices[selected]);
    },
    { isActive: true },
  );

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.subtle}
      paddingX={1}
      marginY={1}
    >
      <Text bold color={theme.brand}>
        Resume conversation
      </Text>
      {choices.length === 0 ? (
        <Text color={theme.subtle}>(no other sessions in this workspace)</Text>
      ) : (
        choices.slice(0, 12).map((session, index) => (
          <Text key={session.id} color={index === selected ? theme.brand : theme.subtle}>
            {index === selected ? '❯' : ' '} {session.name ?? session.id.slice(0, 8)} ·{' '}
            {formatAge(session.updatedAt)} · {session.messageCount} messages
          </Text>
        ))
      )}
      <Text color={theme.subtle} dimColor>
        ↑↓ select · Enter resume · Esc cancel
      </Text>
    </Box>
  );
}
