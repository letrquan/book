import { Box, Text, useInput } from 'ink';
import TextInput from './TextInputField.js';
import { useCallback, useRef, useState } from 'react';
import { useKeyState } from '../hooks/useKeyState.js';
import { useTheme } from '../theme.js';
import type { PlanApprovalResult } from '../../types/tools.js';
import { createUiDebugLogger } from '../../debug-log.js';
import { useDebugMount } from '../debug.js';
import { MarkdownBlock } from './MarkdownBlock.js';

const uiLog = createUiDebugLogger('tui:planapproval');

interface PlanApprovalProps {
  plan: string;
  screenReader?: boolean;
  terminalWidth?: number;
}

interface PlanApprovalActionsProps extends PlanApprovalProps {
  onResolve: (result: PlanApprovalResult) => void;
}

const BUTTONS = [
  { label: 'Approve plan', value: 'approve' as const, key: 'a', colorKey: 'success' as const },
  {
    label: 'Approve, fresh context',
    value: 'approve-fresh' as const,
    key: 'f',
    colorKey: 'success' as const,
  },
  { label: 'Adjust plan', value: 'revise' as const, key: 'e', colorKey: 'warning' as const },
  { label: 'Reject plan', value: 'reject' as const, key: 'r', colorKey: 'error' as const },
];

// Minimum terminal width to lay the buttons out in a row; below this they stack.
// Derived from the labels (each renders as "<prefix><label> (<Key>)" with a margin)
// so it scales automatically when buttons are added or renamed.
const ROW_LAYOUT_MIN_WIDTH = BUTTONS.reduce((sum, button) => sum + button.label.length + 8, 0) + 4;

function countSteps(lines: string[]): number {
  return lines.filter((line) => /^\d+[\.\)]\s/.test(line)).length;
}

function normalizePlanMarkdown(lines: string[]): string {
  return lines
    .map((line) => {
      const indentedHeading = line.match(/^(\s+)#{1,3}\s+(.*)$/);
      return indentedHeading ? `${indentedHeading[1]}${indentedHeading[2]}` : line;
    })
    .join('\n');
}

export function PlanApprovalDetails({
  plan,
  screenReader = false,
  terminalWidth,
}: PlanApprovalProps) {
  const theme = useTheme();
  const lines = plan.split('\n');
  const stepCount = countSteps(lines);
  const normalizedPlan = normalizePlanMarkdown(lines);

  if (screenReader) return <Text>{plan}</Text>;

  return (
    <Box
      marginLeft={2}
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.planMode}
      paddingX={1}
    >
      <Box>
        <Text bold color={theme.planMode}>
          Plan
        </Text>
        <Text color={theme.subtle}> · approval</Text>
        {stepCount > 0 ? (
          <Text color={theme.subtle}>
            {' '}
            · {stepCount} step{stepCount === 1 ? '' : 's'}
          </Text>
        ) : null}
      </Box>
      <Box flexDirection="column" paddingLeft={1}>
        <MarkdownBlock
          content={normalizedPlan}
          terminalWidth={
            terminalWidth === undefined ? undefined : Math.max(12, Math.floor(terminalWidth) - 8)
          }
        />
      </Box>
    </Box>
  );
}

export function PlanApprovalActions({
  plan,
  onResolve,
  screenReader = false,
  terminalWidth,
}: PlanApprovalActionsProps) {
  const theme = useTheme();
  // `useKeyState` rather than `useState`: both of these are read back by the
  // key handler, and Ink delivers a whole stdin chunk in one React batch. With
  // plain state a batched `→`+Enter resolved the button that was armed before
  // the arrow — approving a plan the user had moved off.
  const [selected, setSelected, currentSelected] = useKeyState(0);
  const [feedbackMode, setFeedbackMode, inFeedbackMode] = useKeyState(false);
  const [feedback, setFeedback] = useState('');
  const [feedbackError, setFeedbackError] = useState<string | null>(null);
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
      uiLog.event('resolve', { result: value, selected: currentSelected() });
      onResolve(value);
    },
    [onResolve, currentSelected],
  );

  useInput((input, key) => {
    if (inFeedbackMode()) {
      if (key.escape) {
        setFeedbackMode(false);
        setFeedbackError(null);
      }
      return;
    }

    if (key.leftArrow || (key.shift && key.tab)) {
      setSelected((currentSelected() - 1 + BUTTONS.length) % BUTTONS.length);
    } else if (key.rightArrow || key.tab) {
      setSelected((currentSelected() + 1) % BUTTONS.length);
    } else if (key.return || input === ' ') {
      const value = BUTTONS[currentSelected()].value;
      if (value === 'revise') {
        setFeedbackMode(true);
        setFeedbackError(null);
      } else {
        resolveOnce(value);
      }
    } else if (key.escape) {
      resolveOnce('reject');
    } else if (input.toLowerCase() === 'a') {
      resolveOnce('approve');
    } else if (input.toLowerCase() === 'f') {
      resolveOnce('approve-fresh');
    } else if (input.toLowerCase() === 'e') {
      setSelected(BUTTONS.findIndex((button) => button.value === 'revise'));
      setFeedbackMode(true);
      setFeedbackError(null);
    } else if (['r', 's'].includes(input.toLowerCase())) {
      resolveOnce('reject');
    }
  });

  if (screenReader && !feedbackMode) {
    return (
      <Text>
        Plan approval required. Press A to approve, F to approve and implement with a fresh context,
        E to request adjustments, or R or Escape to reject.
      </Text>
    );
  }

  if (feedbackMode) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.warning} paddingX={1}>
        <Text bold color={theme.warning}>
          Request plan adjustments
        </Text>
        <Text color={theme.subtle}>Tell Book what should change before implementation starts.</Text>
        <Box marginTop={1}>
          <Text color={theme.warning}>› </Text>
          <TextInput
            value={feedback}
            placeholder="Add feedback for the revised plan"
            onChange={(value) => {
              setFeedback(value.slice(0, 2000));
              if (feedbackError) setFeedbackError(null);
            }}
            onSubmit={(value) => {
              const normalized = value.trim();
              if (!normalized) {
                setFeedbackError('Add feedback before requesting changes.');
                return;
              }
              resolveOnce({ decision: 'revise', feedback: normalized });
            }}
          />
        </Box>
        {feedbackError ? <Text color={theme.error}>{feedbackError}</Text> : null}
        <Text color={theme.subtle} dimColor>
          Enter send feedback · Esc return to choices
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.planMode} paddingX={1}>
      <Box
        flexDirection={
          terminalWidth !== undefined && terminalWidth < ROW_LAYOUT_MIN_WIDTH ? 'column' : 'row'
        }
      >
        {BUTTONS.map((button, index) => {
          const active = index === selected;
          const color = theme[button.colorKey];
          return (
            <Box
              key={button.value}
              marginRight={
                terminalWidth !== undefined && terminalWidth < ROW_LAYOUT_MIN_WIDTH ? 0 : 2
              }
            >
              <Text
                backgroundColor={active ? theme.surfaceActive : undefined}
                color={active ? theme.selectionText : color}
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
        ← → to select · Enter to confirm · A/F/E/R shortcuts · Esc to reject
      </Text>
      <Text color={theme.subtle} dimColor>
        Fresh context (F) discards the planning conversation and implements the plan clean.
      </Text>
    </Box>
  );
}

/** Backward-compatible combined surface used by focused component tests. */
export function PlanApprovalButtons(props: PlanApprovalActionsProps) {
  return (
    <Box flexDirection="column">
      <PlanApprovalDetails
        plan={props.plan}
        screenReader={props.screenReader}
        terminalWidth={props.terminalWidth}
      />
      <PlanApprovalActions {...props} />
    </Box>
  );
}
