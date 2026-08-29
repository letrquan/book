import { describe, it, expect } from 'vitest';
import { checkTools } from './check.js';
import { defaultConfig } from '../test/fixtures.js';
import type { AgentConfig } from '../types/runtime.js';
import type { ToolContext, ToolResult } from '../types/tools.js';

const Check = checkTools.find((tool) => tool.name === 'Check')!;

function contextWith(checks: Record<string, string>, checkTimeoutMs?: number): ToolContext {
  const config: AgentConfig = defaultConfig();
  config.settings.agents.checks = checks;
  if (checkTimeoutMs !== undefined) config.settings.agents.checkTimeoutMs = checkTimeoutMs;
  // Only the fields Check reads; a full ToolContext is not needed to exercise it.
  return {
    workspaceRoot: process.cwd(),
    env: {},
    agentConfig: config,
  } as unknown as ToolContext;
}

function run(ctx: ToolContext, name: string): Promise<ToolResult> {
  return Check.execute({ name }, ctx) as Promise<ToolResult>;
}

describe('Check', () => {
  it('reports a passing command as success', async () => {
    const result = await run(
      contextWith({ ok: `node -e "console.log('passed')"` }),
      'ok',
    );
    expect(result.status).toBe('success');
  });

  it('reports a non-zero exit as a plain failure', async () => {
    const result = await run(
      contextWith({ boom: `node -e "console.error('assertion failed'); process.exit(3)"` }),
      'boom',
    );
    expect(result.status).not.toBe('success');
    expect(result.structuredError?.code).toBe('tool_error');
  });

  it('distinguishes a timeout from a failing check', async () => {
    // The bug this guards: exec kills the child with SIGTERM on timeout, and
    // reporting that as an ordinary failure tells the agent its suite failed when
    // the suite never finished — so it "fixes" code that was passing. On a large
    // repository `npm test` exceeds the old hardcoded 120s ceiling every time.
    const result = await run(
      contextWith({ slow: `node -e "setTimeout(() => {}, 10000)"` }, 1_000),
      'slow',
    );
    expect(result.status).not.toBe('success');
    expect(result.structuredError?.code).toBe('check_timed_out');
    expect(result.structuredError?.retryable).toBe(true);
    expect(result.structuredError?.message).toContain('did not fail');
    expect(result.structuredError?.details).toMatchObject({ timeoutMs: 1_000 });
  });

  it('honors a raised agents.checkTimeoutMs', async () => {
    const result = await run(
      contextWith({ brief: `node -e "setTimeout(() => console.log('done'), 200)"` }, 30_000),
      'brief',
    );
    expect(result.status).toBe('success');
  });

  it('still rejects an unknown check name', async () => {
    const result = await run(contextWith({ ok: 'node -e ""' }), 'nope');
    expect(result.status).not.toBe('success');
    expect(result.structuredError?.message).toContain('Unknown check');
  });
});
