import { Box, Text, useInput } from 'ink';
import TextInput from './TextInputField.js';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { UserQuestion, UserQuestionRequest, UserQuestionResponse } from '../../types/tools.js';
import { useTheme } from '../theme.js';
import { truncateDisplay } from './word-wrap.js';
import { floatingFrameMetrics } from './chrome.js';

interface AskUserQuestionWizardProps {
  request: UserQuestionRequest;
  queueLength?: number;
  terminalWidth?: number;
  onResolve: (response: UserQuestionResponse) => void;
  screenReader?: boolean;
}

function sourceLabel(request: UserQuestionRequest): string {
  if (request.source.kind === 'root') return 'Book';
  return request.source.agentPath.join(' / ');
}

function removeValue(values: string[], value: string | undefined): string[] {
  return value ? values.filter((item) => item !== value) : values;
}

function normalizeAnswers(
  questions: UserQuestion[],
  answers: Record<string, string[]>,
): Record<string, string | string[]> | null {
  const normalized: Record<string, string | string[]> = {};
  for (const question of questions) {
    const values = answers[question.question] ?? [];
    if (values.length === 0) return null;
    normalized[question.question] = question.multiSelect ? values : values[0];
  }
  return normalized;
}

export function AskUserQuestionWizard({
  request,
  queueLength = 1,
  terminalWidth = 80,
  onResolve,
  screenReader = false,
}: AskUserQuestionWizardProps) {
  const theme = useTheme();
  const outerWidth = Math.max(20, Math.floor(terminalWidth));
  const frame = floatingFrameMetrics(outerWidth);
  const contentWidth = Math.max(14, frame.width - 4);
  const compact = outerWidth < 60;
  const [questionIndex, setQuestionIndex] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>({});
  const [otherMode, setOtherMode] = useState(false);
  const [otherValue, setOtherValue] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const resolvedRef = useRef(false);
  const question = request.questions[questionIndex];
  const selected = answers[question.question] ?? [];
  const customAnswer = customAnswers[question.question];
  const rowCount = question.options.length + 1;

  const resolveOnce = useCallback(
    (response: UserQuestionResponse) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      onResolve(response);
    },
    [onResolve],
  );

  const advance = useCallback(
    (nextAnswers: Record<string, string[]>) => {
      if (questionIndex === request.questions.length - 1) {
        const normalized = normalizeAnswers(request.questions, nextAnswers);
        if (!normalized) {
          setNotice('Choose at least one answer to continue.');
          return;
        }
        resolveOnce({ action: 'answer', answers: normalized });
        return;
      }
      setQuestionIndex((value) => value + 1);
      setCursor(0);
      setNotice(null);
    },
    [questionIndex, request.questions, resolveOnce],
  );

  const saveAndAdvance = useCallback(
    (values: string[]) => {
      const nextAnswers = { ...answers, [question.question]: values };
      setAnswers(nextAnswers);
      advance(nextAnswers);
    },
    [advance, answers, question.question],
  );

  const chooseKnownOption = useCallback(
    (index: number) => {
      const label = question.options[index]?.label;
      if (!label) return;
      setNotice(null);
      if (!question.multiSelect) {
        setCustomAnswers((current) => {
          const next = { ...current };
          delete next[question.question];
          return next;
        });
        saveAndAdvance([label]);
        return;
      }
      setAnswers((current) => {
        const values = current[question.question] ?? [];
        return {
          ...current,
          [question.question]: values.includes(label)
            ? values.filter((value) => value !== label)
            : [...values, label],
        };
      });
    },
    [question, saveAndAdvance],
  );

  const openOther = useCallback(() => {
    setOtherValue(customAnswer ?? '');
    setOtherMode(true);
    setNotice(null);
  }, [customAnswer]);

  useInput((input, key) => {
    if (otherMode) {
      if (key.escape) {
        setOtherMode(false);
        setNotice(null);
      }
      return;
    }

    const numeric = Number(input);
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= question.options.length) {
      setCursor(numeric - 1);
      chooseKnownOption(numeric - 1);
      return;
    }
    if (key.upArrow || (key.shift && key.tab)) {
      setCursor((value) => (value - 1 + rowCount) % rowCount);
      setNotice(null);
    } else if (key.downArrow || key.tab) {
      setCursor((value) => (value + 1) % rowCount);
      setNotice(null);
    } else if (input === ' ' && question.multiSelect) {
      if (cursor === question.options.length) {
        if (customAnswer) {
          setAnswers((current) => ({
            ...current,
            [question.question]: removeValue(current[question.question] ?? [], customAnswer),
          }));
          setCustomAnswers((current) => {
            const next = { ...current };
            delete next[question.question];
            return next;
          });
        } else {
          openOther();
        }
      } else {
        chooseKnownOption(cursor);
      }
    } else if (key.return) {
      if (cursor === question.options.length) {
        openOther();
      } else if (question.multiSelect) {
        if (selected.length === 0) {
          setNotice('Select one or more options first.');
        } else {
          saveAndAdvance(selected);
        }
      } else {
        chooseKnownOption(cursor);
      }
    } else if (input.toLowerCase() === 'o') {
      setCursor(question.options.length);
      openOther();
    } else if ((input.toLowerCase() === 'b' || key.leftArrow) && questionIndex > 0) {
      setQuestionIndex((value) => value - 1);
      setCursor(0);
      setNotice(null);
    } else if (input.toLowerCase() === 'd') {
      resolveOnce({ action: 'decline' });
    } else if (key.escape) {
      resolveOnce({ action: 'cancel' });
    }
  });

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const source = truncateDisplay(
    sourceLabel(request),
    compact ? contentWidth - 9 : contentWidth - 18,
  );
  const progress = `${questionIndex + 1} of ${request.questions.length}`;
  const queueText = queueLength > 1 ? ` · ${queueLength - 1} waiting` : '';

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
          ? {source}
        </Text>
        <Text color={theme.subtle}>
          {progress}
          {queueText}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold color={theme.brand}>
          {question.header.toUpperCase()}
        </Text>
        <Text bold color={theme.text}>
          {question.question}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {question.options.map((option, index) => {
          const active = index === cursor && !otherMode;
          const checked = selectedSet.has(option.label);
          const marker = question.multiSelect ? (checked ? '■' : '□') : checked ? '●' : '○';
          const description = truncateDisplay(
            option.description,
            compact ? contentWidth - 5 : Math.max(16, contentWidth - option.label.length - 9),
          );
          return (
            <Box
              key={option.label}
              paddingLeft={1}
              flexDirection={compact ? 'column' : 'row'}
              backgroundColor={active ? theme.surfaceActive : undefined}
            >
              <Text
                bold={active || checked}
                color={active ? theme.selectionText : checked ? theme.success : theme.text}
              >
                {active ? '›' : ' '} {marker} {index + 1}. {option.label}
              </Text>
              <Text color={active ? theme.selectionText : theme.subtle}>
                {compact ? `     ${description}` : ` — ${description}`}
              </Text>
            </Box>
          );
        })}

        <Box
          paddingLeft={1}
          backgroundColor={cursor === question.options.length ? theme.surfaceActive : undefined}
        >
          <Text
            bold={cursor === question.options.length || Boolean(customAnswer)}
            color={
              cursor === question.options.length
                ? theme.selectionText
                : customAnswer
                  ? theme.success
                  : theme.text
            }
          >
            {cursor === question.options.length ? '›' : ' '} {customAnswer ? '■' : '+'} Other
            {customAnswer
              ? `: ${truncateDisplay(customAnswer, Math.max(8, contentWidth - 14))}`
              : '…'}
          </Text>
        </Box>
      </Box>

      {otherMode ? (
        <Box
          flexDirection="column"
          marginTop={1}
          borderStyle="round"
          borderColor={theme.border}
          paddingX={1}
        >
          <Text bold color={theme.brand}>
            Your answer
          </Text>
          <Box>
            <Text color={theme.brand}>› </Text>
            <TextInput
              value={otherValue}
              onChange={(value) => setOtherValue(value.slice(0, 2000))}
              onSubmit={(value) => {
                const custom = value.trim();
                if (!custom) {
                  setNotice('Type an answer before continuing.');
                  return;
                }
                const base = removeValue(selected, customAnswer);
                const values = question.multiSelect ? [...base, custom] : [custom];
                const nextAnswers = { ...answers, [question.question]: values };
                setAnswers(nextAnswers);
                setCustomAnswers((current) => ({ ...current, [question.question]: custom }));
                setOtherMode(false);
                setOtherValue('');
                advance(nextAnswers);
              }}
            />
          </Box>
          <Text color={theme.subtle} dimColor>
            Enter use answer · Esc return to choices
          </Text>
        </Box>
      ) : null}

      {notice ? <Text color={theme.warning}>! {notice}</Text> : null}

      {!otherMode ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.subtle} dimColor>
            {screenReader
              ? question.multiSelect
                ? 'Use Up and Down to move. Space or number keys toggle choices. Enter confirms. O writes another answer. Escape cancels.'
                : 'Use Up and Down to move. Number keys choose. Enter confirms. O writes another answer. Escape cancels.'
              : compact
                ? question.multiSelect
                  ? '↑↓ move · Space toggle · Enter next'
                  : '↑↓ move · Enter choose · O custom'
                : question.multiSelect
                  ? '↑↓ move · Space toggle · Enter continue · 1-4 quick toggle'
                  : '↑↓ move · Enter choose · 1-4 quick choose · O custom'}
          </Text>
          <Text color={theme.subtle} dimColor>
            {questionIndex > 0 ? '←/B back · ' : ''}D decline · Esc cancel
            {!compact ? ' · Keep secrets private' : ''}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
