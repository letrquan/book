import { Box, Text, useInput } from 'ink';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useTheme } from '../theme.js';
import type { AgentConfig } from '../../types.js';
import type { ProviderConfig } from '../../settings.js';
import { resolveSecret } from '../../config.js';
import { discoverModels, type ModelDiscoveryOptions } from '../../provider/model-discovery.js';
import type { ModelPickerOption, ProviderSaveRequest } from '../model-options.js';
import { EFFORT_LEVELS, type EffortLevel, type EffortResult } from '../effort.js';
import { ByokWizard } from './ByokWizard.js';
import { useDensityMetrics } from '../density.js';

interface ModelPickerProps {
  options: ModelPickerOption[];
  currentModel: string;
  currentEffort?: AgentConfig['effort'];
  effortLevels?: readonly EffortLevel[];
  hasPriorOutput: boolean;
  warnings?: string[];
  providers: Record<string, ProviderConfig>;
  workspace: string;
  retry: AgentConfig['retry'];
  compact?: boolean;
  maxVisibleModels?: number;
  discover?: (options: ModelDiscoveryOptions) => Promise<Array<{ id: string; label?: string }>>;
  onPick: (model: string, saveDefault: boolean) => { ok: boolean; error?: string } | void;
  onPickEffort: (level: EffortLevel) => EffortResult;
  onSaveProvider: (request: ProviderSaveRequest) => { ok: boolean; error?: string };
  onProviderSaved?: (request: ProviderSaveRequest) => void;
  onCancel: () => void;
}

export function ModelPicker({
  options,
  currentModel,
  currentEffort,
  effortLevels = EFFORT_LEVELS,
  hasPriorOutput,
  warnings = [],
  providers,
  workspace,
  retry,
  compact = false,
  maxVisibleModels = 10,
  discover = discoverModels,
  onPick,
  onPickEffort,
  onSaveProvider,
  onProviderSaved,
  onCancel,
}: ModelPickerProps) {
  const theme = useTheme();
  const density = useDensityMetrics();
  const [selected, setSelected] = useState(0);
  const [filter, setFilter] = useState('');
  const [onEffort, setOnEffort] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [refreshing, setRefreshing] = useState<string>();
  const [error, setError] = useState<string>();
  const pickedRef = useRef(false);
  const filteredOptions = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return options;
    return options.filter(
      (option) =>
        option.id.toLowerCase().includes(query) ||
        option.label.toLowerCase().includes(query) ||
        option.providerId?.toLowerCase().includes(query),
    );
  }, [filter, options]);
  const itemCount = filteredOptions.length + 1;
  const addIndex = filteredOptions.length;

  useEffect(() => {
    setSelected((value) => Math.min(value, filteredOptions.length));
  }, [filteredOptions.length]);

  const handlePick = useCallback(
    (model: string, saveDefault: boolean) => {
      if (pickedRef.current) return;
      const result = onPick(model, saveDefault);
      if (result && !result.ok) {
        setError(result.error ?? 'Could not save the selected model.');
        return;
      }
      pickedRef.current = true;
    },
    [onPick],
  );

  const refreshProvider = useCallback(
    async (providerId: string) => {
      const provider = providers[providerId];
      if (!provider) return;
      const apiKey = resolveSecret(provider.apiKey, workspace);
      if (!apiKey) {
        setError(`No usable API key is configured for ${providerId}.`);
        return;
      }
      setError(undefined);
      setRefreshing(providerId);
      try {
        const models = await discover({
          type: provider.type,
          baseUrl: provider.baseURL ?? provider.baseUrl ?? '',
          apiKey,
          retry,
        });
        const currentForProvider = options.find(
          (option) => option.providerId === providerId && option.id === currentModel,
        );
        const activeModelId = currentForProvider
          ? currentForProvider.id.slice(providerId.length + 1)
          : models[0].id;
        const request: ProviderSaveRequest = {
          providerId,
          type: provider.type,
          baseURL: provider.baseURL ?? provider.baseUrl ?? '',
          apiKey: provider.apiKey ?? apiKey,
          models,
          activeModelId,
          replaceModels: true,
          activate: false,
        };
        const result = onSaveProvider(request);
        if (!result.ok) setError(result.error ?? 'Could not save refreshed models.');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not refresh models.');
      } finally {
        setRefreshing(undefined);
      }
    },
    [currentModel, discover, onSaveProvider, options, providers, retry, workspace],
  );

  useInput(
    (input, key) => {
      if (showWizard) return;
      if (key.escape) {
        if (filter) {
          setFilter('');
          setSelected(0);
          return;
        }
        onCancel();
        return;
      }
      if (onEffort) {
        if (input === 'e') {
          setOnEffort(false);
          return;
        }
        const currentIndex = currentEffort ? effortLevels.indexOf(currentEffort) : -1;
        const idx = currentIndex >= 0 ? currentIndex : 0;
        const nextLevel = key.leftArrow
          ? effortLevels[Math.max(0, idx - 1)]
          : key.rightArrow
            ? effortLevels[Math.min(effortLevels.length - 1, idx + 1)]
            : undefined;
        if (nextLevel) {
          const result = onPickEffort(nextLevel);
          setError(result.ok ? undefined : (result.error ?? 'Could not save effort level.'));
        }
        return;
      }
      if (key.return) {
        if (selected === addIndex) setShowWizard(true);
        else {
          const option = filteredOptions[selected];
          if (option) handlePick(option.id, true);
        }
        return;
      }
      if (key.backspace || key.delete) {
        if (filter) {
          setFilter((value) => value.slice(0, -1));
          setSelected(0);
        }
        return;
      }
      if (key.upArrow) {
        setSelected((value) => (value - 1 + itemCount) % itemCount);
        return;
      }
      if (key.downArrow) {
        setSelected((value) => (value + 1) % itemCount);
        return;
      }
      if (key.meta && input === 'a') {
        setShowWizard(true);
        setError(undefined);
        return;
      }
      if (
        key.meta &&
        input === 'e' &&
        effortLevels.length > 0 &&
        selected !== addIndex &&
        filteredOptions[selected]?.effort
      ) {
        setOnEffort(true);
        return;
      }
      if (key.meta && input === 's' && selected !== addIndex) {
        const option = filteredOptions[selected];
        if (option) handlePick(option.id, false);
        return;
      }
      if (key.meta && input === 'r' && selected !== addIndex) {
        const providerId = filteredOptions[selected]?.providerId;
        if (providerId && !refreshing) void refreshProvider(providerId);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFilter((value) => value + input);
        setSelected(0);
      }
    },
    { isActive: true },
  );

  if (showWizard) {
    return (
      <ByokWizard
        retry={retry}
        compact={compact}
        maxVisibleModels={maxVisibleModels}
        discover={discover}
        onCancel={() => setShowWizard(false)}
        onSave={(request) => {
          const result = onSaveProvider(request);
          if (result.ok) onProviderSaved?.(request);
          return result;
        }}
      />
    );
  }

  const effortIndex = currentEffort ? effortLevels.indexOf(currentEffort) : -1;
  const displayedEffort = effortIndex >= 0 ? effortLevels[effortIndex] : effortLevels[0];
  const windowStart = Math.max(
    0,
    Math.min(selected - Math.floor(maxVisibleModels / 2), itemCount - maxVisibleModels),
  );
  const rows = [
    ...filteredOptions.map((option) => ({ type: 'model' as const, option })),
    { type: 'add' as const },
  ].slice(windowStart, windowStart + maxVisibleModels);

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.brand}>
        Switch model
      </Text>
      <Text color={theme.brand}>Filter: {filter || '(type to filter)'}</Text>
      <Box flexDirection="column">
        {rows.map((row, visibleIndex) => {
          const index = windowStart + visibleIndex;
          const isSelected = index === selected && !onEffort;
          if (row.type === 'add') {
            return (
              <Text
                key="add-byok"
                backgroundColor={isSelected ? theme.surfaceActive : undefined}
                color={isSelected ? theme.selectionText : theme.brand}
                bold={isSelected}
              >
                {isSelected ? '❯' : ' '} + Add BYOK provider…
              </Text>
            );
          }
          const option = row.option;
          const isCurrent = option.id === currentModel;
          return (
            <Text
              key={option.id}
              backgroundColor={isSelected ? theme.surfaceActive : undefined}
              color={isSelected ? theme.selectionText : isCurrent ? theme.brand : theme.subtle}
              bold={isSelected || isCurrent}
            >
              {isSelected ? '❯' : ' '} {option.label}
              {option.providerId ? `  ${option.providerId}` : ''}
              {isCurrent ? '  (current)' : ''}
            </Text>
          );
        })}
      </Box>
      <Box flexDirection="column">
        <Text color={theme.subtle} dimColor>
          {compact || !density.showOptionalHelp
            ? '↑↓ select · Enter save · Alt+S session · Esc cancel'
            : 'Type filter · ↑↓ select · Enter save · Alt+A add BYOK · Alt+S session · Esc cancel'}
        </Text>
        {refreshing && <Text color={theme.brand}>Refreshing {refreshing} models…</Text>}
        {onEffort && (
          <Text color={theme.brand} bold>
            Effort [{displayedEffort}] <Text color={theme.subtle}>← → adjust</Text>
          </Text>
        )}
        {error && <Text color={theme.error}>✕ {error}</Text>}
        {hasPriorOutput && (
          <Text color={theme.warning ?? theme.subtle} dimColor>
            ⚠ Switching now re-reads full history on the next turn (uncached).
          </Text>
        )}
        {warnings.map((warning, index) => (
          <Text key={index} color={theme.warning ?? theme.subtle} dimColor>
            ⚠ {warning}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
