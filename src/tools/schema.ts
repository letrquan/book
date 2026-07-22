import type { JsonSchemaObject } from '../types/tools.js';

export function normalizeToolSchema(raw: Record<string, unknown>): JsonSchemaObject {
  const schema = raw as JsonSchemaObject;
  const normalized: JsonSchemaObject = { ...schema };
  if (schema.properties) {
    normalized.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, property]) => [
        name,
        {
          ...normalizeToolSchema(property),
          description: property.description?.trim() || `Value for ${name}.`,
        },
      ]),
    );
  }
  if (schema.items) normalized.items = normalizeToolSchema(schema.items);
  if (schema.oneOf) normalized.oneOf = schema.oneOf.map(normalizeToolSchema);
  if (schema.anyOf) normalized.anyOf = schema.anyOf.map(normalizeToolSchema);
  if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
    normalized.additionalProperties = normalizeToolSchema(schema.additionalProperties);
  } else if (schema.additionalProperties !== undefined) {
    normalized.additionalProperties = schema.additionalProperties;
  } else if (schema.type === 'object' || schema.properties) {
    normalized.additionalProperties = false;
  }
  return normalized;
}

function matchesType(value: unknown, type: JsonSchemaObject['type']): boolean {
  if (!type) return true;
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object')
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  if (type === 'integer') return typeof value === 'number' && Number.isInteger(value);
  return typeof value === type;
}

function validateValue(value: unknown, schema: JsonSchemaObject, path: string): string[] {
  if (schema.oneOf && !schema.oneOf.some((item) => validateValue(value, item, path).length === 0)) {
    return [`${path} does not match any allowed shape`];
  }
  if (schema.anyOf && !schema.anyOf.some((item) => validateValue(value, item, path).length === 0)) {
    return [`${path} does not match any allowed type`];
  }
  if (!matchesType(value, schema.type)) return [`${path} must be ${schema.type}`];
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) {
    return [`${path} must be one of: ${schema.enum.join(', ')}`];
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      return [`${path} must contain at least ${schema.minLength} character(s)`];
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      return [`${path} must contain at most ${schema.maxLength} character(s)`];
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum)
      return [`${path} must be >= ${schema.minimum}`];
    if (schema.maximum !== undefined && value > schema.maximum)
      return [`${path} must be <= ${schema.maximum}`];
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems)
      return [`${path} requires at least ${schema.minItems} item(s)`];
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      return [`${path} permits at most ${schema.maxItems} item(s)`];
    if (schema.items)
      return value.flatMap((item, index) =>
        validateValue(item, schema.items!, `${path}[${index}]`),
      );
  }
  if (
    (schema.type === 'object' || schema.properties || schema.additionalProperties !== undefined) &&
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const object = value as Record<string, unknown>;
    const properties = schema.properties ?? {};
    const errors: string[] = [];
    for (const required of schema.required ?? []) {
      if (!(required in object)) errors.push(`${path}.${required} is required`);
    }
    for (const [key, item] of Object.entries(object)) {
      const property = properties[key];
      if (property) {
        errors.push(...validateValue(item, property, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key} is not allowed`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validateValue(item, schema.additionalProperties, `${path}.${key}`));
      }
    }
    return errors;
  }
  return [];
}

export function validateToolArguments(
  args: Record<string, unknown>,
  schema: JsonSchemaObject,
): string[] {
  // Timeout is a host execution control, not part of the model-facing schema.
  const modelArgs = { ...args };
  delete modelArgs.timeout;
  return validateValue(modelArgs, schema, 'arguments');
}
