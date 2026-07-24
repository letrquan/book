import { describe, expect, it } from 'vitest';
import { projectToolResultForDisplay, redactToolCallForDisplay } from './activity.js';

describe('managed-agent activity redaction', () => {
  it('redacts sensitive tool argument fields without mutating the source', () => {
    const source = {
      id: 'call',
      name: 'Bash',
      arguments: { command: 'echo ok', env: { API_KEY: 'secret', MODE: 'test' } },
    };
    const displayed = redactToolCallForDisplay(source);
    expect(displayed.arguments).toEqual({
      command: 'echo ok',
      env: { API_KEY: '[redacted]', MODE: 'test' },
    });
    expect(source.arguments.env.API_KEY).toBe('secret');
  });

  it('projects a bounded result without machine data or full output', () => {
    const displayed = projectToolResultForDisplay({
      version: 2,
      toolCallId: 'call',
      status: 'success',
      content: `first useful line\n${'x'.repeat(500)}`,
      data: { secret: 'not-for-events' },
      presentation: {
        kind: 'search',
        summary: 'Search complete',
        details: `detail line\n${'y'.repeat(500)}`,
      },
      artifacts: {
        fileMutation: { kind: 'update', filePath: 'src/a.ts', addedLines: 2, removedLines: 1 },
        fileObservations: [],
      },
    });

    expect(displayed.content).toBe('first useful line');
    expect(displayed.presentation?.details).toBe('detail line');
    expect(displayed).not.toHaveProperty('data');
    expect(displayed.artifacts).toEqual({
      fileMutation: { kind: 'update', filePath: 'src/a.ts', addedLines: 2, removedLines: 1 },
    });
  });
});
