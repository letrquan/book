import { describe, it, expect } from 'vitest';
import {
  permissionPatternForDisplay,
  permissionPatternForTool,
  toolRiskLevel,
} from './PermissionButtons.js';
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

  it('classifies local read-only tools as safe and web tools as networked', () => {
    expect(toolRiskLevel(toolCall('Read'))).toBe('safe');
    expect(toolRiskLevel(toolCall('WebFetch'))).toBe('network');
    expect(toolRiskLevel(toolCall('WebSearch'))).toBe('network');
  });

  it('is defensive for compound shell names', () => {
    expect(toolRiskLevel(toolCall('safeBashRunner'))).toBe('shell');
  });
});

describe('permissionPatternForTool', () => {
  it('persists WebFetch approval by origin and WebSearch approval by tool', () => {
    const fetchCall: ToolCall = {
      id: 'fetch',
      name: 'WebFetch',
      arguments: { url: 'https://docs.example.com/guide/page' },
    };
    const searchCall: ToolCall = {
      id: 'search',
      name: 'WebSearch',
      arguments: { query: 'current TypeScript release' },
    };

    expect(permissionPatternForTool(fetchCall, 'https://docs.example.com/guide/page')).toBe(
      'WebFetch(https://docs.example.com/**)',
    );
    expect(permissionPatternForTool(searchCall, 'current TypeScript release')).toBe('WebSearch');
  });

  it('keeps long persisted rules intact while bounding their display form', () => {
    const command = `bash ${'x'.repeat(200)}`;
    const call: ToolCall = { id: 'bash', name: 'Bash', arguments: { command } };
    const persisted = permissionPatternForTool(call, command);
    const displayed = permissionPatternForDisplay(persisted);

    expect(persisted).toBe(`Bash(${command})`);
    expect(displayed).toHaveLength(40);
    expect(displayed.endsWith('...')).toBe(true);
  });
});
