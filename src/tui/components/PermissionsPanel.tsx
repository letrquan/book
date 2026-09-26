import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useKeyState } from '../hooks/useKeyState.js';
import { useTheme } from '../theme.js';
import type { PermissionMode } from '../../types/runtime.js';
import { panelContentWidth } from '../layout.js';
import { truncateDisplay } from './word-wrap.js';

export type PermissionList = 'allow' | 'ask' | 'deny';

export interface PermissionRuleEntry {
  list: PermissionList;
  rule: string;
}

export interface RemoveRuleResult {
  ok: boolean;
  error?: string;
  /** The rule is inherited from a layer this panel cannot write. */
  notLocal?: boolean;
}

interface PermissionsPanelProps {
  mode: PermissionMode;
  permissions: Record<PermissionList, readonly string[]>;
  /** Removes a rule from the local layer. Absent while another surface owns input. */
  onRemove?: (entry: PermissionRuleEntry) => RemoveRuleResult;
  /** False while a modal or picker owns the keyboard. */
  active?: boolean;
  terminalWidth?: number;
  screenReader?: boolean;
}

const LISTS: readonly PermissionList[] = ['allow', 'ask', 'deny'];

/** Flatten the three lists into the order the panel renders them. */
export function flattenPermissionRules(
  permissions: Record<PermissionList, readonly string[]>,
): PermissionRuleEntry[] {
  return LISTS.flatMap((list) => permissions[list].map((rule) => ({ list, rule })));
}

/**
 * The `/permissions` sheet.
 *
 * It used to be static text captioned "add via the Always allow option at tool
 * prompts" — accurate, and the whole problem: a rule went in on one keystroke
 * and came out only by hand-editing `.book/settings.local.json`. Adding a
 * permission was cheap and removing one was not, which is the wrong way round
 * for the surface that decides what the agent may do unattended.
 */
export function PermissionsPanel({
  mode,
  permissions,
  onRemove,
  active = true,
  terminalWidth = 80,
  screenReader = false,
}: PermissionsPanelProps) {
  const theme = useTheme();
  const entries = useMemo(() => flattenPermissionRules(permissions), [permissions]);
  const [selected, setSelected, currentSelected] = useKeyState(0);
  // The keyed actions read the cursor from a ref: arrows and `x` arriving in
  // one React batch would otherwise remove the row the cursor was on before
  // the arrows moved it.
  const move = (next: (current: number) => number) => {
    setSelected(entries.length === 0 ? 0 : next(currentSelected()));
  };
  const [notice, setNotice] = useState<string | null>(null);
  // The interior of the bordered box app.tsx wraps this in, taken from the same
  // panel grid that sizes the box -- so the rules stop exactly where it does.
  const width = panelContentWidth(terminalWidth);

  // Removing the last rule, or a reload shrinking the list, must not leave the
  // cursor pointing past the end.
  useEffect(() => {
    setSelected(Math.max(0, Math.min(currentSelected(), entries.length - 1)));
  }, [entries.length]);

  const canEdit = Boolean(onRemove) && entries.length > 0 && active && !screenReader;

  useInput(
    (input, key) => {
      if (key.upArrow) {
        setNotice(null);
        move((s) => (s - 1 + entries.length) % entries.length);
        return;
      }
      if (key.downArrow) {
        setNotice(null);
        move((s) => (s + 1) % entries.length);
        return;
      }
      if (input === 'x' || input === 'X') {
        const entry = entries[currentSelected()];
        if (!entry) return;
        const result = onRemove!(entry);
        if (result.ok) setNotice(`Removed ${entry.rule}`);
        else if (result.notLocal)
          setNotice(`${entry.rule} comes from a settings file this panel cannot edit.`);
        else setNotice(result.error ?? `Could not remove ${entry.rule}`);
      }
    },
    { isActive: canEdit },
  );

  // One key column for the mode rows and the rule lists, so every value on the
  // sheet starts at the same place.
  const keyWidth = 8;
  const valueWidth = Math.max(8, width - keyWidth);
  const keyCell = (key: string) => (
    <Box width={keyWidth} flexShrink={0}>
      <Text color={theme.inactive}>{key}</Text>
    </Box>
  );

  return (
    <Box flexDirection="column">
      <Box>
        {keyCell('mode')}
        <Text color={theme.text} bold>
          {truncateDisplay(mode, valueWidth)}
        </Text>
      </Box>
      <Box>
        {keyCell('modes')}
        <Text color={theme.subtle}>
          {truncateDisplay(
            'default · auto · plan · accept-edits · dontAsk · bypassPermissions',
            valueWidth,
          )}
        </Text>
      </Box>
      <Box>
        {keyCell('switch')}
        <Text color={theme.subtle}>Alt+M or Shift+Tab</Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {LISTS.map((list) => (
          <Box key={list}>
            {keyCell(list)}
            <Box flexDirection="column">
              {permissions[list].length === 0 ? (
                <Text color={theme.inactive}>none</Text>
              ) : (
                permissions[list].map((rule) => {
                  const index = entries.findIndex(
                    (entry) => entry.list === list && entry.rule === rule,
                  );
                  const isSelected = canEdit && index === selected;
                  return (
                    <Text key={`${list}-${rule}`}>
                      <Text color={theme.brand}>{isSelected ? '› ' : '  '}</Text>
                      <Text color={isSelected ? theme.selectionText : theme.text} bold={isSelected}>
                        {truncateDisplay(rule, Math.max(4, valueWidth - 2))}
                      </Text>
                    </Text>
                  );
                })
              )}
            </Box>
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {entries.length === 0 ? (
          <Text color={theme.inactive}>
            {truncateDisplay('No rules yet. "Always allow" at a tool prompt adds one.', width)}
          </Text>
        ) : canEdit ? (
          <Text color={theme.inactive}>↑↓ select · x remove</Text>
        ) : null}
        {notice ? <Text color={theme.warning}>{truncateDisplay(notice, width)}</Text> : null}
      </Box>
    </Box>
  );
}
