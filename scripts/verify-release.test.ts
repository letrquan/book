import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyRelease } from './verify-release.js';

const fixtures: string[] = [];

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'book-release-check-'));
  fixtures.push(root);
  for (const path of [
    'package.json',
    'package-lock.json',
    'CHANGELOG.md',
    'src/index.ts',
    'src/cli/doctor.ts',
    'src/mcp.ts',
  ]) {
    const source = resolve(path);
    const target = join(root, path);
    cpSync(source, target, { recursive: true });
  }
  return root;
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('verifyRelease', () => {
  it('accepts consistent package, lockfile, changelog, CLI, and MCP metadata', () => {
    expect(verifyRelease(fixture())).toEqual([]);
  });

  it('reports a lockfile version mismatch', () => {
    const root = fixture();
    const path = join(root, 'package-lock.json');
    const lock = JSON.parse(readFileSync(path, 'utf8')) as {
      version: string;
      packages: Record<string, { version: string }>;
    };
    lock.version = '9.9.9';
    writeFileSync(path, JSON.stringify(lock));

    expect(verifyRelease(root)).toContain(
      'package-lock.json root versions must match package.json.',
    );
  });
});
