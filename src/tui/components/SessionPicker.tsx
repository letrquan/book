import { useMemo } from 'react';
import { ListPicker } from './ListPicker.js';
import type { SessionMeta } from '../../types/sessions.js';
import { displaySessionName } from '../../session/name.js';
import { formatAge } from '../relative-age.js';

interface SessionPickerProps {
  /** Sheet width, from the panel grid; without it the head falls back to a plain title. */
  width?: number;
  sessions: SessionMeta[];
  currentSessionId: string;
  onPick: (session: SessionMeta) => void;
  onCancel: () => void;
}

export function SessionPicker({
  sessions,
  currentSessionId,
  onPick,
  onCancel,
  width,
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
      title="Resume"
      width={width}
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
