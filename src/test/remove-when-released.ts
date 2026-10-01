import { rmSync } from 'node:fs';

/**
 * Remove a test directory once Windows lets go of it. The detached runner exits a moment after it
 * publishes the terminal record, and until it and the killed worker have been torn down, and any
 * scanner has closed their files, Windows refuses the removal with EBUSY or EPERM. Node 24's
 * native `rmSync` reports that as EPERM on the first attempt whatever `maxRetries` says, so the
 * retry lives here. It polls for the release rather than guessing how long teardown takes.
 */
export async function removeWhenReleased(path: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(code) || Date.now() >= deadline) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}
