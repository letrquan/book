import { describe, expect, it } from 'vitest';
import {
  coerceElicitationValue,
  elicitationDefaults,
  toElicitationFields,
  validateElicitationContent,
  validateElicitationField,
  type ElicitationSchemaInput,
} from './mcp-elicitation.js';
import type { ElicitationField } from './types/tools.js';

function fields(schema: ElicitationSchemaInput): ElicitationField[] {
  const result = toElicitationFields(schema);
  if ('error' in result) throw new Error(`expected fields, got: ${result.error}`);
  return result.fields;
}

describe('toElicitationFields', () => {
  it('reads enum options from the oneOf spelling servers emit', () => {
    const [field] = fields({
      type: 'object',
      properties: {
        project: {
          type: 'string',
          title: 'Project',
          description: 'The Azure DevOps project.',
          oneOf: [
            { const: 'alpha', title: 'Alpha' },
            { const: 'beta', title: 'Beta' },
          ],
        },
      },
      required: ['project'],
    });
    expect(field).toEqual({
      name: 'project',
      title: 'Project',
      description: 'The Azure DevOps project.',
      required: true,
      kind: 'enum',
      options: [
        { value: 'alpha', label: 'Alpha' },
        { value: 'beta', label: 'Beta' },
      ],
      default: undefined,
    });
  });

  it('reads enum options from enum/enumNames and falls back to raw values', () => {
    const [field] = fields({
      type: 'object',
      properties: { env: { type: 'string', enum: ['dev', 'prod'], enumNames: ['Development'] } },
    });
    expect(field).toMatchObject({
      kind: 'enum',
      required: false,
      options: [
        { value: 'dev', label: 'Development' },
        { value: 'prod', label: 'prod' },
      ],
    });
  });

  it('flattens the primitive types with their constraints', () => {
    const converted = fields({
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 2, maxLength: 8, format: 'email' },
        count: { type: 'integer', minimum: 1, maximum: 5 },
        ratio: { type: 'number' },
        force: { type: 'boolean', default: true },
      },
      required: ['name'],
    });
    expect(converted).toMatchObject([
      { name: 'name', kind: 'string', required: true, minLength: 2, maxLength: 8, format: 'email' },
      { name: 'count', kind: 'number', integer: true, minimum: 1, maximum: 5 },
      { name: 'ratio', kind: 'number', integer: false },
      { name: 'force', kind: 'boolean', default: true },
    ]);
  });

  it('titles a field by its property name when the server omits one', () => {
    expect(fields({ type: 'object', properties: { token: { type: 'string' } } })[0].title).toBe(
      'token',
    );
  });

  it('keeps a default only when it matches an offered choice', () => {
    const [matching] = fields({
      type: 'object',
      properties: { env: { type: 'string', enum: ['dev', 'prod'], default: 'prod' } },
    });
    const [missing] = fields({
      type: 'object',
      properties: { env: { type: 'string', enum: ['dev', 'prod'], default: 'staging' } },
    });
    expect(matching).toMatchObject({ default: 'prod' });
    expect(missing).toMatchObject({ default: undefined });
  });

  it('rejects schemas it cannot render faithfully', () => {
    expect(toElicitationFields({ type: 'object', properties: {} })).toEqual({
      error: 'requestedSchema declares no properties',
    });
    expect(
      toElicitationFields({
        type: 'object',
        properties: { nested: { type: 'object', properties: {} } },
      }),
    ).toEqual({ error: 'property "nested" has unsupported type "object"' });
    expect(
      toElicitationFields({ type: 'object', properties: { tags: { type: 'array' } } }),
    ).toEqual({ error: 'property "tags" has unsupported type "array"' });
  });

  it('treats an unusable enum declaration as a plain string field', () => {
    const [field] = fields({
      type: 'object',
      properties: { project: { type: 'string', enum: [1, 2] } },
    });
    expect(field.kind).toBe('string');
  });
});

describe('elicitationDefaults', () => {
  it('seeds declared defaults and starts booleans off', () => {
    const converted = fields({
      type: 'object',
      properties: {
        name: { type: 'string', default: 'book' },
        force: { type: 'boolean' },
        count: { type: 'integer' },
      },
    });
    expect(elicitationDefaults(converted)).toEqual({ name: 'book', force: false });
  });
});

describe('validateElicitationField', () => {
  const [text, count, choice] = fields({
    type: 'object',
    properties: {
      text: { type: 'string', title: 'Text', minLength: 3 },
      count: { type: 'integer', title: 'Count', minimum: 2, maximum: 4 },
      choice: { type: 'string', title: 'Choice', enum: ['a', 'b'] },
    },
    required: ['text'],
  });

  it('requires a value only for required fields', () => {
    expect(validateElicitationField(text, undefined)).toBe('Text is required');
    expect(validateElicitationField(count, undefined)).toBeNull();
  });

  it('enforces string, number, and enum constraints', () => {
    expect(validateElicitationField(text, 'ab')).toBe('Text must be at least 3 characters');
    expect(validateElicitationField(count, 1)).toBe('Count must be at least 2');
    expect(validateElicitationField(count, 5)).toBe('Count must be at most 4');
    expect(validateElicitationField(count, 2.5)).toBe('Count must be a whole number');
    expect(validateElicitationField(choice, 'c')).toBe('Choice must be one of the offered choices');
    expect(validateElicitationField(choice, 'b')).toBeNull();
  });
});

describe('coerceElicitationValue', () => {
  const [text, count, force] = fields({
    type: 'object',
    properties: {
      text: { type: 'string' },
      count: { type: 'number' },
      force: { type: 'boolean' },
    },
  });

  it('parses numbers and reports unparsable input as NaN', () => {
    expect(coerceElicitationValue(count, ' 42 ')).toBe(42);
    expect(coerceElicitationValue(count, 'abc')).toBeNaN();
  });

  it('accepts the common spellings of a boolean', () => {
    expect(coerceElicitationValue(force, 'yes')).toBe(true);
    expect(coerceElicitationValue(force, 'FALSE')).toBe(false);
    expect(coerceElicitationValue(force, 'maybe')).toBeUndefined();
  });

  it('preserves string input verbatim and treats blank as absent', () => {
    expect(coerceElicitationValue(text, ' hello ')).toBe(' hello ');
    expect(coerceElicitationValue(text, '   ')).toBeUndefined();
  });
});

describe('validateElicitationContent', () => {
  const converted = fields({
    type: 'object',
    properties: {
      project: { type: 'string', title: 'Project', enum: ['alpha'] },
      note: { type: 'string', title: 'Note' },
    },
    required: ['project'],
  });

  it('drops empty optional answers so the server sees an omitted key', () => {
    expect(validateElicitationContent(converted, { project: 'alpha', note: '' })).toEqual({
      content: { project: 'alpha' },
    });
  });

  it('rejects unknown keys and invalid values', () => {
    expect(validateElicitationContent(converted, { project: 'alpha', other: 'x' })).toEqual({
      error: 'unexpected field: other',
    });
    expect(validateElicitationContent(converted, { project: 'nope' })).toEqual({
      error: 'Project must be one of the offered choices',
    });
    expect(validateElicitationContent(converted, {})).toEqual({ error: 'Project is required' });
  });
});
