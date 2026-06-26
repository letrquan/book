import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs so the store reads as empty and never touches the real disk.
const fsMock = {
  readFileSync: vi.fn(() => ''),
  writeFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn(),
};
vi.mock('fs', () => fsMock);

// Import AFTER mocking fs so the store's module-level fs import is replaced.
const { PermissionStore } = await import('./permissionStore.js');

describe('PermissionStore ordering', () => {
  let store: InstanceType<typeof PermissionStore>;

  beforeEach(() => {
    fsMock.existsSync.mockReturnValue(false);
    fsMock.writeFileSync.mockClear();
    store = new PermissionStore('/fake/ws');
  });

  it('returns ask when no rule matches', () => {
    expect(store.evaluate('bash', 'ls')).toBe('ask');
  });

  it('allowAlways persists and evaluates to allow for the matching command', () => {
    store.allowAlways('bash', 'rm *', 'session');
    expect(store.evaluate('bash', 'rm -rf /tmp/x')).toBe('allow');
    // Non-matching command still asks.
    expect(store.evaluate('bash', 'ls')).toBe('ask');
  });

  it('session-scoped allow rule does not persist to disk', () => {
    store.allowAlways('bash', 'rm *', 'session');
    expect(fsMock.writeFileSync).not.toHaveBeenCalled();
  });

  it('project-scoped allow rule persists to disk', () => {
    store.allowAlways('bash', 'rm *', 'project');
    expect(fsMock.writeFileSync).toHaveBeenCalled();
  });

  it('does not duplicate an identical allow rule', () => {
    store.allowAlways('bash', 'rm *', 'project');
    store.allowAlways('bash', 'rm *', 'project');
    expect(fsMock.writeFileSync).toHaveBeenCalledTimes(1);
  });
});
