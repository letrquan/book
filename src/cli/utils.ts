/** Deeply nested value access by dot-separated key path. */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Deeply nested value setter, creating intermediate objects as needed. */
export function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (
      !(parts[i] in current) ||
      typeof current[parts[i]] !== 'object' ||
      current[parts[i]] === null
    ) {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}

/** Delete a dot-path and prune only empty ancestor objects on that path. */
export function deleteNestedValue(
  obj: Record<string, unknown>,
  path: string | readonly string[],
): boolean {
  const parts = typeof path === 'string' ? path.split('.') : [...path];
  const ancestors: Array<{ parent: Record<string, unknown>; key: string }> = [];
  let current = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!Object.prototype.hasOwnProperty.call(current, key)) return false;
    const next = current[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) return false;
    ancestors.push({ parent: current, key });
    current = next as Record<string, unknown>;
  }

  const leaf = parts[parts.length - 1];
  if (!Object.prototype.hasOwnProperty.call(current, leaf)) return false;
  delete current[leaf];

  for (let i = ancestors.length - 1; i >= 0; i--) {
    const { parent, key } = ancestors[i];
    const child = parent[key];
    if (
      typeof child === 'object' &&
      child !== null &&
      !Array.isArray(child) &&
      Object.keys(child).length === 0
    ) {
      delete parent[key];
    } else {
      break;
    }
  }
  return true;
}
