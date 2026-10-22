import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A workspace's `.mcp.json` and legacy `.bookrc.json` on Windows are asked of the UNC guard
 * before they are opened: one that links to a network path counts as absent. Run on any host, as
 * the other `*.win32.test.ts` suites are (`src/test/windows-links.ts`).
 */
const links = vi.hoisted(() => ({
  map: new Map<string, string>(),
  posixHost: process.platform !== 'win32',
}));

vi.mock('fs', async (importOriginal) =>
  (await import('./test/windows-links.js')).withWindowsLinks(await importOriginal(), links),
);

import * as fs from 'fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseLegacyConfig } from './legacy-config.js';
import { resolveMcpServerList, type McpDiagnostic } from './mcp-config.js';
import { clearSpies, touches, windowsSpelling } from './test/windows-links.js';

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let tmp: string;
let linked: string;
let local: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'book-config-links-'));
  linked = join(tmp, 'linked');
  local = join(tmp, 'local');
  mkdirSync(join(tmp, 'home', '.book'), { recursive: true });
  for (const ws of [linked, local]) {
    mkdirSync(ws);
    writeFileSync(
      join(ws, '.mcp.json'),
      JSON.stringify({ mcpServers: { tool: { command: 'x' } } }),
    );
    writeFileSync(join(ws, '.bookrc.json'), JSON.stringify({ model: 'legacy-model' }));
  }
  links.map.clear();
  for (const name of ['.mcp.json', '.bookrc.json']) {
    links.map.set(windowsSpelling(join(linked, name)), `\\\\host\\share\\${name}`);
  }
  clearSpies(fs);
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  rmSync(tmp, { recursive: true, force: true });
});

const readers = () => [fs.existsSync, fs.readFileSync, fs.statSync, fs.openSync];

describe('project config files on Windows that link to a network path', () => {
  it('does not open a .mcp.json that links to a share, and says it skipped it', () => {
    const diagnostics: McpDiagnostic[] = [];
    const options = {
      home: join(tmp, 'home'),
      onDiagnostic: (d: McpDiagnostic) => diagnostics.push(d),
    };

    expect(resolveMcpServerList(linked, options)).toEqual([]);
    for (const spy of readers()) expect(touches(spy, join(linked, '.mcp.json'))).toBe(false);
    expect(diagnostics.map((d) => d.message)).toEqual([
      `Skipped MCP config on a network path: ${join(linked, '.mcp.json')}`,
    ]);

    // The control: a local one is read through the spied calls.
    expect(resolveMcpServerList(local, options).map((server) => server.name)).toEqual(['tool']);
    expect(touches(fs.readFileSync, join(local, '.mcp.json'))).toBe(true);
  });

  it('does not open a .bookrc.json that links to a share', () => {
    expect(parseLegacyConfig(linked)).toBeNull();
    for (const spy of readers()) expect(touches(spy, join(linked, '.bookrc.json'))).toBe(false);

    expect(parseLegacyConfig(local)?.model).toBe('legacy-model');
    expect(touches(fs.readFileSync, join(local, '.bookrc.json'))).toBe(true);
  });
});
