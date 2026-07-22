import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface PackResult {
  filename: string;
  files: Array<{ path: string }>;
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temporaryRoot = mkdtempSync(join(tmpdir(), 'book-package-smoke-'));

try {
  const dryRun = runNpm(['pack', '--dry-run', '--json'], root);
  const dryRunResult = parsePackResult(dryRun);
  const packagedFiles = new Set(dryRunResult.files.map((file) => file.path.replace(/\\/g, '/')));
  for (const required of [
    'dist/index.js',
    'dist/sdk.js',
    'dist/sdk.d.ts',
    'README.md',
    'LICENSE',
  ]) {
    if (!packagedFiles.has(required)) throw new Error(`Packed artifact is missing ${required}.`);
  }

  const packed = parsePackResult(
    runNpm(['pack', '--json', '--pack-destination', temporaryRoot], root),
  );
  const tarball = join(temporaryRoot, packed.filename);
  writeFileSync(join(temporaryRoot, 'package.json'), '{"private":true}', 'utf8');
  runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], temporaryRoot);

  const installedPackage = JSON.parse(
    readFileSync(join(temporaryRoot, 'node_modules', 'book', 'package.json'), 'utf8'),
  ) as { version: string };
  const cliOutput = execFileSync(
    process.execPath,
    [join(temporaryRoot, 'node_modules', 'book', 'dist', 'index.js'), '--version'],
    { cwd: temporaryRoot, encoding: 'utf8' },
  ).trim();
  if (cliOutput !== installedPackage.version) {
    throw new Error(`Installed CLI reported ${cliOutput}; expected ${installedPackage.version}.`);
  }

  const sdkPath = join(temporaryRoot, 'node_modules', 'book', 'dist', 'sdk.js');
  const sdk = (await import(pathToFileURL(sdkPath).href)) as Record<string, unknown>;
  if (typeof sdk.query !== 'function') throw new Error('Installed SDK does not export query().');

  console.log(
    `Packed and installed book@${installedPackage.version}; CLI and SDK smoke tests passed.`,
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

function runNpm(args: string[], cwd: string): string {
  const npmCli = process.env.npm_execpath;
  const command = npmCli ? process.execPath : 'npm';
  const commandArgs = npmCli ? [npmCli, ...args] : args;
  return execFileSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, npm_config_loglevel: 'error' },
  });
}

function parsePackResult(output: string): PackResult {
  const parsed = JSON.parse(output) as PackResult[];
  const result = parsed[0];
  if (!result?.filename || !Array.isArray(result.files)) {
    throw new Error('npm pack returned an unexpected result.');
  }
  return result;
}
