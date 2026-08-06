import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessEvent, HarnessRunContext, WorkflowDecision } from './contracts.js';
import {
  AVAILABLE_HARNESS_MODES,
  HarnessModeUnavailableError,
  MAX_HARNESS_TEXT_LENGTH,
  createBoundedHarnessText,
  createHarnessCoordinator,
  freezeHarnessRunContext,
} from './coordinator.js';

describe('Phase 1 harness contracts', () => {
  it('keeps workflow decisions descriptive rather than runtime-authoritative', () => {
    const decision: WorkflowDecision = {
      id: 'minimal',
      version: 1,
      reasonCode: 'baseline',
      source: 'baseline',
    };

    expect(decision).toEqual({
      id: 'minimal',
      version: 1,
      reasonCode: 'baseline',
      source: 'baseline',
    });
    expect(decision).not.toHaveProperty('permissions');
    expect(decision).not.toHaveProperty('toolSchemas');
    expect(decision).not.toHaveProperty('retry');
  });

  it('freezes the run context and nested workflow identity', () => {
    const input: HarnessRunContext = {
      runId: 'harness-run-1',
      mode: 'observe',
      workflow: {
        id: 'minimal',
        version: 1,
        reasonCode: 'manual-test',
        source: 'manual',
      },
    };

    const frozen = freezeHarnessRunContext(input);

    expect(frozen).not.toBe(input);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.workflow)).toBe(true);
  });

  it('returns a stable disabled result without fabricating a run context', async () => {
    const coordinator = createHarnessCoordinator('off');

    const first = await coordinator.prepareRun({ mode: 'off' });
    const second = await coordinator.prepareRun({ mode: 'off' });

    expect(first).toBe(second);
    expect(first).toEqual({ status: 'disabled', mode: 'off' });
    expect(first).not.toHaveProperty('context');
    expect(first).not.toHaveProperty('runId');
    expect(coordinator.observe('unused', { type: 'run-started', occurredAt: 0 })).toBe('closed');
    await expect(
      coordinator.finalizeRun('unused', { status: 'completed', outcomes: [] }),
    ).resolves.toEqual({ flushed: true, droppedEventCount: 0 });
  });

  it('accepts only bounded, non-secret text for event string fields', () => {
    const summary = createBoundedHarnessText('  safe summary  ');
    const event: HarnessEvent = {
      type: 'verification-completed',
      occurredAt: 1,
      summary,
      attributes: { verifier: createBoundedHarnessText('unit-tests') },
      evidenceRefs: [createBoundedHarnessText('test-report:1')],
    };

    expect(event.summary).toBe('safe summary');
    expect(() => createBoundedHarnessText('x'.repeat(MAX_HARNESS_TEXT_LENGTH + 1))).toThrow(
      /exceeds/,
    );
    expect(() => createBoundedHarnessText('api_key=super-secret-value')).toThrow(/secret/);
    expect(() => createBoundedHarnessText('unsafe\u0000text')).toThrow(/control/);
  });

  it('creates no files or directories while disabled', async () => {
    const root = mkdtempSync(join(tmpdir(), 'book-harness-off-'));
    try {
      const before = readdirSync(root);

      await createHarnessCoordinator('off').prepareRun({ mode: 'off' });

      expect(readdirSync(root)).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(['observe', 'shadow', 'active', 'learn'] as const)(
    'rejects the valid but unavailable %s mode',
    (mode) => {
      expect(() => createHarnessCoordinator(mode)).toThrow(HarnessModeUnavailableError);
      expect(() => createHarnessCoordinator(mode)).toThrow(`Harness mode "${mode}"`);
      expect(() => createHarnessCoordinator(mode)).toThrow(
        `Available modes: ${AVAILABLE_HARNESS_MODES.join(', ')}`,
      );
    },
  );
});
