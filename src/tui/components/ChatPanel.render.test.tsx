import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, cleanup } from 'ink-testing-library';
import { ThemeContext, DEFAULT_THEME } from '../theme.js';
import { DensityContext, type TuiDensity } from '../density.js';
import { ChatPanel } from './ChatPanel.js';
import { AgentMessage } from './AgentMessage.js';
import type { FileMutationSummary, ToolCall, ToolResult } from '../../types/tools.js';
import type { Message } from '../../types/messages.js';

function stripAnsi(value: string | undefined): string {
  return (value ?? '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function frame(lastFrame: () => string | undefined): string {
  return stripAnsi(lastFrame());
}

function withTheme(children: React.ReactElement): React.ReactElement {
  return <ThemeContext.Provider value={DEFAULT_THEME}>{children}</ThemeContext.Provider>;
}

function withDensity(children: React.ReactElement, density: TuiDensity): React.ReactElement {
  return withTheme(<DensityContext.Provider value={density}>{children}</DensityContext.Provider>);
}

function msg(id: string, role: 'user' | 'assistant', content: string): Message {
  return { id, role, content, includeInContext: true, timestamp: 1 };
}

function successResult(
  toolCallId: string,
  content: string,
  fileMutation?: FileMutationSummary,
): ToolResult {
  return {
    version: 2,
    toolCallId,
    status: 'success',
    content,
    ...(fileMutation ? { artifacts: { fileMutation } } : {}),
  };
}

function failureResult(toolCallId: string, message: string, content = ''): ToolResult {
  return {
    version: 2,
    toolCallId,
    status: 'error',
    content,
    structuredError: { code: 'test_error', message, retryable: false },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ChatPanel Ink rendering', () => {
  it('renders the animated welcome when the conversation is empty', () => {
    const view = render(
      withTheme(
        <ChatPanel
          messages={[]}
          terminalWidth={80}
          terminalHeight={24}
          workspace="/tmp/book"
          model="model-x"
          mode="default"
          commandCount={10}
          skillCount={2}
          reducedMotion
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('╭ BOOK');
    expect(output).toContain('Your coding workspace, indexed.');
    expect(output).toContain('/help');
  });

  it('re-emits completed Static history when the viewport epoch changes', () => {
    const messages = [msg('u1', 'user', 'history marker'), msg('a1', 'assistant', 'answer marker')];
    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          terminalWidth={80}
          reducedMotion
          screenReader
          staticEpoch={0}
        />,
      ),
    );

    view.rerender(
      withTheme(
        <ChatPanel
          messages={messages}
          terminalWidth={80}
          reducedMotion
          screenReader
          staticEpoch={1}
        />,
      ),
    );

    const output = view.frames.map(stripAnsi).join('\n');
    expect(output.match(/history marker/g)?.length).toBeGreaterThanOrEqual(2);
    expect(output.match(/answer marker/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('renders compact boundaries inline without hiding transcript messages', () => {
    const messages = [
      msg('u1', 'user', 'before compact'),
      msg('a1', 'assistant', 'first answer'),
      msg('u2', 'user', 'after compact'),
      msg('a2', 'assistant', 'second answer'),
    ];
    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          compactBoundaries={[
            {
              id: 'c1',
              trigger: 'manual',
              transcriptOrdinal: 2,
              preContextCount: 8,
              postContextCount: 3,
              preContextTokens: 10_300,
              postContextTokens: 3_800,
              generation: 2,
              checkpointVersion: 2,
              timestamp: 2,
            },
          ]}
          terminalWidth={80}
          reducedMotion
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('before compact');
    expect(output).toContain('after compact');
    expect(output).toContain('Context compacted · full transcript retained');
    expect(output).not.toContain('Historical conversation checkpoint');
  });

  it('renders child completion as an agent update instead of a user prompt', () => {
    const notification: Message = {
      id: 'notification-1',
      role: 'user',
      content: 'Atlas completed: Found three gaps',
      includeInContext: true,
      kind: 'agent-notification',
      agentNotifications: [
        {
          agentId: 'atlas',
          displayName: 'Atlas',
          status: 'completed',
          summary: 'Found three gaps',
          evidenceIds: ['e1'],
          durationMs: 1200,
        },
      ],
      timestamp: 1,
    };
    const view = render(
      withTheme(<ChatPanel messages={[notification]} terminalWidth={80} reducedMotion />),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('Agent update');
    expect(output).toContain('[done] Atlas: Found three gaps (1s) | 1 evidence');
    expect(output).not.toContain('You');
  });

  it('renders a submitted user message, assistant placeholder, then streamed text without overwriting older messages', () => {
    const baseMessages = [
      msg('u0', 'user', 'older question'),
      msg('a0', 'assistant', 'older answer'),
      msg('u1', 'user', 'new question'),
      msg('a1', 'assistant', ''),
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={baseMessages}
          streamingMessageId="a1"
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    expect(frame(view.lastFrame)).not.toContain('╭ BOOK');
    expect(frame(view.lastFrame)).not.toContain('Your coding workspace, indexed.');
    expect(frame(view.lastFrame)).toContain('older question');
    expect(frame(view.lastFrame)).toContain('older answer');
    expect(frame(view.lastFrame)).toContain('new question');

    view.rerender(
      withTheme(
        <ChatPanel
          messages={baseMessages.map((message) =>
            message.id === 'a1' ? { ...message, content: 'streamed reply' } : message,
          )}
          streamingMessageId="a1"
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('older question');
    expect(output).toContain('older answer');
    expect(output).toContain('new question');
    expect(output).toContain('streamed reply');
  });

  it('renders an inset user card and open assistant output without visible role labels', () => {
    const view = render(
      withTheme(
        <ChatPanel
          messages={[msg('u1', 'user', 'compact request'), msg('a1', 'assistant', 'compact reply')]}
          terminalWidth={80}
          reducedMotion
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).not.toContain('╭ BOOK');
    expect(output).not.toContain('You');
    expect(output).not.toContain('Book');
    expect(output).toContain('│ compact request');
    expect(output).toContain('compact request');
    expect(output).toContain('compact reply');
  });

  it('keeps the user-to-assistant transition compact', () => {
    const view = render(
      withTheme(
        <ChatPanel
          messages={[
            msg('u1', 'user', 'QUESTION_SPACING_MARKER'),
            msg('a1', 'assistant', 'ANSWER_SPACING_MARKER'),
          ]}
          terminalWidth={80}
          reducedMotion
        />,
      ),
    );
    const lines = frame(view.lastFrame).split('\n');
    const questionLine = lines.findIndex((line) => line.includes('QUESTION_SPACING_MARKER'));
    const answerLine = lines.findIndex((line) => line.includes('ANSWER_SPACING_MARKER'));

    // A single gap separates the card from assistant prose.
    expect(answerLine - questionLine).toBe(2);
  });

  it('keeps the timestamp transition into the next user turn compact', () => {
    const view = render(
      withTheme(
        <ChatPanel
          messages={[
            msg('u1', 'user', 'FIRST_QUESTION_MARKER'),
            msg('a1', 'assistant', 'FIRST_ANSWER_MARKER'),
            { ...msg('u2', 'user', 'SECOND_QUESTION_MARKER'), timestamp: 1_700_000_000_000 },
          ]}
          terminalWidth={80}
          reducedMotion
        />,
      ),
    );
    const lines = frame(view.lastFrame).split('\n');
    const answerLine = lines.findIndex((line) => line.includes('FIRST_ANSWER_MARKER'));
    const nextQuestionLine = lines.findIndex((line) => line.includes('SECOND_QUESTION_MARKER'));

    // A single turn gap separates assistant prose from the next user card.
    expect(nextQuestionLine - answerLine).toBe(2);
  });

  it('keeps wrapped content mounted exactly once when streaming completes', () => {
    const marker = 'UNIQUE_FINAL_SUFFIX_42';
    const messages = [
      msg('u1', 'user', 'write a long answer'),
      msg('a1', 'assistant', `${'wrapped response content '.repeat(16)}\n${marker}`),
    ];
    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          streamingMessageId="a1"
          terminalWidth={48}
          reducedMotion
          screenReader
        />,
      ),
    );

    view.rerender(
      withTheme(
        <ChatPanel
          messages={messages}
          streamingMessageId={null}
          terminalWidth={48}
          reducedMotion
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain(marker);
    expect(output.match(new RegExp(marker, 'g'))).toHaveLength(1);
  });

  it('renders rapid streaming identity changes without withholding prior messages', () => {
    const messages = [
      msg('a1', 'assistant', 'MARKER_A'),
      msg('a2', 'assistant', 'MARKER_B'),
      msg('a3', 'assistant', 'MARKER_C'),
    ];
    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          streamingMessageId="a3"
          terminalWidth={50}
          reducedMotion
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('MARKER_A');
    expect(output).toContain('MARKER_B');
    expect(output).toContain('MARKER_C');
  });

  it('keeps the previous turn visible while a new assistant turn streams', () => {
    const previousMarker = 'PREVIOUS_TURN_SUFFIX';
    const activeMarker = 'ACTIVE_TURN_TEXT';
    const messages = [
      msg('u1', 'user', 'inspect the project'),
      msg('a1', 'assistant', `${'completed wrapped text '.repeat(10)}${previousMarker}`),
      msg('a2', 'assistant', activeMarker),
    ];
    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          streamingMessageId="a2"
          terminalWidth={50}
          reducedMotion
          screenReader
        />,
      ),
    );

    expect(frame(view.lastFrame)).toContain(previousMarker);
    expect(frame(view.lastFrame)).toContain(activeMarker);
  });

  it('merges whitespace-only tool-only assistant content into the prior turn', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'inspect files'),
      { ...msg('a1', 'assistant', 'I will inspect the project first.') },
      {
        ...msg('a2', 'assistant', '   \n\t'),
        toolCalls: [{ id: 'call-ws', name: 'Glob', arguments: { pattern: '*.ts' } }],
        toolResults: [successResult('call-ws', 'src/index.ts')],
      },
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          expandedToolCallId="call-ws"
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('I will inspect the project first.');
    expect(output).toContain('[OK] Find files *.ts');
    expect(output.indexOf('I will inspect the project first.')).toBeLessThan(
      output.indexOf('[OK] Find files *.ts'),
    );
  });

  it('keeps completed history in the dynamic tree during active streaming', () => {
    const messages = [
      msg('u1', 'user', 'DYNAMIC_HISTORY_MARKER'),
      msg('a1', 'assistant', 'done'),
      msg('a2', 'assistant', 'DYNAMIC_ACTIVE_MARKER'),
    ];
    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          streamingMessageId="a2"
          terminalWidth={80}
          reducedMotion
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('DYNAMIC_HISTORY_MARKER');
    expect(output).toContain('done');
    expect(output).toContain('DYNAMIC_ACTIVE_MARKER');
  });

  it('renders every consecutive same-name tool call as its own row', () => {
    const messages: Message[] = [
      {
        ...msg('a1', 'assistant', 'I will inspect each file.'),
        toolCalls: [
          { id: 'read-1', name: 'Read', arguments: { filePath: 'src/a.ts' } },
          { id: 'read-2', name: 'Read', arguments: { filePath: 'src/b.ts' } },
          { id: 'read-3', name: 'Read', arguments: { filePath: 'src/c.ts' } },
        ],
        toolResults: [
          successResult('read-1', 'a'),
          successResult('read-2', 'b'),
          successResult('read-3', 'c'),
        ],
      },
    ];

    const view = render(
      withTheme(
        <AgentMessage message={messages[0]} isStreaming={false} reducedMotion screenReader />,
      ),
    );
    const output = frame(view.lastFrame);

    expect(output).toContain('[OK] Read file src/a.ts');
    expect(output).toContain('[OK] Read file src/b.ts');
    expect(output).toContain('[OK] Read file src/c.ts');
    expect(output).not.toContain('×3');
    expect(output.indexOf('src/a.ts')).toBeLessThan(output.indexOf('src/b.ts'));
    expect(output.indexOf('src/b.ts')).toBeLessThan(output.indexOf('src/c.ts'));
  });

  it('adds one blank row between narration and sibling actions in compact density', () => {
    const message: Message = {
      ...msg('a1', 'assistant', 'I will inspect both files.'),
      toolCalls: [
        { id: 'read-1', name: 'Read', arguments: { filePath: 'src/a.ts' } },
        { id: 'read-2', name: 'Read', arguments: { filePath: 'src/b.ts' } },
      ],
      toolResults: [
        { version: 2, toolCallId: 'read-1', status: 'success', content: 'a' },
        { version: 2, toolCallId: 'read-2', status: 'success', content: 'b' },
      ],
    };
    const view = render(
      withDensity(<AgentMessage message={message} isStreaming={false} reducedMotion />, 'compact'),
    );
    const lines = frame(view.lastFrame).split('\n');
    const narration = lines.findIndex((line) => line.includes('I will inspect both files.'));
    const first = lines.findIndex((line) => line.includes('Read(src/a.ts)'));
    const second = lines.findIndex((line) => line.includes('Read(src/b.ts)'));

    expect(lines.slice(narration + 1, first)).toEqual(['']);
    expect(lines.slice(first + 1, second)).toEqual(['']);
  });

  it('removes action gaps in tight density', () => {
    const message: Message = {
      ...msg('a1', 'assistant', 'Inspecting.'),
      toolCalls: [
        { id: 'read-1', name: 'Read', arguments: { filePath: 'src/a.ts' } },
        { id: 'read-2', name: 'Read', arguments: { filePath: 'src/b.ts' } },
      ],
      toolResults: [
        { version: 2, toolCallId: 'read-1', status: 'success', content: 'a' },
        { version: 2, toolCallId: 'read-2', status: 'success', content: 'b' },
      ],
    };
    const view = render(
      withDensity(<AgentMessage message={message} isStreaming={false} reducedMotion />, 'tight'),
    );
    const lines = frame(view.lastFrame).split('\n');
    const narration = lines.findIndex((line) => line.includes('Inspecting.'));
    const first = lines.findIndex((line) => line.includes('Read(src/a.ts)'));
    const second = lines.findIndex((line) => line.includes('Read(src/b.ts)'));

    expect(first).toBe(narration + 1);
    expect(second).toBe(first + 1);
  });

  it('applies the same sibling spacing to nested actions', () => {
    const message: Message = {
      ...msg('a1', 'assistant', ''),
      toolCalls: [{ id: 'task', name: 'Task', arguments: { agent: 'explorer' } }],
      nestedToolInvocations: [
        {
          traceId: 'task/read-a',
          parentTraceId: 'task',
          call: { id: 'read-a', name: 'Read', arguments: { filePath: 'src/a.ts' } },
          result: {
            version: 2,
            toolCallId: 'read-a',
            status: 'success',
            content: 'a',
          },
        },
        {
          traceId: 'task/read-b',
          parentTraceId: 'task',
          call: { id: 'read-b', name: 'Read', arguments: { filePath: 'src/b.ts' } },
          result: {
            version: 2,
            toolCallId: 'read-b',
            status: 'success',
            content: 'b',
          },
        },
      ],
    };
    const view = render(
      withDensity(<AgentMessage message={message} isStreaming={false} reducedMotion />, 'compact'),
    );
    const lines = frame(view.lastFrame).split('\n');
    const first = lines.findIndex((line) => line.includes('Read(src/a.ts)'));
    const second = lines.findIndex((line) => line.includes('Read(src/b.ts)'));

    expect(lines.slice(first + 1, second)).toEqual(['']);
  });

  it('rerenders a tool result when array lengths stay unchanged', () => {
    const toolCalls: ToolCall[] = [
      { id: 'call-stable', name: 'Bash', arguments: { command: 'npm test' } },
    ];
    const initial = {
      ...msg('a1', 'assistant', ''),
      toolCalls,
      toolResults: [failureResult('call-stable', 'still running')],
    };
    const view = render(
      withTheme(<AgentMessage message={initial} isStreaming reducedMotion screenReader />),
    );
    expect(frame(view.lastFrame)).toContain('[ERR] Run command npm test');

    const completed: Message = {
      ...initial,
      toolResults: [successResult('call-stable', 'passed')],
    };
    view.rerender(
      withTheme(<AgentMessage message={completed} isStreaming reducedMotion screenReader />),
    );

    expect(frame(view.lastFrame)).toContain('[OK] Run command npm test');
    expect(frame(view.lastFrame)).not.toContain('[ERR] Run command npm test');
  });

  it('renders recursive Task subagent tools beneath their parent invocations', () => {
    const message: Message = {
      ...msg('a1', 'assistant', 'Delegating the investigation.'),
      toolCalls: [
        { id: 'task-root', name: 'Task', arguments: { agent: 'explorer', prompt: 'inspect' } },
      ],
      nestedToolInvocations: [
        {
          traceId: 'task-root/1-1:duplicate',
          parentTraceId: 'task-root',
          call: { id: 'duplicate', name: 'Read', arguments: { filePath: 'src/a.ts' } },
          result: successResult('duplicate', 'a'),
        },
        {
          traceId: 'task-root/1-2:nested-task',
          parentTraceId: 'task-root',
          call: {
            id: 'nested-task',
            name: 'Task',
            arguments: { agent: 'reviewer', prompt: 'review' },
          },
        },
        {
          traceId: 'task-root/1-2:nested-task/1-1:duplicate',
          parentTraceId: 'task-root/1-2:nested-task',
          call: { id: 'duplicate', name: 'Read', arguments: { filePath: 'src/b.ts' } },
          result: failureResult('duplicate', 'missing'),
        },
      ],
    };

    const view = render(
      withTheme(<AgentMessage message={message} isStreaming reducedMotion screenReader />),
    );
    const output = frame(view.lastFrame);

    expect(output).toContain('[Running] Run subagent explorer');
    expect(output).toContain('[OK] Read file src/a.ts');
    expect(output).toContain('[Running] Run subagent reviewer');
    expect(output).toContain('[ERR] Read file src/b.ts');
    expect(output.indexOf('explorer')).toBeLessThan(output.indexOf('src/a.ts'));
    expect(output.indexOf('src/a.ts')).toBeLessThan(output.indexOf('reviewer'));
    expect(output.indexOf('reviewer')).toBeLessThan(output.indexOf('src/b.ts'));
  });

  it('renders nested tools based on parent traces rather than the parent tool name', () => {
    const message: Message = {
      ...msg('a1', 'assistant', ''),
      toolCalls: [{ id: 'host', name: 'Orchestrate', arguments: {} }],
      nestedToolInvocations: [
        {
          traceId: 'host/child',
          parentTraceId: 'host',
          call: { id: 'child', name: 'Read', arguments: { filePath: 'src/child.ts' } },
          result: successResult('child', 'done'),
        },
      ],
    };

    const view = render(
      withTheme(<AgentMessage message={message} isStreaming reducedMotion screenReader />),
    );

    expect(frame(view.lastFrame)).toContain('[OK] Read file src/child.ts');
  });

  it('renders tool calls and results under the assistant turn that produced them', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'inspect file'),
      {
        ...msg('a1', 'assistant', 'I will inspect it.'),
        toolCalls: [{ id: 'call-1', name: 'Read', arguments: { filePath: 'src/a.ts' } }],
        toolResults: [successResult('call-1', 'file contents')],
      },
      msg('a2', 'assistant', 'The file looks good.'),
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          expandedToolCallId="call-1"
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('I will inspect it.');
    expect(output).toContain('[OK] Read file src/a.ts');
    expect(output).toContain('file contents');
    expect(output).toContain('The file looks good.');
    expect(output.indexOf('[OK] Read file src/a.ts')).toBeGreaterThan(
      output.indexOf('I will inspect it.'),
    );
    expect(output.indexOf('[OK] Read file src/a.ts')).toBeLessThan(
      output.indexOf('The file looks good.'),
    );
  });

  it('marks a pending permission on the matching assistant tool row', () => {
    const toolCall: ToolCall = {
      id: 'call-pending',
      name: 'Bash',
      arguments: { command: 'npm test' },
    };
    const onResolve = vi.fn();
    const messages: Message[] = [
      msg('u1', 'user', 'run tests'),
      { ...msg('a1', 'assistant', 'I need to run a command.'), toolCalls: [toolCall] },
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          pendingPermission={{ toolCall }}
          onResolvePermission={onResolve}
          expandedToolCallId="call-pending"
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('I need to run a command.');
    expect(output).toContain('[needs approval]');
    expect(output).not.toContain('Permission required for: Bash');
    expect(output).not.toContain('Primary argument: npm test');
  });

  it('keeps a streaming tool-call-only message dynamic so permission prompts can appear', () => {
    const toolCall: ToolCall = {
      id: 'call-streaming-pending',
      name: 'Glob',
      arguments: { pattern: '*.ts' },
    };
    const onResolve = vi.fn();
    const messages: Message[] = [
      msg('u1', 'user', 'inspect files'),
      { ...msg('a1', 'assistant', 'I will inspect the project first.') },
      { ...msg('a2', 'assistant', ''), toolCalls: [toolCall] },
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          streamingMessageId="a2"
          expandedToolCallId="call-streaming-pending"
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    expect(frame(view.lastFrame)).not.toContain('Permission required for: Glob');

    view.rerender(
      withTheme(
        <ChatPanel
          messages={messages}
          streamingMessageId="a2"
          pendingPermission={{ toolCall }}
          onResolvePermission={onResolve}
          expandedToolCallId="call-streaming-pending"
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('I will inspect the project first.');
    expect(output).toContain('[needs approval]');
    expect(output).not.toContain('Permission required for: Glob');
    expect(output).not.toContain('Primary argument: *.ts');
  });

  it('keeps plan approval controls outside transcript content', () => {
    const toolCall: ToolCall = {
      id: 'call-exit-plan-mode',
      name: 'ExitPlanMode',
      arguments: { plan: 'Step 1: update rendering\nStep 2: run tests' },
    };
    const messages: Message[] = [
      msg('u1', 'user', 'fix plan mode scrolling'),
      msg('a1', 'assistant', 'I found the likely cause.'),
      { ...msg('a2', 'assistant', ''), toolCalls: [toolCall] },
    ];
    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          streamingMessageId="a2"
          expandedToolCallId="call-exit-plan-mode"
          terminalWidth={100}
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('fix plan mode scrolling');
    expect(output).toContain('I found the likely cause.');
    expect(output).toContain('ExitPlanMode');
    expect(output).not.toContain('Plan approval required');
    expect(output).not.toContain('Approve plan');
  });

  it('merges a tool-call-only assistant message after streaming completes', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'inspect files'),
      { ...msg('a1', 'assistant', 'I will inspect the project first.') },
      {
        ...msg('a2', 'assistant', ''),
        toolCalls: [{ id: 'call-merged', name: 'Glob', arguments: { pattern: '*.ts' } }],
        toolResults: [successResult('call-merged', 'src/index.ts')],
      },
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          expandedToolCallId="call-merged"
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('I will inspect the project first.');
    expect(output).toContain('[OK] Find files *.ts');
    expect(output.indexOf('I will inspect the project first.')).toBeLessThan(
      output.indexOf('[OK] Find files *.ts'),
    );
  });

  it('renders retry and stall labels on AgentMessage when inline activity is enabled', () => {
    const stalled = render(
      withTheme(
        <AgentMessage
          message={msg('a1', 'assistant', '')}
          isStreaming
          reducedMotion
          retryPhase="stalled"
          retryCountdownMs={20_000}
        />,
      ),
    );

    expect(frame(stalled.lastFrame)).toContain(
      'Retrying: Waiting for API response · will retry in 20s · check your network',
    );
    stalled.unmount();

    const retrying = render(
      withTheme(
        <AgentMessage
          message={msg('a2', 'assistant', 'partial text')}
          isStreaming
          reducedMotion
          retryPhase="transport"
          retryAttempt={2}
          retryMax={10}
          retryCountdownMs={4_000}
        />,
      ),
    );

    expect(frame(retrying.lastFrame)).toContain('Retrying: Retrying in 4s · attempt 2/10');
    expect(frame(retrying.lastFrame)).toContain('partial text');
  });

  it('hides active message spinner when external working indicator owns activity state', () => {
    const view = render(
      withTheme(
        <ChatPanel
          messages={[msg('a1', 'assistant', 'partial text')]}
          streamingMessageId="a1"
          terminalWidth={100}
          reducedMotion
          retryPhase="transport"
          retryAttempt={2}
          retryMax={10}
          retryCountdownMs={4_000}
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('partial text');
    expect(output).not.toContain('Retrying:');
    expect(output).not.toContain('Retrying in 4s');
  });

  it('collapses long tool output under the assistant turn by default', () => {
    const longOutput = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
    const messages: Message[] = [
      {
        ...msg('a1', 'assistant', 'I will run it.'),
        toolCalls: [{ id: 'call-1', name: 'Bash', arguments: { command: 'seq 8' } }],
        toolResults: [successResult('call-1', longOutput)],
      },
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          expandedToolCallId="call-1"
          terminalWidth={100}
          reducedMotion
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('line 1');
    expect(output).toContain('line 3');
    expect(output).toContain('line 6');
    expect(output).toContain('line 8');
    expect(output).not.toContain('line 4');
    expect(output).toContain('2 more lines hidden');
  });

  it('renders long tool output when show-all mode is enabled', () => {
    const longOutput = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join('\n');
    const messages: Message[] = [
      {
        ...msg('a1', 'assistant', 'I will run it.'),
        toolCalls: [{ id: 'call-1', name: 'Bash', arguments: { command: 'seq 8' } }],
        toolResults: [successResult('call-1', longOutput)],
      },
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          expandedToolCallId="call-1"
          terminalWidth={100}
          reducedMotion
          showAllToolOutput
        />,
      ),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('line 8');
    expect(output).not.toContain('more lines hidden');
  });

  it('keeps compact tools concise and exposes every result in detailed mode', () => {
    const message: Message = {
      ...msg('a1', 'assistant', 'Inspecting.'),
      toolCalls: [
        { id: 'read', name: 'Read', arguments: { filePath: 'src/a.ts' } },
        { id: 'bash', name: 'Bash', arguments: { command: 'npm test' } },
      ],
      toolResults: [
        successResult('read', 'READ_RESULT_MARKER'),
        successResult('bash', 'BASH_RESULT_MARKER'),
      ],
    };
    const view = render(
      withTheme(
        <AgentMessage
          message={message}
          isStreaming={false}
          transcriptMode="compact"
          automaticToolCallId={null}
          reducedMotion
          terminalWidth={100}
        />,
      ),
    );

    expect(frame(view.lastFrame)).toContain('Read(src/a.ts)');
    expect(frame(view.lastFrame)).toContain('Bash(npm test)');
    expect(frame(view.lastFrame)).not.toContain('READ_RESULT_MARKER');
    expect(frame(view.lastFrame)).not.toContain('BASH_RESULT_MARKER');

    view.rerender(
      withTheme(
        <AgentMessage
          message={message}
          isStreaming={false}
          transcriptMode="detailed"
          automaticToolCallId={null}
          reducedMotion
          terminalWidth={100}
        />,
      ),
    );
    expect(frame(view.lastFrame)).toContain('filePath: src/a.ts');
    expect(frame(view.lastFrame)).toContain('READ_RESULT_MARKER');
    expect(frame(view.lastFrame)).toContain('command: npm test');
    expect(frame(view.lastFrame)).toContain('BASH_RESULT_MARKER');
  });

  it('collapses a compact action when it completes and preserves manual expansion', () => {
    const running: Message = {
      ...msg('a1', 'assistant', ''),
      toolCalls: [{ id: 'bash', name: 'Bash', arguments: { command: 'npm test' } }],
    };
    const view = render(
      withTheme(
        <AgentMessage
          message={running}
          isStreaming
          transcriptMode="compact"
          automaticToolCallId="bash"
          reducedMotion
        />,
      ),
    );
    expect(frame(view.lastFrame)).toContain('command: npm test');

    const completed: Message = {
      ...running,
      toolResults: [
        {
          version: 2,
          toolCallId: 'bash',
          status: 'success',
          content: 'PASSED_MARKER',
        },
      ],
    };
    view.rerender(
      withTheme(
        <AgentMessage
          message={completed}
          isStreaming={false}
          transcriptMode="compact"
          automaticToolCallId={null}
          reducedMotion
        />,
      ),
    );
    expect(frame(view.lastFrame)).toContain('Bash(npm test)');
    expect(frame(view.lastFrame)).not.toContain('command: npm test');
    expect(frame(view.lastFrame)).not.toContain('PASSED_MARKER');

    view.rerender(
      withTheme(
        <AgentMessage
          message={completed}
          isStreaming={false}
          transcriptMode="compact"
          automaticToolCallId={null}
          toolExpansionOverrides={new Map([['bash', true]])}
          reducedMotion
        />,
      ),
    );
    expect(frame(view.lastFrame)).toContain('command: npm test');
    expect(frame(view.lastFrame)).toContain('PASSED_MARKER');
  });

  it('renders every MCP invocation as its own row in compact mode', () => {
    const message: Message = {
      ...msg('a1', 'assistant', ''),
      toolCalls: [
        { id: 'mcp-1', name: 'mcp__slack__search', arguments: { query: 'release' } },
        { id: 'mcp-2', name: 'mcp__slack__post', arguments: { channel: 'eng' } },
      ],
      toolResults: [successResult('mcp-1', 'found'), successResult('mcp-2', 'posted')],
    };
    const view = render(
      withTheme(
        <AgentMessage
          message={message}
          isStreaming={false}
          transcriptMode="compact"
          reducedMotion
        />,
      ),
    );
    expect(frame(view.lastFrame)).toContain('Called slack(search)');
    expect(frame(view.lastFrame)).toContain('Called slack(post)');
    expect(frame(view.lastFrame)).not.toContain('Called slack 2 times');

    view.rerender(
      withTheme(
        <AgentMessage
          message={message}
          isStreaming={false}
          transcriptMode="detailed"
          reducedMotion
        />,
      ),
    );
    expect(frame(view.lastFrame)).toContain('Called slack(search)');
    expect(frame(view.lastFrame)).toContain('Called slack(post)');
  });

  it('collapses completed file mutation output while keeping diffstats visible', () => {
    const diffOutput = ['@@ -1 +1 @@', '-old line', '+new line'].join('\n');
    const messages: Message[] = [
      {
        ...msg('a1', 'assistant', 'I will update it.'),
        toolCalls: [{ id: 'call-1', name: 'Edit', arguments: { filePath: 'src/a.ts' } }],
        toolResults: [
          successResult('call-1', diffOutput, {
            kind: 'update',
            filePath: 'src/a.ts',
            addedLines: 1,
            removedLines: 1,
          }),
        ],
      },
      msg('a2', 'assistant', 'Done.'),
    ];

    const view = render(
      withTheme(<ChatPanel messages={messages} terminalWidth={100} reducedMotion />),
    );

    const output = frame(view.lastFrame);
    expect(output).toContain('I will update it.');
    expect(output).toContain('Done.');
    expect(output).toContain('Update(src/a.ts)');
    expect(output).toContain('· +1 -1');
    expect(output).not.toContain('- old line');
    expect(output).not.toContain('+ new line');
  });

  it('collapses an older file preview when a newer non-file tool turn completes', () => {
    const messages: Message[] = [
      {
        ...msg('a1', 'assistant', 'Editing the first file.'),
        toolCalls: [{ id: 'edit', name: 'Edit', arguments: { filePath: 'src/a.ts' } }],
        toolResults: [
          successResult('edit', '@@ -1 +1 @@\n-old marker\n+new marker', {
            kind: 'update',
            filePath: 'src/a.ts',
            addedLines: 1,
            removedLines: 1,
          }),
        ],
      },
      {
        ...msg('a2', 'assistant', ''),
        toolCalls: [{ id: 'read', name: 'Read', arguments: { filePath: 'src/b.ts' } }],
        toolResults: [successResult('read', 'contents')],
      },
    ];

    const view = render(
      withTheme(<ChatPanel messages={messages} terminalWidth={100} reducedMotion />),
    );
    const output = frame(view.lastFrame);

    expect(output).toContain('Update(src/a.ts)');
    expect(output).not.toContain('-old marker');
    expect(output).not.toContain('+new marker');
  });

  it('merges adjacent assistant messages where later has no content (tool-call-only turn)', () => {
    const messages: Message[] = [
      msg('u1', 'user', 'run tests'),
      {
        ...msg('a1', 'assistant', 'I will explore the project.'),
        toolCalls: [{ id: 'call-1', name: 'Glob', arguments: { pattern: '*.ts' } }],
        toolResults: [successResult('call-1', 'src/index.ts')],
      },
      // Tool-call-only turn — no content, just tool calls/results.
      {
        ...msg('a2', 'assistant', ''),
        toolCalls: [{ id: 'call-2', name: 'Read', arguments: { filePath: 'src/index.ts' } }],
        toolResults: [successResult('call-2', 'file contents')],
      },
      // Another tool-call-only turn.
      {
        ...msg('a3', 'assistant', ''),
        toolCalls: [{ id: 'call-3', name: 'Grep', arguments: { pattern: 'export' } }],
        toolResults: [successResult('call-3', '1 match')],
      },
    ];

    const view = render(
      withTheme(
        <ChatPanel
          messages={messages}
          expandedToolCallId="call-1"
          terminalWidth={100}
          reducedMotion
          screenReader
        />,
      ),
    );

    const output = frame(view.lastFrame);
    // All tool calls should appear under a single "I will explore the project" block.
    // No repeated empty "Book" headers between tools.
    expect(output).toContain('I will explore the project.');
    expect(output).toContain('[OK] Find files *.ts');
    expect(output).toContain('[OK] Read file src/index.ts');
    expect(output).toContain('[OK] Search files');

    // The tool calls should appear in order after the text.
    const textIdx = output.indexOf('I will explore the project.');
    const globIdx = output.indexOf('[OK] Find files');
    const readIdx = output.indexOf('[OK] Read file');
    const grepIdx = output.indexOf('[OK] Search files');
    expect(textIdx).toBeLessThan(globIdx);
    expect(globIdx).toBeLessThan(readIdx);
    expect(readIdx).toBeLessThan(grepIdx);
  });

  it('renders structured local command output as a panel instead of markdown text', () => {
    const message: Message = {
      ...msg('local-usage', 'assistant', 'Session usage plain fallback'),
      includeInContext: false,
      localCommand: {
        kind: 'usage',
        model: 'claude-sonnet-5',
        currentTurn: 2,
        messageCount: 5,
        turnDurationMs: 1200,
        usage: { promptTokens: 1000, completionTokens: 250, totalTokens: 1250 },
        rate: { inputPerMillion: 3, outputPerMillion: 15 },
        estimatedCostUsd: 0.00675,
      },
    };

    const view = render(
      withTheme(<ChatPanel messages={[message]} terminalWidth={80} reducedMotion />),
    );
    const output = frame(view.lastFrame);

    expect(output).toContain('/usage · Session telemetry');
    expect(output).toContain('input 1,000');
    expect(output).not.toContain('Session usage plain fallback');
  });
});
