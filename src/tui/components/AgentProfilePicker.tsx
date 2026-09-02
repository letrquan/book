import { Box, Text, useInput } from 'ink';
import { useKeyState } from '../hooks/useKeyState.js';
import type { ManagedAgentDef } from '../../agents/profiles.js';
import { useTheme } from '../theme.js';
import { floatingFrameMetrics, PanelTitle, SelectionRow, SoftPanel } from './chrome.js';
import { truncateDisplay } from './word-wrap.js';

interface AgentProfilePickerProps {
  profiles: readonly ManagedAgentDef[];
  parentModel: string;
  configuredModels: Readonly<Record<string, string | undefined>>;
  terminalWidth?: number;
  onSelect: (profile: string) => void;
  onReset: (profile: string) => void;
  onCancel: () => void;
}

function effectiveModel(
  profile: ManagedAgentDef,
  parentModel: string,
  configuredModels: Readonly<Record<string, string | undefined>>,
): { value: string; inherited: boolean } {
  const configured = configuredModels[profile.name];
  if (configured === 'inherit') return { value: parentModel, inherited: true };
  if (configured && configured !== 'inherit') return { value: configured, inherited: false };
  return { value: profile.model ?? parentModel, inherited: true };
}

export function AgentProfilePicker({
  profiles,
  parentModel,
  configuredModels,
  terminalWidth = 80,
  onSelect,
  onReset,
  onCancel,
}: AgentProfilePickerProps) {
  const theme = useTheme();
  const [selected, setSelected, currentSelected] = useKeyState(0);
  const selectedProfile = profiles[selected];
  const frame = floatingFrameMetrics(terminalWidth);
  const contentWidth = Math.max(16, frame.width - 4);

  useInput((input, key) => {
    if (key.escape) return onCancel();
    if (profiles.length === 0) return;
    if (key.upArrow) {
      setSelected((currentSelected() - 1 + profiles.length) % profiles.length);
    } else if (key.downArrow || key.tab) {
      setSelected((currentSelected() + 1) % profiles.length);
    } else if (key.return) {
      const profile = profiles[currentSelected()];
      if (profile) onSelect(profile.name);
    } else if (input.toLowerCase() === 'r') {
      const profile = profiles[currentSelected()];
      if (profile) onReset(profile.name);
    }
  });

  return (
    <SoftPanel tone="brand" width={frame.width} marginX={frame.marginX}>
      <PanelTitle>Subagent profiles</PanelTitle>
      <Text color={theme.subtle}>Select a profile to choose its model for future runs.</Text>
      <Box flexDirection="column" marginTop={1}>
        {profiles.length === 0 ? (
          <Text color={theme.subtle}>No profiles discovered.</Text>
        ) : (
          profiles.map((profile, index) => {
            const model = effectiveModel(profile, parentModel, configuredModels);
            return (
              <SelectionRow key={profile.name} selected={index === selected} width={contentWidth}>
                {index === selected ? '›' : ' '}{' '}
                {truncateDisplay(
                  `${profile.name.padEnd(12)} ${model.value}${model.inherited ? ' (inherit)' : ''} · ${profile.role} · ${profile.isolation}`,
                  contentWidth - 2,
                )}
              </SelectionRow>
            );
          })
        )}
      </Box>
      {selectedProfile ? <Text color={theme.subtle}>{selectedProfile.description}</Text> : null}
      <Text color={theme.subtle} dimColor>
        ↑↓ select · Enter choose model · R reset to inherit · Esc back
      </Text>
    </SoftPanel>
  );
}
