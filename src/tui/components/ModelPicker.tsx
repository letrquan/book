import { Box, Text, useInput } from 'ink';
import TextInput from './TextInputField.js';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useKeyState } from '../hooks/useKeyState.js';
import { useTheme } from '../theme.js';
import type { AgentConfig } from '../../types/runtime.js';
import type { ProviderConfig } from '../../settings.js';
import { resolveSecret } from '../../config.js';
import { discoverModels, type ModelDiscoveryOptions } from '../../provider/model-discovery.js';
import {
  parseModelIds,
  type ModelPickerOption,
  type ProviderSaveRequest,
} from '../model-options.js';
import { EFFORT_LEVELS, type EffortLevel, type EffortResult } from '../../commands/effort.js';
import { ByokWizard } from './ByokWizard.js';
import { modelPickerHints } from './model-picker-hints.js';
import { useDensityMetrics } from '../density.js';
import { stripSgrMouseSequences } from '../mouse.js';

export type ProviderRemovalResult =
  | {
      ok: true;
      providerId: string;
      removedModelCount: number;
      activeModel: string;
      switched: boolean;
      inheritedProviderRevealed: boolean;
    }
  | {
      ok: false;
      error: string;
    };

interface ModelPickerProps {
  title?: string;
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
  removableProviderIds: ReadonlySet<string>;
  removableProviderModelCounts?: ReadonlyMap<string, number>;
  onRemoveProvider: (providerId: string) => ProviderRemovalResult;
  onProviderSaved?: (request: ProviderSaveRequest) => void;
  allowProviderManagement?: boolean;
  onCancel: () => void;
}

const EMPTY_PROVIDER_IDS: ReadonlySet<string> = new Set();

function plural(count: number): string {
  return count === 1 ? '' : 's';
}

export function ModelPicker({
  title,
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
  removableProviderIds = EMPTY_PROVIDER_IDS,
  removableProviderModelCounts,
  onRemoveProvider,
  onProviderSaved,
  allowProviderManagement = true,
  onCancel,
}: ModelPickerProps) {
  const theme = useTheme();
  const density = useDensityMetrics();
  const [selected, setSelected, currentSelected] = useKeyState(0);
  const [filter, setFilter] = useState('');
  const [onEffort, setOnEffort] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [refreshing, setRefreshing] = useState<string>();
  const [manualEntry, setManualEntry] = useState<{ providerId: string; value: string }>();
  const [removal, setRemoval, currentRemoval] = useKeyState<
    { providerId: string; modelCount: number; active: boolean } | undefined
  >(undefined);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const pickedRef = useRef(false);
  const removalInFlightRef = useRef(false);
  const reanchorRef = useRef<string | undefined>(undefined);
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
  const itemCount = filteredOptions.length + (allowProviderManagement ? 1 : 0);
  const addIndex = filteredOptions.length;

  useEffect(() => {
    setSelected(Math.min(currentSelected(), Math.max(0, itemCount - 1)));
  }, [filteredOptions.length, itemCount]);

  // Refreshing or extending a catalog re-sorts the list under the cursor, so a
  // row can slide out from under the highlight and Enter would then save a
  // model the user never looked at. Re-anchor on the id that was selected.
  useEffect(() => {
    const anchor = reanchorRef.current;
    if (!anchor) return;
    reanchorRef.current = undefined;
    const index = filteredOptions.findIndex((option) => option.id === anchor);
    if (index >= 0) setSelected(index);
  }, [filteredOptions]);

  // Catalog edits are written to the user-global settings layer. Doing that for
  // a provider inherited from a project layer would copy its credential into a
  // second file and make the inherited copy look removable, so the same
  // ownership rule that guards removal guards refresh and manual entry.
  const ownsProvider = useCallback(
    (providerId: string) => {
      if (removableProviderIds.has(providerId)) return true;
      setError('Only BYOK providers you added can be changed.');
      return false;
    },
    [removableProviderIds],
  );

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
      setNotice(undefined);
      setRefreshing(providerId);
      try {
        const models = await discover({
          type: provider.type,
          baseUrl: provider.baseURL ?? provider.baseUrl ?? '',
          apiKey,
          retry,
        });
        if (models.length === 0) {
          setError(`${providerId} did not return any models.`);
          return;
        }
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
        else setNotice(`${providerId}: ${models.length} model${plural(models.length)} listed.`);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Could not refresh models.');
      } finally {
        setRefreshing(undefined);
      }
    },
    [currentModel, discover, onSaveProvider, options, providers, retry, workspace],
  );

  // Add hand-typed model IDs to a provider without touching its credentials or
  // the active selection — the catalog grows, nothing else moves.
  const addManualModels = useCallback(
    (providerId: string, raw: string) => {
      const provider = providers[providerId];
      if (!provider) {
        setError(`${providerId} is no longer configured.`);
        return;
      }
      let ids: string[];
      try {
        ids = parseModelIds(raw);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Enter at least one model ID.');
        return;
      }
      const result = onSaveProvider({
        providerId,
        type: provider.type,
        baseURL: provider.baseURL ?? provider.baseUrl ?? '',
        apiKey: provider.apiKey ?? '',
        models: ids.map((id) => ({ id })),
        activeModelId: ids[0],
        manual: true,
        activate: false,
      });
      if (!result.ok) {
        setError(result.error ?? 'Could not save the model.');
        return;
      }
      setManualEntry(undefined);
      setError(undefined);
      setNotice(`Added ${ids.length} model${plural(ids.length)} to ${providerId}.`);
    },
    [onSaveProvider, providers],
  );

  useInput(
    (input, key) => {
      if (showWizard) return;
      // The text field owns every other key while it is open.
      if (manualEntry) {
        if (key.escape) {
          reanchorRef.current = undefined;
          setManualEntry(undefined);
          setError(undefined);
        }
        return;
      }
      // Read back rather than closing over `removal`: Alt+D and the `y` that
      // confirms it can arrive in one chunk, and the second key would then be
      // dispatched by the branch that was live before the prompt opened.
      const pendingRemoval = currentRemoval();
      if (pendingRemoval) {
        if (key.escape || input.toLowerCase() === 'n') {
          removalInFlightRef.current = false;
          setRemoval(undefined);
          setError(undefined);
          return;
        }
        if (key.return || input.toLowerCase() === 'y') {
          if (removalInFlightRef.current) return;
          removalInFlightRef.current = true;
          let result: ProviderRemovalResult;
          try {
            result = onRemoveProvider(pendingRemoval.providerId);
          } catch (caught) {
            result = {
              ok: false,
              error: caught instanceof Error ? caught.message : 'Could not remove the provider.',
            };
          }
          if (!result.ok) {
            removalInFlightRef.current = false;
            setError(result.error);
          }
          return;
        }
        return;
      }
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
        if (allowProviderManagement && currentSelected() === addIndex) setShowWizard(true);
        else {
          const option = filteredOptions[currentSelected()];
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
        setSelected((currentSelected() - 1 + itemCount) % itemCount);
        setNotice(undefined);
        return;
      }
      if (key.downArrow) {
        setSelected((currentSelected() + 1) % itemCount);
        setNotice(undefined);
        return;
      }
      if (allowProviderManagement && key.meta && input === 'a') {
        setShowWizard(true);
        setError(undefined);
        return;
      }
      if (
        key.meta &&
        input === 'e' &&
        effortLevels.length > 0 &&
        currentSelected() !== addIndex &&
        filteredOptions[currentSelected()]?.effort
      ) {
        setOnEffort(true);
        return;
      }
      if (key.meta && input === 's' && currentSelected() !== addIndex) {
        const option = filteredOptions[currentSelected()];
        if (option) handlePick(option.id, false);
        return;
      }
      if (allowProviderManagement && key.meta && input === 'r' && currentSelected() !== addIndex) {
        const providerId = filteredOptions[currentSelected()]?.providerId;
        if (!providerId || refreshing) return;
        if (!ownsProvider(providerId)) return;
        reanchorRef.current = filteredOptions[currentSelected()]?.id;
        void refreshProvider(providerId);
        return;
      }
      if (allowProviderManagement && key.meta && input === 'm' && currentSelected() !== addIndex) {
        const providerId = filteredOptions[currentSelected()]?.providerId;
        if (!providerId) {
          setError('Only custom providers can take extra models.');
          return;
        }
        if (refreshing || !ownsProvider(providerId)) return;
        // The form swallows every key, so this row stays selected until it closes.
        reanchorRef.current = filteredOptions[currentSelected()]?.id;
        setManualEntry({ providerId, value: '' });
        setError(undefined);
        setNotice(undefined);
        return;
      }
      if (allowProviderManagement && key.meta && input === 'd' && currentSelected() !== addIndex) {
        const option = filteredOptions[currentSelected()];
        const providerId = option?.providerId;
        if (!providerId) return;
        if (!removableProviderIds.has(providerId)) {
          setError('Only BYOK providers you added can be removed.');
          return;
        }
        const provider = providers[providerId];
        setRemoval({
          providerId,
          modelCount:
            removableProviderModelCounts?.get(providerId) ??
            (provider ? Object.keys(provider.models).length : 0),
          active: currentModel.startsWith(`${providerId}/`),
        });
        setError(undefined);
        return;
      }
      const typed = stripSgrMouseSequences(input);
      if (typed && !key.ctrl && !key.meta) {
        setFilter((value) => value + typed);
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

  if (manualEntry) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
        <Text bold color={theme.brand}>
          Add models to {manualEntry.providerId}
        </Text>
        <Text bold>Model IDs</Text>
        <Box>
          <Text color={theme.brand}>› </Text>
          <TextInput
            value={manualEntry.value}
            onChange={(value) => setManualEntry({ providerId: manualEntry.providerId, value })}
            onSubmit={(value) => addManualModels(manualEntry.providerId, value)}
          />
        </Box>
        <Text color={theme.subtle} dimColor>
          Comma-separate to add several. Kept when the list is refreshed.
        </Text>
        <Text color={theme.subtle} dimColor>
          Enter add · Esc cancel
        </Text>
        {error && <Text color={theme.error}>✕ {error}</Text>}
      </Box>
    );
  }

  if (removal) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
        <Text bold color={theme.error}>
          Remove BYOK provider?
        </Text>
        <Text>
          Provider: <Text bold>{removal.providerId}</Text>
        </Text>
        <Text>Models: {removal.modelCount}</Text>
        <Text>Settings: .book/settings.local.json</Text>
        <Text color={theme.warning ?? theme.subtle}>Removes credentials and all saved models.</Text>
        <Text color={theme.subtle}>
          {removal.active
            ? 'Active provider: switches to next configured default.'
            : 'Active model: remains unchanged.'}
        </Text>
        <Text color={theme.subtle} dimColor>
          Enter or Y remove · N or Esc cancel
        </Text>
        {error && <Text color={theme.error}>✕ {error}</Text>}
      </Box>
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
    ...(allowProviderManagement ? [{ type: 'add' as const }] : []),
  ].slice(windowStart, windowStart + maxVisibleModels);
  const hasRemovableProviders = removableProviderIds.size > 0;
  // Catalog actions only mean something on a row that belongs to a provider, so
  // they are announced there instead of crowding the always-on footer.
  const selectedProviderId =
    allowProviderManagement && selected !== addIndex
      ? filteredOptions[selected]?.providerId
      : undefined;
  const editableProviderId =
    selectedProviderId && removableProviderIds.has(selectedProviderId)
      ? selectedProviderId
      : undefined;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Text bold color={theme.brand}>
        {title ?? (allowProviderManagement ? 'Models & BYOK providers' : 'Choose subagent model')}
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
                {isSelected ? '›' : ' '} + Add BYOK provider…
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
              {isSelected ? '›' : ' '} {option.label}
              {option.providerId ? `  ${option.providerId}` : ''}
              {option.providerId && removableProviderIds.has(option.providerId) ? '  [BYOK]' : ''}
              {isCurrent ? '  (current)' : ''}
            </Text>
          );
        })}
      </Box>
      <Box flexDirection="column">
        {modelPickerHints({
          allowProviderManagement,
          hasRemovableProviders,
          canSetEffort:
            effortLevels.length > 0 &&
            selected !== addIndex &&
            Boolean(filteredOptions[selected]?.effort),
          // Refresh and add-model are announced only on a row they would act
          // on, which is also the only state in which they fire.
          editableProviderId: refreshing ? undefined : editableProviderId,
          compact: compact || !density.showOptionalHelp,
          filterable: true,
        }).map((line) => (
          <Text key={line} color={theme.subtle} dimColor>
            {line}
          </Text>
        ))}
        {refreshing && <Text color={theme.brand}>Refreshing {refreshing} models…</Text>}
        {notice && !refreshing && <Text color={theme.success}>✓ {notice}</Text>}
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
