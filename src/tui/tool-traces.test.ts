import { describe, expect, it } from 'vitest';
import type { Message, NestedToolInvocation, ToolResult } from '../types.js';
import {
  indexNestedToolInvocations,
  countNestedToolInvocations,
  selectActiveToolId,
  selectExpandedToolId,
  selectLatestToolId,
} from './tool-traces.js';
import { isRenderableFileMutationDiff } from './file-mutation-display.js';

const DIFF = '@@ -1 +1 @@\n-old\n+new';

function assistant(overrides: Partial<Message>): Message {
  return {
    id: 'assistant',
    role: 'assistant',
    content: '',
    includeInContext: true,
    timestamp: 1,
    ...overrides,
  };
}

function result(toolCallId: string, overrides: Partial<ToolResult> = {}): ToolResult {
  return { toolCallId, success: true, output: '', ...overrides };
}

function nested(
  traceId: string,
  parentTraceId: string,
  done = false,
  toolName = 'Read',
  output = '',
): NestedToolInvocation {
  return {
    traceId,
    parentTraceId,
    call: { id: traceId, name: toolName, arguments: {} },
    result: done ? result(traceId, { output }) : undefined,
  };
}

describe('tool traces', () => {
  it('indexes children by parent while preserving event order', () => {
    const index = indexNestedToolInvocations([
      nested('a', 'root'),
      nested('b', 'other'),
      nested('c', 'root'),
    ]);

    expect(index.get('root')?.map((item) => item.traceId)).toEqual(['a', 'c']);
    expect(index.get('other')?.map((item) => item.traceId)).toEqual(['b']);
    expect(countNestedToolInvocations(index, 'root')).toBe(2);
  });

  it('counts recursive nested activity', () => {
    const index = indexNestedToolInvocations([
      nested('child', 'root'),
      nested('grandchild', 'child'),
      nested('sibling', 'root'),
    ]);
    expect(countNestedToolInvocations(index, 'root')).toBe(3);
  });

  it('prefers the latest unfinished nested invocation', () => {
    expect(
      selectActiveToolId(
        assistant({
          toolCalls: [{ id: 'root', name: 'Task', arguments: {} }],
          nestedToolInvocations: [nested('first', 'root'), nested('latest', 'root')],
        }),
      ),
    ).toBe('latest');
  });

  it('falls back to the latest unfinished top-level tool', () => {
    expect(
      selectActiveToolId(
        assistant({
          toolCalls: [
            { id: 'done', name: 'Read', arguments: {} },
            { id: 'running', name: 'Bash', arguments: {} },
          ],
          toolResults: [result('done')],
          nestedToolInvocations: [nested('nested-done', 'done', true)],
        }),
      ),
    ).toBe('running');
  });

  it('returns null when all tools are complete', () => {
    expect(
      selectActiveToolId(
        assistant({
          toolCalls: [{ id: 'done', name: 'Read', arguments: {} }],
          toolResults: [result('done')],
          nestedToolInvocations: [nested('nested-done', 'done', true)],
        }),
      ),
    ).toBeNull();
  });

  it('selects the newest action for explicit expansion', () => {
    expect(
      selectLatestToolId([
        assistant({
          toolCalls: [
            { id: 'first', name: 'Read', arguments: {} },
            { id: 'latest', name: 'Bash', arguments: {} },
          ],
        }),
      ]),
    ).toBe('latest');
  });
});

describe('file mutation preview selection', () => {
  it('accepts canonical and legacy file mutation names only for successful unified diffs', () => {
    expect(isRenderableFileMutationDiff('Edit', result('a', { output: DIFF }))).toBe(true);
    expect(isRenderableFileMutationDiff('edit_file', result('a', { output: DIFF }))).toBe(true);
    expect(isRenderableFileMutationDiff('Write', result('a', { output: '+new' }))).toBe(false);
    expect(isRenderableFileMutationDiff('Bash', result('a', { output: DIFF }))).toBe(false);
    expect(
      isRenderableFileMutationDiff('Edit', result('a', { success: false, output: DIFF })),
    ).toBe(false);
  });

  it('does not reopen a completed mutation after its result arrives', () => {
    const edit = assistant({
      toolCalls: [{ id: 'edit', name: 'Edit', arguments: {} }],
      toolResults: [result('edit', { output: DIFF })],
    });

    expect(selectExpandedToolId([edit])).toBeNull();
  });

  it('keeps completed tools collapsed through later text-only assistant turns', () => {
    const edit = assistant({
      id: 'edit-turn',
      toolCalls: [{ id: 'edit', name: 'Edit', arguments: {} }],
      toolResults: [result('edit', { output: DIFF })],
    });
    const finalText = assistant({ id: 'final', content: 'Done.' });

    expect(selectExpandedToolId([edit, finalText])).toBeNull();
  });

  it('lets the latest tool-bearing turn supersede an older mutation preview', () => {
    const edit = assistant({
      id: 'edit-turn',
      toolCalls: [{ id: 'edit', name: 'Edit', arguments: {} }],
      toolResults: [result('edit', { output: DIFF })],
    });
    const read = assistant({
      id: 'read-turn',
      toolCalls: [{ id: 'read', name: 'Read', arguments: {} }],
      toolResults: [result('read', { output: 'contents' })],
    });

    expect(selectExpandedToolId([edit, read])).toBeNull();
  });

  it('shows a running later tool instead of an older completed mutation', () => {
    const edit = assistant({
      id: 'edit-turn',
      toolCalls: [{ id: 'edit', name: 'Edit', arguments: {} }],
      toolResults: [result('edit', { output: DIFF })],
    });
    const running = assistant({
      id: 'running-turn',
      toolCalls: [{ id: 'bash', name: 'Bash', arguments: {} }],
    });

    expect(selectExpandedToolId([edit, running])).toBe('bash');
  });

  it('selects the newest successful mutation in a parallel batch', () => {
    const parallel = assistant({
      toolCalls: [
        { id: 'first', name: 'Write', arguments: {} },
        { id: 'second', name: 'Edit', arguments: {} },
      ],
      toolResults: [
        result('first', { output: '@@ -1 +1 @@\n+first' }),
        result('second', { output: DIFF }),
      ],
    });

    expect(selectExpandedToolId([parallel])).toBeNull();
  });

  it('supports completed nested mutation previews by trace id', () => {
    const task = assistant({
      toolCalls: [{ id: 'task', name: 'Task', arguments: {} }],
      toolResults: [result('task')],
      nestedToolInvocations: [nested('task/1:edit', 'task', true, 'Edit', DIFF)],
    });

    expect(selectExpandedToolId([task])).toBeNull();
  });

  it('does not preview failed, skipped, no-op, or hook-rewritten mutation results', () => {
    for (const mutationResult of [
      result('edit', { success: false, output: DIFF, error: 'failed' }),
      result('edit', { success: false, output: '', error: 'SKIPPED: denied' }),
      result('edit', { output: 'File edited successfully (no textual change)' }),
      result('edit', { output: 'Hook replaced the output' }),
    ]) {
      expect(
        selectExpandedToolId([
          assistant({
            toolCalls: [{ id: 'edit', name: 'Edit', arguments: {} }],
            toolResults: [mutationResult],
          }),
        ]),
      ).toBeNull();
    }
  });
});
