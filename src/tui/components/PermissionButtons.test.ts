import { describe, it, expect } from 'vitest';
import { toolRiskLevel } from './PermissionButtons.js';
import type { ToolCall } from '../../types/tools.js';

function toolCall(name: string): ToolCall {
  return { id: 'tc-1', name, arguments: {} };
}

describe('toolRiskLevel', () => {
  it('classifies shell tools', () => {
    expect(toolRiskLevel(toolCall('Bash'))).toBe('shell');
    expect(toolRiskLevel(toolCall('bash'))).toBe('shell');
  });

  it('classifies write tools', () => {
    expect(toolRiskLevel(toolCall('Write'))).toBe('write');
    expect(toolRiskLevel(toolCall('Edit'))).toBe('write');
    expect(toolRiskLevel(toolCall('MultiEdit'))).toBe('write');
    expect(toolRiskLevel(toolCall('write_file'))).toBe('write');
  });

  it('classifies read-only tools as safe', () => {
    expect(toolRiskLevel(toolCall('Read'))).toBe('safe');
    expect(toolRiskLevel(toolCall('WebFetch'))).toBe('safe');
  });

  it('is defensive for compound shell names', () => {
    expect(toolRiskLevel(toolCall('safeBashRunner'))).toBe('shell');
  });
});
