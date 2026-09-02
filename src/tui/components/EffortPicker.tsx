import { useMemo, useState } from 'react';
import { ListPicker } from './ListPicker.js';
import type { EffortLevel, EffortResult } from '../../commands/effort.js';

const DESCRIPTIONS: Record<EffortLevel, string> = {
  low: 'Fast responses with lighter reasoning',
  medium: 'Balanced reasoning for everyday tasks',
  high: 'Deeper reasoning for complex work',
  xhigh: 'Extended reasoning for difficult problems',
  max: 'Maximum reasoning depth for the hardest tasks',
};

interface EffortPickerProps {
  current?: EffortLevel;
  availableLevels: readonly EffortLevel[];
  onSelect: (level: EffortLevel) => EffortResult;
  onCancel: () => void;
}

export function EffortPicker({ current, availableLevels, onSelect, onCancel }: EffortPickerProps) {
  const [error, setError] = useState<string>();

  const items = useMemo(
    () =>
      availableLevels.map((level) => ({
        key: level,
        label: `${level.padEnd(6)} ${DESCRIPTIONS[level]}`,
        note: level === current ? '(current)' : undefined,
        accent: level === current,
      })),
    [availableLevels, current],
  );

  return (
    <ListPicker
      title="Set effort level"
      subtitle="Choose how much reasoning Book uses on future requests."
      items={items}
      initialIndex={Math.max(0, current ? availableLevels.indexOf(current) : 0)}
      enterHint="save"
      escHint="cancel"
      error={error}
      onSelect={(index) => {
        const level = availableLevels[index];
        if (!level) return;
        const result = onSelect(level);
        setError(
          result.ok ? undefined : (result.error ?? 'Could not save the selected effort level.'),
        );
      }}
      onCancel={onCancel}
    />
  );
}
