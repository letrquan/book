import { Box, Text, useInput } from 'ink';
import TextInput from './TextInputField.js';
import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useKeyState } from '../hooks/useKeyState.js';
import { useTheme } from '../theme.js';
import { PROMPT_MARK } from '../marks.js';
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
import { ProviderKeySheet } from './ProviderKeySheet.js';
import { modelPickerHints } from './model-picker-hints.js';
import { useDensityMetrics } from '../density.js';
import { stripSgrMouseSequences } from '../mouse.js';
import { SoftPanel } from './chrome.js';
import { panelGrid, sheetContentWidth } from '../layout.js';

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
  /** Terminal columns; the sheet's rule spans them. */
  terminalWidth?: number;
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
  /**
   * `Alt+K`: replace the API key of a provider the user owns, as typed (a literal or a reference).
   * Called once the key sheet has tested it, or the user chose to save it untested.
   */
  onUpdateProviderKey: (providerId: string, apiKey: string) => { ok: boolean; error?: string };
  onProviderSaved?: (request: ProviderSaveRequest) => void;
  allowProviderManagement?: boolean;
  /**
   * `Alt+S`: use the model for this session without saving it. Only the main
   * model has that choice; the compact, advisor and subagent pickers save what
   * they pick, so there the chord is ignored and the footer does not offer it.
   */
  allowSessionOnly?: boolean;
  /**
   * A last row for "none of these", for a setting that can be off (the advisor).
   * It is the current choice when `currentModel` is empty. It takes the add row's
   * slot, so it never appears beside provider management: asked for both, the
   * picker offers provider management and no off row.
   */
  offOption?: { label: string };
  /** Enter on the off row. Returns an error to show, as `onPick` does. */
  onPickOff?: () => { ok: boolean; error?: string } | void;
  onCancel: () => void;
}

const EMPTY_PROVIDER_IDS: ReadonlySet<string> = new Set();

function plural(count: number): string {
  return count === 1 ? '' : 's';
}

export function ModelPicker({
  title,
  terminalWidth = 80,
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
  onUpdateProviderKey,
  onProviderSaved,
  allowProviderManagement = true,
  allowSessionOnly = true,
  offOption,
  onPickOff,
  onCancel,
}: ModelPickerProps) {
  const theme = useTheme();
  const sheetWidth = panelGrid(Math.max(20, Math.floor(terminalWidth))).width;
  const density = useDensityMetrics();
  // Open on the current choice, which the windowed list would otherwise scroll
  // out of view. The filter is empty on open, so an index in `options` is also
  // its index in `filteredOptions`; the off row sits one past the last model.
  const [selected, setSelected, currentSelected] = useKeyState(() => {
    const index = options.findIndex((option) => option.id === currentModel);
    if (index >= 0) return index;
    return currentModel === '' && offOption && !allowProviderManagement ? options.length : 0;
  });
  const [filter, setFilter] = useState('');
  const [onEffort, setOnEffort] = useState(false);
  const [showWizard, setShowWizard] = useState(false);
  const [refreshing, setRefreshing] = useState<string>();
  const [manualEntry, setManualEntry] = useState<{ providerId: string; value: string }>();
  // Batch-safe, like `removal`: a key typed straight after Alt+K can be handled before the sheet
  // has rendered, and it must not land in the picker's filter, where a pasted key would show.
  const [keySheet, setKeySheet, currentKeySheet] = useKeyState<string | undefined>(undefined);
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
  // At most one row follows the models: "+ Add BYOK provider…", or the caller's
  // off row. Provider management wins, so the two share the slot at `addIndex`
  // -- one past the last model, which is why a model row's index is always its
  // index in `filteredOptions` and every `filteredOptions[selected]` lookup holds.
  const hasOffRow = Boolean(offOption) && !allowProviderManagement;
  const itemCount = filteredOptions.length + (allowProviderManagement || hasOffRow ? 1 : 0);
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

  // Shares `handlePick`'s once-only latch: a second Enter in the same chunk must
  // not switch the setting off after the first one has already closed the picker.
  const handlePickOff = useCallback(() => {
    if (pickedRef.current || !onPickOff) return;
    const result = onPickOff();
    if (result && !result.ok) {
      setError(result.error ?? 'Could not save the selection.');
      return;
    }
    pickedRef.current = true;
  }, [onPickOff]);

  const refreshProvider = useCallback(
    async (providerId: string) => {
      const provider = providers[providerId];
      if (!provider) return;
      if (provider.type === 'chatgpt') {
        // Its catalog comes with the sign-in, through the plan token, never an API key.
        setError(
          `${providerId} lists the models of your ChatGPT plan: run \`book auth login\` to refresh them.`,
        );
        return;
      }
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
      // The sheet owns every key while it is open. A provider removed underneath it closes it.
      const sheet = currentKeySheet();
      if (showWizard || (sheet && providers[sheet])) return;
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
        else if (hasOffRow && currentSelected() === addIndex) handlePickOff();
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
      if (allowSessionOnly && key.meta && input === 's' && currentSelected() !== addIndex) {
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
      if (allowProviderManagement && key.meta && input === 'k' && currentSelected() !== addIndex) {
        const providerId = filteredOptions[currentSelected()]?.providerId;
        if (!providerId) {
          setError('Only BYOK providers you added have a key to change here.');
          return;
        }
        if (refreshing || !ownsProvider(providerId)) return;
        if (!providers[providerId]) {
          setError(`${providerId} is no longer configured.`);
          return;
        }
        setKeySheet(providerId);
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
        terminalWidth={terminalWidth}
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

  const keyProvider = keySheet ? providers[keySheet] : undefined;
  if (keySheet && keyProvider) {
    return (
      <ProviderKeySheet
        providerId={keySheet}
        provider={keyProvider}
        workspace={workspace}
        retry={retry}
        compact={compact}
        terminalWidth={terminalWidth}
        discover={discover}
        onSave={(apiKey) => onUpdateProviderKey(keySheet, apiKey)}
        onSaved={(checked) => {
          setKeySheet(undefined);
          setNotice(
            checked
              ? `${keySheet}: API key checked and saved.`
              : `${keySheet}: API key saved without a check.`,
          );
        }}
        onCancel={() => setKeySheet(undefined)}
      />
    );
  }

  if (manualEntry) {
    return (
      <SoftPanel title={`Add models to ${manualEntry.providerId}`} width={sheetWidth}>
        <Text bold color={theme.text}>
          Model IDs
        </Text>
        <Box>
          <Text color={theme.brand}>{`${PROMPT_MARK} `}</Text>
          <TextInput
            value={manualEntry.value}
            onChange={(value) => setManualEntry({ providerId: manualEntry.providerId, value })}
            onSubmit={(value) => addManualModels(manualEntry.providerId, value)}
          />
        </Box>
        <Text color={theme.subtle} dimColor>
          Comma-separate to add several. Kept when the list is refreshed.
        </Text>
        <Text color={theme.inactive}>Enter add · Esc cancel</Text>
        {error && <Text color={theme.error}>✕ {error}</Text>}
      </SoftPanel>
    );
  }

  if (removal) {
    return (
      <SoftPanel tone="error" title="Remove BYOK provider?" width={sheetWidth}>
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
        <Text color={theme.inactive}>Enter or Y remove · N or Esc cancel</Text>
        {error && <Text color={theme.error}>✕ {error}</Text>}
      </SoftPanel>
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
    ...(hasOffRow && offOption ? [{ type: 'off' as const, label: offOption.label }] : []),
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
    <SoftPanel
      title={title ?? (allowProviderManagement ? 'Models' : 'Choose subagent model')}
      meta={`${filteredOptions.length} ${filteredOptions.length === 1 ? 'model' : 'models'}`}
      width={sheetWidth}
    >
      {/* Typing filters, the way the composer takes a prompt: after the prompt mark. */}
      <Text>
        <Text color={theme.brand}>{`${PROMPT_MARK} `}</Text>
        <Text color={filter ? theme.text : theme.inactive}>{filter || 'type to filter'}</Text>
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {rows.map((row, visibleIndex) => {
          const index = windowStart + visibleIndex;
          const isSelected = index === selected && !onEffort;
          if (row.type === 'add') {
            return (
              <Text key="add-byok">
                <Text color={theme.brand}>{isSelected ? '› ' : '  '}</Text>
                <Text color={isSelected ? theme.selectionText : theme.subtle} bold={isSelected}>
                  + Add BYOK provider…
                </Text>
              </Text>
            );
          }
          if (row.type === 'off') {
            return (
              <Text key="off">
                <Text color={theme.brand}>{isSelected ? '› ' : '  '}</Text>
                <Text color={isSelected ? theme.selectionText : theme.text} bold={isSelected}>
                  {row.label}
                </Text>
                {currentModel === '' ? <Text color={theme.brand}>{'  ✓ current'}</Text> : null}
              </Text>
            );
          }
          const option = row.option;
          const isCurrent = option.id === currentModel;
          return (
            <Text key={option.id}>
              <Text color={theme.brand}>{isSelected ? '› ' : '  '}</Text>
              <Text color={isSelected ? theme.selectionText : theme.text} bold={isSelected}>
                {option.label}
              </Text>
              <Text color={theme.inactive}>
                {option.providerId ? `  ${option.providerId}` : ''}
                {option.providerId && removableProviderIds.has(option.providerId) ? '  BYOK' : ''}
              </Text>
              {isCurrent ? <Text color={theme.brand}>{'  ✓ current'}</Text> : null}
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
          allowSessionOnly,
          width: sheetContentWidth(sheetWidth),
        }).map((line) => (
          <Text key={line} color={theme.inactive}>
            {line}
          </Text>
        ))}
        {refreshing && <Text color={theme.subtle}>Refreshing {refreshing} models…</Text>}
        {notice && !refreshing && <Text color={theme.success}>✓ {notice}</Text>}
        {onEffort && (
          <Text color={theme.text} bold>
            Effort [{displayedEffort}] <Text color={theme.inactive}>← → adjust</Text>
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
    </SoftPanel>
  );
}
