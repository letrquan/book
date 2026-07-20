import { Box, Text, useInput } from 'ink';
import { useMemo, useState } from 'react';
import type { RewindAction, RewindTarget } from '../../types.js';
import { useDensityMetrics } from '../density.js';
import { useTheme } from '../theme.js';

interface RewindPickerProps {
  targets: RewindTarget[];
  isRewinding: boolean;
  onAction: (
    target: RewindTarget,
    action: RewindAction,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  onCancel: () => void;
}

type ActionChoice = {
  action: RewindAction | 'cancel';
  label: string;
  description: string;
};

const ACTIONS: ActionChoice[] = [
  {
    action: 'conversation',
    label: 'Conversation',
    description: 'Remove this prompt and newer conversation, then restore the prompt.',
  },
  {
    action: 'code',
    label: 'Code',
    description: 'Restore workspace files while keeping the conversation.',
  },
  {
    action: 'both',
    label: 'Both',
    description: 'Restore workspace files and conversation together.',
  },
  { action: 'cancel', label: 'Cancel', description: 'Return without changing anything.' },
];

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function promptPreview(prompt: string): string {
  const singleLine = prompt.replace(/\s+/g, ' ').trim();
  return singleLine.length <= 72 ? singleLine : `${singleLine.slice(0, 69)}...`;
}

export function RewindPicker({ targets, isRewinding, onAction, onCancel }: RewindPickerProps) {
  const theme = useTheme();
  const density = useDensityMetrics();
  const [stage, setStage] = useState<'target' | 'action'>('target');
  const [selectedTarget, setSelectedTarget] = useState(0);
  const [selectedAction, setSelectedAction] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const target = targets[selectedTarget];
  const visibleTargets = useMemo(() => {
    const start = Math.max(0, Math.min(selectedTarget - 5, Math.max(0, targets.length - 12)));
    return { start, items: targets.slice(start, start + 12) };
  }, [selectedTarget, targets]);

  const chooseAction = async () => {
    const choice = ACTIONS[selectedAction];
    if (!target || !choice || isRewinding) return;
    if (choice.action === 'cancel') return onCancel();
    if ((choice.action === 'code' || choice.action === 'both') && !target.codeAvailable) return;
    setError(null);
    const result = await onAction(target, choice.action);
    if (!result.ok) setError(result.error);
  };

  useInput(
    (_input, key) => {
      if (isRewinding) return;
      if (key.escape) {
        if (stage === 'action') {
          setStage('target');
          setError(null);
        } else {
          onCancel();
        }
        return;
      }
      if (stage === 'target') {
        if (targets.length === 0) return;
        if (key.upArrow)
          setSelectedTarget((index) => (index - 1 + targets.length) % targets.length);
        if (key.downArrow) setSelectedTarget((index) => (index + 1) % targets.length);
        if (key.return) {
          setSelectedAction(0);
          setError(null);
          setStage('action');
        }
        return;
      }
      if (key.upArrow) setSelectedAction((index) => (index - 1 + ACTIONS.length) % ACTIONS.length);
      if (key.downArrow) setSelectedAction((index) => (index + 1) % ACTIONS.length);
      if (key.return) void chooseAction();
    },
    { isActive: true },
  );

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.brand}>
        Rewind
      </Text>
      {stage === 'target' ? (
        targets.length === 0 ? (
          <Text color={theme.subtle}>(no user prompts to rewind)</Text>
        ) : (
          visibleTargets.items.map((choice, visibleIndex) => {
            const index = visibleTargets.start + visibleIndex;
            const selected = index === selectedTarget;
            return (
              <Text
                key={choice.id}
                backgroundColor={selected ? theme.surfaceActive : undefined}
                color={selected ? theme.selectionText : theme.subtle}
                bold={selected}
              >
                {selected ? '›' : ' '} {promptPreview(choice.prompt)} ·{' '}
                {formatAge(choice.timestamp)} ·{' '}
                {choice.codeAvailable ? 'code ready' : 'conversation only'}
              </Text>
            );
          })
        )
      ) : (
        <>
          <Text color={theme.text}>{promptPreview(target?.prompt ?? '')}</Text>
          {ACTIONS.map((choice, index) => {
            const selected = index === selectedAction;
            const disabled =
              (choice.action === 'code' || choice.action === 'both') && !target?.codeAvailable;
            return (
              <Box key={choice.action} flexDirection="column">
                <Text
                  backgroundColor={selected ? theme.surfaceActive : undefined}
                  color={disabled ? theme.subtle : selected ? theme.selectionText : theme.text}
                  bold={selected && !disabled}
                  dimColor={disabled}
                >
                  {selected ? '›' : ' '} {choice.label}
                  {disabled ? ' (unavailable)' : ''}
                </Text>
                {selected ? (
                  <Text color={disabled ? theme.error : theme.subtle} dimColor={!disabled}>
                    {'  '}
                    {disabled ? target?.codeUnavailableReason : choice.description}
                  </Text>
                ) : null}
              </Box>
            );
          })}
        </>
      )}
      {isRewinding ? <Text color={theme.brand}>Restoring...</Text> : null}
      {error ? <Text color={theme.error}>✕ {error}</Text> : null}
      {density.showOptionalHelp ? (
        <Text color={theme.subtle} dimColor>
          ↑↓ select · Enter confirm · Esc back
        </Text>
      ) : null}
    </Box>
  );
}
