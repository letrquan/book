import { describe, expect, it } from 'vitest';
import { toolRiskLevel } from './PermissionButtons.js';

describe('toolRiskLevel', () => {
  it('classifies shell tools as shell-risk', () => {
    expect(toolRiskLevel({ id: '1', name: 'Bash', arguments: { command: 'pwd' } })).toBe('shell');
    expect(toolRiskLevel({ id: '2', name: 'BashOutput', arguments: { shell_id: 'shell_1' } })).toBe(
      'shell',
    );
    expect(toolRiskLevel({ id: '3', name: 'KillShell', arguments: { shell_id: 'shell_1' } })).toBe(
      'shell',
    );
  });

  it('classifies file writes separately from safe tools', () => {
    expect(toolRiskLevel({ id: '4', name: 'Write', arguments: { filePath: 'a.txt' } })).toBe(
      'write',
    );
    expect(toolRiskLevel({ id: '5', name: 'Read', arguments: { filePath: 'a.txt' } })).toBe('safe');
  });
});
