import { describe, it, expect } from 'vitest';
import { bookSettingsSchema } from './settings.js';

describe('settings schema', () => {
  it('validates compactEffort with valid levels and rejects invalid levels', () => {
    expect(bookSettingsSchema.safeParse({ compactEffort: 'low' }).success).toBe(true);
    expect(bookSettingsSchema.safeParse({ compactEffort: 'extreme' }).success).toBe(false);
  });
});
