import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from './registry.js';
import {
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_SAFE_TIMEOUT_MS,
  MAX_TOOL_TIMEOUT_MS,
  resolveToolTimeoutMs,
  toolTimeoutCeilingMs,
} from './timeouts.js';
import type { ToolContext } from '../types/tools.js';

describe('resolveToolTimeoutMs', () => {
  it('prefers the request, then the operator override, then the tool default', () => {
    const env = { BOOK_TOOL_TIMEOUT_MS: '9000' };
    expect(resolveToolTimeoutMs({ requested: 5_000, env, fallback: 300_000 })).toBe(5_000);
    expect(resolveToolTimeoutMs({ env, fallback: 300_000 })).toBe(9_000);
    expect(resolveToolTimeoutMs({ fallback: 300_000 })).toBe(300_000);
    expect(resolveToolTimeoutMs({})).toBe(DEFAULT_TOOL_TIMEOUT_MS);
  });

  it('caps what the model asks for at the built-in ceiling', () => {
    const beyond = MAX_TOOL_TIMEOUT_MS * 2;
    expect(resolveToolTimeoutMs({ requested: beyond })).toBe(MAX_TOOL_TIMEOUT_MS);
    expect(toolTimeoutCeilingMs()).toBe(MAX_TOOL_TIMEOUT_MS);
  });

  // The operator's number is a bound, and a bound has to hold in the direction
  // that costs something: a model told by the Bash schema that it may ask for
  // ten minutes must not walk through a 30s limit someone set deliberately.
  it('treats the operator override as the ceiling, in both directions', () => {
    const lowered = { BOOK_TOOL_TIMEOUT_MS: '30000' };
    expect(resolveToolTimeoutMs({ requested: MAX_TOOL_TIMEOUT_MS, env: lowered })).toBe(30_000);
    expect(resolveToolTimeoutMs({ requested: 5_000, env: lowered })).toBe(5_000);
    expect(toolTimeoutCeilingMs(lowered)).toBe(30_000);

    // Raising it raises the *default*, which needs no argument to reach. It
    // cannot raise the per-call reach past the maximum the Bash schema
    // publishes and validates: advertising a ceiling the model is then rejected
    // for using turns the kill message's advice into a guaranteed retry loop.
    const raised = { BOOK_TOOL_TIMEOUT_MS: String(MAX_TOOL_TIMEOUT_MS * 3) };
    expect(resolveToolTimeoutMs({ env: raised })).toBe(MAX_TOOL_TIMEOUT_MS * 3);
    expect(toolTimeoutCeilingMs(raised)).toBe(MAX_TOOL_TIMEOUT_MS);
    expect(resolveToolTimeoutMs({ requested: MAX_TOOL_TIMEOUT_MS * 2, env: raised })).toBe(
      MAX_TOOL_TIMEOUT_MS,
    );
  });

  // setTimeout takes a 32-bit signed delay and Node rewrites anything larger to
  // 1ms, so "effectively no limit" expressed as 3000000000 would kill every
  // command instantly rather than never.
  it('bounds every source at the largest delay a timer can hold', () => {
    const overflowing = 3_000_000_000;
    expect(resolveToolTimeoutMs({ env: { BOOK_TOOL_TIMEOUT_MS: String(overflowing) } })).toBe(
      MAX_SAFE_TIMEOUT_MS,
    );
    expect(resolveToolTimeoutMs({ configured: overflowing })).toBe(MAX_SAFE_TIMEOUT_MS);
    expect(resolveToolTimeoutMs({ fallback: overflowing })).toBe(MAX_SAFE_TIMEOUT_MS);
    expect(MAX_SAFE_TIMEOUT_MS).toBeLessThanOrEqual(2 ** 31 - 1);
  });

  // `agents.checkTimeoutMs` is about one suite; BOOK_TOOL_TIMEOUT_MS is a
  // blanket default exported for unrelated tuning. The specific one wins.
  it('ranks a deliberate per-tool setting above the blanket override', () => {
    expect(
      resolveToolTimeoutMs({
        configured: 3_600_000,
        env: { BOOK_TOOL_TIMEOUT_MS: '120000' },
        fallback: 120_000,
      }),
    ).toBe(3_600_000);
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

  const declaredBashTimeout = (): number => {
    const declared = createDefaultRegistry().getTool('Bash')?.timeoutMs;
    if (typeof declared !== 'number') throw new Error('Bash should declare a static deadline');
    return declared;
  };

  // Both deadlines resolve from the same three inputs. Whenever they land on
  // the same number the registry's timer wins — it is armed before
  // `tool.execute` is even reached — and its failure carries no output at all.
  it('outlasts the Bash deadline on every resolution path', () => {
    expect(budgetFor({ command: 'true' })).toBeGreaterThan(declaredBashTimeout());
    expect(budgetFor({ command: 'true', timeout: 45_000 })).toBeGreaterThan(45_000);
    expect(budgetFor({ command: 'true' }, { BOOK_TOOL_TIMEOUT_MS: '30000' })).toBeGreaterThan(
      30_000,
    );
  });

  // Check builds a deliberate `check_timed_out` result that says the suite was
  // killed rather than failed, and its own deadline is a setting. A static
  // default could not follow that setting, so the definition resolves it.
  it('outlasts the Check deadline, which comes from settings', () => {
    const context = {
      workspaceRoot: process.cwd(),
      env: {},
      agentConfig: { settings: { agents: { checkTimeoutMs: 600_000 } } },
    } as unknown as ToolContext;
    const prepared = createDefaultRegistry().prepare(
      { id: 'check-1', name: 'Check', arguments: { name: 'test' } },
      context,
    );
    if (prepared.status !== 'ready') throw new Error('Check call was rejected');
    expect(prepared.prepared.timeoutMs).toBeGreaterThan(600_000);
  });

  // Only a tool that publishes `timeout` lets the model set the budget.
  // Honouring a stray value everywhere let one shrink the backstop under a tool
  // that times itself -- `Check` with `timeout: 5000` got a 15s budget against
  // its own 600s deadline -- and turned an MCP tool's seconds-valued `timeout:
  // 30` into a 30ms deadline.
  it('ignores a timeout argument from a tool that does not publish one', () => {
    expect(budgetFor({ filePath: 'a.txt', timeout: 5 }, {}, 'Read')).toBe(DEFAULT_TOOL_TIMEOUT_MS);
    expect(budgetFor({ filePath: 'a.txt' }, {}, 'Read')).toBe(DEFAULT_TOOL_TIMEOUT_MS);

    const context = {
      workspaceRoot: process.cwd(),
      env: {},
      agentConfig: { settings: { agents: { checkTimeoutMs: 600_000 } } },
    } as unknown as ToolContext;
    const prepared = createDefaultRegistry().prepare(
      { id: 'check-2', name: 'Check', arguments: { name: 'test', timeout: 5_000 } },
      context,
    );
    if (prepared.status !== 'ready') throw new Error('Check call was rejected');
    expect(prepared.prepared.timeoutMs).toBeGreaterThan(600_000);
  });

  it('publishes the timeout knob it honors', () => {
    const bash = createDefaultRegistry().getTool('Bash')!;
    const timeout = bash.inputSchema?.properties?.timeout;
    expect(timeout?.type).toBe('number');
    expect(timeout?.maximum).toBe(MAX_TOOL_TIMEOUT_MS);
    expect(timeout?.description).toContain(String(declaredBashTimeout()));
  });

  // A published argument has to be validated like one. Dropping a bad value
  // leaves the model believing it raised a deadline it did not, and the kill
  // message then reads as advice it already followed.
  it('rejects a published timeout that breaks its declared shape', () => {
    const context: ToolContext = { workspaceRoot: process.cwd(), env: {} };
    const registry = createDefaultRegistry();
    for (const timeout of ['10 minutes', MAX_TOOL_TIMEOUT_MS * 2, 0]) {
      const prepared = registry.prepare(
        { id: 'bad-1', name: 'Bash', arguments: { command: 'true', timeout } },
        context,
      );
      expect(prepared.status, String(timeout)).toBe('rejected');
    }
  });

  it('still hides the host control from tools that do not publish it', () => {
    const context: ToolContext = { workspaceRoot: process.cwd(), env: {} };
    const prepared = createDefaultRegistry().prepare(
      { id: 'read-1', name: 'Read', arguments: { filePath: 'a.txt', timeout: 5 } },
      context,
    );
    expect(prepared.status).toBe('ready');
  });
});
