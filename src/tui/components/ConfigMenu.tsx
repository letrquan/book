import { Box, Text, useInput } from 'ink';
import { useRef, useState } from 'react';
import { useTheme } from '../theme.js';
import { floatingFrameMetrics, PanelTitle, SelectionRow, SoftPanel } from './chrome.js';
import { displayWidth, truncateDisplay } from './word-wrap.js';

export type ConfigSection =
  'model' | 'compact-model' | 'effort' | 'theme' | 'agents' | 'skills' | 'permission-mode';

interface ConfigMenuProps {
  model: string;
  compactModel?: string;
  effort?: string;
  themeName: string;
  memoryAutoSave: boolean;
  showThinking: boolean;
  startupAnimation?: boolean;
  agentCount: number;
  skillCount: number;
  defaultPermissionMode: string;
  terminalWidth?: number;
  onOpen: (section: ConfigSection) => void;
  onToggleMemory: () => void;
  onToggleThinking: () => void;
  onToggleStartupAnimation?: () => void;
  onCancel: () => void;
}

/**
 * One table drives the cursor, the accelerator keys, and the letter each row
 * prints. The letters used to live in a separate `if` chain: five of the nine
 * were advertised nowhere, `memory` had no letter at all, and two of them (`i`,
 * `f`) flipped a setting on a row the cursor was not sitting on — so the only
 * feedback was a value changing somewhere else on the screen. Deriving the key
 * and its label from the same row is what stops a shortcut from drifting away
 * from the thing it acts on.
 *
 * `memory` keeps no accelerator rather than being given a contrived one; every
 * other free letter reads as a worse lie than a blank does. It is still
 * reachable with the arrows, and the blank column says so honestly.
 */
const ROWS = [
  { row: 'model', key: 'm' },
  { row: 'compact-model', key: 'c' },
  { row: 'effort', key: 'e' },
  { row: 'thinking', key: 'i' },
  { row: 'startup-animation', key: 'f' },
  { row: 'theme', key: 't' },
  { row: 'permission-mode', key: 'p' },
  { row: 'agents', key: 'a' },
  { row: 'skills', key: 's' },
  { row: 'memory' },
] as const satisfies ReadonlyArray<{ row: string; key?: string }>;
type Row = (typeof ROWS)[number]['row'];

/**
 * The cursor marker, the accelerator, and the gaps around them, as the string
 * the row actually prints. Measuring it beats a hand-kept column count: the
 * budget then cannot drift away from the prefix it is supposed to describe.
 */
function rowPrefix(selected: boolean, key?: string): string {
  return `${selected ? '›' : ' '} ${key ? key.toUpperCase() : ' '}  `;
}

export function ConfigMenu({
  model,
  compactModel,
  effort,
  themeName,
  memoryAutoSave,
  showThinking,
  startupAnimation = true,
  agentCount,
  skillCount,
  defaultPermissionMode,
  terminalWidth = 80,
  onOpen,
  onToggleMemory,
  onToggleThinking,
  onToggleStartupAnimation = () => {},
  onCancel,
}: ConfigMenuProps) {
  const theme = useTheme();
  const [selected, setSelected] = useState(0);
  // An accelerator sets the cursor and acts on it in the same keypress, so the
  // handler cannot read `selected` back from state — React has not flushed it.
  const selectedRef = useRef(0);
  const frame = floatingFrameMetrics(terminalWidth);
  const contentWidth = Math.max(16, frame.width - 4);

  const activate = (row: Row) => {
    if (row === 'memory') onToggleMemory();
    else if (row === 'thinking') onToggleThinking();
    else if (row === 'startup-animation') onToggleStartupAnimation();
    else onOpen(row);
  };

  const moveSelection = (next: number) => {
    selectedRef.current = next;
    setSelected(next);
  };

  useInput((input, key) => {
    if (key.escape) return onCancel();
    // Shift+Tab is back-tab everywhere else it appears; treating a bare
    // `key.tab` as "next" sent it forward, one row past whatever the user was
    // aiming at.
    if (key.upArrow || (key.tab && key.shift)) {
      moveSelection((selectedRef.current - 1 + ROWS.length) % ROWS.length);
      return;
    }
    if (key.downArrow || key.tab) {
      moveSelection((selectedRef.current + 1) % ROWS.length);
      return;
    }
    if (key.return) {
      activate(ROWS[selectedRef.current].row);
      return;
    }
    if (key.ctrl || key.meta) return;
    // An accelerator moves the cursor before it acts, so the row that changes is
    // the row you are looking at. Pressing `i` used to toggle "Show thinking"
    // while the highlight sat on "Model" four rows above it.
    const shortcut = input.toLowerCase();
    const index = ROWS.findIndex((entry) => 'key' in entry && entry.key === shortcut);
    if (index < 0) return;
    moveSelection(index);
    activate(ROWS[index].row);
  });

  // Keyed rather than ordered: `ROWS` owns the order, so the two lists cannot
  // fall out of step and leave the cursor pointing at a row it does not render.
  const details: Record<Row, { label: string; value: string; description: string }> = {
    model: { label: 'Model', value: model, description: 'Default model for the main agent' },
    'compact-model': {
      label: 'Compact model',
      value: compactModel ?? 'same as main',
      description: 'Reducer used only for conversation checkpoints',
    },
    effort: {
      label: 'Effort',
      value: effort ?? 'model default',
      description: 'Reasoning depth for supported models',
    },
    thinking: {
      label: 'Show thinking',
      value: showThinking ? 'on' : 'off',
      description: 'Display the model reasoning in the transcript',
    },
    'startup-animation': {
      label: 'Startup fire',
      value: startupAnimation ? 'on' : 'off',
      description: 'Burn the terminal into the Book welcome screen',
    },
    theme: { label: 'Theme', value: themeName, description: 'Terminal color palette' },
    'permission-mode': {
      label: 'Default permissions',
      value: defaultPermissionMode,
      description: 'Mode for runs without an explicit override',
    },
    agents: {
      label: 'Subagent profiles',
      value: `${agentCount} available`,
      description: 'Choose a model for explorer, patcher, or validator',
    },
    skills: {
      label: 'Skills',
      value: `${skillCount} discovered`,
      description: 'Control automatic matching and explicit use',
    },
    memory: {
      label: 'Memory auto-capture',
      value: memoryAutoSave ? 'on' : 'off',
      description: 'Capture useful corrections for approval later',
    },
  };

  return (
    <SoftPanel tone="brand" width={frame.width} marginX={frame.marginX}>
      <PanelTitle>Settings</PanelTitle>
      <Text color={theme.subtle}>Choose a setting to change.</Text>
      <Box flexDirection="column" marginTop={1}>
        {ROWS.map((entry, index) => {
          const item = details[entry.row];
          const prefix = rowPrefix(index === selected, 'key' in entry ? entry.key : undefined);
          return (
            <SelectionRow key={entry.row} selected={index === selected} width={contentWidth}>
              {prefix}
              {truncateDisplay(
                `${item.label.padEnd(22)} ${item.value} — ${item.description}`,
                contentWidth - displayWidth(prefix),
              )}
            </SelectionRow>
          );
        })}
      </Box>
      <Text color={theme.subtle} dimColor>
        ↑↓ select · Enter choose · or press the letter · Esc close
      </Text>
    </SoftPanel>
  );
}
