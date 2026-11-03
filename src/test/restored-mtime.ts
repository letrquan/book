import { statSync, utimesSync, writeFileSync } from 'node:fs';

/**
 * Rewrite a file and put its mtime back, as `touch -r` (or `cp -p`, `rsync -t`) does after an edit,
 * returning once its ctime has moved (#647). The kernel stamps file times from a coarse clock, so a
 * rewrite inside the same tick as the file's last change can keep its ctime, and a test of the
 * ctime check needs it to differ: the rewrite is repeated until it does.
 */
export async function rewriteRestoringMtime(
  path: string,
  content: string,
  mtime: Date,
): Promise<void> {
  const before = statSync(path).ctimeMs;
  for (let attempt = 0; attempt < 200; attempt++) {
    writeFileSync(path, content);
    utimesSync(path, mtime, mtime);
    if (statSync(path).ctimeMs !== before) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`The ctime of ${path} never moved.`);
}
