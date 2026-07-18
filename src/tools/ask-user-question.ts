import { z } from 'zod';
import type {
  ToolContext,
  ToolDefinition,
  ToolResult,
  UserQuestion,
  UserQuestionRequest,
  UserQuestionResponse,
} from '../types.js';

const optionSchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(300),
  })
  .strict();

const questionSchema = z
  .object({
    question: z.string().trim().min(1).max(500),
    header: z.string().trim().min(1).max(12),
    options: z.array(optionSchema).min(2).max(4),
    multiSelect: z.boolean(),
  })
  .strict()
  .superRefine((question, ctx) => {
    const labels = new Set<string>();
    for (const option of question.options) {
      const key = option.label.toLocaleLowerCase();
      if (labels.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `option labels must be unique: ${option.label}`,
          path: ['options'],
        });
      }
      labels.add(key);
    }
  });

const requestSchema = z
  .object({ questions: z.array(questionSchema).min(1).max(4) })
  .strict()
  .superRefine((request, ctx) => {
    const questions = new Set<string>();
    for (const question of request.questions) {
      const key = question.question.toLocaleLowerCase();
      if (questions.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'question text must be unique',
          path: ['questions'],
        });
      }
      questions.add(key);
    }
  });

function ok(output: string): ToolResult {
  return { toolCallId: '', success: true, output };
}

function fail(error: string): ToolResult {
  return { toolCallId: '', success: false, output: '', error };
}

function validationMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'request'}: ${issue.message}`)
    .join('; ');
}

export function parseUserQuestionInput(
  args: Record<string, unknown>,
): { questions: UserQuestion[] } | { error: string } {
  const parsed = requestSchema.safeParse(args);
  if (!parsed.success) return { error: validationMessage(parsed.error) };
  return parsed.data;
}

export function validateUserQuestionResponse(
  request: UserQuestionRequest,
  response: unknown,
): string | null {
  if (!response || typeof response !== 'object' || !('action' in response)) {
    return 'response must contain an action';
  }
  const candidate = response as Partial<UserQuestionResponse> & { message?: unknown };
  if (!['answer', 'decline', 'cancel'].includes(String(candidate.action))) {
    return `unsupported response action: ${String(candidate.action)}`;
  }
  if (
    (candidate.action === 'decline' || candidate.action === 'cancel') &&
    candidate.message !== undefined &&
    typeof candidate.message !== 'string'
  ) {
    return 'response message must be a string';
  }
  if (candidate.action !== 'answer') return null;
  if (!candidate.answers || typeof candidate.answers !== 'object' || Array.isArray(candidate.answers)) {
    return 'answer response must contain an answers object';
  }

  const answers = candidate.answers as Record<string, unknown>;
  const expected = new Set(request.questions.map((question) => question.question));
  for (const key of Object.keys(answers)) {
    if (!expected.has(key)) return `unexpected answer key: ${key}`;
  }

  for (const question of request.questions) {
    const answer = answers[question.question];
    if (question.multiSelect) {
      if (!Array.isArray(answer) || answer.length === 0) {
        return `${question.question}: expected one or more answers`;
      }
      if (answer.length > 5) {
        return `${question.question}: expected at most four choices and one custom answer`;
      }
      if (
        answer.some(
          (value) => typeof value !== 'string' || value.trim().length === 0 || value.length > 2000,
        )
      ) {
        return `${question.question}: answers must be non-empty strings up to 2000 characters`;
      }
      const normalized = answer.map((value) => value.trim().toLocaleLowerCase());
      if (new Set(normalized).size !== normalized.length) {
        return `${question.question}: duplicate answers are not allowed`;
      }
      const labels = new Set(
        question.options.map((option) => option.label.trim().toLocaleLowerCase()),
      );
      if (normalized.filter((value) => !labels.has(value)).length > 1) {
        return `${question.question}: only one custom answer is allowed`;
      }
    } else if (typeof answer !== 'string' || answer.trim().length === 0 || answer.length > 2000) {
      return `${question.question}: expected one non-empty answer up to 2000 characters`;
    }
  }

  return null;
}

export function formatUserQuestionAnswers(
  request: UserQuestionRequest,
  response: Extract<UserQuestionResponse, { action: 'answer' }>,
): string {
  const lines = request.questions.map((question) => {
    const answer = response.answers[question.question];
    const display = Array.isArray(answer) ? answer.join(', ') : answer;
    return `- ${question.question}: ${display}`;
  });
  return `User answered the questions:\n${lines.join('\n')}`;
}

async function askUserQuestion(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = parseUserQuestionInput(args);
  if ('error' in parsed) return fail(`Invalid AskUserQuestion request: ${parsed.error}`);

  ctx.pendingUserQuestion = { questions: parsed.questions };
  return ok('Questions submitted. Wait for the user response before continuing.');
}

export const askUserQuestionTools: ToolDefinition[] = [
  {
    name: 'AskUserQuestion',
    description:
      'Ask the user 1-4 necessary clarifying questions with 2-4 described choices each. Use only when the answer materially changes the work and cannot be discovered from the workspace. The host also offers free-text Other answers. Never request passwords, API keys, tokens, authentication codes, private keys, or other secrets.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              question: { type: 'string', minLength: 1, maxLength: 500 },
              header: { type: 'string', minLength: 1, maxLength: 12 },
              options: {
                type: 'array',
                minItems: 2,
                maxItems: 4,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    label: { type: 'string', minLength: 1, maxLength: 80 },
                    description: { type: 'string', minLength: 1, maxLength: 300 },
                  },
                  required: ['label', 'description'],
                },
              },
              multiSelect: { type: 'boolean' },
            },
            required: ['question', 'header', 'options', 'multiSelect'],
          },
        },
      },
      required: ['questions'],
    },
    execute: askUserQuestion,
  },
];
