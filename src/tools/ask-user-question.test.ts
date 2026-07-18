import { describe, expect, it } from 'vitest';
import {
  formatUserQuestionAnswers,
  parseUserQuestionInput,
  validateUserQuestionResponse,
} from './ask-user-question.js';
import type { UserQuestionRequest } from '../types.js';

const questions = [
  {
    question: 'Which output format should I use?',
    header: 'Format',
    options: [
      { label: 'Summary', description: 'Brief overview' },
      { label: 'Detailed', description: 'Full explanation' },
    ],
    multiSelect: false,
  },
  {
    question: 'Which sections should be included?',
    header: 'Sections',
    options: [
      { label: 'Intro', description: 'Opening context' },
      { label: 'Tests', description: 'Validation details' },
    ],
    multiSelect: true,
  },
];

const request: UserQuestionRequest = {
  id: 'root:q1',
  questions,
  source: { kind: 'root' },
};

describe('AskUserQuestion validation', () => {
  it('accepts the structured question contract', () => {
    expect(parseUserQuestionInput({ questions })).toEqual({ questions });
  });

  it('rejects duplicate question text and option labels', () => {
    const result = parseUserQuestionInput({
      questions: [
        questions[0],
        {
          ...questions[0],
          options: [
            { label: 'Same', description: 'One' },
            { label: 'same', description: 'Two' },
          ],
        },
      ],
    });
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/unique/);
  });

  it('validates complete single and multi-select answers', () => {
    const response = {
      action: 'answer' as const,
      answers: {
        [questions[0].question]: 'Summary',
        [questions[1].question]: ['Intro', 'Custom appendix'],
      },
    };
    expect(validateUserQuestionResponse(request, response)).toBeNull();
    expect(formatUserQuestionAnswers(request, response)).toContain('Custom appendix');
  });

  it('rejects missing and incorrectly shaped answers', () => {
    expect(
      validateUserQuestionResponse(request, {
        action: 'answer',
        answers: { [questions[0].question]: 'Summary' },
      }),
    ).toMatch(/expected one or more answers/);
    expect(
      validateUserQuestionResponse(request, {
        action: 'answer',
        answers: {
          [questions[0].question]: ['Summary'],
          [questions[1].question]: ['Intro'],
        },
      }),
    ).toMatch(/expected one non-empty answer/);
  });

  it('allows at most one custom multi-select answer', () => {
    expect(
      validateUserQuestionResponse(request, {
        action: 'answer',
        answers: {
          [questions[0].question]: 'Summary',
          [questions[1].question]: ['Intro', 'Custom one', 'Custom two'],
        },
      }),
    ).toMatch(/only one custom answer/);
  });
});
