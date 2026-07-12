import { Box, Text, useInput } from 'ink';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme.js';
import type { PlanApprovalResult } from '../../types.js';
import { createUiDebugLogger } from '../../debug-log.js';
import { useDebugMount } from '../debug.js';

const uiLog = createUiDebugLogger('tui:planapproval');

interface PlanApprovalButtonsProps {
  plan: string;
  onResolve: (result: PlanApprovalResult) => void;
  screenReader?: boolean;
}

interface ButtonDef {
  label: string;
  value: PlanApprovalResult;
  key: string;
  colorKey: 'success' | 'error';
}

const BUTTONS: ButtonDef[] = [
  { label: 'Approve plan', value: 'approve', key: 'a', colorKey: 'success' },
  { label: 'Reject / revise', value: 'reject', key: 'r', colorKey: 'error' },
];

/**
 * Classify a plan line for rendering with appropriate styling.
 * Returns a tag used to pick color and prefix for the line.
 */
type LineTag = 'heading' | 'step' | 'bullet' | 'empty' | 'text';

function classifyLine(line: string): LineTag {
  const trimmed = line.trimStart();
  if (!trimmed) return 'empty';
  if (/^#{1,3}\s/.test(trimmed)) return 'heading';
  if (/^\d+[\.\)]\s/.test(trimmed)) return 'step';
  if (/^[-*•]\s/.test(trimmed)) return 'bullet';
  return 'text';
}

/** Count the number of top-level steps (numbered items) in the plan. */
function countSteps(lines: string[]): number {
  return lines.filter((line) => /^\d+[\.\)]\s/.test(line)).length;
}

/**
 * Render a single plan line with contextual styling.
 */
function PlanLine({
  line,
  tag,
  theme,
}: {
  line: string;
  tag: LineTag;
  theme: ReturnType<typeof useTheme>;
}) {
  if (tag === 'empty') return <Text> </Text>;

  if (tag === 'heading') {
    const match = line.match(/^(\s*)#{1,3}\s+(.*)$/);
    const content = match ? `${match[1]}${match[2]}` : line;
    return (
      <Text bold color={theme.brand}>
        {content}
      </Text>
    );
  }

  if (tag === 'step') {
    // Highlight the step number distinctly from the description.
    const match = line.match(/^(\s*)(\d+[\.\)])\s(.*)$/);
    if (match) {
      const [, indent, num, rest] = match;
      return (
        <Text>
          <Text>{indent}</Text>
          <Text bold color={theme.planMode}>
            {num}
          </Text>
          <Text color={theme.text}> {rest}</Text>
        </Text>
      );
    }
    return <Text color={theme.text}>{line}</Text>;
  }

  if (tag === 'bullet') {
    const match = line.match(/^(\s*)([-*•])\s(.*)$/);
    if (match) {
      const [, indent, marker, rest] = match;
      return (
        <Text>
          <Text>{indent}</Text>
          <Text color={theme.subtle}>{marker}</Text>
          <Text color={theme.text}> {rest}</Text>
        </Text>
      );
    }
    return <Text color={theme.text}>{line}</Text>;
  }

  // Default text
  return <Text color={theme.text}>{line}</Text>;
}

export function PlanApprovalButtons({
  plan,
  onResolve,
  screenReader = false,
}: PlanApprovalButtonsProps) {
  const theme = useTheme();
  const [selected, setSelected] = useState(0);
  const resolvedRef = useRef(false);
  const prevSelectedRef = useRef(0);
  const lines = plan.split('\n');
  const stepCount = countSteps(lines);

  useDebugMount(uiLog, {
    planLength: plan.length,
    lineCount: lines.length,
    stepCount,
  });

  const handleResolve = useCallback(
    (value: PlanApprovalResult) => {
      if (resolvedRef.current) {
        uiLog.event('resolve:double-fire-prevented', { attempt: value });
        return;
      }
      resolvedRef.current = true;
      uiLog.event('resolve', { result: value, selected });
      onResolve(value);
    },
    [onResolve, selected],
  );

  useInput(
    (input, key) => {
      if (key.leftArrow) {
        setSelected((s) => (s - 1 + BUTTONS.length) % BUTTONS.length);
        uiLog.event('input:Left', { selected: `${selected}->?` });
        return;
      }
      if (key.rightArrow) {
        setSelected((s) => (s + 1) % BUTTONS.length);
        uiLog.event('input:Right', { selected: `${selected}->?` });
        return;
      }
      if (key.tab) {
        setSelected((s) =>
          key.shift ? (s - 1 + BUTTONS.length) % BUTTONS.length : (s + 1) % BUTTONS.length,
        );
        uiLog.event('input:Tab', { shift: key.shift, selected: `${selected}->?` });
        return;
      }
      if (key.return || input === ' ') {
        uiLog.event('input:Enter', { selected });
        handleResolve(BUTTONS[selected].value);
        return;
      }
      if (key.escape) {
        uiLog.event('input:Escape', { action: 'reject' });
        handleResolve('reject');
        return;
      }
      if (input === 'a' || input === 'A') {
        uiLog.event('input:shortcut', { key: 'A', action: 'approve' });
        handleResolve('approve');
        return;
      }
      if (input === 'r' || input === 'R' || input === 's' || input === 'S') {
        uiLog.event('input:shortcut', { key: input.toUpperCase(), action: 'reject' });
        handleResolve('reject');
      }
    },
    { isActive: true },
  );

  // Log resolved selection changes.
  useEffect(() => {
    if (prevSelectedRef.current !== selected) {
      uiLog.event('selection:change', {
        from: prevSelectedRef.current,
        to: selected,
      });
      prevSelectedRef.current = selected;
    }
  }, [selected]);

  if (screenReader) {
    return (
      <Box marginLeft={2} marginY={1} flexDirection="column">
        <Text>Plan approval required.</Text>
        <Text>{plan}</Text>
        <Text>Press: [A] Approve [R] Reject [Esc] Reject</Text>
      </Box>
    );
  }

  return (
    <Box
      marginLeft={2}
      marginY={1}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.planMode}
      paddingX={1}
    >
      {/* ── Header ── */}
      <Box>
        <Text color={theme.planMode}>📋 </Text>
        <Text bold color={theme.planMode}>
          Plan Approval
        </Text>
        {stepCount > 0 && (
          <Text color={theme.subtle}>
            {' '}
            · {stepCount} step{stepCount !== 1 ? 's' : ''}
          </Text>
        )}
      </Box>

      {/* ── Separator ── */}
      <Box>
        <Text color={theme.planMode} dimColor>
          {'─'.repeat(40)}
        </Text>
      </Box>

      {/* ── Plan body ── */}
      <Box flexDirection="column" paddingLeft={1}>
        {lines.map((line, index) => {
          const tag = classifyLine(line);
          return <PlanLine key={index} line={line} tag={tag} theme={theme} />;
        })}
      </Box>

      {/* ── Separator ── */}
      <Box marginTop={1}>
        <Text color={theme.planMode} dimColor>
          {'─'.repeat(40)}
        </Text>
      </Box>

      {/* ── Action buttons ── */}
      <Box>
        {BUTTONS.map((btn, i) => {
          const isSelected = i === selected;
          const btnColor = theme[btn.colorKey];
          return (
            <Box key={btn.value} marginRight={2}>
              <Text
                backgroundColor={isSelected ? btnColor : undefined}
                color={isSelected ? theme.inverseText : btnColor}
                bold={isSelected}
              >
                {isSelected ? '▸ ' : '  '}
                {btn.label} ({btn.key.toUpperCase()})
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* ── Hint ── */}
      <Box>
        <Text color={theme.subtle} dimColor>
          ← → to select · Enter to confirm · A/R shortcuts · Esc to reject
        </Text>
      </Box>
    </Box>
  );
}
