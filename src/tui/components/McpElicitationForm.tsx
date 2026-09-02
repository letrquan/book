import { Box, Text, useInput } from 'ink';
import TextInput from './TextInputField.js';
import { useCallback, useMemo, useState } from 'react';
import { useKeyState } from '../hooks/useKeyState.js';
import {
  coerceElicitationValue,
  elicitationDefaults,
  validateElicitationField,
} from '../../mcp-elicitation.js';
import type {
  ElicitationField,
  ElicitationRequest,
  ElicitationResponse,
  ElicitationValue,
} from '../../types/tools.js';
import { useTheme } from '../theme.js';
import { truncateDisplay } from './word-wrap.js';
import { floatingFrameMetrics } from './chrome.js';

interface McpElicitationFormProps {
  request: ElicitationRequest;
  queueLength?: number;
  terminalWidth?: number;
  onResolve: (response: ElicitationResponse) => void;
  screenReader?: boolean;
}

/** Visible option rows for an enum field; longer lists scroll under the cursor. */
const OPTION_WINDOW = 6;

function displayValue(field: ElicitationField, value: ElicitationValue | undefined): string {
  if (value === undefined || value === '') return '—';
  if (field.kind === 'boolean') return value ? 'yes' : 'no';
  if (field.kind === 'enum') {
    const option = field.options.find((entry) => entry.value === value);
    return option?.label ?? String(value);
  }
  return String(value);
}

function matchingOptions(
  field: Extract<ElicitationField, { kind: 'enum' }>,
  filter: string,
): Array<{ value: string; label: string }> {
  const needle = filter.trim().toLowerCase();
  if (!needle) return field.options;
  return field.options.filter(
    (option) =>
      option.label.toLowerCase().includes(needle) || option.value.toLowerCase().includes(needle),
  );
}

/** Offset that keeps the cursor inside a fixed-height window over a long list. */
export function optionWindowStart(cursor: number, total: number, size = OPTION_WINDOW): number {
  if (total <= size) return 0;
  const half = Math.floor(size / 2);
  return Math.min(Math.max(0, cursor - half), total - size);
}

/**
 * Form for an MCP `elicitation/create` request: the server asks, the user
 * answers, and the answer travels back inside the still-open tool call.
 */
export function McpElicitationForm({
  request,
  queueLength = 1,
  terminalWidth = 80,
  onResolve,
  screenReader = false,
}: McpElicitationFormProps) {
  const theme = useTheme();
  const outerWidth = Math.max(20, Math.floor(terminalWidth));
  const frame = floatingFrameMetrics(outerWidth);
  const contentWidth = Math.max(14, frame.width - 4);
  const compact = outerWidth < 60;
  const [values, setValues] = useState<Record<string, ElicitationValue>>(() =>
    elicitationDefaults(request.fields),
  );
  // Read back by the key handler. Ink delivers a whole stdin chunk in one React
  // batch, so with plain state a batched arrow+Enter opened the field the cursor
  // had left — or submitted the form, when the arrow had moved off the submit
  // row.
  const [cursor, setCursor, currentCursor] = useKeyState(0);
  // `editing` deliberately stays plain render state. The enum row's Enter
  // belongs to the filter input's `onSubmit`, and the guard below relies on
  // still reading `true` when Ink's handler sees the same keypress. Making it
  // batch-safe let the handler fall through and advance a second time, which
  // skipped the next field entirely.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [optionCursor, setOptionCursor, currentOption] = useKeyState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  const rowCount = request.fields.length + 1;
  const submitRow = request.fields.length;
  const field = request.fields[cursor];
  const options = useMemo(
    () => (field?.kind === 'enum' ? matchingOptions(field, editing ? draft : '') : []),
    [field, editing, draft],
  );

  const resolveOnce = useCallback(
    (response: ElicitationResponse) => {
      if (resolved) return;
      setResolved(true);
      onResolve(response);
    },
    [onResolve, resolved],
  );

  const submit = useCallback(() => {
    for (const [index, entry] of request.fields.entries()) {
      const error = validateElicitationField(entry, values[entry.name]);
      if (error) {
        setCursor(index);
        setNotice(error);
        return;
      }
    }
    const content: Record<string, ElicitationValue> = {};
    for (const entry of request.fields) {
      const value = values[entry.name];
      if (value === undefined || value === '') continue;
      content[entry.name] = value;
    }
    resolveOnce({ action: 'accept', content });
  }, [request.fields, resolveOnce, values]);

  // Takes the row rather than closing over `field`. The caller is a key handler
  // that may have moved the cursor earlier in the same React batch, so the
  // field this opens has to be resolved from the batch-safe cursor — otherwise
  // an arrow off the send row left `field` undefined and opened nothing.
  const beginEdit = useCallback(
    (row: number) => {
      const target = request.fields[row];
      if (!target) return;
      setNotice(null);
      if (target.kind === 'boolean') {
        setValues((current) => ({ ...current, [target.name]: !current[target.name] }));
        return;
      }
      if (target.kind === 'enum') {
        const current = values[target.name];
        const index = target.options.findIndex((option) => option.value === current);
        setOptionCursor(Math.max(0, index));
        setDraft('');
        setEditing(true);
        return;
      }
      const current = values[target.name];
      setDraft(current === undefined ? '' : String(current));
      setEditing(true);
    },
    [request.fields, values, setOptionCursor],
  );

  const commitOption = useCallback(() => {
    if (field?.kind !== 'enum') return;
    const option = options[optionCursor];
    if (!option) {
      setNotice('No matching choice.');
      return;
    }
    setValues((current) => ({ ...current, [field.name]: option.value }));
    setEditing(false);
    setDraft('');
    setNotice(null);
    setCursor(Math.min(currentCursor() + 1, submitRow));
  }, [field, options, optionCursor, submitRow]);

  const commitText = useCallback(
    (raw: string) => {
      if (!field || field.kind === 'boolean' || field.kind === 'enum') return;
      const parsed = coerceElicitationValue(field, raw);
      if (typeof parsed === 'number' && Number.isNaN(parsed)) {
        setNotice(`${field.title} must be a number`);
        return;
      }
      const error = validateElicitationField(field, parsed);
      if (error) {
        setNotice(error);
        return;
      }
      setValues((current) => {
        const next = { ...current };
        if (parsed === undefined) delete next[field.name];
        else next[field.name] = parsed;
        return next;
      });
      setEditing(false);
      setDraft('');
      setNotice(null);
      setCursor(Math.min(currentCursor() + 1, submitRow));
    },
    [field, submitRow],
  );

  useInput((input, key) => {
    if (editing) {
      if (key.escape) {
        setEditing(false);
        setDraft('');
        setNotice(null);
        return;
      }
      if (field?.kind === 'enum') {
        // Enter belongs to the filter input's onSubmit; handling it here too
        // would commit the choice twice and skip a field.
        if (key.upArrow) setOptionCursor(Math.max(0, currentOption() - 1));
        else if (key.downArrow) {
          setOptionCursor(Math.min(Math.max(0, options.length - 1), currentOption() + 1));
        }
        return;
      }
      return;
    }

    if (key.upArrow || (key.shift && key.tab)) {
      setCursor((currentCursor() - 1 + rowCount) % rowCount);
      setNotice(null);
    } else if (key.downArrow || key.tab) {
      setCursor((currentCursor() + 1) % rowCount);
      setNotice(null);
    } else if (key.return || input === ' ') {
      if (currentCursor() === submitRow) submit();
      else beginEdit(currentCursor());
    } else if (input.toLowerCase() === 'd') {
      resolveOnce({ action: 'decline' });
    } else if (key.escape) {
      resolveOnce({ action: 'cancel' });
    }
  });

  // `field` is undefined while the cursor rests on the send row — that is a
  // normal state, not a reason to stop rendering the form.
  const queueText = queueLength > 1 ? ` · ${queueLength - 1} waiting` : '';
  const windowStart = optionWindowStart(optionCursor, options.length);
  const windowed = options.slice(windowStart, windowStart + OPTION_WINDOW);

  return (
    <Box
      width={frame.width}
      marginX={frame.marginX}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.border}
      paddingX={1}
    >
      <Box justifyContent="space-between">
        <Text bold color={theme.brand}>
          ? {truncateDisplay(request.server, Math.max(8, contentWidth - 18))}
        </Text>
        <Text color={theme.subtle}>MCP request{queueText}</Text>
      </Box>

      <Box marginTop={1}>
        <Text bold color={theme.text}>
          {request.message}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {request.fields.map((entry, index) => {
          const active = index === cursor;
          const value = displayValue(entry, values[entry.name]);
          const label = `${entry.title}${entry.required ? '*' : ''}`;
          return (
            <Box
              key={entry.name}
              paddingLeft={1}
              flexDirection={compact ? 'column' : 'row'}
              backgroundColor={active && !editing ? theme.surfaceActive : undefined}
            >
              <Text bold={active} color={active ? theme.selectionText : theme.text}>
                {active ? '›' : ' '} {label}
              </Text>
              <Text color={active ? theme.selectionText : theme.subtle}>
                {compact
                  ? `    ${value}`
                  : ` — ${truncateDisplay(value, Math.max(8, contentWidth - label.length - 6))}`}
              </Text>
            </Box>
          );
        })}

        <Box
          paddingLeft={1}
          backgroundColor={cursor === submitRow ? theme.surfaceActive : undefined}
        >
          <Text
            bold={cursor === submitRow}
            color={cursor === submitRow ? theme.selectionText : theme.text}
          >
            {cursor === submitRow ? '›' : ' '} ✓ Send to {request.server}
          </Text>
        </Box>
      </Box>

      {editing && field ? (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor={theme.border}
          paddingX={1}
        >
          <Text bold color={theme.brand}>
            {field.title}
          </Text>
          {field.description ? (
            <Text color={theme.subtle} dimColor>
              {truncateDisplay(field.description, contentWidth - 2)}
            </Text>
          ) : null}
          {field.kind === 'enum' ? (
            <Box flexDirection="column">
              <Box>
                <Text color={theme.brand}>filter › </Text>
                <TextInput
                  value={draft}
                  onChange={(value) => {
                    setDraft(value);
                    setOptionCursor(0);
                  }}
                  onSubmit={commitOption}
                />
              </Box>
              {windowed.map((option, index) => {
                const active = windowStart + index === optionCursor;
                return (
                  <Text
                    key={option.value}
                    bold={active}
                    color={active ? theme.selectionText : theme.text}
                    backgroundColor={active ? theme.surfaceActive : undefined}
                  >
                    {active ? '›' : ' '} {truncateDisplay(option.label, contentWidth - 4)}
                  </Text>
                );
              })}
              {options.length > windowed.length ? (
                <Text color={theme.subtle} dimColor>
                  {options.length} choices · showing {windowStart + 1}-
                  {windowStart + windowed.length}
                </Text>
              ) : null}
            </Box>
          ) : (
            <Box>
              <Text color={theme.brand}>› </Text>
              <TextInput
                value={draft}
                onChange={(value) => setDraft(value.slice(0, 2000))}
                onSubmit={commitText}
              />
            </Box>
          )}
          <Text color={theme.subtle} dimColor>
            {field.kind === 'enum'
              ? '↑↓ move · type to filter · Enter choose · Esc back'
              : 'Enter save · Esc back'}
          </Text>
        </Box>
      ) : null}

      {notice ? <Text color={theme.warning}>! {notice}</Text> : null}

      {!editing ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.subtle} dimColor>
            {screenReader
              ? 'Use Up and Down to move between fields. Enter edits a field or sends the form. D declines. Escape cancels.'
              : compact
                ? '↑↓ move · Enter edit/send'
                : '↑↓ move · Enter edit field or send · * required'}
          </Text>
          <Text color={theme.subtle} dimColor>
            D decline · Esc cancel
            {!compact ? ' · Keep secrets private' : ''}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
