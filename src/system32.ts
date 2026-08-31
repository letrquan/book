import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Resolve an executable from %SystemRoot%\System32 on Windows.
 *
 * When System32 is missing from PATH (e.g. Git Bash, MSYS, or sanitized subprocess environments),
 * bare executable names fail with ENOENT under execFile / spawn with shell: false.
 * Off Windows, or if the executable is not found in System32, falls back to the bare name.
 */
export function system32Executable(
  name: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform !== 'win32') return name;
  const fileName = name.toLowerCase().endsWith('.exe') ? name : `${name}.exe`;
  const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows';
  const targetPath = join(systemRoot, 'System32', fileName);
  return existsSync(targetPath) ? targetPath : name;
}
