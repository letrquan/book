import { describe, expect, it } from 'vitest';
import { BUILTIN_AGENTS } from './profiles.js';

describe('built-in managed-agent prompts', () => {
  it('requires concise, referenced final handoffs', () => {
    const explorer = BUILTIN_AGENTS.find((agent) => agent.name === 'explorer');
    const patcher = BUILTIN_AGENTS.find((agent) => agent.name === 'patcher');
    const validator = BUILTIN_AGENTS.find((agent) => agent.name === 'validator');

    expect(explorer?.body).toContain('under 200 words');
    expect(explorer?.body).toContain('exact file:line');
    expect(patcher?.body).toContain('state the outcome first');
    expect(validator?.body).toContain('start with the verdict');
    expect(BUILTIN_AGENTS.every((agent) => agent.maxTurns === undefined)).toBe(true);
  });
});
