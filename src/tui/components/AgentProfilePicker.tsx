import { useMemo } from 'react';
import type { ManagedAgentDef } from '../../agents/profiles.js';
import { floatingFrameMetrics } from './chrome.js';
import { ListPicker } from './ListPicker.js';
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
  const frame = floatingFrameMetrics(terminalWidth);
  const contentWidth = Math.max(16, frame.width - 4);

  const items = useMemo(
    () =>
      profiles.map((profile) => {
        const model = effectiveModel(profile, parentModel, configuredModels);
        return {
          key: profile.name,
          label: truncateDisplay(
            `${profile.name.padEnd(12)} ${model.value}${model.inherited ? ' (inherit)' : ''} · ${profile.role} · ${profile.isolation}`,
            contentWidth - 2,
          ),
          detail: profile.description,
        };
      }),
    [configuredModels, contentWidth, parentModel, profiles],
  );

  return (
    <ListPicker
      title="Subagent profiles"
      subtitle="Select a profile to choose its model for future runs."
      items={items}
      emptyText="No profiles discovered."
      width={frame.width}
      marginX={frame.marginX}
      tabMovesNext
      enterHint="choose model"
      extraHints="R reset to inherit"
      escHint="back"
      onKey={(input, key, index) => {
        if (key.ctrl || key.meta) return false;
        if (input.toLowerCase() !== 'r') return false;
        const profile = profiles[index];
        if (profile) onReset(profile.name);
        return true;
      }}
      onSelect={(index) => {
        const profile = profiles[index];
        if (profile) onSelect(profile.name);
      }}
      onCancel={onCancel}
    />
  );
}
