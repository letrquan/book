import { Box, Text, useInput } from 'ink';
import TextInput from './TextInputField.js';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useKeyState } from '../hooks/useKeyState.js';
import type { RetryConfig } from '../../types/runtime.js';
import {
  DEFAULT_PROVIDER_BASE_URLS,
  discoverModels,
  type DiscoveredModel,
  type ModelDiscoveryOptions,
  type ProviderProtocol,
} from '../../provider/model-discovery.js';
import {
  parseModelIds,
  validateApiKey,
  validateBaseUrl,
  validateDisplayLabel,
  validateProviderId,
  type ProviderSaveRequest,
} from '../model-options.js';
import { useDensityMetrics } from '../density.js';
import { stripSgrMouseSequences } from '../mouse.js';
import { useTheme } from '../theme.js';

export interface ByokWizardProps {
  retry: RetryConfig;
  compact?: boolean;
  maxVisibleModels?: number;
  discover?: (options: ModelDiscoveryOptions) => Promise<DiscoveredModel[]>;
  onSave: (
    request: ProviderSaveRequest,
  ) => { ok: boolean; error?: string } | Promise<{ ok: boolean; error?: string }>;
  onCancel: () => void;
}

type Step =
  | 'provider'
  | 'protocol'
  | 'base-url'
  | 'api-key'
  | 'model-source'
  | 'discovering'
  | 'discovery-error'
  | 'choose-models'
  | 'manual-model'
  | 'label'
  | 'review';

/** Where this provider's model list comes from. */
type ModelSource = 'discover' | 'manual';

const TOTAL_STEPS = 9;

const STEP_NUMBER: Partial<Record<Step, number>> = {
  provider: 1,
  protocol: 2,
  'base-url': 3,
  'api-key': 4,
  'model-source': 5,
  discovering: 6,
  'discovery-error': 6,
  'choose-models': 7,
  'manual-model': 7,
  label: 8,
  review: 9,
};

const MODEL_SOURCES: readonly { value: ModelSource; title: string; hint: string }[] = [
  {
    value: 'discover',
    title: 'Discover models automatically',
    hint: 'Asks the endpoint for its model list.',
  },
  {
    value: 'manual',
    title: 'Enter model IDs manually',
    hint: 'Use this when the endpoint has no model-list API.',
  },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Model discovery failed.';
}

export function ByokWizard({
  retry,
  compact = false,
  maxVisibleModels = 8,
  discover = discoverModels,
  onSave,
  onCancel,
}: ByokWizardProps) {
  const theme = useTheme();
  const density = useDensityMetrics();
  const [step, setStep] = useState<Step>('provider');
  const [providerId, setProviderId] = useState('');
  const [type, setType] = useState<ProviderProtocol>('openai');
  const [baseURL, setBaseURL] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelSource, setModelSource] = useState<ModelSource>('discover');
  const [models, setModels] = useState<DiscoveredModel[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Read back by the key handler, which Ink runs once per stdin chunk: with
  // plain state a batched arrow+Space toggled the model above the highlighted
  // one.
  const [modelCursor, setModelCursor, currentModel] = useKeyState(0);
  const [modelFilter, setModelFilter] = useState('');
  const [manualModel, setManualModel] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const discoveryAbortRef = useRef<AbortController | null>(null);
  const saveRef = useRef(false);

  const filteredModels = useMemo(() => {
    const query = modelFilter.trim().toLowerCase();
    return query
      ? models.filter(
          (model) =>
            model.id.toLowerCase().includes(query) || model.label?.toLowerCase().includes(query),
        )
      : models;
  }, [modelFilter, models]);

  const activeModelId = selectedIds[0] ?? '';

  const startDiscovery = useCallback(async () => {
    setError(undefined);
    setStep('discovering');
    const controller = new AbortController();
    discoveryAbortRef.current = controller;
    try {
      const discovered = await discover({
        type,
        baseUrl: validateBaseUrl(type, baseURL),
        apiKey: validateApiKey(apiKey),
        retry,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (discovered.length === 0) {
        // The error screen's own fallback is the way forward, so route there
        // rather than into an empty picker that refuses to continue.
        setError('The endpoint did not return any models.');
        setStep('discovery-error');
        return;
      }
      setModelSource('discover');
      setModels(discovered);
      setSelectedIds(discovered.map((model) => model.id));
      setModelCursor(0);
      setModelFilter('');
      setStep('choose-models');
    } catch (caught) {
      if (controller.signal.aborted) {
        setStep('model-source');
        return;
      }
      setError(errorMessage(caught));
      setStep('discovery-error');
    } finally {
      if (discoveryAbortRef.current === controller) discoveryAbortRef.current = null;
    }
  }, [apiKey, baseURL, discover, retry, type]);

  const goBack = useCallback(() => {
    setError(undefined);
    switch (step) {
      case 'provider':
        onCancel();
        break;
      case 'protocol':
        setStep('provider');
        break;
      case 'base-url':
        setStep('protocol');
        break;
      case 'api-key':
        setStep('base-url');
        break;
      case 'model-source':
        setStep('api-key');
        break;
      case 'discovering':
        discoveryAbortRef.current?.abort();
        break;
      case 'discovery-error':
      case 'choose-models':
      case 'manual-model':
        setStep('model-source');
        break;
      case 'label':
        setStep(modelSource === 'manual' ? 'manual-model' : 'choose-models');
        break;
      case 'review':
        setStep('label');
        break;
    }
  }, [modelSource, onCancel, step]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        discoveryAbortRef.current?.abort();
        onCancel();
        return;
      }
      if (key.escape) {
        goBack();
        return;
      }
      if (step === 'protocol') {
        if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
          const next: ProviderProtocol = type === 'openai' ? 'anthropic' : 'openai';
          setType(next);
          setBaseURL(DEFAULT_PROVIDER_BASE_URLS[next]);
          return;
        }
        if (key.return) setStep('base-url');
        return;
      }
      if (step === 'model-source') {
        if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
          setModelSource((current) => (current === 'discover' ? 'manual' : 'discover'));
          return;
        }
        if (key.return) {
          if (modelSource === 'discover') void startDiscovery();
          else {
            setError(undefined);
            setModels([]);
            setSelectedIds([]);
            setStep('manual-model');
          }
        }
        return;
      }
      if (step === 'discovery-error') {
        if (input === 'r') void startDiscovery();
        if (input === 'm') {
          setError(undefined);
          setModelSource('manual');
          setModels([]);
          setSelectedIds([]);
          setStep('manual-model');
        }
        return;
      }
      if (step === 'choose-models') {
        const typed = stripSgrMouseSequences(input);
        if (key.return) {
          if (selectedIds.length === 0) setError('Select at least one model.');
          else {
            setError(undefined);
            setStep('label');
          }
          return;
        }
        if (key.backspace || key.delete) {
          setModelFilter((value) => value.slice(0, -1));
          setModelCursor(0);
          return;
        }
        if (filteredModels.length === 0) {
          if (typed && typed !== ' ' && !key.ctrl && !key.meta) {
            setModelFilter((value) => value + typed);
          }
          return;
        }
        if (key.upArrow) {
          setModelCursor((currentModel() - 1 + filteredModels.length) % filteredModels.length);
          return;
        }
        if (key.downArrow) {
          setModelCursor((currentModel() + 1) % filteredModels.length);
          return;
        }
        if (input === ' ') {
          const id = filteredModels[currentModel()]?.id;
          if (!id) return;
          setSelectedIds((current) =>
            current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
          );
          return;
        }
        if (typed && !key.ctrl && !key.meta) {
          setModelFilter((value) => value + typed);
          setModelCursor(0);
        }
        return;
      }
      if (step === 'review' && key.return && !saving && !saveRef.current) {
        saveRef.current = true;
        setSaving(true);
        setError(undefined);
        const chosen = models.filter((model) => selectedIds.includes(model.id));
        void Promise.resolve(
          onSave({
            providerId,
            type,
            baseURL,
            apiKey,
            models: chosen.length > 0 ? chosen : [{ id: activeModelId }],
            activeModelId,
            activeLabel: label || undefined,
            manual: modelSource === 'manual',
          }),
        ).then((result) => {
          if (!result.ok) {
            saveRef.current = false;
            setSaving(false);
            setError(result.error ?? 'Could not save provider settings.');
          }
        });
      }
    },
    { isActive: true },
  );

  const submitProvider = (value: string) => {
    try {
      setProviderId(validateProviderId(value));
      setError(undefined);
      setStep('protocol');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const submitBaseUrl = (value: string) => {
    try {
      setBaseURL(validateBaseUrl(type, value || DEFAULT_PROVIDER_BASE_URLS[type]));
      setError(undefined);
      setStep('api-key');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const submitApiKey = (value: string) => {
    try {
      setApiKey(validateApiKey(value));
      setError(undefined);
      setStep('model-source');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const submitManualModel = (value: string) => {
    try {
      const ids = parseModelIds(value);
      setManualModel(ids.join(', '));
      setModelSource('manual');
      setModels(ids.map((id) => ({ id })));
      setSelectedIds(ids);
      setError(undefined);
      setStep('label');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const submitLabel = (value: string) => {
    try {
      setLabel(validateDisplayLabel(value) ?? '');
      setError(undefined);
      setStep('review');
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  const stepNumber = STEP_NUMBER[step];
  const modelWindowStart = Math.max(
    0,
    Math.min(
      modelCursor - Math.floor(maxVisibleModels / 2),
      filteredModels.length - maxVisibleModels,
    ),
  );
  const visibleModels = filteredModels.slice(modelWindowStart, modelWindowStart + maxVisibleModels);
  const showOptionalHelp = !compact && density.showOptionalHelp;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color={theme.brand}>
          Add BYOK provider
        </Text>
        {stepNumber && (
          <Text color={theme.subtle} dimColor>
            Step {stepNumber}/{TOTAL_STEPS}
          </Text>
        )}
      </Box>

      <Box flexDirection="column">
        {step === 'provider' && (
          <Field
            label="Provider ID"
            hint={showOptionalHelp ? 'Example: openrouter' : undefined}
            value={providerId}
            onChange={setProviderId}
            onSubmit={submitProvider}
          />
        )}
        {step === 'protocol' && (
          <>
            <Text bold>Protocol</Text>
            {(['openai', 'anthropic'] as const).map((value) => (
              <Text key={value} color={type === value ? theme.brand : theme.subtle}>
                {type === value ? '›' : ' '}{' '}
                {value === 'openai' ? 'OpenAI-compatible' : 'Anthropic'}
              </Text>
            ))}
          </>
        )}
        {step === 'base-url' && (
          <Field
            label="Base URL"
            hint={
              !showOptionalHelp
                ? undefined
                : type === 'openai'
                  ? 'Include /v1 when required by the endpoint.'
                  : 'Book adds /v1 for Anthropic requests.'
            }
            placeholder={DEFAULT_PROVIDER_BASE_URLS[type]}
            value={baseURL}
            onChange={setBaseURL}
            onSubmit={submitBaseUrl}
          />
        )}
        {step === 'api-key' && (
          <Field
            label="API key"
            hint={
              showOptionalHelp
                ? 'Stored in ~/.book/settings.json (shared across all your projects).'
                : undefined
            }
            value={apiKey}
            onChange={setApiKey}
            onSubmit={submitApiKey}
            mask="•"
          />
        )}
        {step === 'model-source' && (
          <>
            <Text bold>Models</Text>
            {MODEL_SOURCES.map((source) => (
              <Text
                key={source.value}
                color={modelSource === source.value ? theme.brand : theme.subtle}
              >
                {modelSource === source.value ? '›' : ' '} {source.title}
              </Text>
            ))}
            {showOptionalHelp && (
              <Text color={theme.subtle} dimColor>
                {MODEL_SOURCES.find((source) => source.value === modelSource)?.hint}
              </Text>
            )}
          </>
        )}
        {step === 'discovering' && (
          <>
            <Text bold>Discover models</Text>
            <Text color={theme.brand}>Discovering models…</Text>
          </>
        )}
        {step === 'discovery-error' && (
          <>
            <Text bold>Discover models</Text>
            <Text color={theme.error}>✕ {error}</Text>
            <Text color={theme.subtle}>r retry · m enter model manually · Esc back</Text>
          </>
        )}
        {step === 'choose-models' && (
          <>
            <Text bold>Choose models</Text>
            <Text color={theme.subtle}>Filter: {modelFilter || '(type to filter)'}</Text>
            {visibleModels.length === 0 ? (
              <Text color={theme.subtle}>(no matching models)</Text>
            ) : (
              visibleModels.map((model, index) => {
                const absoluteIndex = modelWindowStart + index;
                return (
                  <Text
                    key={model.id}
                    backgroundColor={
                      absoluteIndex === modelCursor ? theme.surfaceActive : undefined
                    }
                    color={absoluteIndex === modelCursor ? theme.selectionText : theme.subtle}
                    bold={absoluteIndex === modelCursor}
                  >
                    {absoluteIndex === modelCursor ? '›' : ' '}{' '}
                    {selectedIds.includes(model.id) ? '◉' : '○'} {model.label ?? model.id}
                    {model.label && model.label !== model.id ? `  ${model.id}` : ''}
                  </Text>
                );
              })
            )}
            <Text color={theme.subtle} dimColor>
              ↑↓ move · Space toggle · Enter continue ({selectedIds.length} selected)
            </Text>
          </>
        )}
        {step === 'manual-model' && (
          <Field
            label="Model IDs"
            hint={
              showOptionalHelp
                ? 'Example: deepseek-chat, deepseek-reasoner — comma-separate to add several.'
                : undefined
            }
            value={manualModel}
            onChange={setManualModel}
            onSubmit={submitManualModel}
          />
        )}
        {step === 'label' && (
          <Field
            label="Display label (optional)"
            value={label}
            onChange={setLabel}
            onSubmit={submitLabel}
          />
        )}
        {step === 'review' && (
          <>
            <Text bold>Review</Text>
            <Summary label="Provider" value={providerId} />
            <Summary
              label="Protocol"
              value={type === 'openai' ? 'OpenAI-compatible' : 'Anthropic'}
            />
            <Summary label="Base URL" value={baseURL} />
            <Summary label="API key" value="•••••••• (stored in ~/.book)" />
            <Summary
              label="Models"
              value={`${selectedIds.length} selected (${modelSource === 'manual' ? 'entered manually' : 'discovered'})`}
            />
            <Summary label="Active" value={activeModelId} />
            {label && <Summary label="Label" value={label} />}
          </>
        )}
      </Box>

      {error && step !== 'discovery-error' && <Text color={theme.error}>✕ {error}</Text>}
      <Text color={theme.subtle} dimColor>
        {saving
          ? 'Saving…'
          : step === 'review'
            ? 'Enter save & use · Esc back · Ctrl+C cancel'
            : step === 'discovering'
              ? 'Esc cancel request'
              : step === 'choose-models' || step === 'discovery-error'
                ? ''
                : step === 'protocol' || step === 'model-source'
                  ? '↑↓ choose · Enter continue · Esc back'
                  : showOptionalHelp
                    ? 'Enter continue · Esc back · Ctrl+C cancel'
                    : 'Enter continue · Esc back'}
      </Text>
    </Box>
  );
}

function Field({
  label,
  hint,
  placeholder,
  value,
  onChange,
  onSubmit,
  mask,
}: {
  label: string;
  hint?: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  mask?: string;
}) {
  const theme = useTheme();
  return (
    <>
      <Text bold>{label}</Text>
      <Box>
        <Text color={theme.brand}>› </Text>
        <TextInput
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          placeholder={placeholder}
          mask={mask}
        />
      </Box>
      {hint && (
        <Text color={theme.subtle} dimColor>
          {hint}
        </Text>
      )}
    </>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <Box>
      <Box width={12}>
        <Text color={theme.subtle}>{label}</Text>
      </Box>
      <Text>{value}</Text>
    </Box>
  );
}
