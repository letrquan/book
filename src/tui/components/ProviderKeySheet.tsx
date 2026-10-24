import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import TextInput from './TextInputField.js';
import type { ProviderConfig } from '../../settings.js';
import type { RetryConfig } from '../../types/runtime.js';
import { checkProviderKey, validateApiKey } from '../../provider-key.js';
import type { DiscoveredModel, ModelDiscoveryOptions } from '../../provider/model-discovery.js';
import { useDensityMetrics } from '../density.js';
import { useTheme } from '../theme.js';
import { DecisionSheet, KeyValueList } from './chrome.js';
import { panelGrid, sheetContentWidth } from '../layout.js';

export interface ProviderKeySheetProps {
  providerId: string;
  /** The provider as the session resolved it: its endpoint is the only one the key is sent to. */
  provider: ProviderConfig;
  /** Where a relative `{file:…}` reference is rooted. */
  workspace: string;
  retry: RetryConfig;
  terminalWidth?: number;
  compact?: boolean;
  discover?: (options: ModelDiscoveryOptions) => Promise<DiscoveredModel[]>;
  /** Persist the key as typed. Returns an error to show, as the picker's other saves do. */
  onSave: (apiKey: string) => { ok: boolean; error?: string };
  /** The key is saved; `checked` says whether the endpoint accepted it first. */
  onSaved: (checked: boolean) => void;
  onCancel: () => void;
}

/**
 * Where the key is in its round trip. `entry` holds the masked field; `checking` waits on the
 * endpoint's model list; `failed` shows why it said no and offers save anyway or retry.
 *
 * Plain render state, as in the add-provider wizard: on `entry` Enter belongs to the field's
 * `onSubmit`, and the key handler relies on still reading `entry` for that same keypress.
 */
type Step = 'entry' | 'checking' | 'failed';

/**
 * `/model`'s `Alt+K`: replace a configured provider's API key without removing the provider, so
 * its catalog, active model and per-model overrides survive a rotated or expired key (#592).
 *
 * The key never appears on screen: the field masks every character, and nothing else here renders
 * it. It is tested against the provider's own endpoint before it is saved.
 */
export function ProviderKeySheet({
  providerId,
  provider,
  workspace,
  retry,
  terminalWidth = 80,
  compact = false,
  discover,
  onSave,
  onSaved,
  onCancel,
}: ProviderKeySheetProps) {
  const theme = useTheme();
  const density = useDensityMetrics();
  const [step, setStep] = useState<Step>('entry');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string>();
  const abortRef = useRef<AbortController | null>(null);
  // Same-chunk guards: Ink runs the handler once per stdin chunk, so two `s` or two `r` presses
  // can both arrive before the step they start re-renders.
  const checkingRef = useRef(false);
  const savingRef = useRef(false);

  useEffect(() => () => abortRef.current?.abort(), []);

  const save = useCallback(
    (apiKey: string, checked: boolean) => {
      if (savingRef.current) return;
      savingRef.current = true;
      const result = onSave(apiKey);
      if (!result.ok) {
        savingRef.current = false;
        setError(result.error ?? 'Could not save the API key.');
        setStep('entry');
        return;
      }
      onSaved(checked);
    },
    [onSave, onSaved],
  );

  const check = useCallback(
    async (raw: string) => {
      let apiKey: string;
      try {
        apiKey = validateApiKey(raw);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Enter an API key.');
        setStep('entry');
        return;
      }
      if (checkingRef.current) return;
      checkingRef.current = true;
      const controller = new AbortController();
      abortRef.current = controller;
      setError(undefined);
      setStep('checking');
      try {
        const result = await checkProviderKey({
          provider,
          apiKey,
          workspace,
          retry,
          discover,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (result.ok) {
          save(apiKey, true);
          return;
        }
        setError(result.error);
        setStep('failed');
      } finally {
        checkingRef.current = false;
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [discover, provider, retry, save, workspace],
  );

  useInput(
    (input, key) => {
      if (key.ctrl && input === 'c') {
        abortRef.current?.abort();
        onCancel();
        return;
      }
      if (step === 'entry') {
        // The field owns every other key, Enter included.
        if (key.escape) onCancel();
        return;
      }
      if (step === 'checking') {
        if (key.escape) {
          abortRef.current?.abort();
          setStep('entry');
        }
        return;
      }
      if (key.escape) {
        setError(undefined);
        setStep('entry');
        return;
      }
      if (input === 'r') void check(value);
      else if (input === 's') save(value, false);
    },
    { isActive: true },
  );

  const sheetWidth = panelGrid(terminalWidth).width;
  const showOptionalHelp = !compact && density.showOptionalHelp;
  const endpoint = provider.baseURL ?? provider.baseUrl;

  return (
    <DecisionSheet label="Update API key" tone={theme.brand} meta={providerId} width={sheetWidth}>
      <KeyValueList
        width={sheetContentWidth(sheetWidth)}
        rows={[
          { key: 'Provider', value: providerId },
          { key: 'Endpoint', value: endpoint ?? '(no base URL configured)' },
        ]}
      />
      <Box marginTop={1} flexDirection="column">
        {step === 'entry' && (
          <>
            <Text bold>New API key</Text>
            <Box>
              <Text color={theme.brand}>› </Text>
              <TextInput
                value={value}
                onChange={setValue}
                onSubmit={(submitted) => void check(submitted)}
                mask="•"
              />
            </Box>
            {showOptionalHelp && (
              <Text color={theme.subtle} dimColor>
                Tested against the endpoint, then saved to your user settings. {'{env:VAR}'} and{' '}
                {'{file:path}'} work too.
              </Text>
            )}
          </>
        )}
        {step === 'checking' && <Text color={theme.brand}>Testing the key…</Text>}
        {step === 'failed' && (
          <>
            <Text color={theme.error}>✕ {error}</Text>
            <Text color={theme.subtle}>s save anyway · r retry · Esc edit key</Text>
          </>
        )}
        {error && step === 'entry' && <Text color={theme.error}>✕ {error}</Text>}
      </Box>
      <Text color={theme.subtle} dimColor>
        {step === 'entry'
          ? 'Enter test & save · Esc cancel'
          : step === 'checking'
            ? 'Esc stop the test'
            : 'Ctrl+C cancel'}
      </Text>
    </DecisionSheet>
  );
}
