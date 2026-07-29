import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isTranscriptScrollActive,
  markTranscriptScrollActivity,
  TRANSCRIPT_SCROLL_IDLE_MS,
} from './scroll-activity.js';

describe('transcript scroll activity', () => {
  afterEach(() => vi.useRealTimers());

  it('stays active for the idle debounce window', () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    markTranscriptScrollActivity(startedAt);

    expect(isTranscriptScrollActive(startedAt)).toBe(true);
    expect(isTranscriptScrollActive(startedAt + TRANSCRIPT_SCROLL_IDLE_MS - 1)).toBe(true);
    expect(isTranscriptScrollActive(startedAt + TRANSCRIPT_SCROLL_IDLE_MS)).toBe(false);
  });
});
