import { describe, expect, it } from 'vitest';
import { EXPLORATION_REMINDER, ExplorationRoutingTracker } from './exploration-routing.js';

describe('exploration routing', () => {
  it('reminds once after the configured successful-query budget', () => {
    const tracker = new ExplorationRoutingTracker(3);
    expect(tracker.recordSuccessfulQuery(false)).toBeUndefined();
    expect(tracker.recordSuccessfulQuery(false)).toBeUndefined();
    expect(tracker.recordSuccessfulQuery(false)).toBe(EXPLORATION_REMINDER);
    expect(tracker.recordSuccessfulQuery(false)).toBeUndefined();
  });

  it('suppresses the reminder while an explorer is active', () => {
    const tracker = new ExplorationRoutingTracker(3);
    expect(tracker.recordSuccessfulQuery(true)).toBeUndefined();
    expect(tracker.recordSuccessfulQuery(true)).toBeUndefined();
    expect(tracker.recordSuccessfulQuery(true)).toBeUndefined();
  });
});
