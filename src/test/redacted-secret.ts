import { expect } from 'vitest';
import { PROVIDER_KEY_MARKER } from '../provider-secrets.js';
import type { ToolResult } from '../types/tools.js';

/**
 * Asserts that a write tool refused a call because it would add the provider-key marker (#535):
 * the `redacted_secret_write` code, a message naming the marker and why it is refused, and no trace
 * of the real `key` anywhere in the result.
 */
export function expectWriteRefused(result: ToolResult, key: string): void {
  expect(result.status).not.toBe('success');
  expect(result.structuredError?.code).toBe('redacted_secret_write');
  expect(result.structuredError?.message).toContain(PROVIDER_KEY_MARKER);
  expect(result.structuredError?.message).toMatch(/real provider key/);
  expect(JSON.stringify(result)).not.toContain(key);
}
