import { describe, expect, it } from 'vitest';
import { advanceRun, inSpawnerRun, migrateSpawnerClaim, notifiesParent } from './spawner-claim.js';

describe('migrateSpawnerClaim', () => {
  it('numbers a record that never started into the run it claims', () => {
    const migrated = migrateSpawnerClaim({
      runSequence: undefined,
      spawnerClaim: undefined,
      notifyParentOnCompletion: false,
    });

    // The flag pair described the run the record was on, and a record written before runs
    // were numbered had been through its first run (or was about to be, as run 1). Leaving
    // `runSequence` undefined would let the next run be numbered 1, inside the claim.
    expect(migrated.runSequence).toBe(1);
    expect(migrated.spawnerClaim).toEqual({ throughRunSequence: 1, notifyParent: false });
    expect(notifiesParent(migrated)).toBe(false);

    // A follow-up the parent sends is the parent's run, so it is delivered even though the
    // re-driven Task child's own result is not.
    advanceRun(migrated, false);

    expect(migrated.runSequence).toBe(2);
    expect(inSpawnerRun(migrated)).toBe(false);
    expect(notifiesParent(migrated)).toBe(true);
  });

  it('leaves a record that never started in the claimed run when its follow-up keeps it there', () => {
    const migrated = migrateSpawnerClaim({
      runSequence: undefined,
      spawnerClaim: undefined,
      resumeAfterRestart: false,
    });

    expect(migrated.spawnerClaim).toEqual({ throughRunSequence: 1, resumeAfterRestart: false });
    // The spawner still waits on this run, so the follow-up is folded into its claim.
    advanceRun(migrated, true);

    expect(migrated.runSequence).toBe(2);
    expect(inSpawnerRun(migrated)).toBe(true);
  });

  it('keeps the run a legacy record was on, and drops the flags it read', () => {
    const migrated = migrateSpawnerClaim({
      runSequence: 3,
      spawnerClaim: undefined,
      notifyParentOnCompletion: false,
      resumeAfterRestart: false,
    });

    expect(migrated).toEqual({
      runSequence: 3,
      spawnerClaim: { throughRunSequence: 3, notifyParent: false, resumeAfterRestart: false },
    });
  });
});
