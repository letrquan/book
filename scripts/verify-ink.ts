import {
  VERIFIED_INK_VERSION,
  hasInkTrailingNewlineFix,
  installedInkVersion,
} from '../src/cli/ink-renderer.js';

const installed = installedInkVersion();
const problems: string[] = [];
if (installed !== VERIFIED_INK_VERSION) {
  problems.push(
    `ink@${installed ?? 'missing'} is installed, but the TUI was verified against ink@${VERIFIED_INK_VERSION}. ` +
      'Re-verify the TUI (docs/guide/development.md, "Upgrading Ink"), then update VERIFIED_INK_VERSION ' +
      'in src/cli/ink-renderer.ts.',
  );
}
if (!hasInkTrailingNewlineFix()) {
  problems.push("Ink's incremental renderer lacks the trailing-newline fix (upstream issue 909).");
}
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exitCode = 1;
} else {
  console.log(`ink@${installed} matches the verified renderer.`);
}
