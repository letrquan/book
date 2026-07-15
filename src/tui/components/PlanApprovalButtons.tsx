import { Box, Text, useInput } from 'ink';
import { useCallback, useRef, useState } from 'react';
import { useTheme } from '../theme.js';
import type { PlanApprovalResult } from '../../types.js';
import { createUiDebugLogger } from '../../debug-log.js';
import { useDebugMount } from '../debug.js';

const uiLog = createUiDebugLogger('tui:planapproval');

interface PlanApprovalProps {
  plan: string;
  screenReader?: boolean;
}

interface PlanApprovalActionsProps extends PlanApprovalProps {
  onResolve: (result: PlanApprovalResult) => void;
}

type LineTag = 'heading' | 'step' | 'bullet' | 'empty' | 'text';

const BUTTONS = [
  { label: 'Approve plan', value: 'approve' as const, key: 'a', colorKey: 'success' as const },
  { label: 'Reject / revise', value: 'reject' as const, key: 'r', colorKey: 'error' as const },
];

function classifyLine(line: string): LineTag {
  const trimmed = line.trimStart();
  if (!trimmed) return 'empty';
  if (/^#{1,3}\s/.test(trimmed)) return 'heading';
  if (/^\d+[\.\)]\s/.test(line)) return 'step';
  if (/^[-*•]\s/.test(trimmed)) return 'bullet';
  return 'text';
}

function countSteps(lines: string[]): number {
  return lines.filter((line) => /^\d+[\.\)]\s/.test(line)).length;
}

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
    return (
      <Text bold color={theme.brand}>
        {match ? `${match[1]}${match[2]}` : line}
      </Text>
    );
  }
  if (tag === 'step') {
    const match = line.match(/^(\s*)(\d+[\.\)])\s(.*)$/);
    if (match) {
      return (
        <Text>
          <Text>{match[1]}</Text>
          <Text bold color={theme.planMode}>
            {match[2]}
          </Text>
          <Text color={theme.text}> {match[3]}</Text>
        </Text>
      );
    }
  }
  if (tag === 'bullet') {
    const match = line.match(/^(\s*)([-*•])\s(.*)$/);
    if (match) {
      return (
        <Text>
          <Text>{match[1]}</Text>
          <Text color={theme.subtle}>{match[2]}</Text>
          <Text color={theme.text}> {match[3]}</Text>
        </Text>
      );
    }
  }
  return <Text color={theme.text}>{line}</Text>;
}

export function PlanApprovalDetails({ plan, screenReader = false }: PlanApprovalProps) {
  const theme = useTheme();
  const lines = plan.split('\n');
  const stepCount = countSteps(lines);

  if (screenReader) return <Text>{plan}</Text>;

  return (
    <Box
      marginLeft={2}
      marginY={1}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.planMode}
      paddingX={1}
    >
      <Box>
        <Text color={theme.planMode}>📋 </Text>
        <Text bold color={theme.planMode}>
          Plan Approval
        </Text>
        {stepCount > 0 ? (
          <Text color={theme.subtle}>
            {' '}
            · {stepCount} step{stepCount === 1 ? '' : 's'}
          </Text>
        ) : null}
      </Box>
      <Text color={theme.planMode} dimColor>
        {'─'.repeat(40)}
      </Text>
      <Box flexDirection="column" paddingLeft={1}>
        {lines.map((line, index) => (
          <PlanLine key={index} line={line} tag={classifyLine(line)} theme={theme} />
        ))}
      </Box>
    </Box>
  );
}

export function PlanApprovalActions({
  plan,
  onResolve,
  screenReader = false,
}: PlanApprovalActionsProps) {
  const theme = useTheme();
  const [selected, setSelected] = useState(0);
  const resolvedRef = useRef(false);
  const lines = plan.split('\n');
  useDebugMount(uiLog, {
    planLength: plan.length,
    lineCount: lines.length,
    stepCount: countSteps(lines),
  });

  const resolveOnce = useCallback(
    (value: PlanApprovalResult) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      uiLog.event('resolve', { result: value, selected });
      onResolve(value);
    },
    [onResolve, selected],
  );

  useInput((input, key) => {
    if (key.leftArrow || (key.shift && key.tab)) {
      setSelected((value) => (value - 1 + BUTTONS.length) % BUTTONS.length);
    } else if (key.rightArrow || key.tab) {
      setSelected((value) => (value + 1) % BUTTONS.length);
    } else if (key.return || input === ' ') {
      resolveOnce(BUTTONS[selected].value);
    } else if (key.escape) {
      resolveOnce('reject');
    } else if (input.toLowerCase() === 'a') {
      resolveOnce('approve');
    } else if (['r', 's'].includes(input.toLowerCase())) {
      resolveOnce('reject');
    }
  });

  if (screenReader) {
    return <Text>Plan approval required. Press A to approve, R or Escape to reject.</Text>;
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.planMode} paddingX={1}>
      <Box>
        {BUTTONS.map((button, index) => {
          const active = index === selected;
          const color = theme[button.colorKey];
          return (
            <Box key={button.value} marginRight={2}>
              <Text
                backgroundColor={active ? color : undefined}
                color={active ? theme.inverseText : color}
                bold={active}
              >
                {active ? '▸ ' : '  '}
                {button.label} ({button.key.toUpperCase()})
              </Text>
            </Box>
          );
        })}
      </Box>
      <Text color={theme.subtle} dimColor>
        ← → to select · Enter to confirm · A/R shortcuts · Esc to reject
      </Text>
    </Box>
  );
}

/** Backward-compatible combined surface used by focused component tests. */
export function PlanApprovalButtons(props: PlanApprovalActionsProps) {
  return (
    <Box flexDirection="column">
      <PlanApprovalDetails plan={props.plan} screenReader={props.screenReader} />
      <PlanApprovalActions {...props} />
    </Box>
  );
}
