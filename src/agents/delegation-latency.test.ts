import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, expect, it, vi } from 'vitest';
import { defaultConfig } from '../test/fixtures.js';
import { AgentManager } from './manager.js';
import { AgentStore } from './store.js';

/**
 * What one foreground delegation costs beyond the sidekick's own model time.
 *
 * A lead/sidekick pairing only pays for itself if the handoff is cheap relative
 * to the work handed off. Vendors publish cost savings for the pattern and no
 * latency at all, so this measures the half that decides whether the split is
 * usable interactively: hold the child's run time fixed and injected, and every
 * millisecond left over is harness — admission checks, profile resolution,
 * record persistence, the wait plumbing, and completion acknowledgement.
 *
 * The assertion is a ceiling, not a target. It exists so that a change which
 * quietly makes delegation an order of magnitude more expensive fails here
 * rather than in someone's transcript.
 */

const tempRoots: string[] = [];
/**
 * No lock back-off and no fsync. Every persisted write in a delegation fsyncs
 * its lock, its temp file and the directory, and what that costs is the disk's
 * business, not the harness's: ~10ms on the ubuntu runners, ~20ms on the
 * Windows runners, and ~100ms on a laptop SSD, which put the 200ms median
 * ceiling below the floor of a machine that was doing nothing wrong. With
 * fsync stubbed the number left is the harness alone, which is what the
 * ceilings below are about.
 */
const UNCONTENDED = {
  writerOptions: { sleep: () => {}, fs: { fsyncSync: () => {} } },
} as const;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'book-delegation-latency-'));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of tempRoots.splice(0).reverse()) rmSync(root, { recursive: true, force: true });
});

/** Wall-clock breakdown of a single spawn -> run -> wait -> acknowledge cycle. */
async function measureRoundTrip(childRunMs: number): Promise<{
  roundTripMs: number;
  overheadMs: number;
}> {
  const root = tempRoot();
  const bookHome = tempRoot();
  vi.stubEnv('BOOK_HOME', bookHome);
  const config = defaultConfig({ workspace: root });
  config.settings.agents.persist = true;
  const manager = new AgentManager(config, [], {
    findGitRoot: async () => undefined,
    createStore: (repoHash, requestedRoot, enabled) =>
      new AgentStore(repoHash, requestedRoot, enabled, UNCONTENDED),
    // Stands in for the sidekick's model turn. Fixed and known, so it subtracts
    // cleanly and what remains is attributable to the harness alone.
    runLoop: async (_childConfig, _registry, _prompt, history) => {
      await new Promise((resolve) => setTimeout(resolve, childRunMs));
      return history;
    },
  });

  try {
    const startedAt = Date.now();
    const record = await manager.spawn({
      agent: 'explorer',
      prompt: 'Measure the delegation round trip.',
      parentToolCallId: 'probe-call',
    });
    const completed = await manager.wait(record.id, 30_000);
    if (['completed', 'failed', 'stopped', 'interrupted'].includes(completed.status)) {
      await manager.acknowledgeCompletion(`${completed.id}:${completed.completionSequence ?? 0}`);
    }
    const roundTripMs = Date.now() - startedAt;
    return { roundTripMs, overheadMs: Math.max(0, roundTripMs - childRunMs) };
  } finally {
    manager.dispose();
  }
}

/**
 * The ceiling the best sample must clear. The harness's own cost is what is
 * left when the machine is not stalling, and a stall can only add to a sample,
 * so the best of five is the measurement and the median is reported beside it.
 * The GitHub Windows runners stall for whole seconds at a time -- medians of
 * 234ms and 610ms on days when the same code measured 7-37ms everywhere else,
 * three red runs in two days -- so there the ceiling is 2.5x; the Ubuntu cells
 * of the same matrix keep the tight one, which is where a regression is caught.
 */
function overheadCeilingMs(childRunMs: number): number {
  const windowsCi = process.platform === 'win32' && Boolean(process.env.CI);
  return windowsCi ? childRunMs * 2.5 : childRunMs;
}

it('keeps foreground delegation overhead small relative to the delegated work', async () => {
  const childRunMs = 200;
  const samples: number[] = [];
  for (let run = 0; run < 5; run += 1) {
    samples.push((await measureRoundTrip(childRunMs)).overheadMs);
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const best = sorted[0];
  const median = sorted[Math.floor(sorted.length / 2)];
  const worst = sorted[sorted.length - 1];

  // Printed rather than only asserted: the absolute number is the finding, and a
  // ceiling that passes tells you nothing about where the real cost sits.
  console.log(
    `[delegation] child ${childRunMs}ms · overhead best ${best}ms · median ${median}ms · worst ${worst}ms · samples ${sorted.join('/')}ms`,
  );

  expect(best).toBeLessThan(overheadCeilingMs(childRunMs));
  expect(worst).toBeLessThan(2_000);
}, 60_000);

it('reports overhead that does not scale with the delegated work', async () => {
  // If handoff cost tracked the child's run length, the pattern would be unusable
  // for long tasks — the case delegation is actually for. Two child durations an
  // order of magnitude apart should cost about the same to hand off.
  const short = (await measureRoundTrip(50)).overheadMs;
  const long = (await measureRoundTrip(1_000)).overheadMs;
  console.log(`[delegation] overhead short(50ms child)=${short}ms long(1000ms child)=${long}ms`);
  expect(Math.abs(long - short)).toBeLessThan(1_000);
}, 60_000);
