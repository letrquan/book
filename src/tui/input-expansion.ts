import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

/**
 * Expand @path references to file contents in user input.
 * Replaces @<path> with the file content (up to 2000 chars).
 */
export function expandAtMentions(input: string, workspace: string): string {
  return input.replace(/@([^\s]+)/g, (_match, filePath: string) => {
    const resolved = join(workspace, filePath);
    if (existsSync(resolved)) {
      try {
        const content = readFileSync(resolved, 'utf-8').slice(0, 2000);
        return `\n--- ${filePath} ---\n${content}\n--- end ${filePath} ---\n`;
      } catch {
        return `@${filePath}`;
      }
    }
    return `@${filePath}`;
  });
}

/**
 * Expand !cmd shell commands to their output in user input.
 * Replaces lines starting with !<cmd> with the command's stdout.
 */
export function expandShellCommands(input: string, workspace: string): string {
  return input.replace(/^!(\S.*)$/gm, (_match: string, cmd: string) => {
    try {
      const output = execSync(cmd, {
        cwd: workspace,
        encoding: 'utf-8',
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      }).trim();
      return output || `(command '${cmd}' produced no output)`;
    } catch (e: any) {
      return `(command '${cmd}' failed: ${e.message?.slice(0, 200) || 'unknown error'})`;
    }
  });
}
