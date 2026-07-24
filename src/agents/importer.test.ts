import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { installAgentImports, previewAgentImport } from './importer.js';

let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('agent importer', () => {
  it('normalizes comma-separated tools and reports risky unsupported capabilities', () => {
    root = mkdtempSync(join(tmpdir(), 'book-import-'));
    const source = join(root, '.claude', 'agents');
    mkdirSync(source, { recursive: true });
    writeFileSync(
      join(source, 'reviewer.md'),
      [
        '---',
        'name: reviewer',
        'description: Read-only reviewer',
        'tools: Read, Write, WeirdTool',
        'model: inherit',
        '---',
        'Review.',
      ].join('\n'),
    );
    const [preview] = previewAgentImport(source);
    expect(preview.tools).toEqual(['Read', 'Write']);
    expect(preview.unsupportedTools).toEqual(['WeirdTool']);
    expect(preview.model).toBeUndefined();
    expect(preview.warnings.join('\n')).toContain('mutation tools');
  });

  it('only writes normalized definitions when explicitly asked', () => {
    root = mkdtempSync(join(tmpdir(), 'book-import-'));
    const source = join(root, 'agent.md');
    writeFileSync(
      source,
      ['---', 'name: explorer', 'tools: [Read, Grep]', '---', 'Body'].join('\n'),
    );
    const preview = previewAgentImport(source);
    const target = join(root, 'installed');
    expect(() => installAgentImports(preview, target)).not.toThrow();
    expect(previewAgentImport(target)[0].tools).toEqual(['Read', 'Grep']);
  });

  it('accepts allowed-tools and canonicalizes legacy aliases', () => {
    root = mkdtempSync(join(tmpdir(), 'book-import-'));
    const source = join(root, 'agent.md');
    writeFileSync(
      source,
      ['---', 'name: legacy', 'allowed-tools: [read_file, grep, GitStatus]', '---', 'Body'].join(
        '\n',
      ),
    );
    const [preview] = previewAgentImport(source);
    expect(preview.tools).toEqual(['Read', 'Grep', 'GitStatus']);
    expect(preview.unsupportedTools).toEqual([]);
  });

  it('refuses path traversal, duplicate names, and silent overwrites', () => {
    root = mkdtempSync(join(tmpdir(), 'book-import-'));
    const target = join(root, 'installed');
    const unsafe = {
      ...previewAgentImport(
        (() => {
          const source = join(root, 'unsafe.md');
          writeFileSync(
            source,
            ['---', 'name: ../escape', 'tools: Read', '---', 'Body'].join('\n'),
          );
          return source;
        })(),
      )[0],
    };
    expect(unsafe.warnings.join('\n')).toContain('Unsafe agent name');
    expect(() => installAgentImports([unsafe], target)).toThrow('Unsafe agent name');

    const safeSource = join(root, 'safe.md');
    writeFileSync(safeSource, ['---', 'name: safe', 'tools: Read', '---', 'Body'].join('\n'));
    const [safe] = previewAgentImport(safeSource);
    expect(() => installAgentImports([safe, safe], target)).toThrow('Duplicate imported agent');
    expect(installAgentImports([safe], target)).toHaveLength(1);
    expect(() => installAgentImports([safe], target)).toThrow('already exists');
  });
});
