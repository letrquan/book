import { Box, Text, useInput } from 'ink';
import TextInput from './TextInputField.js';
import { useCallback, useRef, useState } from 'react';
import { useKeyState } from '../hooks/useKeyState.js';
import { useTheme } from '../theme.js';
import type { PlanApprovalResult } from '../../types/tools.js';
import { createUiDebugLogger } from '../../debug-log.js';
import { useDebugMount } from '../debug.js';
import { MarkdownBlock } from './MarkdownBlock.js';
import { ChoiceList, DecisionSheet, type Choice } from './chrome.js';
import { PANEL_CHROME, frameGrid } from '../layout.js';
import { PILCROW } from '../marks.js';

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
  {
    label: 'Approve plan',
    value: 'approve' as const,
    key: 'a',
    detail: 'implement it in this conversation',
  },
  {
    label: 'Approve, fresh context',
    value: 'approve-fresh' as const,
    key: 'f',
    detail: 'implement it clean, without the planning talk',
  },
  { label: 'Adjust plan', value: 'revise' as const, key: 'e', detail: 'say what should change' },
  { label: 'Reject plan', value: 'reject' as const, key: 'r', detail: 'stay in plan mode' },
];

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

  // The plan is set under a rule like every decision surface, in plan mode's
  // own tone, with its step count as the rule's note.
  const width = frameGrid(Math.max(20, Math.floor(terminalWidth ?? 80))).width;
  return (
    <DecisionSheet
      label="Plan"
      tone={theme.planMode}
      meta={
        stepCount > 0
          ? `${stepCount} step${stepCount === 1 ? '' : 's'} · awaiting approval`
          : 'awaiting approval'
      }
      width={width}
    >
      <MarkdownBlock content={normalizedPlan} terminalWidth={Math.max(12, width - PANEL_CHROME)} />
    </DecisionSheet>
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

    if (key.leftArrow || key.upArrow || (key.shift && key.tab)) {
      setSelected((currentSelected() - 1 + BUTTONS.length) % BUTTONS.length);
    } else if (key.rightArrow || key.downArrow || key.tab) {
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

  const width = frameGrid(Math.max(20, Math.floor(terminalWidth ?? 80))).width;
  const contentWidth = Math.max(12, width - PANEL_CHROME);

  if (feedbackMode) {
    return (
      <DecisionSheet label="Adjust the plan" tone={theme.warning} width={width}>
        <Text color={theme.subtle}>Tell Book what should change before implementation starts.</Text>
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.border}>{'─'.repeat(contentWidth)}</Text>
          <Box>
            <Text color={theme.brand}>{`${PILCROW} `}</Text>
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
        </Box>
        {feedbackError ? <Text color={theme.error}>{feedbackError}</Text> : null}
        <Box marginTop={1}>
          <Text color={theme.inactive}>Enter send feedback · Esc return to choices</Text>
        </Box>
      </DecisionSheet>
    );
  }

  const choices: Choice[] = BUTTONS.map((button) => ({
    label: button.label,
    // The key first, so a narrow row truncates the explanation, never the key.
    detail: `${button.key.toUpperCase()}  ${button.detail}`,
  }));
  return (
    <DecisionSheet label="Plan approval" tone={theme.planMode} width={width}>
      <ChoiceList choices={choices} selected={selected} width={contentWidth} numbered={false} />
      <Box marginTop={1}>
        <Text color={theme.inactive}>
          ↑↓ select · Enter confirm · A/F/E/R shortcuts · Esc reject
        </Text>
      </Box>
    </DecisionSheet>
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
