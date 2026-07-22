import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackageDocument {
  version?: unknown;
  packageManager?: unknown;
  engines?: { node?: unknown };
}

interface LockDocument {
  version?: unknown;
  packages?: Record<string, { version?: unknown }>;
}

export function verifyRelease(root: string): string[] {
  const errors: string[] = [];
  const packageDocument = readJson<PackageDocument>(resolve(root, 'package.json'));
  const lockDocument = readJson<LockDocument>(resolve(root, 'package-lock.json'));
  const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
  const indexSource = readFileSync(resolve(root, 'src/index.ts'), 'utf8');
  const doctorSource = readFileSync(resolve(root, 'src/cli/doctor.ts'), 'utf8');
  const mcpSource = readFileSync(resolve(root, 'src/mcp.ts'), 'utf8');
  const version = packageDocument.version;

  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    errors.push('package.json must contain a valid semantic version.');
    return errors;
  }
  if (lockDocument.version !== version || lockDocument.packages?.['']?.version !== version) {
    errors.push('package-lock.json root versions must match package.json.');
  }
  if (!changelog.includes(`## [${version}]`)) {
    errors.push(`CHANGELOG.md must contain a ## [${version}] release entry.`);
  }
  if (!indexSource.includes('.version(getPackageVersion())')) {
    errors.push('The CLI version must use getPackageVersion().');
  }
  if (!doctorSource.includes('getPackageVersion()')) {
    errors.push('The doctor command version must use getPackageVersion().');
  }
  if (!mcpSource.includes('version: getPackageVersion()')) {
    errors.push('The MCP client version must use getPackageVersion().');
  }
  if (typeof packageDocument.packageManager !== 'string') {
    errors.push('package.json must declare packageManager.');
  }
  if (typeof packageDocument.engines?.node !== 'string') {
    errors.push('package.json must declare the supported Node.js range.');
  }

  const expectedTag = `v${version}`;
  const releaseTag =
    process.env.GITHUB_REF_TYPE === 'tag' ? process.env.GITHUB_REF_NAME : undefined;
  if (releaseTag && releaseTag !== expectedTag) {
    errors.push(`Release tag ${releaseTag} must match ${expectedTag}.`);
  }
  if (!releaseTag) {
    const headTags = gitTagsAtHead(root);
    const versionTags = headTags.filter((tag) => /^v\d+\.\d+\.\d+(?:-.+)?$/.test(tag));
    if (versionTags.length > 0 && !versionTags.includes(expectedTag)) {
      errors.push(
        `Version tag at HEAD must include ${expectedTag}; found ${versionTags.join(', ')}.`,
      );
    }
  }

  return errors;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function gitTagsAtHead(root: string): string[] {
  try {
    return execFileSync('git', ['tag', '--points-at', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split(/\r?\n/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(scriptPath)) {
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const errors = verifyRelease(root);
  if (errors.length > 0) {
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log('Release metadata is consistent.');
  }
}
