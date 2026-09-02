import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useKeyState } from '../hooks/useKeyState.js';
import type { Skill } from '../../skills.js';
import type { SkillLifecycleEvent } from '../../skill-registry.js';
import type { SkillActivation, SkillExecution } from '../../settings.js';
import { useTheme } from '../theme.js';
import { stripSgrMouseSequences } from '../mouse.js';
import { floatingFrameMetrics, PanelTitle, SelectionRow, SoftPanel } from './chrome.js';
import { truncateDisplay } from './word-wrap.js';

const ACTIVATIONS: readonly SkillActivation[] = ['auto', 'name-only', 'manual', 'off'];
const EXECUTIONS: readonly SkillExecution[] = ['inherit', 'ask', 'deny'];

const ACTIVATION_HELP: Record<SkillActivation, string> = {
  auto: 'Name and description are visible; Book may activate it automatically.',
  'name-only': 'Only the name is visible; explicit use remains reliable.',
  manual: 'Hidden from automatic matching; invoke it explicitly with $name.',
  off: 'Hidden and blocked from invocation.',
};

const EXECUTION_HELP: Record<SkillExecution, string> = {
  inherit: 'Use the normal workspace and permission policy.',
  ask: 'Ask before activating this skill.',
  deny: 'Block this skill even when explicitly mentioned.',
};

export interface SkillManagerResult {
  ok: boolean;
  error?: string;
}

interface SkillManagerProps {
  skills: readonly Skill[];
  enabled?: boolean;
  watcherError?: string;
  lifecycleEvents?: readonly SkillLifecycleEvent[];
  activeSkillNames?: readonly string[];
  terminalWidth?: number;
  maxVisible?: number;
  onChangeActivation: (skillName: string, activation: SkillActivation) => SkillManagerResult;
  onChangeExecution: (skillName: string, execution: SkillExecution) => SkillManagerResult;
  onChangeEnabled: (enabled: boolean) => SkillManagerResult;
  onUse: (skill: Skill) => void;
  onReload: () => void;
  onCancel: () => void;
}

function nextValue<T>(values: readonly T[], current: T): T {
  const index = values.indexOf(current);
  return values[(index + 1) % values.length] ?? values[0];
}

export function SkillManager({
  skills,
  enabled = true,
  watcherError,
  lifecycleEvents = [],
  activeSkillNames = [],
  terminalWidth = 80,
  maxVisible = 8,
  onChangeActivation,
  onChangeExecution,
  onChangeEnabled,
  onUse,
  onReload,
  onCancel,
}: SkillManagerProps) {
  const theme = useTheme();
  // Both of these are read back by the key handler, so they have to survive a
  // React batch: Ink hands a whole stdin chunk over at once. With plain state a
  // batched `↓`+Space wrote an activation change to the skill above the
  // highlighted one, and a batched `/`+letter ran the letter as a command
  // instead of typing it into the search field.
  const [selected, setSelected, currentSelected] = useKeyState(0);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState('');
  const [searching, setSearching, isSearching] = useKeyState(false);
  const frame = floatingFrameMetrics(terminalWidth);
  const contentWidth = Math.max(16, frame.width - 4);
  const filteredSkills = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return skills;
    return skills.filter((skill) =>
      [skill.name, skill.description, skill.source, skill.rootKind, skill.path]
        .join(' ')
        .toLowerCase()
        .includes(normalized),
    );
  }, [query, skills]);

  useEffect(() => {
    setSelected(Math.max(0, Math.min(currentSelected(), filteredSkills.length - 1)));
  }, [filteredSkills.length, setSelected, currentSelected]);

  const window = useMemo(() => {
    if (filteredSkills.length <= maxVisible) return { start: 0, items: filteredSkills };
    const half = Math.floor(maxVisible / 2);
    const start = Math.max(0, Math.min(selected - half, filteredSkills.length - maxVisible));
    return { start, items: filteredSkills.slice(start, start + maxVisible) };
  }, [filteredSkills, maxVisible, selected]);

  useInput((input, key) => {
    if (isSearching()) {
      if (key.escape || key.return) {
        setSearching(false);
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((current) => current.slice(0, -1));
        return;
      }
      const typed = stripSgrMouseSequences(input);
      if (!key.ctrl && !key.meta && typed && !key.upArrow && !key.downArrow) {
        setQuery((current) => current + typed);
      }
      return;
    }

    if (key.escape) return onCancel();
    if (input === '/') {
      setSearching(true);
      setQuery('');
      setError(undefined);
      return;
    }
    if (input.toLowerCase() === 'r') {
      setError(undefined);
      onReload();
      return;
    }
    if (input.toLowerCase() === 'g') {
      const result = onChangeEnabled(!enabled);
      setError(
        result.ok ? undefined : (result.error ?? 'Could not save the global skill setting.'),
      );
      return;
    }
    if (filteredSkills.length === 0) return;
    if (key.upArrow) {
      setSelected((currentSelected() - 1 + filteredSkills.length) % filteredSkills.length);
      setError(undefined);
      return;
    }
    if (key.downArrow || key.tab) {
      setSelected((currentSelected() + 1) % filteredSkills.length);
      setError(undefined);
      return;
    }

    const skill = filteredSkills[currentSelected()];
    if (!skill) return;
    if (input === ' ') {
      const activation = nextValue(ACTIVATIONS, skill.activation);
      const result = onChangeActivation(skill.name, activation);
      setError(result.ok ? undefined : (result.error ?? 'Could not save the skill setting.'));
      return;
    }
    if (input.toLowerCase() === 'e') {
      const execution = nextValue(EXECUTIONS, skill.execution);
      const result = onChangeExecution(skill.name, execution);
      setError(result.ok ? undefined : (result.error ?? 'Could not save the consent setting.'));
      return;
    }
    if (key.return) {
      if (!enabled) {
        setError('Skills are globally disabled. Press G to enable them before use.');
        return;
      }
      if (!skill.valid) {
        setError('This skill is invalid. Review its diagnostics before use.');
        return;
      }
      if (skill.activation === 'off' || skill.execution === 'deny') {
        setError('This skill is blocked. Change its activation or consent policy before use.');
        return;
      }
      onUse(skill);
    }
  });

  const active = filteredSkills[selected];
  const lastLifecycleEvent = active
    ? [...lifecycleEvents].reverse().find((event) => event.skill === active.name)
    : undefined;

  return (
    <SoftPanel tone="brand" width={frame.width} marginX={frame.marginX}>
      <PanelTitle>Manage skills</PanelTitle>
      <Text color={enabled ? theme.success : theme.warning}>
        {enabled ? 'Enabled' : 'Globally off'} · {skills.length} discovered
        {query ? ` · ${filteredSkills.length} matching "${query}"` : ''}
      </Text>
      {searching ? <Text color={theme.brand}>Search: {query || '_'}</Text> : null}
      {watcherError ? (
        <Text color={theme.warning}>
          Watcher: {truncateDisplay(watcherError, Math.max(8, contentWidth - 9))}
        </Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {filteredSkills.length === 0 ? (
          <Text color={theme.subtle} dimColor>
            {skills.length === 0
              ? 'No skills found in .book, .agents, .claude, or .opencode skill roots.'
              : 'No skills match this search.'}
          </Text>
        ) : (
          window.items.map((skill, offset) => {
            const index = window.start + offset;
            const validity = skill.valid ? 'ok' : 'invalid';
            const activeState = activeSkillNames.includes(skill.name) ? 'active' : 'idle';
            const row = `${skill.name.padEnd(20)} ${skill.activation.padEnd(9)} ${skill.execution.padEnd(7)} ${activeState.padEnd(6)} ${skill.rootKind}/${skill.source} ${validity}`;
            return (
              <SelectionRow key={`${skill.source}:${skill.path}`} selected={index === selected}>
                {index === selected ? '›' : ' '} {truncateDisplay(row, contentWidth - 2)}
              </SelectionRow>
            );
          })
        )}
      </Box>
      {active ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.text}>
            {truncateDisplay(active.description, Math.max(8, contentWidth))}
          </Text>
          <Text color={theme.text}>{ACTIVATION_HELP[active.activation]}</Text>
          <Text color={theme.subtle}>
            {active.execution === 'inherit' && active.source === 'project'
              ? 'Project instructions require consent unless an InvokeSkill rule already allows them.'
              : EXECUTION_HELP[active.execution]}
          </Text>
          <Text color={theme.subtle}>
            {active.version} · {active.entryByteSize} bytes · {active.resources.length} resources
            {active.shadowed.length ? ` · shadows ${active.shadowed.length}` : ''}
          </Text>
          {active.whenToUse ? (
            <Text color={theme.subtle}>
              Trigger: {truncateDisplay(active.whenToUse, Math.max(8, contentWidth - 9))}
            </Text>
          ) : null}
          {active.compatibility ? (
            <Text color={theme.subtle}>
              Compatibility: {truncateDisplay(active.compatibility, Math.max(8, contentWidth - 15))}
            </Text>
          ) : null}
          {active.resources.slice(0, 2).map((resource) => (
            <Text key={resource.relativePath} color={theme.subtle}>
              Resource: {truncateDisplay(resource.relativePath, Math.max(8, contentWidth - 10))}
            </Text>
          ))}
          {active.resources.length > 2 ? (
            <Text color={theme.subtle}>+{active.resources.length - 2} more resources</Text>
          ) : null}
          {active.shadowed.slice(0, 2).map((shadowed) => (
            <Text key={shadowed.path} color={theme.warning}>
              Shadows: {truncateDisplay(shadowed.path, Math.max(8, contentWidth - 9))}
            </Text>
          ))}
          {active.shadowed.length > 2 ? (
            <Text color={theme.warning}>+{active.shadowed.length - 2} more shadowed sources</Text>
          ) : null}
          {active.issues.slice(0, 3).map((issue) => (
            <Text
              key={`${issue.code}:${issue.message}`}
              color={issue.severity === 'error' ? theme.error : theme.warning}
            >
              {issue.severity}: {truncateDisplay(issue.message, Math.max(8, contentWidth - 9))}
            </Text>
          ))}
          {active.issues.length > 3 ? (
            <Text color={theme.warning}>+{active.issues.length - 3} more validation issues</Text>
          ) : null}
          {lastLifecycleEvent ? (
            <Text color={theme.subtle}>
              Last event: {lastLifecycleEvent.type}
              {typeof lastLifecycleEvent.details?.code === 'string'
                ? ` (${lastLifecycleEvent.details.code})`
                : ''}
            </Text>
          ) : null}
          <Text color={theme.subtle} dimColor>
            {truncateDisplay(active.path, contentWidth)}
          </Text>
        </Box>
      ) : null}
      {/* Two lines, split by what the keys act on. As one line this was eight
          chords that did not fit, so Ink wrapped it — and the wrap landed after
          a trailing separator, leaving "Esc close" stranded on a line of its
          own under a dangling "·". */}
      <Text color={theme.subtle} dimColor>
        ↑↓ select · / search · Enter insert · Esc close
      </Text>
      <Text color={theme.subtle} dimColor>
        Space activation · E consent · G global · R reload
      </Text>
      {error ? <Text color={theme.error}>✕ {error}</Text> : null}
    </SoftPanel>
  );
}
