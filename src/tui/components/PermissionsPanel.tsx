import { Box, Text, useInput } from 'ink';
import { useEffect, useMemo, useState } from 'react';
import { useKeyState } from '../hooks/useKeyState.js';
import { useTheme } from '../theme.js';
import type { PermissionMode } from '../../types/runtime.js';
import { SelectionRow } from './chrome.js';
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
  const width = Math.max(24, Math.min(terminalWidth, 120) - 6);

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

  return (
    <Box flexDirection="column">
      <Box flexDirection="column">
        <Text color={theme.subtle} dimColor>
          Current mode — {mode}
        </Text>
        <Text color={theme.subtle} dimColor>
          Modes — default, auto, plan, accept-edits, dontAsk, bypassPermissions
        </Text>
        <Text color={theme.subtle} dimColor>
          Switch — Alt+M or Shift+Tab
        </Text>
      </Box>
      <Box flexDirection="column">
        <Text color={theme.subtle} dimColor>
          {entries.length === 0
            ? 'No rules yet. "Always allow" at a tool prompt adds one.'
            : canEdit
              ? 'Rules — ↑↓ select, x remove'
              : 'Rules'}
        </Text>
        {LISTS.map((list) => (
          <Box key={list} flexDirection="column">
            <Text color={theme.subtle} dimColor>
              {' '}
              {list}:
            </Text>
            {permissions[list].length === 0 ? (
              <Text color={theme.subtle} dimColor>
                {'  (none)'}
              </Text>
            ) : (
              permissions[list].map((rule) => {
                const index = entries.findIndex(
                  (entry) => entry.list === list && entry.rule === rule,
                );
                const isSelected = canEdit && index === selected;
                return (
                  <SelectionRow key={`${list}-${rule}`} selected={isSelected} width={width}>
                    {truncateDisplay(`${isSelected ? ' › ' : '   '}${rule}`, width)}
                  </SelectionRow>
                );
              })
            )}
          </Box>
        ))}
        {notice ? <Text color={theme.warning}>{truncateDisplay(notice, width)}</Text> : null}
      </Box>
    </Box>
  );
}
