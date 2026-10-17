import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../../agents/types.js';
import { toolSuccess } from '../../tools/result.js';
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

  it('shows a placeholder instead of the welcome screen for an empty transcript', () => {
    const record: AgentRecord = {
      id: 'agent-2',
      profile: 'explorer',
      displayName: 'Trace the auth flow',
      profileDescription: 'Explore the codebase',
      purpose: 'Find the login path',
      resolvedModel: 'gateway/fast',
      isolation: 'worktree',
      name: 'explorer',
      role: 'explorer',
      description: 'Explore the codebase',
      status: 'running',
      applicationStatus: 'not_applied',
      prompt: 'Find the login path',
      referencedEvidenceIds: [],
      transcript: [],
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
    expect(output).toContain('main > Trace the auth flow');
    expect(output).toContain('Waiting for the subagent to produce output');
    // The main-app welcome banner must never leak into a child transcript.
    expect(output).not.toContain('Ask me anything');
  });

  it('does not claim it is waiting for a terminal child with no transcript', () => {
    const record: AgentRecord = {
      id: 'agent-4',
      profile: 'validator',
      displayName: 'Validate the fix',
      profileDescription: 'Validate changes',
      purpose: 'Validate changes',
      resolvedModel: 'gateway/review',
      isolation: 'worktree',
      name: 'validator',
      role: 'validator',
      description: 'Validate changes',
      status: 'failed',
      applicationStatus: 'not_applied',
      prompt: 'Validate changes',
      referencedEvidenceIds: [],
      transcript: [],
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
    expect(output).toContain('No transcript recorded.');
    expect(output).not.toContain('Waiting for the subagent to produce output');
  });

  it('streams live text while an empty transcript is still filling', () => {
    const record: AgentRecord = {
      id: 'agent-3',
      profile: 'explorer',
      displayName: 'Trace the auth flow',
      profileDescription: 'Explore the codebase',
      purpose: 'Find the login path',
      resolvedModel: 'gateway/fast',
      isolation: 'worktree',
      name: 'explorer',
      role: 'explorer',
      description: 'Explore the codebase',
      status: 'running',
      applicationStatus: 'not_applied',
      prompt: 'Find the login path',
      referencedEvidenceIds: [],
      transcript: [],
      pendingMessages: [],
      createdAt: 1,
      updatedAt: 2,
    };
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <SubagentDetail
          record={record}
          liveText="Reading src/auth"
          width={100}
          height={30}
          reducedMotion
        />
      </ThemeContext.Provider>,
    );
    const output = view.lastFrame() ?? '';
    expect(output).toContain('Reading src/auth');
    expect(output).not.toContain('Waiting for the subagent to produce output');
  });

  it('keeps inline reasoning tags out of the live stream', () => {
    // A router that inlines thinking as `<think>…</think>` streams the tags
    // through the live buffer. Printed raw, the detail view showed the child's
    // private reasoning verbatim, tags and all, while the same text in the
    // settled transcript one row up was collapsed to a `thought` row.
    const record: AgentRecord = {
      id: 'agent-live',
      profile: 'reviewer',
      displayName: 'Review the change',
      profileDescription: 'Review changes',
      purpose: 'Review the change',
      resolvedModel: 'gateway/review',
      isolation: 'workspace-readonly',
      name: 'reviewer',
      role: 'reviewer',
      description: 'Review changes',
      status: 'running',
      applicationStatus: 'not_applied',
      prompt: 'Review the change',
      referencedEvidenceIds: [],
      transcript: [],
      pendingMessages: [],
      createdAt: 1,
      updatedAt: 2,
    };
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <SubagentDetail
          record={record}
          liveText="<think></think>I'll read the surrounding context.<think></think><think>private</think>"
          width={100}
          height={30}
          reducedMotion
        />
      </ThemeContext.Provider>,
    );
    const output = view.lastFrame() ?? '';
    expect(output).toContain("I'll read the surrounding context.");
    expect(output).not.toContain('<think>');
    expect(output).not.toContain('</think>');
    expect(output).not.toContain('0 lines');
  });

  it('applies expansion overrides to tool rows in the child transcript', () => {
    const record: AgentRecord = {
      id: 'agent-tools',
      profile: 'validator',
      displayName: 'Run child checks',
      profileDescription: 'Validate changes',
      purpose: 'Run tests',
      resolvedModel: 'gateway/review',
      isolation: 'worktree',
      name: 'validator',
      role: 'validator',
      description: 'Validate changes',
      status: 'completed',
      applicationStatus: 'not_applied',
      prompt: 'Run tests',
      referencedEvidenceIds: [],
      transcript: [
        {
          id: 'message-tools',
          role: 'assistant',
          content: '',
          includeInContext: true,
          timestamp: 1,
          toolCalls: [{ id: 'child-tool', name: 'Bash', arguments: { command: 'npm test' } }],
          toolResults: [
            // A closed command row previews its first line, so the line an override must
            // reveal is a later one.
            toolSuccess('running checks\nok 1\nok 2\nCHILD_TOOL_OUTPUT', {
              toolCallId: 'child-tool',
            }),
          ],
        },
      ],
      pendingMessages: [],
      createdAt: 1,
      updatedAt: 2,
    };
    const detail = (expanded: boolean) => (
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <SubagentDetail
          record={record}
          width={100}
          height={30}
          reducedMotion
          toolExpansionOverrides={new Map([['child-tool', expanded]])}
        />
      </ThemeContext.Provider>
    );
    const view = render(detail(false));

    expect(view.lastFrame()).not.toContain('CHILD_TOOL_OUTPUT');
    view.rerender(detail(true));
    expect(view.lastFrame()).toContain('CHILD_TOOL_OUTPUT');
  });
});

describe('SubagentDetail application status', () => {
  function patcher(overrides: Partial<AgentRecord> = {}): AgentRecord {
    return {
      id: 'agent-patch',
      profile: 'patcher',
      displayName: 'Fix the login bug',
      resolvedModel: 'gateway/code',
      isolation: 'worktree',
      name: 'patcher',
      role: 'patcher',
      description: 'Patch the code',
      status: 'completed',
      applicationStatus: 'not_applied',
      prompt: 'Fix the login bug',
      referencedEvidenceIds: [],
      transcript: [],
      pendingMessages: [],
      patchCandidate: {
        baseCommit: '0000000000000000000000000000000000000000',
        headCommit: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
        branch: 'book/agent-patch',
        agentId: 'agent-patch',
      },
      createdAt: 1,
      updatedAt: 2,
      ...overrides,
    };
  }

  function frame(record: AgentRecord): string {
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <SubagentDetail record={record} width={100} height={30} reducedMotion />
      </ThemeContext.Provider>,
    );
    return view.lastFrame() ?? '';
  }

  it('says the candidate was applied, with its short commit', () => {
    expect(frame(patcher({ applicationStatus: 'applied' }))).toContain(
      'Candidate 1a2b3c4: applied',
    );
  });

  it('says a candidate that has not been applied is not', () => {
    expect(frame(patcher())).toContain('Candidate 1a2b3c4: not applied');
  });

  it('says an apply that conflicted failed', () => {
    expect(frame(patcher({ applicationStatus: 'conflicted' }))).toContain(
      'Candidate 1a2b3c4: apply failed',
    );
  });

  it('says nothing about a record without a candidate', () => {
    const output = frame(patcher({ patchCandidate: undefined }));
    expect(output).toContain('main > Fix the login bug');
    expect(output).not.toContain('Candidate');
    expect(output).not.toContain('applied');
  });
});
