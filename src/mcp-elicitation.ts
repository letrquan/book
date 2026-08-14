/**
 * Translation layer between the MCP `elicitation/create` wire format and the
 * host-facing form model.
 *
 * The protocol restricts requested schemas to a flat object of primitives, so
 * the conversion is total and can reject anything it cannot render honestly —
 * a form Book cannot present faithfully is declined rather than shown wrong.
 * Response content is validated here too, because the server re-validates it
 * and a malformed answer surfaces as an opaque protocol error otherwise.
 */
import type { ElicitationField, ElicitationValue } from './types/tools.js';

/** The `requestedSchema` of a form-mode elicitation, as parsed by the SDK. */
export interface ElicitationSchemaInput {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
}

export type ElicitationFieldsResult = { fields: ElicitationField[] } | { error: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Enum options in either supported spelling: `enum` (+ optional parallel
 * `enumNames`) or `oneOf: [{const, title}]`, which servers built on the newer
 * SDK schema helpers emit.
 */
function enumOptions(
  property: Record<string, unknown>,
): Array<{ value: string; label: string }> | null {
  if (Array.isArray(property.enum)) {
    const values = property.enum;
    if (values.length === 0 || !values.every((value) => typeof value === 'string')) return null;
    const names = Array.isArray(property.enumNames) ? property.enumNames : [];
    return (values as string[]).map((value, index) => ({
      value,
      label: optionalString(names[index]) ?? value,
    }));
  }
  if (Array.isArray(property.oneOf)) {
    const options: Array<{ value: string; label: string }> = [];
    for (const entry of property.oneOf) {
      const record = asRecord(entry);
      const value = optionalString(record?.const);
      if (value === undefined) return null;
      options.push({ value, label: optionalString(record?.title) ?? value });
    }
    return options.length > 0 ? options : null;
  }
  return null;
}

/** Flatten a requested schema into renderable fields, or explain why it cannot be. */
export function toElicitationFields(schema: ElicitationSchemaInput): ElicitationFieldsResult {
  const properties = asRecord(schema?.properties);
  if (!properties) return { error: 'requestedSchema.properties must be an object' };
  const entries = Object.entries(properties);
  if (entries.length === 0) return { error: 'requestedSchema declares no properties' };

  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields: ElicitationField[] = [];

  for (const [name, raw] of entries) {
    const property = asRecord(raw);
    if (!property) return { error: `property "${name}" must be an object` };
    const shared = {
      name,
      title: optionalString(property.title) ?? name,
      description: optionalString(property.description),
      required: required.has(name),
    };
    const type = property.type;

    if (type === 'boolean') {
      fields.push({
        ...shared,
        kind: 'boolean',
        default: typeof property.default === 'boolean' ? property.default : undefined,
      });
      continue;
    }
    if (type === 'number' || type === 'integer') {
      fields.push({
        ...shared,
        kind: 'number',
        integer: type === 'integer',
        minimum: optionalNumber(property.minimum),
        maximum: optionalNumber(property.maximum),
        default: optionalNumber(property.default),
      });
      continue;
    }
    if (type === 'string') {
      const options = enumOptions(property);
      if (options) {
        const fallback = optionalString(property.default);
        fields.push({
          ...shared,
          kind: 'enum',
          options,
          default: options.some((option) => option.value === fallback) ? fallback : undefined,
        });
        continue;
      }
      fields.push({
        ...shared,
        kind: 'string',
        format: optionalString(property.format),
        minLength: optionalNumber(property.minLength),
        maxLength: optionalNumber(property.maxLength),
        default: optionalString(property.default),
      });
      continue;
    }
    return { error: `property "${name}" has unsupported type ${JSON.stringify(type)}` };
  }

  return { fields };
}

/** Values a form starts with, so hosts render server-declared defaults. */
export function elicitationDefaults(fields: ElicitationField[]): Record<string, ElicitationValue> {
  const defaults: Record<string, ElicitationValue> = {};
  for (const field of fields) {
    if (field.kind === 'boolean') defaults[field.name] = field.default ?? false;
    else if (field.default !== undefined) defaults[field.name] = field.default;
  }
  return defaults;
}

/** Human-readable reason a single value is not acceptable, or null when it is. */
export function validateElicitationField(
  field: ElicitationField,
  value: ElicitationValue | undefined,
): string | null {
  if (value === undefined || value === '') {
    return field.required ? `${field.title} is required` : null;
  }
  switch (field.kind) {
    case 'boolean':
      return typeof value === 'boolean' ? null : `${field.title} must be true or false`;
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return `${field.title} must be a number`;
      }
      if (field.integer && !Number.isInteger(value)) return `${field.title} must be a whole number`;
      if (field.minimum !== undefined && value < field.minimum) {
        return `${field.title} must be at least ${field.minimum}`;
      }
      if (field.maximum !== undefined && value > field.maximum) {
        return `${field.title} must be at most ${field.maximum}`;
      }
      return null;
    }
    case 'enum':
      return field.options.some((option) => option.value === value)
        ? null
        : `${field.title} must be one of the offered choices`;
    case 'string': {
      if (typeof value !== 'string') return `${field.title} must be text`;
      if (field.minLength !== undefined && value.length < field.minLength) {
        return `${field.title} must be at least ${field.minLength} characters`;
      }
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return `${field.title} must be at most ${field.maxLength} characters`;
      }
      return null;
    }
  }
}

/** Parse raw host input (text fields arrive as strings) into a typed value. */
export function coerceElicitationValue(
  field: ElicitationField,
  raw: string,
): ElicitationValue | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (field.kind === 'number') {
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  }
  if (field.kind === 'boolean') {
    if (/^(true|yes|y|1)$/i.test(trimmed)) return true;
    if (/^(false|no|n|0)$/i.test(trimmed)) return false;
    return undefined;
  }
  return raw;
}

export type ElicitationContentResult =
  { content: Record<string, ElicitationValue> } | { error: string };

/**
 * Validate an accepted form submission against its fields, dropping empty
 * optional answers so the server sees an omitted key rather than an empty one.
 */
export function validateElicitationContent(
  fields: ElicitationField[],
  content: Record<string, unknown>,
): ElicitationContentResult {
  const known = new Set(fields.map((field) => field.name));
  for (const key of Object.keys(content)) {
    if (!known.has(key)) return { error: `unexpected field: ${key}` };
  }

  const accepted: Record<string, ElicitationValue> = {};
  for (const field of fields) {
    const value = content[field.name] as ElicitationValue | undefined;
    const error = validateElicitationField(field, value);
    if (error) return { error };
    if (value === undefined || value === '') continue;
    accepted[field.name] = value;
  }
  return { content: accepted };
}
