import { describe, expect, it } from 'vitest';
import type { ToolContext } from '../types/tools.js';
import { createRegistry } from './registry.js';
import {
  normalizeToolResult,
  replaceToolResult,
  toolFailure,
  toolResultModelContent,
  toolSuccess,
} from './result.js';

const context: ToolContext = { workspaceRoot: process.cwd(), env: {} };

describe('ToolResult V2', () => {
  it('returns a V2 envelope from registered tools', async () => {
    const registry = createRegistry();
    registry.register({
      name: 'LegacyEcho',
      description: 'Echo text',
      parameters: {
        type: 'object',
        properties: { value: { type: 'string', description: 'Text to echo' } },
        required: ['value'],
      },
      execute: async (args) => toolSuccess(String(args.value)),
    });

    const result = await registry.execute(
      { id: 'call-1', name: 'LegacyEcho', arguments: { value: 'hello' } },
      context,
    );
    expect(result).toMatchObject({
      version: 2,
      status: 'success',
      content: 'hello',
    });
    expect(result.presentation?.details).toBe('hello');
  });

  it('serializes structured failures into actionable model context', () => {
    const result = toolFailure('Bad input', {
      code: 'invalid_arguments',
      remediation: 'Pass a non-empty query.',
    });
    expect(result.structuredError).toMatchObject({
      code: 'invalid_arguments',
      message: 'Bad input',
      retryable: false,
      remediation: 'Pass a non-empty query.',
    });
    expect(toolResultModelContent(result)).toContain('ERROR [invalid_arguments]: Bad input');
  });

  it('keeps model content independent from structured data', () => {
    const result = toolSuccess('2 matches', { data: { matches: ['a', 'b'] } });
    expect(toolResultModelContent(result)).toBe('2 matches');
    expect(result.data).toEqual({ matches: ['a', 'b'] });
  });

  it('keeps machine-readable data on failure envelopes', () => {
    const result = toolFailure('No candidates fit', {
      code: 'budget_exceeded',
      data: { rejected: ['HugeTool'] },
    });
    expect(result.data).toEqual({ rejected: ['HugeTool'] });
  });

  it('preserves explicit presentation fields during registry enrichment', async () => {
    const registry = createRegistry();
    registry.register({
      name: 'Read',
      description: 'Render custom content',
      parameters: {
        type: 'object',
        properties: { filePath: { type: 'string' } },
        required: ['filePath'],
      },
      execute: async () =>
        toolSuccess('raw content', {
          presentation: {
            kind: 'markdown',
            summary: 'Custom summary',
            details: 'Custom details',
            metadata: ['custom metadata'],
            target: 'custom target',
          },
        }),
    });

    const result = await registry.execute(
      { id: 'presentation', name: 'Read', arguments: { filePath: 'ignored.md' } },
      context,
    );
    expect(result.presentation).toEqual({
      kind: 'markdown',
      summary: 'Custom summary',
      details: 'Custom details',
      metadata: ['custom metadata'],
      target: 'custom target',
    });
  });

  it('upgrades persisted legacy results without retaining legacy projections', () => {
    const result = normalizeToolResult({
      toolCallId: 'legacy-call',
      success: false,
      output: 'command output',
      error: 'Tool timeout after 1000ms',
      durationMs: 1_000,
      fileMutation: {
        kind: 'update',
        filePath: 'src/a.ts',
        addedLines: 1,
        removedLines: 2,
      },
    });

    expect(result).toMatchObject({
      version: 2,
      status: 'timed_out',
      content: 'command output',
      structuredError: {
        code: 'timed_out',
        message: 'Tool timeout after 1000ms',
        retryable: true,
      },
      metrics: { durationMs: 1_000 },
      artifacts: {
        fileMutation: {
          kind: 'update',
          filePath: 'src/a.ts',
          addedLines: 1,
          removedLines: 2,
        },
      },
    });
    expect(result).not.toHaveProperty('success');
    expect(result).not.toHaveProperty('output');
    expect(result).not.toHaveProperty('error');
    expect(result).not.toHaveProperty('durationMs');
    expect(result).not.toHaveProperty('fileMutation');
  });

  it('replaces structured errors without adding a legacy error projection', () => {
    const result = replaceToolResult(toolSuccess('submitted'), {
      status: 'blocked',
      content: '',
      error: {
        code: 'plan_not_approved',
        message: 'Plan was not approved.',
        retryable: false,
      },
    });

    expect(result).toMatchObject({
      status: 'blocked',
      content: '',
      structuredError: {
        code: 'plan_not_approved',
        message: 'Plan was not approved.',
        retryable: false,
      },
    });
    expect(result).not.toHaveProperty('error');
    expect(normalizeToolResult(result).structuredError?.message).toBe('Plan was not approved.');
  });
});
