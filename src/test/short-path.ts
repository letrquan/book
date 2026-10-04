import { spawn } from 'node:child_process';

/**
 * A directory's 8.3 short name, or `undefined` where there is not one.
 *
 * Windows lets one directory be written two ways: the long form (`C:\Users\runneradmin\AppData`)
 * and the DOS 8.3 form (`C:\Users\RUNNER~1\AppData`). The two are the same directory and two
 * different strings, and a process that compares a root the user typed against a path `realpath`,
 * a glob walk or ripgrep reported reads "outside" between them. GitHub's Windows runners put
 * `os.tmpdir()` in the short form, so a test workspace root is spelled short while every tool
 * answers in long form; these tests use this to reproduce that on any machine.
 *
 * `cmd /c for %I in ("<dir>") do @echo %~sI` is the shell's own answer and needs no Windows API
 * binding, so it works in a plain Node test. Returns `undefined` on POSIX, and on a volume with
 * 8.3 name generation disabled.
 */
export function shortPathName(directory: string): Promise<string | undefined> {
  if (process.platform !== 'win32') return Promise.resolve(undefined);
  return new Promise((resolve) => {
    // The whole `for` loop is one argument, and it holds quotes and spaces of its own, so it is
    // passed verbatim: Node's own quoting turns it into something cmd misparses.
    const child = spawn('cmd', ['/c', `for %I in ("${directory}") do @echo %~sI`], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsVerbatimArguments: true,
    });
    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      out += chunk;
    });
    const settle = () => {
      // The short name is the one line, trimmed of the shell's trailing carriage return. A drive
      // with no 8.3 names echoes the long form back, which is a correct answer for "there is no
      // shorter spelling to disagree with", so it is passed through rather than dropped.
      const short = out.trim();
      resolve(short === '' ? undefined : short);
    };
    child.once('error', () => resolve(undefined));
    child.once('close', settle);
  });
}

/** The same path with a lowercase drive letter: `C:\ws` as `c:\ws`. */
export function withLowercaseDriveLetter(directory: string): string {
  return /^[A-Z]:/.test(directory) ? directory.toLowerCase() : directory;
}
