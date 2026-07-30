import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PERMISSION_MODE,
  normalizePermissionMode,
  resolvePermissionMode,
} from './permission-mode.js';

describe('permission mode resolution', () => {
  it('uses the settings default when no invocation override is supplied', () => {
    expect(resolvePermissionMode({ defaultMode: 'plan' })).toBe('plan');
  });

  it('normalizes the settings spelling for accept-edits', () => {
    expect(resolvePermissionMode({ defaultMode: 'acceptEdits' })).toBe('accept-edits');
    expect(normalizePermissionMode('accept-edits')).toBe('accept-edits');
  });

  it('gives an explicit invocation mode precedence over the settings default', () => {
    expect(resolvePermissionMode({ defaultMode: 'plan' }, 'dontAsk')).toBe('dontAsk');
  });

  it('falls back safely for missing or invalid values', () => {
    expect(resolvePermissionMode({ defaultMode: undefined })).toBe(DEFAULT_PERMISSION_MODE);
    expect(resolvePermissionMode({ defaultMode: 'bypassPermissions' }, 'not-a-mode')).toBe(
      DEFAULT_PERMISSION_MODE,
    );
  });

  it('clamps bypass mode when it is disabled by settings', () => {
    expect(
      resolvePermissionMode({
        defaultMode: 'bypassPermissions',
        disableBypassPermissionsMode: true,
      }),
    ).toBe(DEFAULT_PERMISSION_MODE);
    expect(
      resolvePermissionMode(
        { defaultMode: 'plan', disableBypassPermissionsMode: true },
        'bypassPermissions',
      ),
    ).toBe(DEFAULT_PERMISSION_MODE);
  });
});
