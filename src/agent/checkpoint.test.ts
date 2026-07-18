import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type { FileObservation, Message } from '../types.js';
import { createTextFileObservation } from '../tools/file-observation.js';
import {
  materializeCheckpointFileFreshness,
  renderCheckpointMessage,
  validateCheckpointResponse,
} from './checkpoint.js';

const messages: Message[] = [
  {
    id: 'u1',
    role: 'user',
    content: 'Do not change the public API.',
    includeInContext: true,
    timestamp: 0,
  },
  {
    id: 'a1',
    role: 'assistant',
    content: 'Read src/a.ts.',
    includeInContext: true,
    timestamp: 0,
  },
];

const observation: FileObservation = {
  workspaceIdentity: 'workspace',
  path: 'src/a.ts',
  sha256: 'book-hash',
  sizeBytes: 42,
  coverage: { kind: 'full' },
  operation: 'read',
  sourceRef: 'session://current/event/a1/tool-result/read1',
};

describe('checkpoint v2 grounding', () => {
  it('grounds exact quotes and copies file metadata only from Book observations', () => {
    const checkpoint = validateCheckpointResponse(
      JSON.stringify({
        stateAtCheckpoint: {
          taskSummary: 'Earlier API work.',
          status: 'completed',
          sourceRefs: ['session://current/event/u1', 'invented'],
        },
        constraints: [
          {
            exactText: 'Do not change the public API.',
            scope: 'session',
            status: 'active',
            sourceRef: 'session://current/event/u1',
          },
        ],
        files: [
          {
            path: 'src/a.ts',
            workspaceIdentity: 'model',
            sha256: 'invented',
            sizeBytes: 999,
            relevanceNote: 'Relevant implementation.',
            observations: ['Has exports.'],
            sourceRefs: ['invented'],
          },
        ],
        episodes: [],
        openThreads: [],
      }),
      {
        messages,
        fileObservations: [observation],
        generation: 2,
        retainedMessageCount: 2,
        estimatedPrefixTokens: 20,
        estimatedTailTokens: 10,
      },
    );

    expect(checkpoint.stateAtCheckpoint.sourceRefs).toEqual(['session://current/event/u1']);
    expect(checkpoint.constraints[0].scope).toBe('unknown');
    expect(checkpoint.files[0]).toMatchObject({
      workspaceIdentity: 'workspace',
      sha256: 'book-hash',
      sizeBytes: 42,
      sourceRefs: [observation.sourceRef],
    });
    expect(renderCheckpointMessage(checkpoint)).toContain('historical/reference data');
  });

  it('drops ungrounded quotes and paths and fails closed on ungrounded state', () => {
    expect(() =>
      validateCheckpointResponse(
        JSON.stringify({
          stateAtCheckpoint: { taskSummary: 'Invented.', status: 'completed', sourceRefs: ['bad'] },
          constraints: [{ exactText: 'never said', sourceRef: 'bad' }],
          files: [{ path: 'not/observed', relevanceNote: 'invented' }],
          episodes: [],
          openThreads: [],
        }),
        {
          messages,
          fileObservations: [observation],
          generation: 1,
          retainedMessageCount: 2,
          estimatedPrefixTokens: 1,
          estimatedTailTokens: 1,
        },
      ),
    ).toThrow(/ungrounded/);
  });

  it('materializes checkpoint file facts as current or stale from the live workspace', () => {
    const workspace = mkdtempSync(join(tmpdir(), 'book-checkpoint-'));
    try {
      const content = 'export const value = 1;\n';
      writeFileSync(join(workspace, 'a.ts'), content, 'utf-8');
      const fileObservation = createTextFileObservation({
        workspaceRoot: workspace,
        path: 'a.ts',
        content,
        operation: 'read',
        sourceRef: 'session://current/event/a1/tool-result/read1',
      });
      const checkpoint = validateCheckpointResponse(
        JSON.stringify({
          stateAtCheckpoint: {
            taskSummary: 'Earlier API work.',
            status: 'paused',
            sourceRefs: ['session://current/event/u1'],
          },
          constraints: [],
          files: [{ path: 'a.ts', relevanceNote: 'Relevant implementation.' }],
          episodes: [],
          openThreads: [],
        }),
        {
          messages,
          fileObservations: [fileObservation],
          generation: 1,
          retainedMessageCount: 1,
          estimatedPrefixTokens: 10,
          estimatedTailTokens: 5,
        },
      );

      expect(materializeCheckpointFileFreshness(checkpoint, workspace)[0]).toContain('current');
      writeFileSync(join(workspace, 'a.ts'), 'export const value = 2;\n', 'utf-8');
      expect(materializeCheckpointFileFreshness(checkpoint, workspace)[0]).toContain(
        'stale locator',
      );
      expect(renderCheckpointMessage(checkpoint, workspace)).toContain('content changed');
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
