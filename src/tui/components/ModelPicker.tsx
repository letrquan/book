import { Box, Text, useInput } from 'ink';
import { useState, useCallback, useRef } from 'react';
import { useTheme } from '../theme.js';
import { AVAILABLE_MODELS } from '../../models.js';
import type { AgentConfig } from '../../types.js';

const EFFORT_LEVELS: AgentConfig['effort'][] = ['low', 'medium', 'high', 'xhigh', 'max'];

interface ModelPickerProps {
  currentModel: string;
  currentEffort?: AgentConfig['effort'];
  hasPriorOutput: boolean;
  /** env-override or provider-switch caveats to render as warning rows */
  warnings?: string[];
  onPick: (model: string, saveDefault: boolean) => void;
  onPickEffort: (level: AgentConfig['effort']) => void;
  onCancel: () => void;
}

/**
 * Arrow-key model picker. Enter = switch + save as default (persists);
 * `s` = switch for this session only (no persist). Effort is a sub-axis for
 * models that support it (Anthropic adaptive thinking).
 *
 * Modeled on PermissionButtons.tsx: useInput with isActive:true so it captures
 * keys even while the parent also listens. Esc cancels. ponytail: ceiling =
 * fuzzy type-to-filter; add when the picker grows past ~12 rows.
 */
export function ModelPicker({
  currentModel,
  currentEffort,
  hasPriorOutput,
  warnings = [],
  onPick,
  onPickEffort,
  onCancel,
}: ModelPickerProps) {
  const theme = useTheme();
  const [selected, setSelected] = useState(0);
  const [onEffort, setOnEffort] = useState(false);
  const pickedRef = useRef(false);

  const handlePick = useCallback(
    (model: string, saveDefault: boolean) => {
      if (pickedRef.current) return;
      pickedRef.current = true;
      onPick(model, saveDefault);
    },
    [onPick],
  );

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      // Effort sub-axis toggle: `e` enters/leaves the effort slider.
      if (input === 'e') {
        setOnEffort((v) => !v);
        return;
      }
      if (onEffort) {
        const idx = currentEffort ? EFFORT_LEVELS.indexOf(currentEffort) : 2; // default high
        if (key.leftArrow) {
          onPickEffort(EFFORT_LEVELS[Math.max(0, idx - 1)]);
          return;
        }
        if (key.rightArrow) {
          onPickEffort(EFFORT_LEVELS[Math.min(EFFORT_LEVELS.length - 1, idx + 1)]);
          return;
        }
        return;
      }
      if (key.upArrow) {
        setSelected((s) => (s - 1 + AVAILABLE_MODELS.length) % AVAILABLE_MODELS.length);
        return;
      }
      if (key.downArrow) {
        setSelected((s) => (s + 1) % AVAILABLE_MODELS.length);
        return;
      }
      if (key.return) {
        handlePick(AVAILABLE_MODELS[selected].id, true);
        return;
      }
      if (input === 's') {
        handlePick(AVAILABLE_MODELS[selected].id, false);
        return;
      }
    },
    { isActive: true },
  );

  const effIdx = currentEffort ? EFFORT_LEVELS.indexOf(currentEffort) : 2;

  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.subtle}
      paddingX={1}
      marginY={1}
    >
      <Text bold color={theme.brand}>
        Switch model
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {AVAILABLE_MODELS.map((m, i) => {
          const isSel = i === selected && !onEffort;
          const isCurrent = m.id === currentModel;
          return (
            <Box key={m.id}>
              <Text
                backgroundColor={isSel ? theme.brand : undefined}
                color={isSel ? theme.inverseText : isCurrent ? theme.brand : theme.subtle}
                bold={isSel || isCurrent}
              >
                {isSel ? '❯' : ' '} {m.label}{isCurrent ? '  (current)' : ''}
              </Text>
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.subtle} dimColor>
          ↑↓ select  •  Enter switch+save default  •  s session-only  •  e effort  •  Esc cancel
        </Text>
        {onEffort && (
          <Box marginTop={1}>
            <Text color={theme.brand} bold>
              Effort [{EFFORT_LEVELS[effIdx]}]
            </Text>
            <Text color={theme.subtle} dimColor>  ← → adjust</Text>
          </Box>
        )}
        {hasPriorOutput && (
          <Text color={theme.warning ?? theme.subtle} dimColor>
            ⚠ Switching now re-reads full history on the next turn (uncached).
          </Text>
        )}
        {warnings.map((w, i) => (
          <Text key={i} color={theme.warning ?? theme.subtle} dimColor>
            ⚠ {w}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
