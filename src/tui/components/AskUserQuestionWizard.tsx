import { Box, Text, useInput } from 'ink';
import TextInput from './TextInputField.js';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useKeyState } from '../hooks/useKeyState.js';
import type { UserQuestion, UserQuestionRequest, UserQuestionResponse } from '../../types/tools.js';
import { useTheme } from '../theme.js';
import { truncateDisplay } from './word-wrap.js';
import { ChoiceList, DecisionSheet, floatingFrameMetrics, type Choice } from './chrome.js';
import { PILCROW } from '../marks.js';

interface AskUserQuestionWizardProps {
  request: UserQuestionRequest;
  queueLength?: number;
  terminalWidth?: number;
  onResolve: (response: UserQuestionResponse) => void;
  screenReader?: boolean;
}

/**
 * Option labels chosen (single-select) or toggled (multi-select), by question
 * index. Keyed by index rather than by question text so a question the model
 * happened to call `constructor` or `__proto__` cannot read an inherited member
 * of `Object.prototype` where an array was expected.
 */
type Choices = Record<number, string[]>;

/** The Other-row text, by question index. Kept apart from the labels: see {@link answerValues}. */
type CustomAnswers = Record<number, string>;

function sourceLabel(request: UserQuestionRequest): string {
  if (request.source.kind === 'root') return 'Book';
  return request.source.agentPath.join(' / ');
}

/** The host validator compares answers this way; matching it here keeps a duplicate from leaving. */
function normalizeLabel(value: string): string {
  return value.trim().toLocaleLowerCase();
}

/**
 * The value a question is answered with. Custom text lives beside the toggled
 * labels rather than among them, so toggling an option can never delete it and
 * an exact-match filter can never mistake one for the other.
 */
function answerValues(
  question: UserQuestion,
  index: number,
  choices: Choices,
  custom: CustomAnswers,
): string[] {
  const labels = choices[index] ?? [];
  const text = custom[index];
  if (question.multiSelect) return text ? [...labels, text] : labels;
  return text ? [text] : labels;
}

function normalizeAnswers(
  questions: UserQuestion[],
  choices: Choices,
  custom: CustomAnswers,
): Record<string, string | string[]> | null {
  const entries: [string, string | string[]][] = [];
  for (const [index, question] of questions.entries()) {
    const values = answerValues(question, index, choices, custom);
    if (values.length === 0) return null;
    entries.push([question.question, question.multiSelect ? values : values[0]]);
  }
  // fromEntries defines own properties, so a question literally named
  // `__proto__` lands as an answer key rather than replacing the prototype.
  return Object.fromEntries(entries);
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
  // Everything the key handler reads back is batch-safe: Ink delivers a whole
  // stdin chunk in one React batch, so plain state would still show the value
  // from before the first key. Helpers take the question *index* and resolve it
  // against `request.questions` (props), never against `question` below, which
  // is one batch behind after a back + Enter.
  const [questionIndex, setQuestionIndex, currentQuestion] = useKeyState(0);
  const [cursor, setCursor, currentCursor] = useKeyState(0);
  const [choices, setChoices, currentChoices] = useKeyState<Choices>({});
  const [customAnswers, setCustomAnswers, currentCustom] = useKeyState<CustomAnswers>({});
  const [otherMode, setOtherMode, inOtherMode] = useKeyState(false);
  const [otherValue, setOtherValue, currentOtherValue] = useKeyState('');
  const [notice, setNotice] = useState<string | null>(null);
  const resolvedRef = useRef(false);
  const question = request.questions[questionIndex];
  const selected = choices[questionIndex] ?? [];
  const customAnswer = customAnswers[questionIndex];

  const resolveOnce = useCallback(
    (response: UserQuestionResponse) => {
      if (resolvedRef.current) return;
      resolvedRef.current = true;
      onResolve(response);
    },
    [onResolve],
  );

  const setChoice = useCallback(
    (index: number, labels: string[]) => {
      setChoices({ ...currentChoices(), [index]: labels });
    },
    [currentChoices, setChoices],
  );

  const setCustom = useCallback(
    (index: number, text: string | undefined) => {
      const next = { ...currentCustom() };
      if (text === undefined) delete next[index];
      else next[index] = text;
      setCustomAnswers(next);
    },
    [currentCustom, setCustomAnswers],
  );

  const advance = useCallback(() => {
    const index = currentQuestion();
    if (index === request.questions.length - 1) {
      const normalized = normalizeAnswers(request.questions, currentChoices(), currentCustom());
      if (!normalized) {
        setNotice('Choose at least one answer to continue.');
        return;
      }
      resolveOnce({ action: 'answer', answers: normalized });
      return;
    }
    setQuestionIndex(index + 1);
    setCursor(0);
    setNotice(null);
  }, [
    currentQuestion,
    currentChoices,
    currentCustom,
    request.questions,
    resolveOnce,
    setQuestionIndex,
    setCursor,
  ]);

  const chooseKnownOption = useCallback(
    (index: number, optionIndex: number) => {
      const target = request.questions[index];
      const label = target?.options[optionIndex]?.label;
      if (!label) return;
      setNotice(null);
      if (!target.multiSelect) {
        setCustom(index, undefined);
        setChoice(index, [label]);
        advance();
        return;
      }
      const labels = currentChoices()[index] ?? [];
      setChoice(
        index,
        labels.includes(label) ? labels.filter((value) => value !== label) : [...labels, label],
      );
    },
    [request.questions, currentChoices, setChoice, setCustom, advance],
  );

  const openOther = useCallback(
    (index: number) => {
      setOtherValue(currentCustom()[index] ?? '');
      setOtherMode(true);
      setNotice(null);
    },
    [currentCustom, setOtherValue, setOtherMode],
  );

  const submitOther = useCallback(
    (index: number) => {
      const target = request.questions[index];
      if (!target) return;
      const text = currentOtherValue().trim();
      if (!text) {
        setNotice('Type an answer before continuing.');
        return;
      }
      setOtherMode(false);
      setOtherValue('');
      // Text that names an option is that option. Stored as custom text it
      // would reach the host as a duplicate, and the validator then discards
      // every answer in the request.
      const key = normalizeLabel(text);
      const match = target.options.findIndex((option) => normalizeLabel(option.label) === key);
      if (match >= 0) {
        if (!target.multiSelect) {
          chooseKnownOption(index, match);
          return;
        }
        const label = target.options[match].label;
        const labels = currentChoices()[index] ?? [];
        setCustom(index, undefined);
        setChoice(index, labels.includes(label) ? labels : [...labels, label]);
        advance();
        return;
      }
      if (!target.multiSelect) setChoice(index, []);
      setCustom(index, text);
      advance();
    },
    [
      request.questions,
      currentOtherValue,
      currentChoices,
      setOtherMode,
      setOtherValue,
      setChoice,
      setCustom,
      chooseKnownOption,
      advance,
    ],
  );

  useInput((input, key) => {
    const index = currentQuestion();
    if (inOtherMode()) {
      // This handler is the only owner of Enter while the editor is open; the
      // TextInput below has no onSubmit. Two listeners on one keypress meant
      // the second saw the mode flag already flipped and answered the next
      // question with its first option before it was ever shown.
      if (key.return) submitOther(index);
      else if (key.escape) {
        setOtherMode(false);
        setNotice(null);
      }
      return;
    }

    const activeQuestion = request.questions[index];
    if (!activeQuestion) return;

    const activeCursor = currentCursor();
    const otherRow = activeQuestion.options.length;
    const rowCount = otherRow + 1;

    // A single digit, not anything Number() would coerce: a pasted line that
    // starts with " 1" or "1.0" is text, not the quick-choose the footer offers.
    if (/^[1-9]$/.test(input) && Number(input) <= otherRow) {
      setCursor(Number(input) - 1);
      chooseKnownOption(index, Number(input) - 1);
      return;
    }
    if (key.upArrow || (key.shift && key.tab)) {
      setCursor((activeCursor - 1 + rowCount) % rowCount);
      setNotice(null);
    } else if (key.downArrow || key.tab) {
      setCursor((activeCursor + 1) % rowCount);
      setNotice(null);
    } else if (input === ' ' && activeQuestion.multiSelect) {
      if (activeCursor === otherRow) {
        if (currentCustom()[index]) setCustom(index, undefined);
        else openOther(index);
      } else {
        chooseKnownOption(index, activeCursor);
      }
    } else if (key.return) {
      if (activeCursor === otherRow) {
        openOther(index);
      } else if (activeQuestion.multiSelect) {
        const values = answerValues(activeQuestion, index, currentChoices(), currentCustom());
        if (values.length === 0) setNotice('Select one or more options first.');
        else advance();
      } else {
        chooseKnownOption(index, activeCursor);
      }
    } else if (input.toLowerCase() === 'o') {
      setCursor(otherRow);
      openOther(index);
    } else if ((input.toLowerCase() === 'b' || key.leftArrow) && index > 0) {
      setQuestionIndex(index - 1);
      setCursor(0);
      setNotice(null);
    } else if (input.toLowerCase() === 'd') {
      resolveOnce({ action: 'decline' });
    } else if (key.escape) {
      resolveOnce({ action: 'cancel' });
    }
  });

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const fromAgent = request.source.kind !== 'root';
  const progress =
    request.questions.length > 1 ? ` · ${questionIndex + 1} of ${request.questions.length}` : '';
  const queueText = queueLength > 1 ? ` · ${queueLength - 1} waiting` : '';
  const choiceRows: Choice[] = [
    ...question.options.map((option) => ({
      label: option.label,
      detail: option.description,
      checked: selectedSet.has(option.label),
    })),
    {
      label: customAnswer
        ? `Other: ${truncateDisplay(customAnswer, Math.max(8, contentWidth - 24))}`
        : 'Other…',
      detail: customAnswer ? undefined : 'write your own answer',
      checked: Boolean(customAnswer),
      numeral: '+',
    },
  ];

  // The same sheet as a permission: a rule naming who asks (only when it is not
  // Book itself) and what, the question in bold, then the choices.
  return (
    <DecisionSheet
      label={fromAgent ? `${sourceLabel(request)} asks` : 'Question'}
      tone={theme.text}
      meta={`${question.header}${progress}${queueText}`}
      width={frame.width}
      marginX={frame.marginX}
    >
      <Text bold color={theme.text} wrap="wrap">
        {question.question}
      </Text>

      <Box flexDirection="column" marginTop={1}>
        <ChoiceList
          choices={choiceRows}
          selected={cursor}
          width={contentWidth}
          // A column for the ✓ on every question, so an answer already given
          // shows when you step back to it.
          marks
          active={!otherMode}
        />
      </Box>

      {otherMode ? (
        // Your own answer is written the way everything else you write is:
        // after a pilcrow, under a hairline, like the composer.
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.border}>{'─'.repeat(Math.max(8, contentWidth))}</Text>
          <Box>
            <Text color={theme.brand}>{`${PILCROW} `}</Text>
            <TextInput
              value={otherValue}
              placeholder="Write your own answer"
              onChange={(value) => setOtherValue(value.slice(0, 2000))}
            />
          </Box>
          <Text color={theme.inactive}>Enter use answer · Esc return to choices</Text>
        </Box>
      ) : null}

      {notice ? <Text color={theme.warning}>! {notice}</Text> : null}

      {!otherMode ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.inactive}>
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
          <Text color={theme.inactive}>
            {questionIndex > 0 ? '←/B back · ' : ''}D decline · Esc cancel
            {!compact ? ' · Keep secrets private' : ''}
          </Text>
        </Box>
      ) : null}
    </DecisionSheet>
  );
}
