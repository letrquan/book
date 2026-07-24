import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../../agents/types.js';
import { DEFAULT_THEME, ThemeContext } from '../theme.js';
import { SubagentDetail } from './SubagentDetail.js';

afterEach(cleanup);

describe('SubagentDetail', () => {
  it('renders child identity, transcript, isolation, and evidence', () => {
    const record: AgentRecord = {
      id: 'agent-1',
      profile: 'validator',
      displayName: 'Validate session fix',
      profileDescription: 'Validate changes',
      purpose: 'Review the patch',
      resolvedModel: 'gateway/review',
      isolation: 'worktree',
      name: 'validator',
      role: 'validator',
      description: 'Validate changes',
      status: 'completed',
      applicationStatus: 'not_applied',
      prompt: 'Review the patch',
      referencedEvidenceIds: ['evidence-1'],
      transcript: [
        {
          id: 'message-1',
          role: 'assistant',
          content: 'Validation passed.',
          includeInContext: true,
          timestamp: 1,
        },
      ],
      pendingMessages: [],
      createdAt: 1,
      updatedAt: 2,
    };
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <SubagentDetail record={record} width={100} height={30} reducedMotion />
      </ThemeContext.Provider>,
    );
    const output = view.lastFrame() ?? '';
    expect(output).toContain('main > Validate session fix');
    expect(output).toContain('validator | gateway/review | worktree | completed');
    expect(output).toContain('Evidence: evidence-1');
    expect(output).toContain('Validation passed.');
    expect(output).toContain('Type a follow-up to resume this child');
    expect(output).toContain('Esc main');
  });
});
