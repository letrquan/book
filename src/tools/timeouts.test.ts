import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from './registry.js';
import { DEFAULT_TOOL_TIMEOUT_MS, MAX_TOOL_TIMEOUT_MS, resolveToolTimeoutMs } from './timeouts.js';
import type { ToolContext } from '../types/tools.js';

describe('resolveToolTimeoutMs', () => {
  it('prefers the request, then the operator override, then the tool default', () => {
    const env = { BOOK_TOOL_TIMEOUT_MS: '9000' };
    expect(resolveToolTimeoutMs({ requested: 5_000, env, fallback: 300_000 })).toBe(5_000);
    expect(resolveToolTimeoutMs({ env, fallback: 300_000 })).toBe(9_000);
    expect(resolveToolTimeoutMs({ fallback: 300_000 })).toBe(300_000);
    expect(resolveToolTimeoutMs({})).toBe(DEFAULT_TOOL_TIMEOUT_MS);
  });

  it('caps what the model asks for but leaves the operator override alone', () => {
    const beyond = MAX_TOOL_TIMEOUT_MS * 2;
    expect(resolveToolTimeoutMs({ requested: beyond })).toBe(MAX_TOOL_TIMEOUT_MS);
    expect(resolveToolTimeoutMs({ env: { BOOK_TOOL_TIMEOUT_MS: String(beyond) } })).toBe(beyond);
  });

  it('ignores values that would arm a timer with nonsense', () => {
    for (const requested of ['forever', NaN, Infinity, 0, -1, null, {}, true]) {
      expect(resolveToolTimeoutMs({ requested, fallback: 300_000 }), String(requested)).toBe(
        300_000,
      );
    }
    expect(resolveToolTimeoutMs({ env: { BOOK_TOOL_TIMEOUT_MS: 'soon' }, fallback: 300_000 })).toBe(
      300_000,
    );
  });
});

describe('registry budget for a tool that enforces its own deadline', () => {
  const budgetFor = (
    args: Record<string, unknown>,
    env: Record<string, string> = {},
    name = 'Bash',
  ): number => {
    const context: ToolContext = { workspaceRoot: process.cwd(), env };
    const prepared = createDefaultRegistry().prepare(
      { id: 'call-1', name, arguments: args },
      context,
    );
    if (prepared.status !== 'ready') throw new Error(`${name} call was rejected`);
    return prepared.prepared.timeoutMs;
  };

  // Both deadlines resolve from the same three inputs. Whenever they land on
  // the same number the registry's timer wins — it is armed before
  // `tool.execute` is even reached — and its failure carries no output at all.
  it('outlasts the Bash deadline on every resolution path', () => {
    const declared = createDefaultRegistry().getTool('Bash')!.timeoutMs!;
    expect(budgetFor({ command: 'true' })).toBeGreaterThan(declared);
    expect(budgetFor({ command: 'true', timeout: 45_000 })).toBeGreaterThan(45_000);
    expect(budgetFor({ command: 'true' }, { BOOK_TOOL_TIMEOUT_MS: '30000' })).toBeGreaterThan(
      30_000,
    );
    expect(budgetFor({ command: 'true', timeout: MAX_TOOL_TIMEOUT_MS * 2 })).toBeGreaterThan(
      MAX_TOOL_TIMEOUT_MS,
    );
  });

  it('leaves a tool without its own deadline on the budget as resolved', () => {
    expect(budgetFor({ filePath: 'a.txt', timeout: 5 }, {}, 'Read')).toBe(5);
    expect(budgetFor({ filePath: 'a.txt' }, {}, 'Read')).toBe(DEFAULT_TOOL_TIMEOUT_MS);
  });

  it('publishes the timeout knob it honors', () => {
    const bash = createDefaultRegistry().getTool('Bash')!;
    const timeout = bash.inputSchema?.properties?.timeout;
    expect(timeout?.type).toBe('number');
    expect(timeout?.maximum).toBe(MAX_TOOL_TIMEOUT_MS);
    expect(timeout?.description).toContain(String(bash.timeoutMs));
  });
});
