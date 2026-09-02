import { useMemo } from 'react';
import { ListPicker } from './ListPicker.js';
import type { SessionMeta } from '../../types/sessions.js';
import { displaySessionName } from '../../session/name.js';

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
  const choices = useMemo(
    () => sessions.filter((session) => session.id !== currentSessionId),
    [currentSessionId, sessions],
  );

  const items = useMemo(
    () =>
      choices.map((session) => ({
        key: session.id,
        label: `${displaySessionName(session.name)} · ${formatAge(session.updatedAt)} · ${session.messageCount} messages`,
        muted: true,
      })),
    [choices],
  );

  return (
    <ListPicker
      title="Resume conversation"
      items={items}
      // This list used to be cut to twelve rows while the cursor still wrapped
      // over every session, so past the twelfth nothing was highlighted and
      // Enter resumed a conversation that had never been on screen. It windows
      // now, and it is the one list long enough to be worth filtering.
      maxVisible={12}
      filterable
      emptyText="(no other sessions in this workspace)"
      enterHint="resume"
      onSelect={(index) => {
        const session = choices[index];
        if (session) onPick(session);
      }}
      onCancel={onCancel}
    />
  );
}
