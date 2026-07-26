import { cleanup, render } from 'ink-testing-library';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentActivity, AgentRecord } from '../agents/types.js';
import type { Message } from '../types/messages.js';
import { ChatPanel } from './components/ChatPanel.js';
import { DEFAULT_THEME, ThemeContext } from './theme.js';
import { projectManagedAgentTraces } from './managed-agent-transcript.js';

afterEach(cleanup);

const rootMessage: Message = {
  id: 'root-message',
  role: 'assistant',
  content: 'I delegated the investigation.',
  includeInContext: true,
  timestamp: 1,
  toolCalls: [
    {
      id: 'spawn-1',
      name: 'AgentSpawn',
      arguments: { agent: 'explorer', description: 'Trace authentication' },
    },
  ],
  toolResults: [
    {
      version: 2,
      toolCallId: 'spawn-1',
      status: 'success',
      content: 'spawned',
      data: { agentId: 'agent-1' },
    },
  ],
};

function childRecord(transcript: Message[] = []): AgentRecord {
  return {
    id: 'agent-1',
    profile: 'explorer',
    displayName: 'Trace authentication',
    name: 'explorer',
    role: 'explorer',
    description: 'Explore',
    status: 'running',
    applicationStatus: 'not_applied',
    prompt: 'Trace authentication.',
    referencedEvidenceIds: [],
    transcript,
    pendingMessages: [],
    createdAt: 1,
    startedAt: 2,
    updatedAt: 3,
  };
}

function activity(
  id: string,
  status: AgentActivity['status'],
  name = 'Read',
  arguments_: Record<string, unknown> = { filePath: `src/${id}.ts` },
): AgentActivity {
  return {
    id,
    kind: 'tool',
    label: `Using ${name}`,
    toolName: name,
    toolCall: { id, name, arguments: arguments_ },
    status,
    startedAt: Number(id.replace(/\D/g, '')) || 3,
    ...(status === 'running'
      ? {}
      : {
          finishedAt: 20,
          result: {
            version: 2,
            toolCallId: id,
            status: status === 'failed' ? 'error' : 'success',
            content: `${id} result`,
          },
        }),
  };
}

describe('managed agent transcript projection', () => {
  it('renders a dedicated child activity block as soon as a tool starts', () => {
    const traces = projectManagedAgentTraces(
      [rootMessage],
      new Map([['agent-1', childRecord()]]),
      new Map([['agent-1', [activity('read-1', 'running')]]]),
    );
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ChatPanel
          messages={[rootMessage]}
          managedAgentTraces={traces}
          reducedMotion
          terminalWidth={100}
        />
      </ThemeContext.Provider>,
    );

    const output = view.lastFrame() ?? '';
    expect(output).toContain('explorer(Trace authentication)');
    expect(output).toContain('src/read-1.ts');
    expect(output).toContain('Running in background');
    expect(output).not.toContain('I delegated the investigation.');
    expect(output).not.toContain('AgentSpawn');
    expect(rootMessage.nestedToolInvocations).toBeUndefined();
  });

  it('shows only the newest call and summarizes older tool uses', () => {
    const traces = projectManagedAgentTraces(
      [rootMessage],
      new Map([['agent-1', childRecord()]]),
      new Map([
        [
          'agent-1',
          [
            activity('call-1', 'completed', 'Bash', { command: 'first-command' }),
            activity('call-2', 'completed', 'Bash', { command: 'second-command' }),
            activity('call-3', 'completed', 'Bash', { command: 'third-command' }),
            activity('call-4', 'running', 'Bash', { command: 'fourth-command' }),
          ],
        ],
      ]),
    );
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ChatPanel
          messages={[rootMessage]}
          managedAgentTraces={traces}
          reducedMotion
          terminalWidth={100}
        />
      </ThemeContext.Provider>,
    );
    const output = view.lastFrame() ?? '';

    expect(output).not.toContain('first-command');
    expect(output).not.toContain('second-command');
    expect(output).not.toContain('third-command');
    expect(output).toContain('fourth-command');
    expect(output).toContain('+3 tool uses');
  });

  it('reconciles live activity with transcript results without duplicate rows', () => {
    const transcript: Message[] = [
      {
        id: 'child-message',
        role: 'assistant',
        content: '',
        includeInContext: true,
        timestamp: 4,
        toolCalls: [{ id: 'read-1', name: 'Read', arguments: { filePath: 'src/auth.ts' } }],
        toolResults: [
          {
            version: 2,
            toolCallId: 'read-1',
            status: 'success',
            content: 'authoritative transcript result',
          },
        ],
      },
    ];
    const traces = projectManagedAgentTraces(
      [rootMessage],
      new Map([['agent-1', childRecord(transcript)]]),
      new Map([['agent-1', [activity('read-1', 'completed')]]]),
    );
    const [tool] = traces.get('spawn-1')?.toolUses ?? [];

    expect(traces.get('spawn-1')?.toolUses).toHaveLength(1);
    expect(tool?.call.arguments).toEqual({ filePath: 'src/auth.ts' });
    expect(tool?.result?.content).toBe('authoritative transcript result');
  });

  it('describes hidden history and navigation in screen-reader mode', () => {
    const traces = projectManagedAgentTraces(
      [rootMessage],
      new Map([['agent-1', childRecord()]]),
      new Map([
        [
          'agent-1',
          [
            activity('call-1', 'completed'),
            activity('call-2', 'completed'),
            activity('call-3', 'completed'),
            activity('call-4', 'completed'),
          ],
        ],
      ]),
    );
    const view = render(
      <ThemeContext.Provider value={DEFAULT_THEME}>
        <ChatPanel
          messages={[rootMessage]}
          managedAgentTraces={traces}
          reducedMotion
          screenReader
          terminalWidth={100}
        />
      </ThemeContext.Provider>,
    );
    const output = view.lastFrame() ?? '';

    expect(output).toContain('Subagent explorer, Trace authentication');
    expect(output).toContain('3 earlier tool uses hidden');
    expect(output).toContain('Down then Enter');
  });
});
