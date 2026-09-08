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
// Read the name rather than assuming one: a scoped package installs to
// `node_modules/@scope/name`, and hardcoding the unscoped path made this smoke
// test pass only for the name the project happened to start with.
const packageName = (
  JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name: string }
).name;
const temporaryRoot = mkdtempSync(join(tmpdir(), 'book-package-smoke-'));
const installedRoot = join(temporaryRoot, 'node_modules', ...packageName.split('/'));

try {
  const dryRun = runNpm(['pack', '--dry-run', '--json'], root);
  const dryRunResult = parsePackResult(dryRun);
  const packagedFiles = new Set(dryRunResult.files.map((file) => file.path.replace(/\\/g, '/')));
  for (const required of [
    'dist/index.js',
    'dist/sdk.js',
    'dist/sdk.d.ts',
    'README.md',
    'patches/ink+6.8.0.patch',
    'scripts/apply-ink-patch.mjs',
  ]) {
    if (!packagedFiles.has(required)) throw new Error(`Packed artifact is missing ${required}.`);
  }

  // The command is the product for a CLI, and `npm publish` silently drops a
  // `bin` entry whose path it considers malformed — a leading `./` is enough —
  // after which the package installs cleanly and provides no command at all.
  // Neither `npm pack` nor running `dist/index.js` directly can see it: both
  // keep working, and only the published manifest loses the entry. So the
  // format is asserted here, where it is still checkable.
  const declaredBin = (
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { bin?: Record<string, string> }
  ).bin;
  for (const [command, target] of Object.entries(declaredBin ?? {})) {
    if (target.startsWith('./') || target.startsWith('.\\')) {
      throw new Error(
        `bin["${command}"] is "${target}"; npm publish drops a relative-prefixed bin path, ` +
          `which would ship a CLI with no command. Use "${target.slice(2)}".`,
      );
    }
    if (!packagedFiles.has(target.replace(/\\/g, '/'))) {
      throw new Error(`bin["${command}"] points at ${target}, which is not in the packed files.`);
    }
  }
  if (!declaredBin?.book) throw new Error('package.json declares no `book` command.');

  const packed = parsePackResult(
    runNpm(['pack', '--json', '--pack-destination', temporaryRoot], root),
  );
  const tarball = join(temporaryRoot, packed.filename);
  writeFileSync(join(temporaryRoot, 'package.json'), '{"private":true}', 'utf8');
  runNpm(['install', '--no-audit', '--no-fund', tarball], temporaryRoot);

  const installedPackage = JSON.parse(
    readFileSync(join(installedRoot, 'package.json'), 'utf8'),
  ) as { version: string };
  const cliOutput = execFileSync(
    process.execPath,
    [join(installedRoot, 'dist', 'index.js'), '--version'],
    { cwd: temporaryRoot, encoding: 'utf8' },
  ).trim();
  if (cliOutput !== installedPackage.version) {
    throw new Error(`Installed CLI reported ${cliOutput}; expected ${installedPackage.version}.`);
  }

  const sdkPath = join(installedRoot, 'dist', 'sdk.js');
  const sdk = (await import(pathToFileURL(sdkPath).href)) as Record<string, unknown>;
  if (typeof sdk.query !== 'function') throw new Error('Installed SDK does not export query().');

  console.log(
    `Packed and installed ${packageName}@${installedPackage.version}; CLI and SDK smoke tests passed.`,
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
